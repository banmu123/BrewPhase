import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpAuthRequests, mcpOauthClients } from "../db/schema.js";
import { constantTimeEqual, randomToken, sha256Hex } from "../security/crypto.js";
import { invalidRequest } from "../security/errors.js";
import { mcpResourceFor, MCP_SCOPES, parseScopeClaim } from "./constants.js";

/**
 * MCP 授权请求的**业务层**（Phase 1.3.1-C2a：authorize / login / callback）。
 *
 * 这一层不碰 Hono、不碰 Cookie、不发日志——它只负责「校验参数 → 建行」、
 * 「原子绑定浏览器」、「原子占用 Provider 流程」、「原子消费回调」。
 * 路由层负责协议与响应，两层分开才能让并发测试只针对这一层。
 *
 * ## 三个必须原子化的动作
 *
 * | 动作 | 为什么不能「先查后写」 |
 * |---|---|
 * | TOFU 绑定 | 两个浏览器同时进同一个 `rid`，各自读到 NULL 都会写成功 |
 * | 占用 Provider 流程 | 同一 `rid` 被同时切到两个 Provider，回调时不知道信哪个 |
 * | 消费 Provider State | 同一回调被重放两次，会重复创建授权结果 |
 *
 * 三处都用**条件 UPDATE**（WHERE 里带上「尚未发生」的判据）作为唯一判据，
 * 并且都**不在 Provider 网络请求期间持有事务**——网络请求在消费之后进行。
 */

/** 授权请求的有效期：10 分钟（比 Desktop 的 5 分钟长，因为多了一次登录）。 */
export const MCP_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

/** `state` 的长度上限。OAuth 的 state 是客户端的小片状态，没有一个正常的
 * 客户端会发超过几百字节；不设上限等于允许用它撑大数据库行。 */
const MAX_STATE_LENGTH = 512;

/** PKCE S256 的 challenge 恒为 43 字符 base64url（32 字节 SHA-256 的编码）。 */
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAuthRequestId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Provider State / Nonce 的哈希。
 *
 * **不加域分隔**，与 Google 适配器的契约严格对齐：适配器验证 ID Token 时算的是
 * `sha256Hex(idToken.nonce)`，如果这里加了前缀，Google 的 nonce 校验会永远失败
 * ——而且表现为「登录总是失败」，很难定位到是哈希域的问题。
 *
 * 不加域分隔不会削弱安全性：输入是 32 字节密码学随机值，不存在暴力破解空间，
 * 域分隔在这里唯一的作用是「防止同一密钥下的跨用途碰撞」，而这里根本不涉及密钥。
 */
export function hashProviderSecret(value: string): string {
  return sha256Hex(value);
}

/** CSRF 哈希（域分隔）。明文只在 C2b 渲染的 HTML 里出现。 */
export function hashCsrf(csrf: string): string {
  return sha256Hex(`mcp-csrf:${csrf}`);
}

/**
 * 授权码哈希：`sha256("mcp-code:" ‖ code)`。
 *
 * 与 CSRF / Provider State 一样**只落哈希**：授权码是兑换 token 的唯一凭据，
 * 明文只在签发那一次的 302 `Location` 里出现。
 *
 * 放在这里（而不是签发它的 consent-flow）是因为兑换侧也要用它——两个方向
 * 共用同一个域分隔常量，才不会出现「签的时候带前缀、查的时候忘带」。
 */
export function mcpAuthCodeHash(code: string): string {
  return sha256Hex(`mcp-code:${code}`);
}

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

export interface AuthorizeParams {
  responseType: string | undefined;
  clientId: string | undefined;
  redirectUri: string | undefined;
  scope: string | undefined;
  state: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  resource: string | undefined;
}

export interface ValidatedAuthorize {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string[];
  resource: string;
  state: string | null;
  codeChallenge: string;
}

