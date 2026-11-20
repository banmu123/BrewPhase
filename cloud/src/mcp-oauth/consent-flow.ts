import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { recordAuthEvent } from "../db/audit.js";
import { mcpAuthCodes, mcpAuthRequests, mcpGrants, mcpOauthClients } from "../db/schema.js";
import { constantTimeEqual, randomToken } from "../security/crypto.js";
import { hashCsrf, isAuthRequestId, mcpAuthCodeHash } from "./authorize-flow.js";
import { clientIdentifierDisplay } from "./consent-page.js";
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
  | "unsupported_provider"
  /**
   * 四条件实时复核失败（设计 §8.3）：注册行消失 / INVALID / redirect_uri 已被
   * 移出注册集合 / grant_types 不再含 `authorization_code`。
   *
   * **拒绝的副作用（删行 + `mcp_consent_metadata_invalid` 审计）已经在
   * `loadConsentRequest` 的事务里提交**——路由层只渲染 400 页面，绝不再删一次、
   * 再审计一次（§4.4：删除与审计必须真正提交，且不得重复）。
   */
  | "metadata_invalid";

/**
 * 四条件（设计 §8.3 冻结判据）的失败编号。
 *
 * 1 = 注册行不存在；2 = `metadata_cache_expires_at` 等于 INVALID 哨兵 epoch；
 * 3 = `auth_request.redirect_uri` 不在当前 `client.redirect_uris`（逐字符）；
 * 4 = `client.grant_types` 不含 `authorization_code`。
 *
 * **不比对 `metadata_version`**（方案 B）：版本因 `client_name` 等展示字段变化
 * 而递增时授权必须继续；`response_types` 不落库，运行时也不复核（§5.6）。
 */
export type MetadataCondition = 1 | 2 | 3 | 4;

/**
 * 四条件所需的注册行投影（LEFT JOIN 下「行不存在」= 三个可空字段均为 NULL；
 * `redirectUris` / `grantTypes` 是 NOT NULL 列，它们为 NULL 即表示整行缺失）。
 */
export interface MetadataClientRow {
  redirectUris: string[] | null;
  grantTypes: string[] | null;
  /** NULL 视为非 INVALID；epoch 哨兵（`new Date(0)`）才是 INVALID。 */
  metadataCacheExpiresAt: Date | null;
}

/** 只拒绝 INVALID（epoch 哨兵）；FRESH 与 STALE 都放行（§8.3：no-cache 永久 STALE）。 */
export function evaluateMetadataConditions(
  client: MetadataClientRow | null | undefined,
  redirectUri: string,
): MetadataCondition | null {
  if (!client || client.redirectUris === null || client.grantTypes === null) return 1;
  if (client.metadataCacheExpiresAt !== null && client.metadataCacheExpiresAt.getTime() === 0) {
    return 2;
  }
  // [ID §4.2 MUST]：逐字符，不做前缀 / 规范化比较。
  if (!client.redirectUris.some((registered) => registered === redirectUri)) return 3;
  if (!client.grantTypes.includes("authorization_code")) return 4;
  return null;
}

/**
 * 「删 pending 授权请求 + 写 `mcp_consent_metadata_invalid`」——**必须同一事务
 * 提交**（§8.5 边界二：禁止靠抛错让这对副作用一起回滚，也禁止只写其一）。
 *
 * `stage`：`consent` = GET（§15）、`consent_submit` = POST。
 */
async function commitMetadataRejection(
  db: Database,
  input: {
    rid: string;
    clientId: string;
    userId: string | null;
    stage: "consent" | "consent_submit";
    condition: MetadataCondition;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, input.rid));
    await recordAuthEvent(tx, {
      eventType: "mcp_consent_metadata_invalid",
      ...(input.userId === null ? {} : { userId: input.userId }),
      detail: {
        rid: input.rid,
        clientId: input.clientId,
        stage: input.stage,
        condition: input.condition,
      },
    });
  });
}

