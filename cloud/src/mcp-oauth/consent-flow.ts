import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpAuthCodes, mcpAuthRequests, mcpGrants, mcpOauthClients } from "../db/schema.js";
import { constantTimeEqual, randomToken } from "../security/crypto.js";
import { hashCsrf, isAuthRequestId, mcpAuthCodeHash } from "./authorize-flow.js";
import {
  MCP_AUTH_CODE_TTL_MS,
  MCP_CSRF_BYTES,
  orderMcpScopes,
  type McpScope,
} from "./constants.js";

/**
 * 用户同意（Consent）的**业务层**（Phase 1.3.1-C2b）。
 *
 * 与 `authorize-flow.ts` 同一分工：这一层不碰 Hono、不碰 Cookie、不发日志，
 * 只回答三个问题——
 *
 * 1. 「这次授权请求现在能不能渲染同意页？」（`loadConsentRequest`）
 * 2. 「这次 GET 应该拿到哪一把 CSRF？」（`issueConsentCsrf`）
 * 3. 「用户按下允许/拒绝之后，数据库唯一合法的新状态是什么？」（`decideConsent`）
 *
 * ## 为什么允许路径必须是一个事务
 *
 * 一次批准要做三件事，它们要么全成、要么全不成：
 *
 * ```
 * upsert mcp_grants        ← 授权本身
 * INSERT mcp_auth_codes    ← 交给客户端的兑换凭据
 * DELETE mcp_auth_requests ← 消费掉这次授权请求
 * ```
 *
 * 少了第一件，客户端拿到的 code 兑不出 grant；少了第二件，grant 建了但没人
 * 能兑换（等于用户点了同意却什么都没发生）；少了第三件，同一个 rid 可以
 * 被反复用来签发多把 code。三者放在一个事务里，才不会出现「部分成功」。
 *
 * ## 为什么先 `SELECT … FOR UPDATE` 再改
 *
 * 同一个 `rid` 的两个 POST（双击、两个标签页、重放）如果都先读到「未消费」，
 * 就会各自建 grant、各自插 code。行锁把两个请求串行化：后到的那个在拿到锁
 * 之后重新读到「行已被删」，于是 fail-closed。**最终只有一个请求成功**——
 * 这条不变量由数据库的行锁保证，而不是由「先查后写」的时序运气保证。
 */

export type ConsentFailure =
  | "not_found"
  | "expired"
  | "not_authenticated"
  | "provider_not_consumed"
  | "binding_mismatch"
  | "unsupported_provider";

export interface ConsentRequest {
  rid: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  /** 只取 host：同意页要显示「回到哪里」，但不必暴露内部查询参数。 */
  redirectHost: string;
  /** 客户端**请求**的 scope（已按 `MCP_SCOPES` 定序、剔除未知值）。 */
  requestedScopes: McpScope[];
  resource: string;
  state: string | null;
  userId: string;
  provider: "google" | "github";
}

export interface ActiveGrant {
  grantId: string;
  scopes: McpScope[];
}

export type ConsentLoadOutcome =
  | { ok: true; request: ConsentRequest; activeGrant: ActiveGrant | null }
  | { ok: false; reason: ConsentFailure };

interface ConsentRow {
  id: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  scope: string[];
  resource: string;
  state: string | null;
  codeChallenge: string;
  csrfHash: string;
  browserBindingHash: string | null;
  userId: string | null;
  provider: string | null;
  providerConsumedAt: Date | null;
  expiresAt: Date;
}