/**
 * 逐个参数校验。**任何一项不过就拒绝，绝不「尽量理解」**：
 * `redirect_uri` 一旦被放宽（前缀、通配、端口浮动），授权码就可能被投递到
 * 攻击者的回调地址——那是 OAuth 最经典的失陷方式。
 */
export async function validateAuthorizeParams(
  db: Database,
  options: { baseUrl: string },
  params: AuthorizeParams,
): Promise<ValidatedAuthorize> {
  if (params.responseType !== "code") {
    throw invalidRequest("response_type must be code");
  }

  const clientId = params.clientId;
  // **不再按 512 预先拒绝**（设计 §3.1）：长度硬上限（2048）与「查库优先」
  // 由 `resolveClientForAuthorize` 承担——先按原始字符串查库，命中就用；
  // 在这里按 512 拒绝会让「查库命中才说明是我们自己建的」这半条顺序修正失效。
  // 512 仍是**创建**预注册客户端时的约束。
  if (!clientId || clientId.length === 0) {
    throw invalidRequest("client_id is required");
  }

  const clientRows = await db
    .select({
      clientId: mcpOauthClients.clientId,
      clientName: mcpOauthClients.clientName,
      redirectUris: mcpOauthClients.redirectUris,
      grantTypes: mcpOauthClients.grantTypes,
    })
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, clientId))
    .limit(1);
  const client = clientRows[0];
  // 「未注册的客户端」与「参数写错」返回同一个 400：区分它们等于给出
  // 「这个 client_id 存在吗」的探针。
  if (!client) throw invalidRequest("client is not registered");

  if (!client.grantTypes.includes("authorization_code")) {
    throw invalidRequest("client is not allowed to use the authorization code grant");
  }

  const redirectUri = params.redirectUri;
  if (!redirectUri) throw invalidRequest("redirect_uri is required");
  // **逐字符相等**：不做前缀比较、不做 URL 规范化比较。
  // `https://a.example/cb` 与 `https://a.example/cb/` 是两个不同的回调。
  if (!client.redirectUris.some((registered) => registered === redirectUri)) {
    throw invalidRequest("redirect_uri does not match a registered value");
  }

  const scope = params.scope ? parseScopeClaim(params.scope) : null;
  if (!scope) {
    // 空 scope、含未知 scope、含非 MCP_SCOPES 值，全部收敛到这里。
    throw invalidRequest(`scope must be a non-empty subset of: ${MCP_SCOPES.join(" ")}`);
  }

  if (params.codeChallengeMethod !== "S256") {
    // `plain` 等于没有 PKCE：verifier 会随 code 一起在链路里出现。
    throw invalidRequest("code_challenge_method must be S256");
  }
  const codeChallenge = params.codeChallenge;
  if (!codeChallenge || !PKCE_CHALLENGE_PATTERN.test(codeChallenge)) {
    throw invalidRequest("code_challenge must be 43 characters of base64url");
  }

  const expectedResource = mcpResourceFor(options.baseUrl);
  if (params.resource !== expectedResource) {
    throw invalidRequest("resource does not match this MCP server");
  }

  if (params.state !== undefined && params.state.length > MAX_STATE_LENGTH) {
    throw invalidRequest("state is too long");
  }

  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    scope,
    resource: expectedResource,
    // 缺省与空串都归一成 NULL：`''` 会让「客户端没发 state」与「发了空 state」
    // 在后续回传时表现不同。
    state: params.state && params.state.length > 0 ? params.state : null,
    codeChallenge,
  };
}

export interface CreatedAuthorizeRequest {
  rid: string;
  redirectUri: string;
  state: string | null;
}

/**
 * 建授权请求行。
 *
 * `csrf_hash` 是 NOT NULL，但 C2a 还没有 Consent 页面，所以这里写入一个
 * **一次性丢弃明文的随机值**：它能满足约束，且**永远不可能匹配任何提交**
 * （明文在生成后立即丢弃）。C2b 渲染同意页时必须重新生成 CSRF 并覆盖这一列。
 *
 * 这是刻意的 fail-closed：即使有人在 C2b 之前手工 POST 一个同意请求，
 * 也没有任何 CSRF 值能通过校验。
 */