export interface ConsentRequest {
  rid: string;
  clientId: string;
  clientName: string;
  /** `client_id` 的安全展示形式（§16：URL→hostname / 不透明 id 截断 40 字符）。 */
  clientIdentifierHost: string;
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
  | {
      ok: false;
      reason: ConsentFailure;
      /** `metadata_invalid` 时给出失败的条件编号（1–4），其余失败为 undefined。 */
      condition?: MetadataCondition;
      clientId?: string;
    };

interface ConsentRow {
  id: string;
  clientId: string;
  clientName: string | null;
  /** LEFT JOIN 的注册行投影（三个字段同时为 NULL = 注册行不存在）。 */
  clientRedirectUris: string[] | null;
  clientGrantTypes: string[] | null;
  clientMetadataCacheExpiresAt: Date | null;
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
      clientRedirectUris: mcpOauthClients.redirectUris,
      clientGrantTypes: mcpOauthClients.grantTypes,
      clientMetadataCacheExpiresAt: mcpOauthClients.metadataCacheExpiresAt,
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
    // 四条件的「行存在」判断（条件 1）由 `clientRedirectUris === null` 给出。
    .leftJoin(mcpOauthClients, eq(mcpAuthRequests.clientId, mcpOauthClients.clientId))
    .where(eq(mcpAuthRequests.id, rid))
    .limit(1);
  return rows[0];
}

/** 从 `ConsentRow` 抽出四条件所需的注册行投影。 */
function metadataClientOf(row: ConsentRow): MetadataClientRow {
  return {
    redirectUris: row.clientRedirectUris,
    grantTypes: row.clientGrantTypes,
    metadataCacheExpiresAt: row.clientMetadataCacheExpiresAt,
  };
}

/**
 * 同意页的十条前置条件（任务书 §3.1）。
 *
 * 顺序不是随意的：先「行还在吗」，再「过期了吗」，然后「登录态」，最后
 * 「这是不是同一个浏览器」。绑定不匹配要留证（调用方删行 + 审计），所以要
 * 排在登录态之后——一个没登录的行本来就不该出现在任何人的浏览器里。
 */
function evaluateConsentRow(
  row: Pick<
    ConsentRow,
    "expiresAt" | "providerConsumedAt" | "userId" | "provider" | "browserBindingHash"
  >,
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

  /**
   * 四条件实时复核（设计 §8.3，GET 为**纯读检查**、不加锁）。
   *
   * 任一失败：删 pending 授权请求 + 写 `mcp_consent_metadata_invalid`——两者
   * 在**同一事务**提交（`commitMetadataRejection`），随后只返回结论，路由层
   * 渲染 400 HTML，**不再重复删除 / 重复审计**。
   */
  const condition = evaluateMetadataConditions(metadataClientOf(row), row.redirectUri);
  if (condition !== null) {
    await commitMetadataRejection(db, {
      rid: row.id,
      clientId: row.clientId,
      userId: row.userId,
      stage: "consent",
      condition,
    });
    return { ok: false, reason: "metadata_invalid", condition, clientId: row.clientId };
  }

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
      clientIdentifierHost: clientIdentifierDisplay(row.clientId),
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

/** deny 事务的结果：两条分支都**正常提交**（§8.5 边界二），绝不靠 throw 表达拒绝。 */
type DenyTxOutcome =
  | { kind: "denied"; result: ConsentDenied }
  | { kind: "rejected"; reason: ConsentDecisionFailure; userId?: string; clientId?: string };

/**
 * 用户拒绝（显式 `deny`，或「允许但一个 scope 都没选」）的**事务实现**
 * （C3c-3B-3-R1，任务书 §5.1）。
 *
 * ## 为什么必须是事务 + `FOR SHARE`（修复前的 P2）
 *
 * 修复前的路径是「普通 SELECT 快照查四条件 → 条件 DELETE → 302」：检查与
 * 删除/重定向之间没有持锁，刷新事务可以在窗口内改写注册行（例如把本次
 * `redirect_uri` 移出 `redirect_uris`），拒绝仍会把响应 302 到**已不在注册
 * 集合里**的回调地址。现在判定与删除在同一次持锁事务里完成，锁序与 allow
 * 完全一致、**不得反向**：
 *
 * ```text
 * 1. SELECT mcp_auth_requests FOR UPDATE
 * 2. 重新检查：行存在 / expires_at / provider_consumed_at / user_id / provider /
 *    browser_binding_hash / CSRF（不信任入口读时的任何结论）
 * 3. SELECT mcp_oauth_clients FOR SHARE
 * 4. 四条件（锁内值；条件 1–4 见 evaluateMetadataConditions）
 * 5. metadata invalid → 删行 + mcp_consent_metadata_invalid（stage=consent_submit、
 *    condition=1|2|3|4）**同一事务正常 return 提交** → 路由 400，绝不 302
 * 6. 四条件通过 → 删行（redirect_uri / state 取锁内行）→ return denied
 *    → 事务提交后路由才允许 302 access_denied
 * ```
 *
 * `FOR SHARE` 与刷新的 `UPDATE` 冲突：刷新要么先提交（我们读到新值、按新值
 * 判定），要么等我们提交（拒绝只删自己的 pending 行，不签发任何凭据）。
 *
 * **不 throw 表达预期拒绝**：throw 会把删行与审计一起回滚（§8.5 边界二）。
 * 只有数据库异常才抛出 → 外层 `decideConsentSafely` 收口成固定 500（整事务
 * 回滚）。
 *
 * 判据仍是「条件 DELETE 的命中行数」（读到可以拒绝之后、删之前，可能有另一个
 * POST 已经把它批准了——持锁后该窗口被关闭，命中 0 行仍按 fail-closed 处理）。
 */
async function denyConsentInTransaction(
  db: Database,
  input: ConsentDecisionInput,
): Promise<ConsentDecisionOutcome> {
  const outcome = await db.transaction(async (tx): Promise<DenyTxOutcome> => {
    // ---- 1. 锁住这一行，之后所有判据都以锁内读到的为准 ----
    const rows = await tx
      .select({
        id: mcpAuthRequests.id,
        clientId: mcpAuthRequests.clientId,
        redirectUri: mcpAuthRequests.redirectUri,
        state: mcpAuthRequests.state,
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
    if (!row) return { kind: "rejected", reason: "not_found" };

    // ---- 2. 重新检查（入口的普通读只用于选错误文案，这里才是判据）----
    const failure = evaluateConsentRow(row, input);
    if (failure) {
      return {
        kind: "rejected",
        reason: failure,
        userId: row.userId ?? undefined,
        clientId: row.clientId,
      };
    }
    // CSRF：与 allow 路径同一纪律——不一致就删行并**正常 return（提交）**，
    // 不 throw（抛错会把删除一起回滚，被篡改的表单就能继续重试）。
    if (!constantTimeEqual(row.csrfHash, hashCsrf(input.csrf))) {
      await tx.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, input.rid));
      return {
        kind: "rejected",
        reason: "csrf_mismatch",
        userId: row.userId ?? undefined,
        clientId: row.clientId,
      };
    }

    // ---- 3. 客户端注册行 FOR SHARE（锁序：auth_requests → oauth_clients）----
    const clientRows = await tx
      .select({
        redirectUris: mcpOauthClients.redirectUris,
        grantTypes: mcpOauthClients.grantTypes,
        metadataCacheExpiresAt: mcpOauthClients.metadataCacheExpiresAt,
      })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, row.clientId))
      .for("share")
      .limit(1);
    const client = clientRows[0];

    // ---- 4. 四条件（全部基于锁内读到的当前值）----
    const condition = evaluateMetadataConditions(
      client
        ? {
            redirectUris: client.redirectUris,
            grantTypes: client.grantTypes,
            metadataCacheExpiresAt: client.metadataCacheExpiresAt,
          }
        : null,
      row.redirectUri,
    );

    // ---- 5. metadata invalid：删行 + 审计，同一事务正常提交 → 路由 400 ----
    if (condition !== null) {
      await tx.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, input.rid));
      await recordAuthEvent(tx, {
        eventType: "mcp_consent_metadata_invalid",
        ...(row.userId === null ? {} : { userId: row.userId }),
        detail: {
          rid: input.rid,
          clientId: row.clientId,
          stage: "consent_submit",
          condition,
        },
      });
      return {
        kind: "rejected",
        reason: "metadata_invalid",
        userId: row.userId ?? undefined,
        clientId: row.clientId,
      };
    }

