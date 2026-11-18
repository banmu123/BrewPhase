import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { recordAuthEvent } from "../db/audit.js";
import { mcpGrants, mcpRefreshTokens, mcpSessions, users } from "../db/schema.js";
import { pepperedSha256Hex, randomToken } from "../security/crypto.js";
import { type AppError, invalidGrant, invalidRequest } from "../security/errors.js";

/**
 * MCP OAuth 会话与 Refresh Token 服务（Phase 1.3.1-B）。
 *
 * 这一层是**两层模型**的实现：`mcp_sessions` 是长期身份（`id` 就是 JWT 的
 * `sid`，授权时生成一次、跨刷新不变），`mcp_refresh_tokens` 是每代凭据。
 * 与 Desktop 登录的 `auth_sessions` **没有任何共享**——那张表把「会话身份」
 * 与「当前 refresh」放在同一行，轮换即改身份；这里刻意不那样做（设计 §9.2）。
 *
 * ## 三条不可动摇的规则
 *
 * 1. **`created_at` / `absolute_expires_at` 只在 INSERT 时写一次**。
 *    刷新只允许碰 `last_used_at`。任何一次「顺手更新」都会让 90 天绝对上限
 *    退化成「每次刷新续 90 天」，而这正是 1.3.0 设计的原始缺陷。
 * 2. **锁顺序恒为「先 refresh 行、后 session 行」**。反过来的话，两个并发刷新
 *    可能各自持有 session 锁再互等对方的 refresh 锁——死锁。统一「先细后粗」。
 * 3. **明文 token 只在本函数返回时出现一次**。库里只有哈希，审计只记原因，
 *    任何拒绝路径都不透露「token 是否存在 / 过期 / 已被消费」。
 */

/** 绝对期限：`absolute_expires_at = created_at + 90 days`（设计 §9.9）。 */
export const MCP_SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 单代 Refresh Token 寿命上限：30 天，且被 Session 的绝对期限夹住。 */
export const MCP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 重放宽限窗口。
 *
 * 与 Desktop 的 `REFRESH_REUSE_GRACE_MS` **数值相同但策略独立**：那边是
 * 「整族撤销」的窗口，这边是「整条 Session 撤销」的窗口，两者的调整理由
 * 完全不同，不共用一个常量以免将来改一处误伤另一处。
 */
export const MCP_REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * MCP Refresh Token 的哈希域。
 *
 * **必须**与 Desktop 的 `"refresh-token"` 域分开：两套 token 都由同一个
 * `SESSION_TOKEN_PEPPER` 保护，若域相同，一条 Desktop refresh token 的哈希
 * 会与某条 MCP refresh token 的哈希在同一个值空间里——跨域重放就从「结构上
 * 不可能」变成「取决于两处表的查询顺序」。
 */
const MCP_REFRESH_HASH_DOMAIN = "mcp-refresh";

export function generateMcpRefreshToken(): string {
  return randomToken(32);
}

export function mcpRefreshTokenHash(pepper: string, rawToken: string): string {
  return pepperedSha256Hex(pepper, MCP_REFRESH_HASH_DOMAIN, rawToken);
}

/**
 * 所有拒绝路径共用的**固定文案**。
 *
 * 不区分「不存在 / 已过期 / 已被轮换 / 会话已撤销」：区分等于给出四条探针，
 * 攻击者据此能判断某个 token 是否曾经真实存在。具体原因只进 `meta`
 * （`serializeError` 只序列化 `code` 与 `message`，`meta` 不上线）与服务端日志。
 */
const INVALID_GRANT_MESSAGE = "refresh token is not valid";

/**
 * 创建路径的固定文案。
 *
 * 与上面分开：`createMcpSession` 的调用方此刻**没有** refresh token，
 * 错误却说「refresh token 无效」会把排障方向指向错误的一端。
 * 两边的 `code` 都是 `invalid_grant`（token 端点统一映射），只是描述诚实。
 */
const AUTHORIZATION_INVALID_MESSAGE = "authorization is not valid";

type RejectReason =
  | "unknown_token"
  | "token_expired"
  | "session_missing"
  | "session_revoked"
  | "session_expired"
  | "user_inactive"
  | "grant_revoked";
/** 仅用于事务内结论 → 服务端 meta；对外文案恒为 `INVALID_GRANT_MESSAGE`。 */
type RotationRejectReason = RejectReason | "grace_reuse" | "reuse_detected";