export async function createAuthorizeRequest(
  db: Database,
  input: ValidatedAuthorize & { now: Date },
): Promise<CreatedAuthorizeRequest> {
  const csrfHash = hashCsrf(randomToken(32));
  const rows = await db
    .insert(mcpAuthRequests)
    .values({
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      resource: input.resource,
      state: input.state,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      csrfHash,
      // 三处「尚未发生」显式写 NULL（而不是依赖列默认值），
      // 因为它们的 NULL 语义是契约的一部分。
      browserBindingHash: null,
      userId: null,
      provider: null,
      providerStateHash: null,
      nonceHash: "",
      providerConsumedAt: null,
      expiresAt: new Date(input.now.getTime() + MCP_AUTH_REQUEST_TTL_MS),
    })
    .returning({
      id: mcpAuthRequests.id,
      redirectUri: mcpAuthRequests.redirectUri,
      state: mcpAuthRequests.state,
    });
  const row = rows[0];
  if (!row) throw new Error("failed to create mcp auth request");
  return { rid: row.id, redirectUri: row.redirectUri, state: row.state };
}

// ---------------------------------------------------------------------------
// 读取与 TOFU 绑定
// ---------------------------------------------------------------------------

export interface AuthRequestRow {
  id: string;
  clientId: string;
  /**
   * 客户端的显示名。
   *
   * 登录页与同意页都要展示「哪个应用在申请授权」——这是规范对同意页的
   * 硬要求（用户必须能看见发起方）。名字来自 `mcp_oauth_clients`，用
   * LEFT JOIN 取：注册行被清理时仍要能渲染（退化成 client_id）。
   */
  clientName: string;
  redirectUri: string;
  scope: string[];
  resource: string;
  state: string | null;
  provider: string | null;
  browserBindingHash: string | null;
  userId: string | null;
  providerConsumedAt: Date | null;
  expiresAt: Date;
}

export async function loadAuthRequest(
  db: Database,
  rid: string,
): Promise<AuthRequestRow | undefined> {
  const rows = await db
    .select({
      id: mcpAuthRequests.id,
      clientId: mcpAuthRequests.clientId,
      clientName: mcpOauthClients.clientName,
      redirectUri: mcpAuthRequests.redirectUri,
      scope: mcpAuthRequests.scope,
      resource: mcpAuthRequests.resource,
      state: mcpAuthRequests.state,
      provider: mcpAuthRequests.provider,
      browserBindingHash: mcpAuthRequests.browserBindingHash,
      userId: mcpAuthRequests.userId,
      providerConsumedAt: mcpAuthRequests.providerConsumedAt,
      expiresAt: mcpAuthRequests.expiresAt,
    })
    .from(mcpAuthRequests)
    // LEFT JOIN：注册行被清理时仍然能读（名字退化为空，由调用方保底）。
    .leftJoin(mcpOauthClients, eq(mcpAuthRequests.clientId, mcpOauthClients.clientId))
    .where(eq(mcpAuthRequests.id, rid))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  // `client_name` 是 NOT NULL 列，但 LEFT JOIN 后类型上可能是 null。
  return { ...row, clientName: row.clientName ?? row.clientId };
}

export async function deleteAuthRequest(db: Database, rid: string): Promise<void> {
  await db.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, rid));
}

export interface DeniedProviderRequest {
  rid: string;
  redirectUri: string;
  state: string | null;
}