    // ---- 6. 四条件通过：删行（防御性条件仍在），redirect/state 取锁内行 ----
    const userId = row.userId as string;
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
    if (deleted.length !== 1) {
      // 持锁下不该发生（读与删之间没人能改这一行）；真发生就 fail-closed。
      return {
        kind: "rejected",
        reason: "not_found",
        userId,
        clientId: row.clientId,
      };
    }
    return {
      kind: "denied",
      result: {
        kind: "denied",
        redirectUri: row.redirectUri,
        state: row.state,
        userId,
        clientId: row.clientId,
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
      const failure = evaluateConsentRow(row, input);
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

      /**
       * 四条件实时复核（设计 §8.3 检查点 2）：`mcp_oauth_clients` **`FOR SHARE`**。
       *
       * 为什么必须加锁：READ COMMITTED 的普通 SELECT 只看语句开始时的快照，
       * 刷新事务可以在「我们查完」与「我们插码」之间提交，码就会按旧集合签发。
       * `FOR SHARE` 与刷新的 `UPDATE` 冲突，把这段窗口关掉；`FOR SHARE` 而不是
       * `FOR UPDATE`，是为了让**同一 client 的多个用户并发同意互不阻塞**
       * （S7/P6），只与刷新串行。
       *
       * 锁顺序：`auth_requests(U) → oauth_clients(S) → grants(UPSERT) → auth_codes(I)`。
       */
      const clientRows = await tx
        .select({
          clientName: mcpOauthClients.clientName,
          redirectUris: mcpOauthClients.redirectUris,
          grantTypes: mcpOauthClients.grantTypes,
          metadataCacheExpiresAt: mcpOauthClients.metadataCacheExpiresAt,
        })
        .from(mcpOauthClients)
        .where(eq(mcpOauthClients.clientId, row.clientId))
        .for("share")
        .limit(1);
      const client = clientRows[0];
      const condition = evaluateMetadataConditions(
        client
          ? {
              redirectUris: client.redirectUris,
              grantTypes: client.grantTypes,
              metadataCacheExpiresAt: client.metadataCacheExpiresAt,
            }
          : null,
        row.redirectUri,
      );
      if (condition !== null) {
        /**
         * 有意的拒绝分支：**只删行 + 写审计，然后正常 `return`（提交事务）**。
         *
         * 绝不 throw——抛错会把删除与审计一起回滚（§8.5 边界二）：授权请求
         * 永远留在表里，用户每次重试都撞同一堵墙，审计里也查不到它为什么被拒。
         * Grant upsert、授权码、Session 在这里**都还没有发生**，因此本分支天然
         * 零副作用（不创建 / 不恢复任何授权，不 302）。
         */
        await tx.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, input.rid));
        await recordAuthEvent(tx, {
          eventType: "mcp_consent_metadata_invalid",
          ...(row.userId === null ? {} : { userId: row.userId }),
          detail: {
            rid: input.rid,
            clientId: row.clientId,
            stage: "consent_submit",
            condition,
          },
        });
        return {
          kind: "rejected",
          reason: "metadata_invalid",
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

      // 客户端名来自上面那次 `FOR SHARE` 读（同一把锁内，不再另开一次普通读）。
      const clientName = client?.clientName ?? row.clientId;

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

  /**
   * 拒绝路径（显式 `deny`，或「允许但一个都没勾」）——**与 allow 同一锁序的
   * 事务**（C3c-3B-3-R1）。
   *
   * 入口处按快照做的四条件预检已**移入事务**：判定与删除必须在
   * `auth_requests FOR UPDATE → oauth_clients FOR SHARE` 保护下完成，否则刷新
   * 可以在「检查之后、删除/重定向之前」改写注册行，拒绝仍会把响应 302 到已移出
   * 注册集合的回调（独立审核 P2）。空 scope 沿用显式 deny 的同一处理逻辑。
   */
  if (input.decision === "deny" || input.scopes.length === 0) {
    return denyConsentInTransaction(db, input);
  }

  return allowConsent(db, {
    rid: input.rid,
    csrf: input.csrf,
    rawScopes: input.scopes,
    bindingHash: input.bindingHash,
    now: input.now,
  });
}