async function readConsentRow(db: Database, rid: string): Promise<ConsentRow | undefined> {
  const rows = await db
    .select({
      id: mcpAuthRequests.id,
      clientId: mcpAuthRequests.clientId,
      clientName: mcpOauthClients.clientName,
      redirectUri: mcpAuthRequests.redirectUri,
      scope: mcpAuthRequests.scope,
      resource: mcpAuthRequests.resource,
      state: mcpAuthRequests.state,
      codeChallenge: mcpAuthRequests.codeChallenge,
      csrfHash: mcpAuthRequests.csrfHash,
      browserBindingHash: mcpAuthRequests.browserBindingHash,
      userId: mcpAuthRequests.userId,
      provider: mcpAuthRequests.provider,
      providerConsumedAt: mcpAuthRequests.providerConsumedAt,
      expiresAt: mcpAuthRequests.expiresAt,
    })
    .from(mcpAuthRequests)
    // LEFT JOIN：注册项被清理时仍能渲染（名字退化成 client_id）。
    .leftJoin(mcpOauthClients, eq(mcpAuthRequests.clientId, mcpOauthClients.clientId))
    .where(eq(mcpAuthRequests.id, rid))
    .limit(1);
  return rows[0];
}

/**
 * 同意页的十条前置条件（任务书 §3.1）。
 *
 * 顺序不是随意的：先「行还在吗」，再「过期了吗」，然后「登录态」，最后
 * 「这是不是同一个浏览器」。绑定不匹配要留证（调用方删行 + 审计），所以要
 * 排在登录态之后——一个没登录的行本来就不该出现在任何人的浏览器里。
 */
function evaluateConsentRow(
  row: ConsentRow,
  input: { bindingHash: string; now: Date },
): ConsentFailure | null {
  if (row.expiresAt.getTime() <= input.now.getTime()) return "expired";
  if (row.providerConsumedAt === null) return "provider_not_consumed";
  if (row.userId === null) return "not_authenticated";
  if (row.provider !== "google" && row.provider !== "github") return "unsupported_provider";
  if (!row.browserBindingHash) return "binding_mismatch";
  if (!constantTimeEqual(row.browserBindingHash, input.bindingHash)) return "binding_mismatch";
  return null;
}

function hostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    // 行内的 redirect_uri 在 authorize 阶段已按注册值逐字符校验过，正常不会
    // 解析失败。真解析不了就不显示 host，绝不影响后续判断。
    return "";
  }
}

export async function loadConsentRequest(
  db: Database,
  input: { rid: string; bindingHash: string; now: Date },
): Promise<ConsentLoadOutcome> {
  if (!isAuthRequestId(input.rid)) return { ok: false, reason: "not_found" };

  const row = await readConsentRow(db, input.rid);
  if (!row) return { ok: false, reason: "not_found" };

  const failure = evaluateConsentRow(row, input);
  if (failure) return { ok: false, reason: failure };

  const requestedScopes = orderMcpScopes(row.scope);
  // 请求里一个已知 scope 都没有 —— 说明这一行不是由 `validateAuthorizeParams`
  // 建出来的（或 scope 已被外部改坏）。不渲染同意页。
  if (requestedScopes.length === 0) return { ok: false, reason: "not_found" };

  const grantRows = await db
    .select({ id: mcpGrants.id, scopes: mcpGrants.scopes })
    .from(mcpGrants)
    .where(
      and(
        eq(mcpGrants.userId, row.userId as string),
        eq(mcpGrants.clientId, row.clientId),
        eq(mcpGrants.resource, row.resource),
        isNull(mcpGrants.revokedAt),
      ),
    )
    .limit(1);
  const grant = grantRows[0];

  return {
    ok: true,
    request: {
      rid: row.id,
      clientId: row.clientId,
      clientName: row.clientName ?? row.clientId,
      redirectUri: row.redirectUri,
      redirectHost: hostOf(row.redirectUri),
      requestedScopes,
      resource: row.resource,
      state: row.state,
      userId: row.userId as string,
      provider: row.provider as "google" | "github",
    },
    activeGrant: grant ? { grantId: grant.id, scopes: orderMcpScopes(grant.scopes) } : null,
  };
}

/**
 * 为本次渲染签发一把新的 CSRF，并覆盖行内哈希。
 *
 * **明文只返回给调用方一次**（写进 HTML 隐藏字段），数据库里只有哈希；
 * 明文不进日志、不进 URL、不进 Cookie。
 *
 * 每次打开同意页都会换一把：旧页面里那张表单的 CSRF 立刻失效。这样
 * 「把表单留上十分钟再提交」和「同时开两个标签页，用旧的那个提交」都会
 * 得到 400，而不是绕过检查。
 *
 * 条件 UPDATE 的作用是 fail-closed：如果这一行在被读取之后已经被消费、
 * 被删除、换了浏览器或过期，命中 0 行，调用方拿不到 CSRF，页面也渲染不出来。
 */