/**
 * Provider 侧拒绝后**一次性**取回可回跳的地址（顺便删行）。
 *
 * ## 为什么 DELETE 必须带上当时读到的那把 State（Phase 1.3.1-C2b 修复）
 *
 * 同一 `rid` 允许重新发起 Provider 流程（用户点了两次「用 Google 登录」），
 * 每次都会换一把新的 `provider_state_hash`。如果拒绝回调只按 `id` 删行，
 * 下面这条真实路径会删掉**新**那次授权：
 *
 * ```
 * 用户在 Google 页面点「拒绝」（旧 State S1）      ← 请求 A 还在路上
 * 用户回到登录页重新点「用 Google 登录」→ 写入 S2   ← 行被换成新的
 * 请求 A 抵达：SELECT 命中的是 S2 那一行（按 id 删）→ S2 被删
 * ```
 *
 * 因此 DELETE 的条件必须包含 `provider_state_hash = hash(S1)`：S1 已经不是
 * 当前那把，删除命中 0 行，回调得到 400 而不是把新流程一起带走。
 *
 * 其余条件同样是判据的一部分：`provider`（不是另一个 Provider 的流程）、
 * `browser_binding_hash`（不是另一个浏览器）、`provider_consumed_at IS NULL`
 * （没被当成正常回调消费过）、`expires_at > now`（过期行不再产生重定向）。
 *
 * 返回 `undefined` = 这一行已经不是「那个被拒绝的授权」了，**不得重定向**。
 */
export async function deleteDeniedProviderRequest(
  db: Database,
  input: {
    rid: string;
    provider: "google" | "github";
    stateHash: string;
    bindingHash: string;
    now: Date;
  },
): Promise<DeniedProviderRequest | undefined> {
  const deleted = await db
    .delete(mcpAuthRequests)
    .where(
      and(
        eq(mcpAuthRequests.id, input.rid),
        eq(mcpAuthRequests.providerStateHash, input.stateHash),
        eq(mcpAuthRequests.provider, input.provider),
        eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
        isNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
      ),
    )
    .returning({
      id: mcpAuthRequests.id,
      redirectUri: mcpAuthRequests.redirectUri,
      state: mcpAuthRequests.state,
    });
  const hit = deleted[0];
  if (!hit) return undefined;
  return { rid: hit.id, redirectUri: hit.redirectUri, state: hit.state };
}

export interface MismatchedProviderRequest {
  rid: string;
  provider: "google" | "github";
  /** 最初 SELECT 读到的那把 State 的哈希（不是重新计算的）。 */
  stateHash: string;
  /** 最初 SELECT 读到的**行内**绑定哈希（可能为 NULL）。 */
  storedBindingHash: string | null;
  now: Date;
}

/**
 * 清理一次「绑定不匹配」的 Provider 授权请求（Phase 1.3.1-C2b-R1）。
 *
 * ## 为什么不能只按 rid 删
 *
 * 同一个 `rid` 允许在同一 Provider 下重新发起登录（换一把新的
 * `provider_state_hash`，见 `claimProvider`）。于是存在这条真实交错：
 *
 * ```
 * 请求 A：旧 State S1 的回调
 *   ├─ SELECT 成功，读到 S1 对应的行
 *   │        ← 用户重新点了「用 Google 登录」，同一 rid 换成 S2
 *   └─ 判定绑定不匹配 → DELETE WHERE id = rid
 *        └─ 删掉的是 S2 那一行（新流程被旧回调带走）
 * ```
 *
 * 条件是「那一行仍然是我刚才读到的行」，逐项对应：
 *
 * | 条件 | 防什么 |
 * |---|---|
 * | `id` | 别的授权请求 |
 * | `provider_state_hash` | 同一 rid 被重新发起（旧 State 的清理不能碰新 State） |
 * | `provider` | 同一 rid 被切到另一个 Provider |
 * | `browser_binding_hash`（**行内值**） | 换浏览器重新绑定（预期值绝不能取请求携带的那个） |
 * | `provider_consumed_at IS NULL` | 已被正常回调消费 |
 * | `expires_at > now` | 已过期 |
 *
 * 命中 0 行 = 状态已经变了，**什么都不做**：不删、不审计、不重定向。
 * 返回 `true` 表示确实删掉了「当时读到的那一行」。
 */