function rejectRefresh(reason: RotationRejectReason): AppError {
  return invalidGrant(INVALID_GRANT_MESSAGE, { mcpOAuth: true, reason });
}

function rejectAuthorization(reason: RejectReason): AppError {
  return invalidGrant(AUTHORIZATION_INVALID_MESSAGE, { mcpOAuth: true, reason });
}

export interface McpOAuthDeps {
  db: Database;
  /** 与 Desktop 登录共用同一个值；哈希域不同（见上）。 */
  pepper: string;
  /**
   * 可注入时钟。
   *
   * 90 天绝对期限的验收必须能「跨 4 个 30 天窗口」，真实等待不可能。
   * 服务内部**不出现 `new Date()`**（只在这里兜底一次），否则时间相关的
   * 用例就只能靠 sleep，而 sleep 既慢又不确定。
   */
  now?: (() => Date) | undefined;
}

function readClock(deps: McpOAuthDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// 创建：一次授权 = 一条 Session + 第一代 Refresh Token
// ---------------------------------------------------------------------------

export interface CreateMcpSessionInput {
  userId: string;
  grantId: string;
  /** 用户**实际勾选**的 scope（consent 页可能已收窄）。 */
  issuedScope: readonly string[];
  ipHash?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreatedMcpSession {
  /** = JWT `sid`，跨刷新不变。 */
  sessionId: string;
  userId: string;
  grantId: string;
  clientId: string;
  resource: string;
  issuedScope: string[];
  absoluteExpiresAt: Date;
  /** 明文 Refresh Token，**只在这里出现一次**。 */
  refreshToken: string;
}

/**
 * 创建 Session 与第一代 Refresh Token（同一事务）。
 *
 * `client_id` 与 `resource` **不接受调用方传入**：它们直接取自 Grant。
 * 这样「Session 的 client/resource 与 Grant 一致」不是一条需要校验的规则，
 * 而是一个不可能被违反的结构事实——少一条能写错的路径。
 *
 * Grant 读取不加行锁：即使它在此刻被并发撤销，`/mcp` 的每次请求仍会回查
 * Grant（设计 §9.7），所以这里不需要付出锁开销。
 */
export async function createMcpSession(
  deps: McpOAuthDeps,
  input: CreateMcpSessionInput,
): Promise<CreatedMcpSession> {
  const issuedScope = [...new Set(input.issuedScope)];
  if (issuedScope.length === 0) {
    throw invalidRequest("at least one scope must be granted");
  }

  const now = readClock(deps);
  const absoluteExpiresAt = new Date(now.getTime() + MCP_SESSION_ABSOLUTE_TTL_MS);
  const refreshExpiresAt = earliest(
    new Date(now.getTime() + MCP_REFRESH_TOKEN_TTL_MS),
    absoluteExpiresAt,
  );
  const rawToken = generateMcpRefreshToken();

  const created = await deps.db.transaction(async (tx) => {
    // ---- 1. 用户必须存在且处于 active ----
    const userRows = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.status !== "active") {
      throw rejectAuthorization("user_inactive");
    }

    // ---- 2. Grant 必须属于该用户、未撤销 ----
    const grantRows = await tx
      .select({
        id: mcpGrants.id,
        userId: mcpGrants.userId,
        clientId: mcpGrants.clientId,
        scopes: mcpGrants.scopes,
        resource: mcpGrants.resource,
        revokedAt: mcpGrants.revokedAt,
      })
      .from(mcpGrants)
      .where(and(eq(mcpGrants.id, input.grantId), eq(mcpGrants.userId, input.userId)))
      .limit(1);
    const grant = grantRows[0];
    // 「不存在」与「不属于这个用户」返回同一个错误：分开会让 grant_id
    // 变成一条归属探针。
    if (!grant) throw rejectAuthorization("grant_revoked");
    if (grant.revokedAt !== null) throw rejectAuthorization("grant_revoked");

    // ---- 3. 授予的 scope 必须是 Grant 的子集 ----
    const grantScopes = new Set(grant.scopes);
    const extra = issuedScope.filter((scope) => !grantScopes.has(scope));
    if (extra.length > 0) {
      // 不回显 scope 列表：它是授权内容，不该出现在错误里。
      throw invalidRequest("granted scope exceeds the authorization");
    }

    // ---- 4. Session（身份）----
    const sessionRows = await tx
      .insert(mcpSessions)
      .values({
        userId: input.userId,
        grantId: grant.id,
        clientId: grant.clientId,
        issuedScope,
        resource: grant.resource,
        // 显式写入而不是依赖列默认值：绝对期限必须能由注入时钟推出，
        // 否则「跨 90 天」的测试只能靠真实等待。
        createdAt: now,
        absoluteExpiresAt,
        lastUsedAt: now,
        ipHash: input.ipHash ?? "",
        userAgent: input.userAgent ?? "",
      })
      .returning({ id: mcpSessions.id });
    const session = sessionRows[0];
    if (!session) throw new Error("failed to create mcp session");

    // ---- 5. 第一代 Refresh Token ----
    await tx.insert(mcpRefreshTokens).values({
      sessionId: session.id,
      tokenHash: mcpRefreshTokenHash(deps.pepper, rawToken),
      generation: 1,
      createdAt: now,
      expiresAt: refreshExpiresAt,
      ipHash: input.ipHash ?? "",
      userAgent: input.userAgent ?? "",
    });

    return {
      sessionId: session.id,
      userId: input.userId,
      grantId: grant.id,
      clientId: grant.clientId,
      resource: grant.resource,
      issuedScope,
      absoluteExpiresAt,
    };
  });

  // 审计在事务外写（与 auth_sessions 的做法一致：撤销/创建已落库，
  // 审计写入失败不该回滚业务事实）。detail 里没有 token、没有明文。
  await recordAuthEvent(deps.db, {
    eventType: "mcp_session_created",
    userId: created.userId,
    sessionId: created.sessionId,
    ipHash: input.ipHash ?? "",
    detail: {
      grantId: created.grantId,
      clientId: created.clientId,
      scope: created.issuedScope,
      absoluteExpiresAt: created.absoluteExpiresAt.toISOString(),
    },
  });

  return { ...created, refreshToken: rawToken };
}

// ---------------------------------------------------------------------------
// 轮换
// ---------------------------------------------------------------------------

export interface RotateMcpRefreshTokenInput {
  refreshToken: string;
  ipHash?: string | undefined;
  userAgent?: string | undefined;
}

export interface RotatedMcpRefreshToken {
  /** 与旧 token 的 `sid` **完全相同**。 */
  sessionId: string;
  userId: string;
  grantId: string;
  clientId: string;
  resource: string;
  /** 本次授权实际授予的 scope（Session 上的快照）。 */
  issuedScope: string[];
  /**
   * `issuedScope ∩ grant.scopes`。
   *
   * 直接给 1.3.1-C 的 access token 签发用：设计 §9.7 规定 token 的 `scope`
   * 是这个交集，而不是任一单边——只看 grant 会让历史 token 凭空获得新权限，
   * 只看 token 会让被收窄的 scope 在 15 分钟内继续可用。
   */
  effectiveScope: string[];
  absoluteExpiresAt: Date;
  /** 明文下一代 Refresh Token，**只在这里出现一次**。 */
  refreshToken: string;
  generation: number;
}

type RotationOutcome =
  | {
      kind: "rotated";
      sessionId: string;
      userId: string;
      grantId: string;
      clientId: string;
      resource: string;
      issuedScope: string[];
      effectiveScope: string[];
      absoluteExpiresAt: Date;
      refreshToken: string;
      generation: number;
      ipHash: string;
    }
  /** 刚被轮换过（并发重试 / 响应丢失后的立即重试）：拒绝但**不撤**会话。 */
  | { kind: "grace"; userId: string; sessionId: string; sinceConsumedMs: number; ipHash: string }
  /** 宽限外重放：判定为凭据被盗，撤销整条 Session。 */
  | { kind: "reuse"; userId: string; sessionId: string; revokedNow: boolean; ipHash: string }
  | { kind: "rejected"; reason: RejectReason };

/**
 * 用旧 Refresh Token 换下一代。
 *
 * 成功时**旧行保留**（只标 `consumed_at` 与 `replaced_by`）——重放检测依赖
 * 这些历史行；删掉它们等于把「这个 token 已经被用过」这个事实一起删掉。
 */
export async function rotateMcpRefreshToken(
  deps: McpOAuthDeps,
  input: RotateMcpRefreshTokenInput,
): Promise<RotatedMcpRefreshToken> {
  const now = readClock(deps);
  const ipHash = input.ipHash ?? "";
  const oldHash = mcpRefreshTokenHash(deps.pepper, input.refreshToken);

  const outcome: RotationOutcome = await deps.db.transaction(async (tx) => {
    // ---- 1. 先锁 refresh 行（锁序约定：先细后粗）----
    const tokenRows = await tx
      .select({
        id: mcpRefreshTokens.id,
        sessionId: mcpRefreshTokens.sessionId,
        generation: mcpRefreshTokens.generation,
        expiresAt: mcpRefreshTokens.expiresAt,
        consumedAt: mcpRefreshTokens.consumedAt,
      })
      .from(mcpRefreshTokens)
      .where(eq(mcpRefreshTokens.tokenHash, oldHash))
      .for("update")
      .limit(1);
    const old = tokenRows[0];
    if (!old) return { kind: "rejected", reason: "unknown_token" };

    // ---- 2. 已被消费：先判「是否宽限内」，再判会话 ----
    //
    // 顺序是设计 §9.10 明确要求的：重放检测是安全事件，必须早于
    // 「会话已撤销」这个更平淡的理由判定，否则一次真实的盗用会被记成
    // 「会话过期」，安全审计里就永远看不到它。
    if (old.consumedAt !== null) {
      const sinceConsumedMs = now.getTime() - old.consumedAt.getTime();

      // 无论宽限内外都要读 session（拿 userId 做审计），锁序仍是
      // 「先 refresh 后 session」，与正常轮换一致，不会互相死锁。
      const sessionRows = await tx
        .select({ id: mcpSessions.id, userId: mcpSessions.userId, revokedAt: mcpSessions.revokedAt })
        .from(mcpSessions)
        .where(eq(mcpSessions.id, old.sessionId))
        .for("update")
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        // FK 是 CASCADE，理论上不会走到这里；真走到了也只当普通拒绝。
        return { kind: "rejected", reason: "session_missing" };
      }

      if (sinceConsumedMs <= MCP_REFRESH_REUSE_GRACE_MS) {
        return {
          kind: "grace",
          userId: session.userId,
          sessionId: session.id,
          sinceConsumedMs,
          ipHash,
        };
      }

      let revokedNow = false;
      if (session.revokedAt === null) {
        await tx
          .update(mcpSessions)
          .set({ revokedAt: now, revokedReason: "refresh_reuse" })
          .where(eq(mcpSessions.id, session.id));
        revokedNow = true;
      }
      return {
        kind: "reuse",
        userId: session.userId,
        sessionId: session.id,
        revokedNow,
        ipHash,
      };
    }

    // ---- 3. 这一代自身是否过期 ----
    if (old.expiresAt.getTime() <= now.getTime()) {
      return { kind: "rejected", reason: "token_expired" };
    }

    // ---- 4. 锁 Session，逐条判状态 ----
    const sessionRows = await tx
      .select({
        id: mcpSessions.id,
        userId: mcpSessions.userId,
        grantId: mcpSessions.grantId,
        clientId: mcpSessions.clientId,
        resource: mcpSessions.resource,
        issuedScope: mcpSessions.issuedScope,
        absoluteExpiresAt: mcpSessions.absoluteExpiresAt,
        revokedAt: mcpSessions.revokedAt,
      })
      .from(mcpSessions)
      .where(eq(mcpSessions.id, old.sessionId))
      .for("update")
      .limit(1);
    const session = sessionRows[0];
    if (!session) return { kind: "rejected", reason: "session_missing" };
    if (session.revokedAt !== null) return { kind: "rejected", reason: "session_revoked" };
    if (session.absoluteExpiresAt.getTime() <= now.getTime()) {
      // 过期不写 revoke：它是时间的函数，不是一次事件。写进去会让
      // 「撤销」与「到期」在审计上无法区分。
      return { kind: "rejected", reason: "session_expired" };
    }

    // ---- 5. 账号状态 ----
    const userRows = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.status !== "active") {
      return { kind: "rejected", reason: "user_inactive" };
    }

    // ---- 6. Grant 必须仍未撤销 ----
    //
    // 这一条不能只靠「撤销 grant 时会同步撤 session」：那次同步是应用层
    // 事务，与这里的轮换是两个并发过程。轮换自己回查一次，才能在
    // 「grant 已撤、session 还没撤」的窗口里 fail-closed。
    const grantRows = await tx
      .select({ scopes: mcpGrants.scopes, revokedAt: mcpGrants.revokedAt })
      .from(mcpGrants)
      .where(eq(mcpGrants.id, session.grantId))
      .limit(1);
    const grant = grantRows[0];
    if (!grant || grant.revokedAt !== null) {
      return { kind: "rejected", reason: "grant_revoked" };
    }

    // ---- 7. 下一代 ----
    const rawToken = generateMcpRefreshToken();
    const generation = old.generation + 1;
    // 被 Session 的绝对期限夹住：第 89 天刷新时新 token 只活 1 天，
    // 而不是 30 天——这是「绝对上限不可续命」在这次轮换里的落点。
    const expiresAt = earliest(
      new Date(now.getTime() + MCP_REFRESH_TOKEN_TTL_MS),
      session.absoluteExpiresAt,
    );

    // 先消费旧代，再插新代：反过来会撞上「每个会话至多一条未消费」的
    // 部分唯一索引（那是我们对并发刷新的核心防线）。
    //
    // 新 id 由这里生成，好让 `replaced_by` 与插入在同一步确定下来；
    // 中途任何失败都会整笔回滚，不会留下「已消费但没有下一代」的行。
    const nextId = randomUUID();
    await tx
      .update(mcpRefreshTokens)
      .set({ consumedAt: now, replacedBy: nextId })
      .where(eq(mcpRefreshTokens.id, old.id));

    await tx.insert(mcpRefreshTokens).values({
      id: nextId,
      sessionId: session.id,
      tokenHash: mcpRefreshTokenHash(deps.pepper, rawToken),
      generation,
      createdAt: now,
      expiresAt,
      ipHash,
      userAgent: input.userAgent ?? "",
    });

    // ---- 8. Session 只推 last_used_at ----
    //
    // `created_at` / `absolute_expires_at` / `id` 一律不在这里出现。
    // 它们是不可变身份字段（有静态回归测试盯着这一行）。
    await tx
      .update(mcpSessions)
      .set({ lastUsedAt: now })
      .where(eq(mcpSessions.id, session.id));

    const grantScopes = new Set(grant.scopes);
    return {
      kind: "rotated",
      sessionId: session.id,
      userId: session.userId,
      grantId: session.grantId,
      clientId: session.clientId,
      resource: session.resource,
      issuedScope: session.issuedScope,
      effectiveScope: session.issuedScope.filter((scope) => grantScopes.has(scope)),
      absoluteExpiresAt: session.absoluteExpiresAt,
      refreshToken: rawToken,
      generation,
      ipHash,
    };
  });

  // ---- 事务已提交，下面只做审计与错误映射 ----
  //
  // 撤销必须**提交之后**才返回失败：如果在事务内抛异常，撤销会被一起回滚，
  // 于是「检测到盗用」变成了一句没有后果的日志。
  if (outcome.kind === "grace") {
    await recordAuthEvent(deps.db, {
      eventType: "mcp_refresh_grace_reuse",
      sessionId: outcome.sessionId,
      ipHash: outcome.ipHash,
      detail: { sinceConsumedMs: outcome.sinceConsumedMs, graceMs: MCP_REFRESH_REUSE_GRACE_MS },
    });
    throw rejectRefresh("grace_reuse");
  }

  if (outcome.kind === "reuse") {
    await recordAuthEvent(deps.db, {
      eventType: "mcp_refresh_reuse_detected",
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      ipHash: outcome.ipHash,
      detail: { revokedNow: outcome.revokedNow },
    });
    if (outcome.revokedNow) {
      await recordAuthEvent(deps.db, {
        eventType: "mcp_session_revoked",
        userId: outcome.userId,
        sessionId: outcome.sessionId,
        ipHash: outcome.ipHash,
        detail: { reason: "refresh_reuse" },
      });
    }
    throw rejectRefresh("reuse_detected");
  }

  if (outcome.kind === "rejected") {
    throw rejectRefresh(outcome.reason);
  }

  await recordAuthEvent(deps.db, {
    eventType: "mcp_refresh_success",
    userId: outcome.userId,
    sessionId: outcome.sessionId,
    ipHash: outcome.ipHash,
    detail: {
      grantId: outcome.grantId,
      generation: outcome.generation,
      scope: outcome.effectiveScope,
    },
  });

  return {
    sessionId: outcome.sessionId,
    userId: outcome.userId,
    grantId: outcome.grantId,
    clientId: outcome.clientId,
    resource: outcome.resource,
    issuedScope: outcome.issuedScope,
    effectiveScope: outcome.effectiveScope,
    absoluteExpiresAt: outcome.absoluteExpiresAt,
    refreshToken: outcome.refreshToken,
    generation: outcome.generation,
  };
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export type McpSessionState = "active" | "revoked" | "expired" | "missing";

