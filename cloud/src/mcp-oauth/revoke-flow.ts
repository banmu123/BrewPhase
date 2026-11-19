import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpRefreshTokens } from "../db/schema.js";
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
  /** 无效 Token：不存在 / 已消费 / 已过期 / Session 非 active。 */
  | { kind: "not_found" }
  /** 是一个有效的 MCP Access JWT，但本阶段不支持按 Access Token 撤销。 */
  | { kind: "unsupported_token_type" };

export interface RevokeTokenInput {
  /** 表单里的 `token` 原值。**不落库、不进日志**。 */
  token: string;
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
    })
    .from(mcpRefreshTokens)
    .where(eq(mcpRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];

  if (row) {
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
  try {
    await verifyMcpAccessToken(deps.keyRing, input.token, {
      issuer: deps.issuer,
      resource: deps.resource,
    });
    return { kind: "unsupported_token_type" };
  } catch {
    // 签名不对 / 过期 / 不是 JWT / 是 Desktop 的 token（`aud` 不符）——
    // 对外一律「无效 Token」，200。
    return { kind: "not_found" };
  }
}