export async function deleteMismatchedProviderRequest(
  db: Database,
  input: MismatchedProviderRequest,
): Promise<boolean> {
  const deleted = await db
    .delete(mcpAuthRequests)
    .where(
      and(
        eq(mcpAuthRequests.id, input.rid),
        eq(mcpAuthRequests.providerStateHash, input.stateHash),
        eq(mcpAuthRequests.provider, input.provider),
        // `browser_binding_hash` 可为 NULL。Drizzle 里用两个分支表达
        // `IS NOT DISTINCT FROM`：NULL 匹配 NULL，非 NULL 用等值。
        input.storedBindingHash === null
          ? isNull(mcpAuthRequests.browserBindingHash)
          : eq(mcpAuthRequests.browserBindingHash, input.storedBindingHash),
        isNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
      ),
    )
    .returning({ id: mcpAuthRequests.id });
  return deleted.length === 1;
}

export type BindOutcome =
  | { ok: true; alreadyBound: boolean }
  | { ok: false; reason: "not_found" | "expired" | "consumed" | "binding_mismatch" };

/**
 * TOFU（首次使用即绑定）。
 *
 * 先做一次**条件 UPDATE**（只有 `browser_binding_hash IS NULL` 时才写）。
 * 写成功 = 我们抢到了首次绑定；写不进去时再读一次判断原因。
 *
 * 这比「先 SELECT 再 UPDATE」强的地方在于：两个浏览器同时冲进来时，
 * 恰好一个的 UPDATE 命中、另一个命中 0 行——而不可能两个都读到 NULL
 * 然后都写成功（后者会让「绑定」这个断言彻底失去意义）。
 */
export async function bindBrowser(
  db: Database,
  rid: string,
  bindingHash: string,
  now: Date,
): Promise<BindOutcome> {
  const bound = await db
    .update(mcpAuthRequests)
    .set({ browserBindingHash: bindingHash })
    .where(
      and(
        eq(mcpAuthRequests.id, rid),
        isNull(mcpAuthRequests.browserBindingHash),
        isNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, now),
      ),
    )
    .returning({ id: mcpAuthRequests.id });
  if (bound.length > 0) return { ok: true, alreadyBound: false };

  const row = await loadAuthRequest(db, rid);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.providerConsumedAt !== null) return { ok: false, reason: "consumed" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  // 并发下可能是「同一个浏览器刚好绑上了」，也可能是「别的浏览器已经绑上了」。
  // 两者用哈希区分：相等就是自己的，不相等才是劫持嫌疑。
  if (row.browserBindingHash && constantTimeEqual(row.browserBindingHash, bindingHash)) {
    return { ok: true, alreadyBound: true };
  }
  return { ok: false, reason: "binding_mismatch" };
}

// ---------------------------------------------------------------------------
// 占用 Provider 流程
// ---------------------------------------------------------------------------

export interface ProviderClaim {
  providerState: string;
  nonce: string | undefined;
}

export type ClaimOutcome =
  | { ok: true; redirectUri: string; state: string | null; claim: ProviderClaim }
  | {
      ok: false;
      reason: "not_found" | "expired" | "consumed" | "binding_mismatch" | "provider_conflict";
    };

/**
 * 为一个 `rid` 启动（或重启）某个 Provider 的授权流程。
 *
 * 生成的 `PR`（Provider State）与 Google `nonce` 都是 32 字节随机值，
 * 库里只落哈希；明文只出现在 Provider 的授权 URL 里。
 *
 * 条件 UPDATE 同时排除四种情况：过期、已消费、绑定不是这个浏览器、
 * 已经被**另一个** Provider 占用。同一 Provider 重复点击（用户点两次
 * 「用 Google 登录」）是允许的——它会换一把新的 PR，旧的立刻失效。
 */
