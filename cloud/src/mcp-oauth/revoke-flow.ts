import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpRefreshTokens, mcpSessions } from "../db/schema.js";
import type { Logger } from "../logger.js";
import type { JwtKeyRing } from "../sessions/jwt.js";
import { getMcpSessionState, mcpRefreshTokenHash, revokeMcpSession } from "./sessions.js";
import { verifyMcpAccessToken } from "./tokens.js";

/**
 * MCP OAuth Revocation（RFC 7009）的业务层 —— Phase 1.3.1-C3b。
 *
 * ## 撤销粒度：Session，不是 Grant
 *
 * ```
 * refresh_token（明文）→ sha256(pepper, "mcp-refresh", token) → mcp_refresh_tokens
 *   → mcp_refresh_tokens.session_id → mcp_sessions.id
 * ```
 *
 * 撤销的是**这一条 Session**。同一个 Grant 下的其它 Session（用户在另一台
 * 设备、另一个客户端会话）不受影响，`mcp_grants` 一行都不动。
 *
 * **这是对 RFC 7009 §2.1 一处 SHOULD 的有意偏离**：RFC 建议撤销 Refresh Token
 * 时「一并使其授权下的 Access Token 失效」。在单 Session 单凭证家族的模型里，
 * 「同一授权下的 Access Token」在本项目就等于「这条 Session 签出的 JWT」——
 * 而 `/mcp` 每次都按 `sid` 回查 Session 状态，Session 一被撤销，它签出的所有
 * Access JWT 立刻不可用。也就是说 SHOULD 的**效果**满足了，只是不通过「撤销
 * Grant」这条更粗的路径实现：Grant 是用户的授权决定，一次客户端登出不该把
 * 用户在别处的授权一起清掉。设计 §9.11 的行为矩阵是这条策略的验收本体。
 *
 * ## 无效 Token 一律 200
 *
 * RFC 7009 §2.2：「invalid tokens do not cause an error」。随机值、已消费、
 * 已过期、Session 已撤销/已过期，全部返回同一个 200 空响应——否则端点就变成
 * 一台「这个 token 是否存在 / 是否曾经有效」的探测机。
 *
 * 唯一的例外是**有效的 MCP Access JWT**：本阶段不支持用它撤销（Session 才是
 * 撤销单位，而一个 JWT 无法证明调用方仍持有对应的 Refresh Token），按
 * `unsupported_token_type` 返回 400。
 */

export interface McpRevokeDeps {
  db: Database;
  /** 与 Token Endpoint 同一个 pepper（哈希域 `mcp-refresh`）。 */
  pepper: string;
  keyRing: JwtKeyRing;
  /** `BASE_URL`。 */
  issuer: string;
  /** `MCP_RESOURCE`（= `issuer + "/mcp"`）。 */
  resource: string;
  logger?: Pick<Logger, "warn"> | undefined;
}

export type RevokeOutcome =
  /** 成功撤销（或并发下已被别人撤销——对外一致）。 */
  | { kind: "revoked" }
  /** Token 是真的，但归属的 client 与请求里的 `client_id` 不一致。 */
  | { kind: "client_mismatch" }
  /** 无效 Token：不存在 / 已消费 / 已过期 / Session 非 active。 */
  | { kind: "not_found" }
  /** 是一个有效的 MCP Access JWT，但本阶段不支持按 Access Token 撤销。 */
  | { kind: "unsupported_token_type" };

export interface RevokeTokenInput {
  /** 表单里的 `token` 原值。**不落库、不进日志**。 */
  token: string;
  /** 请求方声称的公开客户端标识（`client_id`，非 Secret）。 */
  clientId: string;
  /** 请求来源的 IP 哈希（与 Session 创建/轮换同一种算法）。 */
  ipHash?: string | undefined;
  now: Date;
}

/**
 * 撤销请求的唯一入口。
 *
 * 查找顺序是「先 Refresh，再 Access」：
 *
 * 1. Refresh Token 是一段 32 字节随机值，哈希后按唯一索引查一行——一次读，
 *    命中即判定（这正是 RFC 7009 要求的「不要只信 `token_type_hint`」）。
 * 2. 没命中才尝试把它当 MCP Access JWT 验证。**这一步不产生任何写**：它只用来
 *    区分「这是一个合法但不支持撤销的凭据」与「这是一段垃圾」。
 *
 * 反向顺序（先验 JWT）会让每个无效 Refresh Token 都付一次签名验证的代价，
 * 而攻击者完全可以用随机串把这个端点变成 CPU 消耗点。
 */