export async function issueConsentCsrf(
  db: Database,
  input: { rid: string; bindingHash: string; userId: string; now: Date },
): Promise<string | null> {
  const csrf = randomToken(MCP_CSRF_BYTES);
  const updated = await db
    .update(mcpAuthRequests)
    .set({ csrfHash: hashCsrf(csrf) })
    .where(
      and(
        eq(mcpAuthRequests.id, input.rid),
        eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
        eq(mcpAuthRequests.userId, input.userId),
        isNotNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
      ),
    )
    .returning({ id: mcpAuthRequests.id });
  return updated.length === 1 ? csrf : null;
}

// ---------------------------------------------------------------------------
// 提交决定
// ---------------------------------------------------------------------------

export type ConsentDecisionFailure =
  | "invalid_request"
  | ConsentFailure
  | "csrf_mismatch"
  | "invalid_scope"
  | "no_scope_granted";

export interface ConsentDecisionInput {
  rid: string;
  csrf: string;
  /** 原始提交值（`allow` / `deny` / 其他）。 */
  decision: string;
  /** 原始提交的 scope 列表（可重复、可含未知值）。 */
  scopes: readonly string[];
  bindingHash: string;
  now: Date;
}

export interface ConsentDenied {
  kind: "denied";
  redirectUri: string;
  state: string | null;
  userId: string;
  clientId: string;
}

export interface ConsentAllowed {
  kind: "allowed";
  redirectUri: string;
  state: string | null;
  userId: string;
  clientId: string;
  clientName: string;
  resource: string;
  /** 明文授权码。**只在 302 的 Location 里出现一次**。 */
  code: string;
  grantId: string;
  /** 单条 grant 的版本（不是设备级 `grant_epoch`）。 */
  epoch: number;
  scopes: McpScope[];
}

export type ConsentDecisionOutcome =
  | { ok: true; result: ConsentDenied | ConsentAllowed }
  | {
      ok: false;
      reason: ConsentDecisionFailure;
      /** 失败时已经能确定的上下文（审计用；不含任何凭据）。 */
      userId?: string;
      clientId?: string;
    };

/**
 * 用户拒绝（显式 `deny`，或允许但一个 scope 都没选）。
 *
 * 判据是那次**条件 DELETE 的命中行数**，不是前面读到的状态：读到「可以拒绝」
 * 之后、删之前，可能有另一个 POST 已经把它批准了。这时 DELETE 命中 0 行，
 * 拒绝方得到 400，而不是把一次已成立的授权撤销掉。
 */
async function denyConsent(
  db: Database,
  input: {
    rid: string;
    bindingHash: string;
    row: ConsentRow;
    now: Date;
  },
): Promise<ConsentDecisionOutcome> {
  const userId = input.row.userId as string;
  const deleted = await db
    .delete(mcpAuthRequests)
    .where(
      and(
        eq(mcpAuthRequests.id, input.rid),
        eq(mcpAuthRequests.csrfHash, input.row.csrfHash),
        eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
        eq(mcpAuthRequests.userId, userId),
        isNotNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
      ),
    )
    .returning({
      redirectUri: mcpAuthRequests.redirectUri,
      state: mcpAuthRequests.state,
    });

  const hit = deleted[0];
  if (!hit) {
    return { ok: false, reason: "not_found", userId, clientId: input.row.clientId };
  }
  return {
    ok: true,
    result: {
      kind: "denied",
      redirectUri: hit.redirectUri,
      state: hit.state,
      userId,
      clientId: input.row.clientId,
    },
  };
}

class ConsentRejection extends Error {
  constructor(
    readonly reason: ConsentDecisionFailure,
    readonly context: { userId?: string; clientId?: string } = {},
  ) {
    super(reason);
    this.name = "ConsentRejection";
  }
}