export async function claimProvider(
  db: Database,
  input: {
    rid: string;
    provider: "google" | "github";
    bindingHash: string;
    now: Date;
  },
): Promise<ClaimOutcome> {
  const providerState = randomToken(32);
  // Google OIDC 需要 nonce；GitHub 没有 ID Token，给它 nonce 没有意义，
  // 所以 nonce_hash 写空串（与 Desktop 流程的约定一致）。
  const nonce = input.provider === "google" ? randomToken(32) : undefined;

  const updated = await db
    .update(mcpAuthRequests)
    .set({
      provider: input.provider,
      providerStateHash: hashProviderSecret(providerState),
      nonceHash: nonce === undefined ? "" : hashProviderSecret(nonce),
    })
    .where(
      and(
        eq(mcpAuthRequests.id, input.rid),
        eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
        isNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
        // 未占用，或已被**同一个** provider 占用（允许重新发起）。
        or(isNull(mcpAuthRequests.provider), eq(mcpAuthRequests.provider, input.provider)),
      ),
    )
    .returning({
      redirectUri: mcpAuthRequests.redirectUri,
      state: mcpAuthRequests.state,
    });

  const row = updated[0];
  if (row) {
    return { ok: true, redirectUri: row.redirectUri, state: row.state, claim: { providerState, nonce } };
  }

  const existing = await loadAuthRequest(db, input.rid);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.providerConsumedAt !== null) return { ok: false, reason: "consumed" };
  if (existing.expiresAt.getTime() <= input.now.getTime()) return { ok: false, reason: "expired" };
  if (existing.browserBindingHash !== input.bindingHash) {
    return { ok: false, reason: "binding_mismatch" };
  }
  return { ok: false, reason: "provider_conflict" };
}

// ---------------------------------------------------------------------------
// Provider 回调
// ---------------------------------------------------------------------------

export interface ConsumedCallback {
  rid: string;
  redirectUri: string;
  state: string | null;
  nonceHash: string;
}

export type ConsumeOutcome =
  | { ok: true; request: ConsumedCallback }
  /**
   * 绑定不匹配：**除了 rid，还要把「刚才读到的那一行」的身份带出去**。
   *
   * 只给 `rid` 是不够的——调用方随后的清理如果只按 id 删，就会在「同一 rid
   * 已被重新发起一个新 State」时删掉新流程（见 `deleteMismatchedProviderRequest`）。
   * 这四个字段就是那条条件 DELETE 的全部预期值。
   */
  | {
      ok: false;
      reason: "binding_mismatch";
      rid: string;
      provider: "google" | "github";
      /** 本次回调携带的 state 的哈希（= 行内当时的那把）。 */
      stateHash: string;
      /** 行内读到的绑定哈希。可能为 NULL（从未绑定）。 */
      storedBindingHash: string | null;
    }
  | { ok: false; reason: "unknown_state" | "provider_mismatch" | "consumed" }
  | { ok: false; reason: "expired"; rid: string };

/**
 * 原子消费 Provider State。
 *
 * 顺序是刻意的：
 * 1. 先按哈希**读**一次，用于区分五种失败（都需要不同的处理与审计）；
 * 2. 再发**条件 UPDATE**（`provider_consumed_at IS NULL` 是 WHERE 的一部分）。
 *
 * 第 1 步的读不是判据——判据只有第 2 步的 UPDATE 命中与否。因此两个并发回调
 * 里恰好一个能进入网络交换，另一个拿到 `consumed`。这满足了「不允许先普通
 * SELECT 检查，再在另一个事务中无条件 UPDATE」。
 *
 * ## 条件 UPDATE 的五个条件缺一不可（Phase 1.3.1-C2b 补强）
 *
 * ```
 * provider_state_hash = hash(state)   ← 这一把 state 确实是当前那把
 * provider            = :provider     ← 不是拿 Google 的码兑 GitHub 的行
 * browser_binding_hash = :binding     ← 不是另一个浏览器
 * provider_consumed_at IS NULL        ← 没被消费过（并发只有一条赢）
 * expires_at > :now                   ← SELECT 与 UPDATE 之间不会「跑着跑着过期」
 * ```
 *
 * 后两个条件在 C2a 只写在 SELECT 里。那样会留下一个窄窗口：SELECT 读到「未
 * 过期、未消费」，随后同一行被另一个事务改掉（换 state / 过期），UPDATE 仍会
 * 命中并写 `provider_consumed_at`。把判据全部搬进 UPDATE 之后，唯一能写成功
 * 的就是「读到的那个状态仍然是当前状态」。
 *
 * **不在网络请求期间持有事务**：这里没有 `db.transaction`，消费是一次
 * 自动提交的 UPDATE，之后才去调 Provider。
 */