export async function revokeToken(
  deps: McpRevokeDeps,
  input: RevokeTokenInput,
): Promise<RevokeOutcome> {
  const tokenHash = mcpRefreshTokenHash(deps.pepper, input.token);

  const rows = await deps.db
    .select({
      sessionId: mcpRefreshTokens.sessionId,
      consumedAt: mcpRefreshTokens.consumedAt,
      expiresAt: mcpRefreshTokens.expiresAt,
      // 归属以**已签发 Token 关联的 Session** 为准，而不是 `mcp_oauth_clients`
      // 这张注册/元数据缓存表——后者记录的是「客户端长什么样」，不是
      // 「这枚凭据是谁的」。
      ownerClientId: mcpSessions.clientId,
    })
    .from(mcpRefreshTokens)
    // INNER JOIN：Session 不存在（FK 级联后理论不可能）按「无效 Token」处理。
    .innerJoin(mcpSessions, eq(mcpRefreshTokens.sessionId, mcpSessions.id))
    .where(eq(mcpRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];

  if (row) {
    /**
     * 客户端绑定必须排在**所有状态判定与写操作之前**。
     *
     * 排在 `consumed_at` / `expires_at` 之后会泄露状态（「这枚 token 存在但
     * 已过期」与「它不属于你」返回不同结果），排在撤销之后则会让错误客户端
     * 拿到一个破坏性原语。
     *
     * 比较是**逐字符**的：不 trim、不改大小写、不做 URL 归一化。
     */
    if (row.ownerClientId !== input.clientId) return { kind: "client_mismatch" };

    // 已是历史代（被轮换过）：它对应的 Session 可能仍然活着，但**这一枚**
    // 早就不是凭据了。撤销它等于让「捡到旧 token 的人」拥有踢掉合法会话的
    // 能力——那不是 RFC 7009 想要的语义。
    if (row.consumedAt !== null) return { kind: "not_found" };
    if (row.expiresAt.getTime() <= input.now.getTime()) return { kind: "not_found" };

    // Session 已撤销 / 已过期时**不再写库**：`revokeMcpSession` 只对未撤销的
    // 行生效（过期的那种它仍会写 `revoked_at`），所以这里先判状态，保证
    // 「无效 Token 不产生新的数据库副作用」。
    const state = await getMcpSessionState(deps.db, row.sessionId, input.now);
    if (state !== "active") return { kind: "not_found" };

    // 并发下这次更新可能命中 0 行（对方已经撤过）：对外仍是「撤销成功」，
    // 审计也只由真正改变状态的那一次写入——`revokeMcpSession` 只在命中时记账。
    await revokeMcpSession(
      {
        db: deps.db,
        pepper: deps.pepper,
        now: () => input.now,
        ...(deps.logger ? { logger: deps.logger } : {}),
      },
      { sessionId: row.sessionId, reason: "client_revoke", ipHash: input.ipHash },
    );
    return { kind: "revoked" };
  }

  // 不是 Refresh Token：判断它是不是一枚**有效**的 MCP Access JWT。
  let claims;
  try {
    claims = await verifyMcpAccessToken(deps.keyRing, input.token, {
      issuer: deps.issuer,
      resource: deps.resource,
    });
  } catch {
    // 签名不对 / 过期 / 不是 JWT / 是 Desktop 的 token（`aud` 不符）——
    // 对外一律「无效 Token」，200。
    return { kind: "not_found" };
  }

  /**
   * 验签通过**不等于**这枚 token 现在还能用（Phase 1.3.1-C3b-R2-R1）。
   *
   * `verifyMcpAccessToken()` 只回答「这串字节是不是我们签的、有没有过期」。
   * 资源服务器（`/mcp`）在每次请求时还会按 `sid` 回查 Session 状态——所以
   * 一枚签名完好的 JWT，在 Session 被撤销或越过 90 天绝对期限之后，**已经
   * 不是有效凭据**了。继续把它当成「有效但不支持撤销」会在撤销端点上凭空
   * 造出一个「这枚 token 仍然活着」的假信号。
   *
   * 一次查询把需要的三列一起读出来，不为了「先查存在、再查状态」跑两遍。
   */
  const sessions = await deps.db
    .select({
      clientId: mcpSessions.clientId,
      revokedAt: mcpSessions.revokedAt,
      absoluteExpiresAt: mcpSessions.absoluteExpiresAt,
    })
    .from(mcpSessions)
    .where(eq(mcpSessions.id, claims.sessionId))
    .limit(1);
  const session = sessions[0];

  // 三个「无效」彼此不可区分：Session 不存在 / 已撤销 / 已过期。
  if (!session) return { kind: "not_found" };
  if (session.revokedAt !== null) return { kind: "not_found" };
  if (session.absoluteExpiresAt.getTime() <= input.now.getTime()) return { kind: "not_found" };

  /**
   * JWT 的声明与 Session 记录必须一致。
   *
   * 这一条挡的是「claims 自证」：如果一个实现只比 `claims.clientId` 与请求值，
   * 那么一枚把 `client_id` 写成任意值的伪造 claim（只要签名合法——比如密钥
   * 轮换期的旧签名）就能自称属于任何客户端。**归属的权威是 Session 行**，
   * JWT 只是它的一个快照。
   */
  if (claims.clientId !== session.clientId) return { kind: "not_found" };

  /**
   * 到这里：Token 有效、Session 活着、两者归属一致。
   *
   * 只剩最后一个判据——**发请求的是不是这个客户端**。它排在最后，因为
   * 前三种「无效」对任何人都必须返回同一个 200；而这一条是 401，语义是
   * 「你的身份声明与这枚凭据对不上」，只有在凭据确实有效时才有意义。
   */
  if (input.clientId !== session.clientId) return { kind: "client_mismatch" };

  // 有效但不支持按 Access Token 撤销（撤销单位是 Session，凭据是 Refresh Token）。
  return { kind: "unsupported_token_type" };
}