/**
 * 判定一条 Session 的状态（惰性判定，不写库）。
 *
 * 只看 Session 自身。`/mcp` 的授权还要叠加 Grant 回查与 scope 交集
 * （设计 §9.7）；把那些塞进来会让这个函数在 1.3.2 里不得不改签名。
 */
export async function getMcpSessionState(
  db: Database,
  sessionId: string,
  now: Date = new Date(),
): Promise<McpSessionState> {
  const rows = await db
    .select({ revokedAt: mcpSessions.revokedAt, absoluteExpiresAt: mcpSessions.absoluteExpiresAt })
    .from(mcpSessions)
    .where(eq(mcpSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return "missing";
  // 已撤销优先于已过期：两者都成立时，「被人撤销」是更有信息量的那个事实。
  if (row.revokedAt !== null) return "revoked";
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export interface RevokeMcpSessionInput {
  sessionId: string;
  reason: "user_revoke" | "grant_revoked" | "refresh_reuse" | "client_revoke";
  ipHash?: string | undefined;
}

/**
 * 撤销一条 Session。
 *
 * **只打标记，不删行**：删除会让「这个会话曾经存在、在何时被谁撤掉」
 * 永久消失，而撤销正是最需要审计的动作。级联删除留给「删除 Grant」
 * 这类真正的数据清理（见 relations 测试）。
 */
export async function revokeMcpSession(
  deps: McpOAuthDeps,
  input: RevokeMcpSessionInput,
): Promise<{ revoked: boolean }> {
  const now = readClock(deps);
  const rows = await deps.db
    .update(mcpSessions)
    .set({ revokedAt: now, revokedReason: input.reason })
    .where(and(eq(mcpSessions.id, input.sessionId), isNull(mcpSessions.revokedAt)))
    .returning({ id: mcpSessions.id, userId: mcpSessions.userId });

  const row = rows[0];
  if (!row) return { revoked: false };

  await recordAuthEvent(deps.db, {
    eventType: "mcp_session_revoked",
    userId: row.userId,
    sessionId: row.id,
    ipHash: input.ipHash ?? "",
    detail: { reason: input.reason },
  });
  return { revoked: true };
}

export interface RevokeMcpSessionsByGrantInput {
  grantId: string;
  reason: "user_revoke" | "grant_revoked" | "refresh_reuse" | "client_revoke";
  ipHash?: string | undefined;
}

/**
 * 撤销某条 Grant 下的**全部** Session。
 *
 * 供未来的「Web 撤销授权」使用：它必须与 `mcp_grants.revoked_at` 在**同一个
 * 事务**里执行（设计 §9.6 第 5 条），因此本函数接受 `db` 而不自己开事务——
 * 传进来的可以是 `db`，也可以是一层 `tx`（drizzle 的 `PgTransaction`
 * 结构上兼容 `PostgresJsDatabase`，现有 `recordAuthEvent(tx, …)` 就是这么做）。
 * 单条 UPDATE 本身是原子的，不需要额外包裹。
 */
export async function revokeMcpSessionsByGrant(
  deps: McpOAuthDeps,
  input: RevokeMcpSessionsByGrantInput,
): Promise<{ revokedCount: number }> {
  const now = readClock(deps);
  const rows = await deps.db
    .update(mcpSessions)
    .set({ revokedAt: now, revokedReason: input.reason })
    .where(and(eq(mcpSessions.grantId, input.grantId), isNull(mcpSessions.revokedAt)))
    .returning({ id: mcpSessions.id, userId: mcpSessions.userId });

  if (rows.length === 0) return { revokedCount: 0 };

  // 一条事件而不是每条一个：撤销 grant 是一个动作，`revokedCount` 就是
  // 「影响了几条会话」的答案。逐条写会让一次批量撤销刷满审计表。
  await recordAuthEvent(deps.db, {
    eventType: "mcp_session_revoked",
    userId: rows[0]?.userId,
    ipHash: input.ipHash ?? "",
    detail: {
      reason: input.reason,
      grantId: input.grantId,
      revokedCount: rows.length,
      scope: "grant",
    },
  });
  return { revokedCount: rows.length };
}
