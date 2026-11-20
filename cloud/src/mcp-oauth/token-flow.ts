import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpAuthCodes, mcpGrants, mcpOauthClients } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { verifyPkce } from "../security/crypto.js";
import { invalidClient, invalidGrant, unauthorizedClient } from "../security/errors.js";
import type { JwtKeyRing } from "../sessions/jwt.js";
import { mcpAuthCodeHash } from "./authorize-flow.js";
import { orderMcpScopes, type McpScope } from "./constants.js";
import {
  createMcpSessionInTransaction,
  recordMcpSessionCreated,
  rotateMcpRefreshToken,
} from "./sessions.js";
import { signMcpAccessToken } from "./tokens.js";

/**
 * MCP Token Endpoint 的**业务层**（Phase 1.3.1-C3a）。
 *
 * 这一层只做三件事：把授权码换成会话、把 Refresh Token 换下一代、签 Access
 * Token。HTTP 解析、限流与错误映射都在路由层——两层分开之后，并发测试可以
 * 直接打这一层，不必绕过表单。
 *
 * ## 为什么授权码兑换必须是一个事务
 *
 * ```
 * SELECT … FOR UPDATE mcp_auth_codes
 *   → 校验 code / client / redirect_uri / resource / PKCE
 *   → 条件 UPDATE 消费授权码
 *   → INSERT mcp_sessions（复用 createMcpSessionInTransaction）
 *   → INSERT mcp_refresh_tokens（第一代）
 * COMMIT
 * ```
 *
 * 任何一步拆出去都会留下一种「半成功」：码被消费了却没有 Session（客户端
 * 拿不到任何凭据、也无法重试）、Session 建了却没有第一代 Refresh Token
 * （15 分钟后彻底失去续期能力）、或者两个并发请求各自建一条 Session。
 * 所以这里**不调用** `createMcpSession()`（它自己开事务），而是调用它的
 * 事务内版本。
 *
 * ## 错误面
 *
 * 授权码路径的所有失败都收敛到**同一个** `invalid_grant` 文案：区分「不存在 /
 * 过期 / 已用 / PKCE 不符 / client 不符」等于给出五条探针。Refresh 路径除了
 * `invalid_client`（客户端绑定失败）与 `invalid_scope`（请求越界）之外同理。
 */

export interface TokenFlowDeps {
  db: Database;
  /** Refresh Token 的哈希 pepper（与 Desktop 共用 `SESSION_TOKEN_PEPPER`）。 */
  pepper: string;
  keyRing: JwtKeyRing;
  /** `BASE_URL`。 */
  issuer: string;
  /** `MCP_RESOURCE`（= `issuer + "/mcp"`）。 */
  resource: string;
  /** 真实的 Access Token TTL（`env.accessTokenTtlSeconds`），不硬编码。 */
  accessTokenTtlSeconds: number;
  logger?: Pick<Logger, "warn"> | undefined;
}

export interface IssuedTokens {
  accessToken: string;
  /**
   * 明文 Refresh Token。**只在这里出现一次**。
   *
   * `undefined` = 该客户端注册的 `grant_types` **未声明** `refresh_token`
   * （设计 §8.4 gating）：此时数据库里同样**没有**创建任何 Refresh Token 行，
   * 响应里也不出现该字段——三者由同一个分支保证。
   */
  refreshToken?: string;
  /** 与 `access_token.exp - iat` 一致，供 `expires_in` 直接使用。 */
  expiresIn: number;
  /** 本次签发的 scope（= `issued_scope ∩ grant.scopes`，可能被请求再收窄）。 */
  scope: McpScope[];
  sessionId: string;
  userId: string;
  grantId: string;
  clientId: string;
  /** Refresh 路径专用：第几代（授权码路径恒为 1）。 */
  generation: number;
}

const CODE_INVALID_MESSAGE = "authorization code is not valid";

export interface ExchangeAuthorizationCodeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
  now: Date;
  ipHash?: string | undefined;
  userAgent?: string | undefined;
}