function reject(reason: ConsentDecisionFailure, context?: { userId?: string; clientId?: string }): never {
  throw new ConsentRejection(reason, context ?? {});
}

/** 事务的结果类型：`rejected` 会**提交**（它可能带着一次有意的删行），`allowed` 正常提交。 */
type TxOutcome =
  | { kind: "allowed"; result: ConsentAllowed }
  | { kind: "rejected"; reason: ConsentDecisionFailure; userId?: string; clientId?: string };

/**
 * 允许路径的事务体。
 *
 * 事务内外的分工：
 * - **事务内**只做数据库写入与判据（行锁、grant upsert、code 插入、删行）；
 * - **事务外**才做审计、清 Cookie、302——那些都不是数据库状态的一部分。
 */
async function allowConsent(
  db: Database,
  input: {
    rid: string;
    csrf: string;
    rawScopes: readonly string[];
    bindingHash: string;
    now: Date;
  },
): Promise<ConsentDecisionOutcome> {
  try {
    const outcome = await db.transaction(async (tx): Promise<TxOutcome> => {
      // ---- 1. 锁住这一行，之后所有判据都以锁内读到的为准 ----
      //
      // 先锁主表再单独取客户端名：`SELECT … FOR UPDATE` 带 JOIN 时，
      // 锁的行为取决于 `OF`，而这个流程只需要锁 `mcp_auth_requests`——
      // 拆成两条查询比依赖一个容易写错的选项更稳。
      const rows = await tx
        .select({
          id: mcpAuthRequests.id,
          clientId: mcpAuthRequests.clientId,
          redirectUri: mcpAuthRequests.redirectUri,
          scope: mcpAuthRequests.scope,
          resource: mcpAuthRequests.resource,
          state: mcpAuthRequests.state,
          codeChallenge: mcpAuthRequests.codeChallenge,
          csrfHash: mcpAuthRequests.csrfHash,
          browserBindingHash: mcpAuthRequests.browserBindingHash,
          userId: mcpAuthRequests.userId,
          provider: mcpAuthRequests.provider,
          providerConsumedAt: mcpAuthRequests.providerConsumedAt,
          expiresAt: mcpAuthRequests.expiresAt,
        })
        .from(mcpAuthRequests)
        .where(eq(mcpAuthRequests.id, input.rid))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) reject("not_found");

      // ---- 2. 重新验证（不信任 GET 时的任何结论）----
      const failure = evaluateConsentRow(
        { ...row, clientName: null },
        input,
      );
      if (failure) reject(failure, { userId: row.userId ?? undefined, clientId: row.clientId });

      // CSRF 用常量时间比较；不一致就**删行**（这张表单已被篡改，不能再用）。
      //
      // 这里刻意 `return` 而不是 `throw`：删行必须**提交**，抛错会把删除一起
      // 回滚，于是被篡改的表单可以继续重试。
      if (!constantTimeEqual(row.csrfHash, hashCsrf(input.csrf))) {
        await tx
          .delete(mcpAuthRequests)
          .where(
            and(
              eq(mcpAuthRequests.id, input.rid),
              eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
            ),
          );
        return {
          kind: "rejected",
          reason: "csrf_mismatch",
          userId: row.userId ?? undefined,
          clientId: row.clientId,
        };
      }

      const userId = row.userId as string;
      const requested = new Set<string>(orderMcpScopes(row.scope));
      if (requested.size === 0) reject("not_found");

      // ---- 3. 校验提交的 scope：只能收窄，不能发明 ----
      //
      // 逐项校验而不是「过滤掉非法值」：过滤会让一次越权提交看起来像一次
      // 正常的收窄授权，客户端永远不会知道自己的 scope 被改过。
      const submitted: McpScope[] = [];
      for (const raw of input.rawScopes) {
        if (!requested.has(raw)) reject("invalid_scope", { userId, clientId: row.clientId });
        submitted.push(raw as McpScope);
      }
      const selected = orderMcpScopes(submitted);
      if (selected.length === 0) {
        // 「允许但一个都不选」按拒绝处理。走到这里说明调用方没有在
        // `decideConsent` 入口把它转成 deny —— 兜底成拒绝，绝不放行空授权。
        reject("no_scope_granted", { userId, clientId: row.clientId });
      }

      // ---- 4. Step-up：已有 active grant 的 scope 必须原样保留 ----
      const grantRows = await tx
        .select({ id: mcpGrants.id, scopes: mcpGrants.scopes })
        .from(mcpGrants)
        .where(
          and(
            eq(mcpGrants.userId, userId),
            eq(mcpGrants.clientId, row.clientId),
            eq(mcpGrants.resource, row.resource),
            isNull(mcpGrants.revokedAt),
          ),
        )
        .limit(1);
      const active = grantRows[0];
      const previousScopes = active ? orderMcpScopes(active.scopes) : [];
      const isStepUp =
        previousScopes.length > 0 &&
        previousScopes.every((scope) => requested.has(scope)) &&
        previousScopes.length < requested.size;

      // Step-up 的并集只在「已有 scope 全部在本次请求里」时成立，所以
      // `finalScopes ⊆ requested` 是结构事实，不是需要额外放宽的规则。
      const finalScopes = isStepUp ? orderMcpScopes([...previousScopes, ...selected]) : selected;
      if (finalScopes.length === 0) reject("no_scope_granted", { userId, clientId: row.clientId });

      const clientRows = await tx
        .select({ clientName: mcpOauthClients.clientName })
        .from(mcpOauthClients)
        .where(eq(mcpOauthClients.clientId, row.clientId))
        .limit(1);
      const clientName = clientRows[0]?.clientName ?? row.clientId;

      // ---- 5. upsert grant（唯一约束 + ON CONFLICT 是并发保护）----
      //
      // epoch 规则：
      // | 情况 | epoch |
      // |---|---|
      // | 新建 | 1（列默认值） |
      // | active 且 scope 未变 | **不变**（无意义地涨版本会让 Desktop 重装上下文） |
      // | active 且 scope 变了 | +1 |
      // | 已撤销后再次授权 | +1（并清空 revoked_at） |
      //
      // 不用「先 SELECT 再 INSERT」：不存在的行在 Postgres 里没有可锁的对象，
      // 两个并发首次授权都会读到「没有」，然后一个撞唯一约束。ON CONFLICT
      // 让数据库自己完成「插入或更新」，两个请求必定串行。
      const upserted = await tx
        .insert(mcpGrants)
        .values({
          userId,
          clientId: row.clientId,
          clientName,
          scopes: finalScopes,
          resource: row.resource,
          epoch: 1,
          revokedAt: null,
        })
        .onConflictDoUpdate({
          target: [mcpGrants.userId, mcpGrants.clientId, mcpGrants.resource],
          set: {
            clientName,
            scopes: finalScopes,
            revokedAt: null,
            // `mcp_grants.*` 在 DO UPDATE 里指向**已存在的那一行**，
            // `excluded.*` 才是本次提议的新值。两者比较一次就能同时判断
            // 「scope 有没有变」与「是不是从撤销态恢复」。
            epoch: sql`case
              when ${mcpGrants.revokedAt} is null and ${mcpGrants.scopes} = excluded.scopes
              then ${mcpGrants.epoch}
              else ${mcpGrants.epoch} + 1
            end`,
          },
        })
        .returning({ id: mcpGrants.id, epoch: mcpGrants.epoch });
      const grant = upserted[0];
      if (!grant) throw new Error("consent: grant upsert returned no row");

      // ---- 6. 授权码（60 秒，只存哈希）----
      const code = randomToken(32);
      await tx.insert(mcpAuthCodes).values({
        codeHash: mcpAuthCodeHash(code),
        userId,
        clientId: row.clientId,
        grantId: grant.id,
        redirectUri: row.redirectUri,
        codeChallenge: row.codeChallenge,
        scope: finalScopes,
        resource: row.resource,
        consumedAt: null,
        // 显式写入时间而不是依赖 `now()`：同一事务里的三个时间点必须来自
        // 同一个时钟，否则「code 比 grant 晚 60 秒」这种断言无法复现。
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + MCP_AUTH_CODE_TTL_MS),
      });

      // ---- 7. 消费授权请求（与上面两件同一个事务）----
      const deleted = await tx
        .delete(mcpAuthRequests)
        .where(
          and(
            eq(mcpAuthRequests.id, input.rid),
            eq(mcpAuthRequests.csrfHash, row.csrfHash),
            eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
            eq(mcpAuthRequests.userId, userId),
            isNotNull(mcpAuthRequests.providerConsumedAt),
            gt(mcpAuthRequests.expiresAt, input.now),
          ),
        )
        .returning({ id: mcpAuthRequests.id });
      // 不是 1 行就整体回滚：授权码与 grant 都不能留下来，否则会出现
      // 「代码已签发但授权请求还能被再提交一次」。
      if (deleted.length !== 1) throw new Error("consent: auth request was not consumed exactly once");

      return {
        kind: "allowed",
        result: {
          kind: "allowed",
          redirectUri: row.redirectUri,
          state: row.state,
          userId,
          clientId: row.clientId,
          clientName,
          resource: row.resource,
          code,
          grantId: grant.id,
          epoch: grant.epoch,
          scopes: finalScopes,
        },
      };
    });

    if (outcome.kind === "rejected") {
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.userId === undefined ? {} : { userId: outcome.userId }),
        ...(outcome.clientId === undefined ? {} : { clientId: outcome.clientId }),
      };
    }
    return { ok: true, result: outcome.result };
  } catch (err) {
    if (err instanceof ConsentRejection) {
      return { ok: false, reason: err.reason, ...err.context };
    }
    throw err;
  }
}