export async function consumeProviderCallback(
  db: Database,
  input: {
    provider: "google" | "github";
    state: string;
    bindingHash: string;
    now: Date;
  },
): Promise<ConsumeOutcome> {
  const stateHash = hashProviderSecret(input.state);

  const rows = await db
    .select({
      id: mcpAuthRequests.id,
      provider: mcpAuthRequests.provider,
      browserBindingHash: mcpAuthRequests.browserBindingHash,
      providerConsumedAt: mcpAuthRequests.providerConsumedAt,
      expiresAt: mcpAuthRequests.expiresAt,
    })
    .from(mcpAuthRequests)
    .where(eq(mcpAuthRequests.providerStateHash, stateHash))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown_state" };
  if (row.provider !== input.provider) {
    // 用 Google 的回调地址去兑一个 GitHub 流程的 state —— 不透露是哪一边错了。
    return { ok: false, reason: "provider_mismatch" };
  }
  if (row.providerConsumedAt !== null) return { ok: false, reason: "consumed" };
  if (row.expiresAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: "expired", rid: row.id };
  }
  if (!row.browserBindingHash || !constantTimeEqual(row.browserBindingHash, input.bindingHash)) {
    // 把「刚才读到的那一行」的完整身份返回给调用方。清理必须基于它做条件
    // 删除，而不是只凭 rid —— 同一个 rid 允许重新发起登录并换一把新 State。
    return {
      ok: false,
      reason: "binding_mismatch",
      rid: row.id,
      provider: input.provider,
      stateHash,
      storedBindingHash: row.browserBindingHash,
    };
  }

  const consumed = await db
    .update(mcpAuthRequests)
    .set({ providerConsumedAt: input.now })
    .where(
      and(
        eq(mcpAuthRequests.providerStateHash, stateHash),
        eq(mcpAuthRequests.provider, input.provider),
        eq(mcpAuthRequests.browserBindingHash, input.bindingHash),
        isNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
      ),
    )
    .returning({
      id: mcpAuthRequests.id,
      redirectUri: mcpAuthRequests.redirectUri,
      state: mcpAuthRequests.state,
      nonceHash: mcpAuthRequests.nonceHash,
    });

  const hit = consumed[0];
  // 没命中就 fail-closed：这一行在读与写之间被别人改过（换 state、消费、
  // 过期或换浏览器），任何一条都足以说明「这次回调不该继续」。
  if (!hit) return { ok: false, reason: "consumed" };
  return {
    ok: true,
    request: {
      rid: hit.id,
      redirectUri: hit.redirectUri,
      state: hit.state,
      nonceHash: hit.nonceHash,
    },
  };
}

/**
 * 把用户写到授权请求上（callback 成功之后）。
 *
 * 要求 `user_id IS NULL`：这一行只允许被写入一次身份。若已经写过，
 * 说明有人试图把同一个 `rid` 换成另一个用户——那不是正常流程。
 */
export async function attachUser(
  db: Database,
  rid: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(mcpAuthRequests)
    .set({ userId })
    .where(and(eq(mcpAuthRequests.id, rid), isNull(mcpAuthRequests.userId)))
    .returning({ id: mcpAuthRequests.id });
  return rows.length > 0;
}