export async function exchangeAuthorizationCode(
  deps: TokenFlowDeps,
  input: ExchangeAuthorizationCodeInput,
): Promise<IssuedTokens> {
  const codeHash = mcpAuthCodeHash(input.code);
  const sessionDeps = {
    db: deps.db,
    pepper: deps.pepper,
    now: () => input.now,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };

  const issued = await deps.db.transaction(async (tx) => {
    // ---- 1. 锁住授权码行 ----
    //
    // 行锁是并发兑换的唯一串行化点：两个请求同时到达时，后到的那个在拿到锁
    // 之后会读到已经提交的 `consumed_at`（READ COMMITTED 下 `FOR UPDATE`
    // 重读最新版本），于是直接以 invalid_grant 结束。
    const rows = await tx
      .select({
        codeHash: mcpAuthCodes.codeHash,
        userId: mcpAuthCodes.userId,
        clientId: mcpAuthCodes.clientId,
        grantId: mcpAuthCodes.grantId,
        redirectUri: mcpAuthCodes.redirectUri,
        codeChallenge: mcpAuthCodes.codeChallenge,
        scope: mcpAuthCodes.scope,
        resource: mcpAuthCodes.resource,
        consumedAt: mcpAuthCodes.consumedAt,
        expiresAt: mcpAuthCodes.expiresAt,
      })
      .from(mcpAuthCodes)
      .where(eq(mcpAuthCodes.codeHash, codeHash))
      .for("update")
      .limit(1);
    const row = rows[0];
    // 从这里开始，任何失败都用同一句 fixed message：不区分原因。
    if (!row) throw invalidGrant(CODE_INVALID_MESSAGE);
    if (row.consumedAt !== null) throw invalidGrant(CODE_INVALID_MESSAGE);
    if (row.expiresAt.getTime() <= input.now.getTime()) throw invalidGrant(CODE_INVALID_MESSAGE);
    // `client_id` / `redirect_uri` / `resource` 都是**逐字符**比较：
    // 授权码是发给「某个 client 的某个回调」的，任何一处放宽都等于把码
    // 投递给另一个接收方。
    if (row.clientId !== input.clientId) throw invalidGrant(CODE_INVALID_MESSAGE);

    /**
     * 注册行复核（设计 §8.4：**单行 PK 读、不加锁**，不引入新的锁边）。
     *
     * 只查两条：注册行存在、`grant_types` 仍含 `authorization_code`。
     * **不查**缓存 INVALID、**不查** `metadata_version`、**不回溯**
     * `redirect_uri` 是否还在注册集合里——授权码代表一次**已经发生**的用户
     * 同意（签发时四条件已全过），回调合法性在签发时刻判定。
     * 失败映射 `invalid_client` [ID §6.1 MUST]，且发生在**消费授权码之前**。
     */
    const clientRows = await tx
      .select({ grantTypes: mcpOauthClients.grantTypes })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, row.clientId))
      .limit(1);
    const client = clientRows[0];
    if (!client) throw invalidClient("client is not registered");
    if (!client.grantTypes.includes("authorization_code")) {
      throw invalidClient("client is not allowed to use the authorization code grant");
    }
    // Refresh gating（§8.4）：只有**显式声明** `refresh_token` 才创建第一代
    // Refresh Token；未声明的客户端只拿 Session + Access Token。
    const issueRefreshToken = client.grantTypes.includes("refresh_token");

    if (row.redirectUri !== input.redirectUri) throw invalidGrant(CODE_INVALID_MESSAGE);
    if (row.resource !== input.resource) throw invalidGrant(CODE_INVALID_MESSAGE);
    // PKCE：`verifyPkce` 内部先校验 verifier 形态（RFC 7636 的 43–128 与
    // 字符集），再做常量时间比较。失败一律 invalid_grant。
    if (!verifyPkce(input.codeVerifier, row.codeChallenge)) {
      throw invalidGrant(CODE_INVALID_MESSAGE);
    }

    // ---- 2. 条件消费 ----
    //
    // 判据是这次 UPDATE 的命中行数，而不是上面那次读：读只用来给失败分类
    // （这里连分类都不给），写才是唯一判据。
    const consumed = await tx
      .update(mcpAuthCodes)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(mcpAuthCodes.codeHash, codeHash),
          isNull(mcpAuthCodes.consumedAt),
          gt(mcpAuthCodes.expiresAt, input.now),
        ),
      )
      .returning({ codeHash: mcpAuthCodes.codeHash });
    if (consumed.length !== 1) throw invalidGrant(CODE_INVALID_MESSAGE);

    // ---- 3. Session + 第一代 Refresh Token（同一个事务）----
    //
    // `createMcpSessionInTransaction` 会再校验一次：用户 active、Grant 属于
    // 该用户且未撤销（FOR UPDATE）、授权码的 scope ⊆ Grant 的 scope。
    // 数据全部来自授权码行，不接受调用方另传一套。
    const session = await createMcpSessionInTransaction(tx, sessionDeps, {
      userId: row.userId,
      grantId: row.grantId,
      issuedScope: row.scope,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
      issueRefreshToken,
    });

    // ---- 4. 本次签发的 scope ----
    //
    // 授权码的 scope 在签发时已被约束为 Grant 的子集；这里再求一次交集是
    // 为了「授权码发出后 Grant 被收窄」的窗口（码 60 秒有效，完全可能）。
    // Grant 行此刻已被上一步 `FOR UPDATE` 锁住，读到的一定是最新版本。
    const grantRows = await tx
      .select({ scopes: mcpGrants.scopes })
      .from(mcpGrants)
      .where(eq(mcpGrants.id, row.grantId))
      .limit(1);
    const grantScopes = new Set(grantRows[0]?.scopes ?? []);
    const scope = orderMcpScopes(row.scope.filter((value) => grantScopes.has(value)));
    // 空交集不该走到这里（`createMcpSessionInTransaction` 已要求 issued ⊆ grant），
    // 但真走到了也绝不签一个空 scope 的 token——那在 `/mcp` 上是全量 403。
    if (scope.length === 0) throw invalidGrant(CODE_INVALID_MESSAGE);

    // ---- 5. 签 Access Token（纯计算，留在事务内）----
    //
    // 放在事务里是为了「要么拿到完整的一组凭据，要么什么都没有」：签名失败
    // （理论上只会因为 scope 非法）会让授权码消费一起回滚。
    const accessToken = await signMcpAccessToken(
      deps.keyRing,
      { userId: session.userId, sessionId: session.sessionId, clientId: session.clientId, scope },
      {
        issuer: deps.issuer,
        resource: deps.resource,
        ttlSeconds: deps.accessTokenTtlSeconds,
        now: () => input.now,
      },
    );

    return { accessToken, session, scope };
  });

  // ---- 事务已提交：审计是记账，失败不回滚凭据 ----
  await recordMcpSessionCreated(sessionDeps, issued.session, input.ipHash ?? "");

  return {
    accessToken: issued.accessToken,
    ...(issued.session.refreshToken === undefined
      ? {}
      : { refreshToken: issued.session.refreshToken }),
    expiresIn: deps.accessTokenTtlSeconds,
    scope: issued.scope,
    sessionId: issued.session.sessionId,
    userId: issued.session.userId,
    grantId: issued.session.grantId,
    clientId: issued.session.clientId,
    generation: 1,
  };
}