/**
 * 提交一次同意/拒绝。
 *
 * 入口先做一次普通读：拒绝路径与失败页面都需要知道「这是谁的行、为什么不行」。
 * **但判据永远是后面的条件写**——读只用于选择错误文案与审计事件。
 */
export async function decideConsent(
  db: Database,
  input: ConsentDecisionInput,
): Promise<ConsentDecisionOutcome> {
  if (input.decision !== "allow" && input.decision !== "deny") {
    return { ok: false, reason: "invalid_request" };
  }
  if (!isAuthRequestId(input.rid)) return { ok: false, reason: "invalid_request" };

  const row = await readConsentRow(db, input.rid);
  if (!row) return { ok: false, reason: "not_found" };

  const failure = evaluateConsentRow(row, { bindingHash: input.bindingHash, now: input.now });
  if (failure) {
    return { ok: false, reason: failure, userId: row.userId ?? undefined, clientId: row.clientId };
  }

  // CSRF 必须在任何写操作之前用常量时间比对一次。比较的是
  // `hashCsrf(提交值)` 与行内哈希——**不是**明文与哈希比。
  if (!constantTimeEqual(row.csrfHash, hashCsrf(input.csrf))) {
    await db
      .delete(mcpAuthRequests)
      .where(
        and(
          eq(mcpAuthRequests.id, input.rid),
          eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
        ),
      );
    return {
      ok: false,
      reason: "csrf_mismatch",
      userId: row.userId ?? undefined,
      clientId: row.clientId,
    };
  }

  if (input.decision === "deny") {
    return denyConsent(db, { rid: input.rid, bindingHash: input.bindingHash, row, now: input.now });
  }

  // 「允许但一个都没勾」= 拒绝。先做这一步，才能在 deny 路径上走同一条
  // 原子删除，而不是先建 grant 再发现 scope 为空。
  if (input.scopes.length === 0) {
    return denyConsent(db, { rid: input.rid, bindingHash: input.bindingHash, row, now: input.now });
  }

  return allowConsent(db, {
    rid: input.rid,
    csrf: input.csrf,
    rawScopes: input.scopes,
    bindingHash: input.bindingHash,
    now: input.now,
  });
}