export interface ExchangeRefreshTokenInput {
  refreshToken: string;
  clientId: string;
  resource: string;
  /** 可选：只能收窄。已解析成数组（路由层负责拆分与校验已知值）。 */
  requestedScope?: readonly string[] | undefined;
  now: Date;
  ipHash?: string | undefined;
  userAgent?: string | undefined;
}

export async function exchangeRefreshToken(
  deps: TokenFlowDeps,
  input: ExchangeRefreshTokenInput,
): Promise<IssuedTokens> {
  /**
   * 注册行复核——**必须在轮换（任何写入 / 消费）之前**（设计 §8.4 / 任务书
   * §6.3）：行不存在 → `invalid_client`；未声明 `refresh_token` →
   * `unauthorized_client`。放在 `rotateMcpRefreshToken` 之前，保证拒绝时
   * 旧代 Refresh Token **一个字节都没被消费**。
   */
  const clientRows = await deps.db
    .select({ grantTypes: mcpOauthClients.grantTypes })
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, input.clientId))
    .limit(1);
  const client = clientRows[0];
  if (!client) throw invalidClient("client is not registered");
  if (!client.grantTypes.includes("refresh_token")) {
    throw unauthorizedClient("client is not allowed to use the refresh token grant");
  }

  // 轮换内部已经处理：客户端/资源绑定、scope 收窄、重放宽限、绝对期限、
  // Grant / 用户状态。它**先算 scope 再写任何状态**，所以越界的请求不会
  // 消费掉旧代 Refresh Token。
  const rotated = await rotateMcpRefreshToken(
    {
      db: deps.db,
      pepper: deps.pepper,
      now: () => input.now,
      ...(deps.logger ? { logger: deps.logger } : {}),
    },
    {
      refreshToken: input.refreshToken,
      clientId: input.clientId,
      resource: input.resource,
      ...(input.requestedScope === undefined ? {} : { requestedScope: input.requestedScope }),
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    },
  );

  // `sid` 跨刷新不变；`issued_scope` 也不变（Session 的身份与授权快照）。
  // 只有发给客户端的这一枚 token 的 scope 会随着 Grant 收窄而变小。
  const accessToken = await signMcpAccessToken(
    deps.keyRing,
    {
      userId: rotated.userId,
      sessionId: rotated.sessionId,
      clientId: rotated.clientId,
      scope: rotated.effectiveScope,
    },
    {
      issuer: deps.issuer,
      resource: deps.resource,
      ttlSeconds: deps.accessTokenTtlSeconds,
      now: () => input.now,
    },
  );

  return {
    accessToken,
    refreshToken: rotated.refreshToken,
    expiresIn: deps.accessTokenTtlSeconds,
    scope: rotated.effectiveScope as McpScope[],
    sessionId: rotated.sessionId,
    userId: rotated.userId,
    grantId: rotated.grantId,
    clientId: rotated.clientId,
    generation: rotated.generation,
  };
}
