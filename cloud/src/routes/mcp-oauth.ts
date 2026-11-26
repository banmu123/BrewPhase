import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { eq } from "drizzle-orm";
import type { AppContext, AppHono } from "../context.js";
import { recordAuthEvent, type AuthEventInput } from "../db/audit.js";
import { mcpAuthRequests } from "../db/schema.js";
import {
  invalidClient,
  invalidRequest,
  invalidScope,
  providerNotConfigured,
  respondError,
  serverError,
  unsupportedGrantType,
  unsupportedTokenType,
  AppError,
} from "../security/errors.js";
import { constantTimeEqual } from "../security/crypto.js";
import { formatScopeClaim, isMcpScope, mcpResourceFor } from "../mcp-oauth/constants.js";
import { exchangeAuthorizationCode, exchangeRefreshToken } from "../mcp-oauth/token-flow.js";
import { revokeToken } from "../mcp-oauth/revoke-flow.js";
import { sessionMetaFromRequest } from "./body.js";
import { rateLimit } from "../security/rate-limit.js";
import { isProviderName, type ProviderName } from "../oauth/providers.js";
import { findOrCreateUserWithIdentity } from "../users/user-service.js";
import {
  assertBrowserSessionKey,
  browserBindingHash,
  clearBrowserSessionCookie,
  createBrowserSession,
  readBrowserSessionCookie,
  setBrowserSessionCookie,
  type BrowserSessionOptions,
} from "../mcp-oauth/browser-session.js";
import {
  attachUser,
  bindBrowser,
  claimProvider,
  consumeProviderCallback,
  createAuthorizeRequest,
  deleteAuthRequest,
  deleteDeniedProviderRequest,
  deleteMismatchedProviderRequest,
  hashProviderSecret,
  isAuthRequestId,
  loadAuthRequest,
  validateAuthorizeParams,
} from "../mcp-oauth/authorize-flow.js";
import {
  decideConsent,
  issueConsentCsrf,
  loadConsentRequest,
  type ConsentFailure,
} from "../mcp-oauth/consent-flow.js";
import { clientIdentifierDisplay, renderConsentPage } from "../mcp-oauth/consent-page.js";
import { createCimdDeps, type CimdFetcherDeps } from "../mcp-oauth/cimd.js";
import {
  InMemoryNegativeCooldown,
  resolveClientForAuthorize,
  type CimdRegistryDeps,
  type RegistryFailure,
} from "../mcp-oauth/cimd-registry.js";
import { syncGrantToOnlineDevice } from "../mcp-oauth/grant-sync.js";
import {
  AUTH_PAGE_HEADERS,
  authPageHeaders,
  renderErrorPage,
  renderLoginPage,
} from "../mcp-oauth/login-page.js";
import {
  resolveAuthLocale,
  type AuthErrorKey,
  type AuthErrorParams,
  type AuthLocale,
} from "../mcp-oauth/auth-locale.js";

/** 本次请求的页面语种（只由 `Accept-Language` 决定）。 */
function localeOf(c: Context): AuthLocale {
  return resolveAuthLocale(c.req.header("accept-language"));
}

/**
 * MCP 浏览器授权路由（Phase 1.3.1-C2a：authorize / login / callback）。
 *
 * ## 与 Desktop 登录 OAuth 的关系：**只共享适配器，不共享任何状态**
 *
 * | 维度 | `/oauth/*`（Desktop 登录） | `/mcp/oauth/*`（本文件） |
 * |---|---|---|
 * | 事务表 | `oauth_transactions` | `mcp_auth_requests` |
 * | 授权码 | `oauth_codes` | （`mcp_auth_codes`，C2b/C3 才写） |
 * | `redirect_uri` | 只能 `http://127.0.0.1:<port>/callback` | 注册客户端的**精确**回调 |
 * | 浏览器状态 | 无 | 签名 Cookie（仅 `/mcp/oauth`） |
 * | 用户同意 | 无 | 必须有（C2b） |
 *
 * 两边唯一共用的东西是 Google/GitHub 适配器与 `findOrCreateUserWithIdentity()`。
 * **不调用** `handleProviderCallback()`：它会签发 Desktop 登录码并重定向到
 * 已限死的 127.0.0.1，与 MCP 的「任意注册回调」在语义上冲突。
 */

function htmlError(
  c: Context,
  status: number,
  key: AuthErrorKey | string,
  params: AuthErrorParams = {},
): Response {
  // 语种只由 `Accept-Language` 决定：错误页不能因为「用户点的是中文站点」
  // 就假设语言，也不能因为没带头就把中文用户推到英文页。
  const locale = resolveAuthLocale(c.req.header("accept-language"));
  return c.html(
    renderErrorPage(key, locale, params),
    status as ContentfulStatusCode,
    AUTH_PAGE_HEADERS,
  );
}

/**
 * Registry（`resolveClientForAuthorize`）失败 → **HTML 错误页**（设计 §5.5 /
 * 任务书 §5.3）。
 *
 * | status | 语义 |
 * |---|---|
 * | 400 | terminal（含 mismatch、身份冲突、形态不合格、行消失）→「无法验证该客户端」 |
 * | 503 | transient（含 STALE floor 内、**CAS 失败 fail-closed**）→ 可重试 |
 * | 500 | `database_error`（固定文案，不泄 SQL） |
 *
 * 三条纪律（§5.5 / §16.2）：
 * 1. **HTML、不重定向**——[ID §6.1 MUST NOT]；此刻没有可信的 `redirect_uri`。
 * 2. **不回显完整 `client_id`**：只放 `clientIdentifierDisplay()`（hostname 或
 *    ≤40 字符截断），且 `renderErrorPage` 会再 `escapeHtml` 一次。
 * 3. 只渲染本次失败的结论，不带 Registry 的 detail（可能含抓取细节）。
 */
function registryFailurePage(c: Context, clientId: string, failure: RegistryFailure): Response {
  // 只取安全展示形式（hostname 或 ≤40 字符截断），绝不回显完整 client_id。
  const label = clientIdentifierDisplay(clientId);
  if (failure.status === 503) {
    return htmlError(c, 503, "client_unavailable", { client: label });
  }
  if (failure.status === 500) {
    return htmlError(c, 500, "service_unavailable");
  }
  return htmlError(c, 400, "client_unverified", { client: label });
}

/**
 * 保证当前请求带着一个有效的浏览器会话。
 *
 * **已有时不重新签发**（不滑动续期，也不重写 cookie）：授权流程里
 * 「同一个浏览器」必须是稳定身份，每次重签会让多标签页互相覆盖。
 */
async function ensureBrowserSession(
  c: Context,
  options: BrowserSessionOptions,
): Promise<{ sid: string; reused: boolean }> {
  const existing = await readBrowserSessionCookie(c, options);
  if (existing.ok) return { sid: existing.session.sid, reused: true };

  const session = createBrowserSession(options);
  await setBrowserSessionCookie(c, session, options);
  return { sid: session.sid, reused: false };
}

function buildRedirectUri(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * 审计的**非阻断**包装。
 *
 * `recordAuthEvent` 失败会抛错。在授权/拒绝路径上，这个错发生在**事务已提交
 * 之后**——把它抛出去会让一次已经成立的授权变成 500，而客户端永远拿不到
 * `code`（数据库里却已经躺着一个有效的 grant 与授权码）。审计是记账，不是
 * 授权的前置条件，所以这里只记一条不含上下文的告警。
 */
async function audit(ctx: AppContext, input: AuthEventInput): Promise<void> {
  try {
    await recordAuthEvent(ctx.db.db, input);
  } catch {
    ctx.logger.warn("mcp_audit_failed", { eventType: input.eventType });
  }
}

/**
 * 取**恰好一个**查询参数。
 *
 * 重复参数（`?rid=a&rid=b`）在 OAuth 里没有合法语义，不同的解析层会各自
 * 挑一个（Hono 的 `query()` 取第一个，某些框架取最后一个），于是「校验的
 * 那一个」与「使用的那一个」可能不是同一个。这里直接判成无效。
 */
function singleQuery(c: Context, name: string): string | null {
  const values = c.req.queries(name);
  if (!values || values.length !== 1) return null;
  return values[0] ?? null;
}

/**
 * `ConsentFailure` → 错误键。
 *
 * 文案（中英）集中在 `auth-locale.ts` 的目录里，这里只做**原因 → 键**的映射：
 * 同一个原因在 GET 与 POST 两条路径上都要出同一张页，把字符串散在两处
 * 迟早会漂移（例如 GET 改了措辞、POST 忘了改）。
 *
 * `metadata_invalid` 的删行 + `mcp_consent_metadata_invalid` 审计已在业务层的
 * 事务里提交（§8.5 边界二），页面侧只负责渲染 400——**不重定向、不再删一次、
 * 不再审计一次**。
 */
const CONSENT_FAILURE_KEYS: Record<ConsentFailure, AuthErrorKey> = {
  not_found: "link_invalid",
  expired: "link_expired",
  not_authenticated: "not_authenticated",
  provider_not_consumed: "provider_not_consumed",
  binding_mismatch: "session_mismatch",
  unsupported_provider: "provider_unsupported_consent",
  metadata_invalid: "metadata_invalid",
};

/**
 * 同意表单的解析结果。
 *
 * ## 为什么不用 `c.req.parseBody()`
 *
 * `parseBody()` 对 urlencoded 是 `Object.fromEntries(new URLSearchParams(...))`：
 * 同名参数**后者覆盖前者**，于是 `rid=好&rid=坏` 在不同层会得到不同的值，
 * 而「校验的 rid」与「使用的 rid」可能不是同一个。这里用 `getAll()`，
 * 对安全关键字段要求「恰好一个」，其余按数组收。
 */
interface ConsentForm {
  rid: string;
  csrf: string;
  decision: string;
  scopes: string[];
}

const MAX_CONSENT_BODY_BYTES = 8 * 1024;
const MAX_CSRF_LENGTH = 256;

/**
 * 调 `decideConsent` 并在异常时收口成 `server_error`。
 *
 * **为什么不能让它原样抛给 `onError`**：drizzle 的错误 message 会带上整条 SQL
 * 与全部参数，其中包含 `code_hash`（授权码的等价物）与 CSRF 哈希。`onError`
 * 对非 `AppError` 会把 message 写进日志——那等于把凭据写进日志。
 * 换成固定文案的 `AppError` 之后，日志里只剩 `{code, status}`。
 */
async function decideConsentSafely(
  ctx: AppContext,
  input: Parameters<typeof decideConsent>[1],
): Promise<Awaited<ReturnType<typeof decideConsent>>> {
  try {
    return await decideConsent(ctx.db.db, input);
  } catch {
    throw serverError("consent transaction failed");
  }
}

async function parseConsentForm(c: Context): Promise<ConsentForm | null> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  // 只接受标准 urlencoded：multipart 会引入文件名/编码层，而这张表单
  // 只有几个纯文本字段，没有任何理由接受它。
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return null;

  const body = await c.req.text();
  // 表单只有 ~200 字节。上限存在的意义不是「省内存」，而是让「用一个巨大的
  // body 撑爆解析」变成 400 而不是一次昂贵的分配。
  if (body.length > MAX_CONSENT_BODY_BYTES) return null;

  const params = new URLSearchParams(body);
  const single = (name: string): string | null => {
    const all = params.getAll(name);
    return all.length === 1 ? (all[0] ?? null) : null;
  };

  const rid = single("rid");
  const csrf = single("csrf");
  const decision = single("decision");
  if (rid === null || csrf === null || decision === null) return null;
  if (csrf.length === 0 || csrf.length > MAX_CSRF_LENGTH) return null;

  return { rid, csrf, decision, scopes: params.getAll("scope") };
}

export function routeMcpOAuth(app: AppHono, ctx: AppContext): void {
  // 只有通过启用边界才会被调用（见 app.ts）。这里再断言一次，是为了让
  // 「绕过边界直接挂载」在启动时就炸掉，而不是每个请求 500。
  const key = assertBrowserSessionKey(ctx.env.mcpBrowserSessionKey);
  const browserOptions: BrowserSessionOptions = {
    key,
    // 生产必须 Secure。开发环境允许关闭：`http://localhost` 下带 Secure 的
    // Cookie 会被浏览器直接丢弃，本地联调表现为「点了登录又回到原点」。
    secure: ctx.env.isProduction,
  };

  const limiter = rateLimit({
    name: "mcp-oauth",
    max: ctx.env.rateLimit.maxAuthorize,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
    maxBuckets: ctx.env.rateLimit.maxBuckets,
  });

  /**
   * Token Endpoint 的**独立**限流桶（Phase 1.3.1-C3a）。
   *
   * 与浏览器授权流程分开：`/authorize`/`/login` 是「一个人点几下」，token 是
   * 「客户端按需刷新」，两者的正常频率差一个量级。共用一个桶会让一次浏览器
   * 授权的浏览行为把客户端的刷新额度吃掉。
   */
  const tokenLimiter = rateLimit({
    name: "mcp-token",
    max: ctx.env.rateLimit.maxToken,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
    maxBuckets: ctx.env.rateLimit.maxBuckets,
  });

  /**
   * Revocation 的独立限流桶（Phase 1.3.1-C3b）。
   *
   * 与 `mcp-token` 分开：撤销是「用户点了登出」，刷新是「客户端按节奏续期」，
   * 两者的正常频率与突发形态都不一样。共用桶会让一次登出把后续刷新挤掉。
   */
  const revokeLimiter = rateLimit({
    name: "mcp-revoke",
    max: ctx.env.rateLimit.maxToken,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
    maxBuckets: ctx.env.rateLimit.maxBuckets,
  });

  const now = (): Date => new Date();

  /**
   * CIMD Registry 依赖（Phase 1.3.1-C3c-3B-3，任务书 §5.2）。
   *
   * **共享状态只建一次**：`cooldown`（ABSENT / no-store 负面冷却）与
   * `singleflight`（省略 → `processWideSingleflight` 进程级默认）都是跨请求
   * 共享的进程内状态，**绝不能**每次 HTTP 请求 `new`（那会让冷却永远只覆盖
   * 一次请求）。每次 authorize 只重建**薄壳对象**并**按请求读取**
   * `ctx.cimdFetcher`（测试在建 app 之后注入可控抓取器；生产恒为
   * `createCimdDeps(proxy)` 的 DNS Pinning 实现，没有任何绕过路径）。
   */
  const registryCooldown = new InMemoryNegativeCooldown();
  let productionFetcher: CimdFetcherDeps | undefined;
  const makeRegistryDeps = (): CimdRegistryDeps => ({
    db: ctx.db.db,
    fetcher: ctx.cimdFetcher ?? (productionFetcher ??= createCimdDeps(ctx.env.outboundProxy)),
    baseUrl: ctx.env.baseUrl,
    mcpResource: mcpResourceFor(ctx.env.baseUrl),
    mcpTrustedPeerIdentifiers: ctx.env.mcpTrustedPeerIdentifiers,
    now,
    cooldown: registryCooldown,
    audit: (input) => audit(ctx, input),
  });

  // -------------------------------------------------------------------------
  // GET /mcp/oauth/authorize
  // -------------------------------------------------------------------------

  /**
   * 授权入口。顺序（任务书 §5.1，**不可调换**）：
   *
   * ```text
   * 0. 纯语法预检（response_type / client_id 非空）——无 DB、无网络
   * 1. Registry：长度上限 → 精确查库 → pre_registered/dcr（URL 形态才查身份
   *    冲突）→ cimd 四态 → 未注册 URL 才抓取（先查库、再判 URL 形态）
   * 2. validateAuthorizeParams（redirect_uri 逐字符 / scope / PKCE / resource）
   * 3. createAuthorizeRequest —— 只有 1 与 2 都成功才建行
   * ```
   *
   * Registry 失败 → **HTML 错误页**（`registryFailurePage`，400/503/500，
   * 不重定向、不回显完整 client_id）；参数失败维持既有 JSON `invalid_request`。
   * **绝不先建 auth request 再验证 CIMD**（§8.5 边界一）。
   */
  app.get("/mcp/oauth/authorize", limiter, async (c) => {
    // 步骤 0：纯语法预检。放在 Registry 之前是为了让「参数写错」的请求
    // 不触发一次真实抓取，也维持这类错误既有的 JSON 形态。
    if (c.req.query("response_type") !== "code") {
      throw invalidRequest("response_type must be code");
    }
    const clientIdParam = c.req.query("client_id");
    if (!clientIdParam || clientIdParam.length === 0) {
      throw invalidRequest("client_id is required");
    }

    // 步骤 1：Registry 确认客户端。
    const resolved = await resolveClientForAuthorize(clientIdParam, makeRegistryDeps());
    if (!resolved.ok) return registryFailurePage(c, clientIdParam, resolved.failure);

    const validated = await validateAuthorizeParams(
      ctx.db.db,
      { baseUrl: ctx.env.baseUrl },
      {
        responseType: c.req.query("response_type"),
        clientId: clientIdParam,
        redirectUri: c.req.query("redirect_uri"),
        scope: c.req.query("scope"),
        state: c.req.query("state"),
        codeChallenge: c.req.query("code_challenge"),
        codeChallengeMethod: c.req.query("code_challenge_method"),
        resource: c.req.query("resource"),
      },
    );

    const created = await createAuthorizeRequest(ctx.db.db, { ...validated, now: now() });

    // 这里**不写** browser_binding_hash：此刻可能还没有真实浏览器
    // （客户端可能是服务端去拉这个 URL，Set-Cookie 被丢弃）。绑定发生在
    // 用户真正打开登录页那一刻（TOFU）。
    const browser = await ensureBrowserSession(c, browserOptions);

    await audit(ctx, {
      eventType: "mcp_authorize_started",
      detail: {
        rid: created.rid,
        clientId: validated.clientId,
        scope: validated.scope,
        browserReused: browser.reused,
      },
    });

    return c.redirect(`/mcp/oauth/login?rid=${encodeURIComponent(created.rid)}`, 302);
  });

  // -------------------------------------------------------------------------
  // GET /mcp/oauth/login
  // -------------------------------------------------------------------------

  /**
   * 登录页与 Provider 跳转。
   *
   * 一个路由承担两件事，是因为它们共用同一组前置校验（rid 有效、未过期、
   * 浏览器绑定正确）。拆成两个路由会让那组校验出现两份实现，而两份实现
   * 迟早会漂移——漂移的那一份就是漏洞。
   */
  app.get("/mcp/oauth/login", limiter, async (c) => {
    const rid = singleQuery(c, "rid") ?? "";
    if (!isAuthRequestId(rid)) {
      return htmlError(c, 400, "link_malformed");
    }

    const currentTime = now();
    const existing = await loadAuthRequest(ctx.db.db, rid);
    if (!existing) return htmlError(c, 400, "link_invalid");
    if (existing.providerConsumedAt !== null) {
      // Provider 回调已经用掉这一次性状态，下一站是同意页。再走登录只会
      // 覆盖 `provider`/`nonce`，把已经成立的身份写丢。
      return htmlError(c, 400, "link_invalid");
    }
    if (existing.expiresAt.getTime() <= currentTime.getTime()) {
      await deleteAuthRequest(ctx.db.db, rid);
      return htmlError(c, 400, "link_expired");
    }

    /**
     * 浏览器会话：**缺失时可以新建，但只在「这一行还没绑过」时**。
     *
     * 为什么允许新建：客户端可能是在服务端去拉 `authorize`（拿到的
     * `Set-Cookie` 被丢弃），然后把登录地址交给真实浏览器。此时服务端那次
     * 请求会留下一个从未被任何浏览器持有的 Cookie，用户第一次打开 `/login`
     * 必然没有 Cookie——旧实现会在这里报「会话已失效」，合法流程被锁死。
     *
     * 为什么只在未绑定时允许：`browser_binding_hash` 非空意味着「这一行已经
     * 属于某个浏览器」。此时缺失 Cookie 只能说明「你不是那个浏览器」，
     * 新建一个再绑定等于让任何拿到 `rid` 的人接管授权。
     *
     * 注意 `bindBrowser` 仍然使用条件 UPDATE（`WHERE browser_binding_hash
     * IS NULL`），所以「两个浏览器同时首次进入」依然只有一个能绑上。
     */
    let sid: string;
    const cookie = await readBrowserSessionCookie(c, browserOptions);
    if (cookie.ok) {
      sid = cookie.session.sid;
    } else {
      if (existing.browserBindingHash !== null) {
        return htmlError(c, 400, "browser_expired");
      }
      const session = createBrowserSession(browserOptions);
      await setBrowserSessionCookie(c, session, browserOptions);
      sid = session.sid;
    }

    const binding = browserBindingHash(sid);
    const bound = await bindBrowser(ctx.db.db, rid, binding, currentTime);

    if (!bound.ok) {
      if (bound.reason === "binding_mismatch") {
        // 有劫持嫌疑：删行 + 审计。删行让「另一个浏览器」也无法继续，
        // 这是 fail-closed 的选择——宁可打断一次合法流程，也不放行一次可疑流程。
        await deleteAuthRequest(ctx.db.db, rid);
        await audit(ctx, {
          eventType: "mcp_browser_binding_mismatch",
          detail: { rid, stage: "login" },
        });
        return htmlError(c, 400, "session_mismatch");
      }
      if (bound.reason === "expired") {
        await deleteAuthRequest(ctx.db.db, rid);
        return htmlError(c, 400, "link_expired");
      }
      return htmlError(c, 400, "link_invalid");
    }

    const request = await loadAuthRequest(ctx.db.db, rid);
    if (!request) return htmlError(c, 400, "link_invalid");

    const providerParam = c.req.query("provider");
    if (providerParam === undefined || providerParam.length === 0) {
      // 只列出**真实可用**的 Provider：凭据没配置的那个不该出现在页面上，
      // 否则用户点了会拿到 400，看起来像服务坏了。
      const available = (["google", "github"] as const).filter(
        (name): name is ProviderName => ctx.providers[name] !== undefined,
      );
      return c.html(
        renderLoginPage({
          rid,
          clientName: request.clientName,
          availableProviders: available,
          locale: localeOf(c),
        }),
        200,
        AUTH_PAGE_HEADERS,
      );
    }

    if (!isProviderName(providerParam)) {
      return htmlError(c, 400, "provider_unsupported");
    }
    const adapter = ctx.providers[providerParam];
    if (!adapter) {
      // 走统一错误出口（provider_not_configured），与其他路由保持一致。
      throw providerNotConfigured(providerParam);
    }

    const claim = await claimProvider(ctx.db.db, {
      rid,
      provider: providerParam,
      bindingHash: binding,
      now: currentTime,
    });
    if (!claim.ok) {
      if (claim.reason === "binding_mismatch") {
        await deleteAuthRequest(ctx.db.db, rid);
        await audit(ctx, {
          eventType: "mcp_browser_binding_mismatch",
          detail: { rid, stage: "login_provider" },
        });
        return htmlError(c, 400, "session_mismatch");
      }
      if (claim.reason === "provider_conflict") {
        return htmlError(c, 400, "provider_conflict");
      }
      if (claim.reason === "expired") {
        await deleteAuthRequest(ctx.db.db, rid);
        return htmlError(c, 400, "link_expired");
      }
      return htmlError(c, 400, "link_invalid");
    }

    await audit(ctx, {
      eventType: "mcp_login_provider_started",
      detail: { rid, provider: providerParam, clientId: request.clientId },
    });

    const authorizeUrl = adapter.buildAuthorizeUrl({
      // **必须**是本文件自己的回调。用 Desktop 的 `/oauth/callback/:provider`
      // 会让 Provider 把码送回登录流程，而那边会签发 Desktop 授权码。
      cloudRedirectUri: `${ctx.env.baseUrl}/mcp/oauth/callback/${providerParam}`,
      combinedState: claim.claim.providerState,
      nonce: claim.claim.nonce,
    });
    return c.redirect(authorizeUrl, 302);
  });

  // -------------------------------------------------------------------------
  // GET /mcp/oauth/callback/:provider
  // -------------------------------------------------------------------------

  app.get("/mcp/oauth/callback/:provider", limiter, async (c) => {
    const providerParam = c.req.param("provider") ?? "";
    if (!isProviderName(providerParam)) {
      return htmlError(c, 400, "provider_unsupported");
    }
    const provider: ProviderName = providerParam;
    const adapter = ctx.providers[provider];
    if (!adapter) throw providerNotConfigured(provider);

    const cookie = await readBrowserSessionCookie(c, browserOptions);
    if (!cookie.ok) {
      return htmlError(c, 400, "browser_expired");
    }
    const binding = browserBindingHash(cookie.session.sid);

    const stateParam = c.req.query("state");
    const errorParam = c.req.query("error");

    // ---- 分支一：用户在 Provider 侧拒绝 ----
    if (errorParam !== undefined) {
      if (!stateParam) {
        return htmlError(c, 400, "auth_incomplete");
      }
      return await handleProviderDenied(c, {
        ctx,
        browserOptions,
        provider,
        providerError: errorParam,
        stateHash: hashProviderSecret(stateParam),
        binding,
        now: now(),
      });
    }

    // ---- 分支二：正常回调 ----
    const code = c.req.query("code");
    if (!code) {
      return htmlError(c, 400, "auth_no_code");
    }
    if (!stateParam) {
      return htmlError(c, 400, "auth_no_state");
    }

    const currentTime = now();
    const consumed = await consumeProviderCallback(ctx.db.db, {
      provider,
      state: stateParam,
      bindingHash: binding,
      now: currentTime,
    });

    if (!consumed.ok) {
      if (consumed.reason === "binding_mismatch") {
        /**
         * **条件删除**（C2b-R1）：预期值全部来自刚才那次 SELECT。
         *
         * 只按 `rid` 删会踩到这条交错：用户重新发起登录把同一 rid 换成 S2，
         * 旧 State 的失配回调随后抵达，把 S2 删掉。命中 0 行说明这一行已经
         * 不是「刚才读到的那个授权」了——此时不删、不审计、不重定向。
         */
        const removed = await deleteMismatchedProviderRequest(ctx.db.db, {
          rid: consumed.rid,
          provider,
          stateHash: consumed.stateHash,
          storedBindingHash: consumed.storedBindingHash,
          now: now(),
        });
        // 只有确实删掉了那一行，才把它记成一次「绑定不匹配」；否则留下的
        // 审计会指向一个已经被新流程取代的 rid，排障时会误导。
        if (removed) {
          await audit(ctx, {
            eventType: "mcp_browser_binding_mismatch",
            detail: { rid: consumed.rid, stage: "callback", provider },
          });
        }
        return htmlError(c, 400, "session_mismatch");
      }
      if (consumed.reason === "expired") {
        await deleteAuthRequest(ctx.db.db, consumed.rid);
        await audit(ctx, {
          eventType: "mcp_provider_callback_failed",
          detail: { rid: consumed.rid, provider, reason: "expired" },
        });
        return htmlError(c, 400, "link_expired");
      }
      // unknown_state / provider_mismatch / consumed：对外不透露是哪一种。
      await audit(ctx, {
        eventType: "mcp_provider_callback_failed",
        detail: { provider, reason: consumed.reason },
      });
      return htmlError(c, 400, "link_invalid");
    }

    const request = consumed.request;

    // ---- 交换身份（网络请求，**不在事务里**）----
    let identity;
    try {
      identity = await adapter.exchangeAndVerify({
        code,
        cloudRedirectUri: `${ctx.env.baseUrl}/mcp/oauth/callback/${provider}`,
        expectedNonceHash: request.nonceHash,
      });
    } catch (err) {
      // 交换失败：清理这一行（已被消费，无法重放），然后把「服务端/Provider
      // 故障」如实交回客户端。
      //
      // **不伪装成 access_denied**：那是「用户拒绝」的信号，会让客户端以为
      // 用户放弃了（并可能停止重试），而实际是服务端坏了。
      //
      // 也**不返回 Cloud 的 500 页面**：此时 `redirect_uri` 已经由 authorize
      // 阶段按注册值逐字符校验过，可信；把用户丢在一个 Cloud 的错误页上，
      // 客户端就永远等不到那次回调。用 `server_error` 回到客户端，让它按
      // OAuth 的错误语义决定是否重试。
      await deleteAuthRequest(ctx.db.db, request.rid);
      await audit(ctx, {
        eventType: "mcp_provider_callback_failed",
        detail: {
          rid: request.rid,
          provider,
          reason: "exchange_failed",
          // 只记错误码，不记 Provider 返回的任何内容。
          code: (err as AppError).code ?? "unknown",
        },
      });
      clearBrowserSessionCookie(c, browserOptions);
      return c.redirect(
        buildRedirectUri(request.redirectUri, {
          error: "server_error",
          state: request.state ?? undefined,
          iss: ctx.env.baseUrl,
        }),
        302,
      );
    }

    const resolved = await findOrCreateUserWithIdentity(ctx.db.db, {
      provider,
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    });

    if (resolved.user.status !== "active") {
      // 被暂停的账号不能进入同意页。删行：这次授权不该留任何可用状态。
      await deleteAuthRequest(ctx.db.db, request.rid);
      await audit(ctx, {
        eventType: "mcp_provider_callback_failed",
        detail: { rid: request.rid, provider, reason: "user_inactive", userId: resolved.user.id },
      });
      return htmlError(c, 403, "account_unavailable");
    }

    const attached = await attachUser(ctx.db.db, request.rid, resolved.user.id);
    if (!attached) {
      // 行在交换期间消失，或已被写入别的用户：fail-closed。
      await deleteAuthRequest(ctx.db.db, request.rid);
      return htmlError(c, 400, "link_invalid");
    }

    await audit(ctx, {
      eventType: "mcp_provider_callback_succeeded",
      userId: resolved.user.id,
      detail: { rid: request.rid, provider, created: resolved.created },
    });

    // **保留**授权请求行：同意页还要读它（client / scope / redirect_uri）。
    return c.redirect(`/mcp/oauth/consent?rid=${encodeURIComponent(request.rid)}`, 302);
  });

  // -------------------------------------------------------------------------
  // GET /mcp/oauth/consent
  // -------------------------------------------------------------------------

  /**
   * 同意页。
   *
   * 十条前置条件全部在 `loadConsentRequest` 里（行存在、未过期、Provider 回调
   * 已消费、`user_id` 已就位、provider 合法、Cookie 有效且绑定一致）。这里
   * 只负责「失败时给出哪个页面」与「成功时渲染什么」。
   *
   * **每次打开都换一把 CSRF**：旧表单里的值立刻失效，于是「把页面留十分钟
   * 再提交」和「两个标签页用旧的那个提交」都会 400，而不是绕过检查。
   */
  app.get("/mcp/oauth/consent", limiter, async (c) => {
    const rid = singleQuery(c, "rid") ?? "";
    if (!isAuthRequestId(rid)) {
      return htmlError(c, 400, "link_malformed");
    }

    const cookie = await readBrowserSessionCookie(c, browserOptions);
    if (!cookie.ok) {
      // 同意页**不允许**新建浏览器会话：绑定必须发生在登录那一步，
      // 否则「拿到 rid」就足以在任意浏览器里打开同意页。
      return htmlError(c, 400, "browser_expired");
    }
    const binding = browserBindingHash(cookie.session.sid);
    const currentTime = now();

    const loaded = await loadConsentRequest(ctx.db.db, {
      rid,
      bindingHash: binding,
      now: currentTime,
    });
    if (!loaded.ok) {
      return await consentFailurePage(c, ctx, rid, loaded.reason);
    }

    const csrf = await issueConsentCsrf(ctx.db.db, {
      rid,
      bindingHash: binding,
      userId: loaded.request.userId,
      now: currentTime,
    });
    if (!csrf) {
      // 这一行在「读」与「写 CSRF」之间被消费/删除/换了浏览器。fail-closed：
      // 渲染一张没有 CSRF 的同意页等于给出一个永远提交不了的陷阱。
      return htmlError(c, 400, "link_invalid");
    }

    /**
     * Step-up：已有 active grant 的 scope **全部**在本次请求里，且请求新增了
     * scope。只有这种情形才把已有项灰置——否则（例如上一次授了
     * `records+coffee`、这次只请求 `records`）它是一次正常的收窄授权，
     * 每一项都必须可选。
     */
    const grantedScopes = loaded.activeGrant?.scopes ?? [];
    const requested = new Set<string>(loaded.request.requestedScopes);
    const isStepUp =
      grantedScopes.length > 0 &&
      grantedScopes.every((scope) => requested.has(scope)) &&
      grantedScopes.length < requested.size;

    return c.html(
      renderConsentPage({
        rid,
        csrf,
        clientName: loaded.request.clientName,
        clientIdentifierHost: loaded.request.clientIdentifierHost,
        redirectHost: loaded.request.redirectHost,
        locale: localeOf(c),
        scopes: loaded.request.requestedScopes.map((scope) => ({
          scope,
          granted: isStepUp && grantedScopes.includes(scope),
        })),
      }),
      200,
      // 同意页的表单 POST 会 302 回**跨 Origin** 的回调地址；Chromium 把
      // `form-action 'self'` 也套用到那次重定向上，不放行就会 `ERR_ABORTED`
      // 把页面钉在原地（Allow / Deny 一起卡死）。放行的 Origin 来自
      // authorize 阶段已与预注册 redirect_uris 逐字符比对过的值。
      authPageHeaders({ formActionOrigin: loaded.request.redirectOrigin }),
    );
  });

  // -------------------------------------------------------------------------
  // POST /mcp/oauth/consent
  // -------------------------------------------------------------------------

  /**
   * 提交同意或拒绝。
   *
   * 所有判据都在 `decideConsent` 的事务里重新取一遍（Cookie 绑定、CSRF、
   * `user_id`、`provider_consumed_at`、有效期、请求 scope）。**不信任 GET
   * 时的任何结论**——GET 与 POST 之间可能有另一个标签页、另一台设备或
   * 一次过期的流逝。
   */
  app.post("/mcp/oauth/consent", limiter, async (c) => {
    const form = await parseConsentForm(c);
    if (!form) {
      return htmlError(c, 400, "form_invalid");
    }
    if (!isAuthRequestId(form.rid)) {
      return htmlError(c, 400, "link_malformed");
    }

    const cookie = await readBrowserSessionCookie(c, browserOptions);
    if (!cookie.ok) {
      return htmlError(c, 400, "browser_expired");
    }
    const binding = browserBindingHash(cookie.session.sid);
    const currentTime = now();

    const outcome = await decideConsentSafely(ctx, {
      rid: form.rid,
      csrf: form.csrf,
      decision: form.decision,
      scopes: form.scopes,
      bindingHash: binding,
      now: currentTime,
    });

    if (!outcome.ok) {
      return await consentSubmitFailure(c, ctx, form.rid, outcome.reason, {
        userId: outcome.userId,
        clientId: outcome.clientId,
      });
    }

    const result = outcome.result;

    // ---- 用户拒绝（含「取消全部勾选」）----
    if (result.kind === "denied") {
      await audit(ctx, {
        eventType: "mcp_consent_denied",
        userId: result.userId,
        detail: { rid: form.rid, clientId: result.clientId },
      });
      clearBrowserSessionCookie(c, browserOptions);
      return c.redirect(
        buildRedirectUri(result.redirectUri, {
          error: "access_denied",
          state: result.state ?? undefined,
          iss: ctx.env.baseUrl,
        }),
        302,
      );
    }

    // ---- 用户允许：授权码已经提交，之后只剩「记账」与「同步」----
    await audit(ctx, {
      eventType: "mcp_consent_allowed",
      userId: result.userId,
      detail: {
        rid: form.rid,
        clientId: result.clientId,
        grantId: result.grantId,
        scope: result.scopes,
        epoch: result.epoch,
      },
    });
    await audit(ctx, {
      eventType: "mcp_auth_code_issued",
      userId: result.userId,
      // **不记 code、不记 code_hash**：前者是凭据，后者是它的等价物。
      detail: { rid: form.rid, clientId: result.clientId, grantId: result.grantId },
    });

    /**
     * 在线 Grant 同步：**数据库已提交**，这一步失败不回滚。
     *
     * 设备离线时授权依然成立——下次握手时 `hello_ok` 会按数据库重建整张
     * 上下文表。同步失败只影响「现在能不能派发」，转发层自己会 fail-closed
     * （未 ack 的 ctx 不可路由）。
     */
    const sync = await syncGrantToOnlineDevice(ctx, {
      userId: result.userId,
      grantId: result.grantId,
      clientId: result.clientId,
      clientName: result.clientName,
      scopes: result.scopes,
      epoch: result.epoch,
    });
    if (sync.status === "failed") {
      ctx.logger.warn("mcp_grant_sync_failed", {
        grantId: result.grantId,
        deviceId: sync.deviceId?.slice(0, 8),
        reason: sync.reason,
      });
      await audit(ctx, {
        eventType: "mcp_grant_sync_failed",
        userId: result.userId,
        detail: {
          rid: form.rid,
          grantId: result.grantId,
          reason: sync.reason,
          deviceId: sync.deviceId,
        },
      });
    }

    clearBrowserSessionCookie(c, browserOptions);
    return c.redirect(
      buildRedirectUri(result.redirectUri, {
        code: result.code,
        state: result.state ?? undefined,
        iss: ctx.env.baseUrl,
      }),
      302,
    );
  });

  // -------------------------------------------------------------------------
  // POST /mcp/oauth/token
  // -------------------------------------------------------------------------

  /**
   * MCP Token Endpoint（Phase 1.3.1-C3a）。
   *
   * 只接受 `application/x-www-form-urlencoded`；不接受 JSON / multipart，
   * 也不使用任何 Cookie 作为认证（`bp_mcp_bs` 因为 Path 是 `/mcp/oauth`
   * 可能被浏览器带上，但这里**完全不读**它）。
   *
   * 错误一律走 `respondError`：它只序列化 `code` 与（非生产环境的）描述，
   * 不会带出 SQL、参数或任何凭据。
   */
  app.post("/mcp/oauth/token", tokenLimiter, async (c) => {
    // 成功与失败都 `no-store`：响应体里就是凭据。
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    try {
      return await issueTokens(c, ctx);
    } catch (err) {
      if (err instanceof AppError) {
        return respondError(c, err, ctx.env.isProduction);
      }
      /**
       * 非 AppError = 数据库/加密栈抛出的异常。
       *
       * **绝不能原样交给 `respondError` 或 `onError`**：drizzle 的 message
       * 会带上整条 SQL 与全部参数（授权码哈希、refresh token 哈希都在里面），
       * 非生产环境还会把它序列化进响应体。日志也只记一个固定事件。
       */
      ctx.logger.error("mcp_token_failed", {});
      return respondError(c, serverError("token issuance failed"), ctx.env.isProduction);
    }
  });

  // -------------------------------------------------------------------------
  // POST /mcp/oauth/revoke
  // -------------------------------------------------------------------------

  /**
   * Token Revocation（RFC 7009，Phase 1.3.1-C3b）。
   *
   * ## 为什么绝大多数失败也是 200
   *
   * RFC 7009 §2.2：**无效 Token 不产生错误**。随机串、已消费的历史代、已过期、
   * Session 已撤销/已过期，对外必须是同一个 200 空响应——否则这个端点就是
   * 一台「token 是否存在 / 是否曾经有效」的探测机。
   *
   * 唯一返回 4xx 的两种情况：
   * - 请求本身畸形（缺 `token`、重复字段、Content-Type 不对、超限）→ `invalid_request`；
   * - 拿了一枚**有效**的 MCP Access JWT 来撤销 → `unsupported_token_type`。
   *
   * ## `token_type_hint` 只当提示
   *
   * 不按 Hint 分流：先按 Refresh Token 的哈希查一次（唯一索引，O(1)），
   * 没命中才把它当 Access JWT 验一次。于是「Hint 说 access_token、实际给的是
   * refresh_token」照样能撤掉——RFC 7009 §2.1 明确要求不要只信 Hint。
   * 未知 Hint 值直接忽略。
   */
  app.post("/mcp/oauth/revoke", revokeLimiter, async (c) => {
    // 成功与失败都不许缓存：响应形态本身（200 vs 400）就是信息。
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    try {
      /**
       * Query 里出现 `token` 就拒绝整个请求（Phase 1.3.1-C3b-R1）。
       *
       * URL 会留在浏览器历史、代理访问日志、`Referer`、截图和工单里——token
       * 出现在那里就已经等于泄露，**无论 Body 里是否另外提供了一个合法值**。
       * 所以这不是「优先用 Body、忽略 Query」的容错，而是「这种请求形态本身
       * 不接受」。
       *
       * 检查放在 `parseTokenForm()` 之前：拒绝必须发生在读 body、算哈希、查库
       * 与验签之前。`queries()` 对 `?token=`（空值）与重复出现都返回非
       * `undefined`，三种形态一并挡掉。
       */
      if (c.req.queries("token") !== undefined) {
        throw invalidRequest("token must be sent in the request body, not the query string");
      }

      const form = await parseTokenForm(c);
      const token = form.get("token");
      if (token === undefined || token.length === 0) {
        throw invalidRequest("token is required");
      }
      /**
       * `client_id` 必填（Phase 1.3.1-C3b-R2）。
       *
       * Public Client 没有 secret，`client_id` 不是认证凭据，但它仍然表达
       * 「我是谁」。撤销端点要求它，是为了让「拿着别人的 Refresh Token 来
       * 撤销」这条路径**在协议层就写不成立**——归属校验见 `revokeToken()`。
       * 长度与重复字段由 `parseTokenForm()` / `requireField()` 统一处理。
       */
      const clientId = requireField(form, "client_id");

      const meta = sessionMetaFromRequest(c, ctx.env);
      const outcome = await revokeToken(
        {
          db: ctx.db.db,
          pepper: ctx.env.sessionTokenPepper,
          keyRing: ctx.keyRing,
          issuer: ctx.env.baseUrl,
          resource: mcpResourceFor(ctx.env.baseUrl),
          logger: ctx.logger,
        },
        { token, clientId, ipHash: meta.ipHash, now: new Date() },
      );

      if (outcome.kind === "client_mismatch") {
        throw invalidClient("client does not match this token");
      }
      if (outcome.kind === "unsupported_token_type") throw unsupportedTokenType();

      // 200 + 空体。`c.body(null, 200)` 保留上面设好的响应头。
      return c.body(null, 200);
    } catch (err) {
      if (err instanceof AppError) {
        return respondError(c, err, ctx.env.isProduction);
      }
      /**
       * 非 AppError 一律换成固定文案：drizzle 的 message 带整条 SQL 与全部
       * 参数（这里就是 token 哈希），原样透出即凭据泄露。
       */
      ctx.logger.error("mcp_revoke_failed", {});
      return respondError(c, serverError("token revocation failed"), ctx.env.isProduction);
    }
  });
}

const MAX_TOKEN_BODY_BYTES = 8 * 1024;
/** 表单字段的长度上限（授权码 / refresh token 都是 43 字符，512 足够）。 */
const MAX_TOKEN_FIELD_LENGTH = 512;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * 严格解析 `Content-Type`（Phase 1.3.1-C3a-R1）。
 *
 * 原来的 `startsWith("application/x-www-form-urlencoded")` 会接受
 * `application/x-www-form-urlencoded-evil`——一个完全不同（且未注册）的媒体
 * 类型，只因为前缀相同就被当成表单。这里按 RFC 9110 的结构解析：
 *
 * ```
 * type "/" subtype *( OWS ";" OWS parameter )
 * parameter = token "=" ( token / quoted-string )
 * ```
 *
 * 规则：
 * - 类型必须**逐字符**等于 `application/x-www-form-urlencoded`（大小写不敏感）；
 * - 参数只允许 `charset`，且值必须是 `utf-8`（大小写不敏感，可带引号）；
 * - 空参数（尾随 `;`、`;;`）、缺 `=`、未知参数名、未知 charset 一律拒绝。
 *
 * 只允许 `utf-8` 是因为下面的解码器就是 UTF-8；接受 `charset=iso-8859-1`
 * 然后按 UTF-8 解码，等于对同一段字节给出两种解释。
 */
function isFormContentType(raw: string | undefined): boolean {
  if (raw === undefined || raw.length === 0) return false;

  const segments = raw.split(";");
  if ((segments[0] ?? "").trim().toLowerCase() !== FORM_CONTENT_TYPE) return false;

  // 参数名**不能重复**：`charset=utf-8; charset=UTF-8` 不是一个能确定含义的
  // 头——两个解析器各取一个就是两种行为。即使两处值相同也拒绝，因为「值恰好
  // 一样」只是这一次的巧合，不构成规则。
  const seen = new Set<string>();
  for (const segment of segments.slice(1)) {
    const param = segment.trim();
    // 空参数说明头本身有语法错误（`…;` / `…;;charset=utf-8`）。
    if (param.length === 0) return false;
    const eq = param.indexOf("=");
    if (eq <= 0) return false;
    const name = param.slice(0, eq).trim().toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);

    let value = param.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name !== "charset") return false;
    if (value.toLowerCase() !== "utf-8") return false;
  }
  return true;
}

/**
 * 有界读取请求体（Phase 1.3.1-C3a-R1）。
 *
 * 三条约束，缺一不可：
 *
 * 1. **按字节而不是按字符计数**。`body.length` 是 UTF-16 码元数，一个汉字算
 *    1 而实际占 3 字节——用它做上限，攻击者可以把 8 KiB 的配额放大三倍。
 * 2. **在读取过程中截断**。先 `c.req.text()` 再判大小意味着先把任意大的请求
 *    读进内存，上限只在事后生效（正是要修的问题）。
 * 3. **`Content-Length` 只作为早退优化，不作为判据**。它可以缺失、可以撒谎；
 *    真正的判据是累计读到的字节数。
 *
 * 超限时 `cancel()` 掉 reader：剩下的字节不再消费，也不留在流里。
 */
async function readBoundedBody(c: Context, maxBytes: number): Promise<Uint8Array> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    // RFC 9110：`Content-Length = 1*DIGIT`。**必须逐字符校验**——`Number()` 太宽容：
    // `Number("")` 是 0（空头会被当成「零字节」放行）、`Number("0x10")` 是 16、
    // `Number("1e3")` 是 1000。这些都不是合法的 Content-Length。
    if (!/^\d+$/.test(declared)) {
      throw invalidRequest("content-length is not a valid byte count");
    }
    if (Number(declared) > maxBytes) throw invalidRequest("request body is too large");
  }

  const body = c.req.raw.body;
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) throw invalidRequest("request body is too large");
      chunks.push(value);
    }
  } finally {
    if (!completed) {
      // 不读完剩余字节：既省带宽，也让「超大请求」无法靠慢速续传拖住连接。
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // 已 cancel 的 reader 可能不允许再释放锁；此处无副作用需要处理。
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 按 UTF-8 严格解码。非法字节序列 **fail-closed**，不替换成 U+FFFD。
 *
 * 宽松解码会把「一段垃圾字节」变成一串看似正常（但被悄悄改过）的参数值——
 * 那是比 400 更糟的结果：请求被接受，内容却不是客户端发的。
 */
function decodeFormBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest("request body is not valid UTF-8");
  }
}

/**
 * 解析 token 请求的表单。
 *
 * **要求每个字段恰好出现一次**：`URLSearchParams` 在 `Object.fromEntries` 下
 * 会「后者覆盖前者」，于是校验用的值与实际使用的值可能不是同一个。这里显式
 * 拒绝重复字段，而不是挑一个。
 */
async function parseTokenForm(c: Context): Promise<Map<string, string>> {
  if (!isFormContentType(c.req.header("content-type"))) {
    throw invalidRequest("content-type must be application/x-www-form-urlencoded");
  }

  // 顺序固定：先按字节截断，再解码。反过来会让「非法 UTF-8」与「超限」
  // 互相掩盖——两条拒绝理由里必须只有一条成立。
  const bytes = await readBoundedBody(c, MAX_TOKEN_BODY_BYTES);
  const body = decodeFormBody(bytes);

  const params = new URLSearchParams(body);
  const values = new Map<string, string>();
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    if (all.length !== 1) {
      // **不回显字段名**：名字完全由请求方控制（可含换行、可超长），
      // 拼进 description 既是日志注入面，也把一条安全错误变成了回显槽。
      throw invalidRequest("a parameter appears more than once");
    }

    const value = all[0] ?? "";
    /**
     * **统一限长**（Phase 1.3.1-C3a-R2）。
     *
     * 放在这里而不是 `requireField()` 里：必填字段、可选字段（`scope`）与
     * 未知扩展字段必须走同一条判据。只在 `requireField()` 里查会漏掉
     * `form.get("scope")` 与所有被忽略的扩展参数——「已知字段有上限、
     * 未知字段没有」不是一条能讲清楚的规则。
     *
     * 错误文案**不回显字段名**：参数名是攻击者可控的（可以带换行或超长
     * 内容），拼进错误里既是日志注入面，也会让「超长」这条错误本身变得不可读。
     */
    if (value.length > MAX_TOKEN_FIELD_LENGTH) {
      throw invalidRequest("parameter value exceeds the maximum length");
    }
    values.set(key, value);
  }
  return values;
}

function requireField(form: Map<string, string>, name: string): string {
  const value = form.get(name);
  if (value === undefined || value.length === 0) {
    throw invalidRequest(`${name} is required`);
  }
  if (value.length > MAX_TOKEN_FIELD_LENGTH) {
    throw invalidRequest(`${name} is too long`);
  }
  return value;
}

/**
 * 解析请求的 `scope`（空格分隔）。
 *
 * 只校验「是已知 scope」；「是否超出已有授权」由 `rotateMcpRefreshToken` 在
 * 写入之前判定（那里才拿得到 `issued ∩ grant`）。
 */
function parseScopeParam(raw: string): string[] {
  const parts = raw.split(" ").filter((part) => part.length > 0);
  if (parts.length === 0) throw invalidScope("scope must not be empty");
  for (const part of parts) {
    if (!isMcpScope(part)) throw invalidScope("unknown scope requested");
  }
  return parts;
}

function tokenResponse(
  c: Context,
  issued: {
    accessToken: string;
    /** `undefined` = 客户端未声明 `refresh_token` → 响应**不出现**该字段。 */
    refreshToken?: string | undefined;
    expiresIn: number;
    scope: readonly string[];
  },
): Response {
  return c.json({
    access_token: issued.accessToken,
    token_type: "Bearer",
    // 必须是配置值，不是硬编码 900：客户端按它安排刷新节奏。
    expires_in: issued.expiresIn,
    // 与数据库一致：未声明 `refresh_token` 的客户端既没有行、也没有字段
    // （§8.4 gating——禁止「库里有、响应没有」的分裂）。
    ...(issued.refreshToken === undefined ? {} : { refresh_token: issued.refreshToken }),
    scope: formatScopeClaim(issued.scope),
  });
}

async function issueTokens(c: Context, ctx: AppContext): Promise<Response> {
  const form = await parseTokenForm(c);
  const grantType = requireField(form, "grant_type");
  const clientId = requireField(form, "client_id");
  const resource = requireField(form, "resource");

  const expectedResource = mcpResourceFor(ctx.env.baseUrl);
  if (resource !== expectedResource) {
    throw invalidRequest("resource does not match this MCP server");
  }

  const scopeParam = form.get("scope");
  const requestedScope = scopeParam === undefined ? undefined : parseScopeParam(scopeParam);

  const meta = sessionMetaFromRequest(c, ctx.env);
  const deps = {
    db: ctx.db.db,
    pepper: ctx.env.sessionTokenPepper,
    keyRing: ctx.keyRing,
    issuer: ctx.env.baseUrl,
    resource: expectedResource,
    accessTokenTtlSeconds: ctx.env.accessTokenTtlSeconds,
    logger: ctx.logger,
  };
  // 一次请求内只有一个「现在」：授权码有效期、会话 created_at、JWT 的
  // iat/exp 都从它推导，避免同一次兑换里出现两个相差几毫秒的时间点。
  const currentTime = new Date();

  if (grantType === "authorization_code") {
    // `scope` 在授权码流程里**不生效**：授权码已经承载了用户勾选的最终
    // scope，客户端不能借兑换时再要一次。这里既不校验也不扩大。
    return tokenResponse(
      c,
      await exchangeAuthorizationCode(deps, {
        code: requireField(form, "code"),
        clientId,
        redirectUri: requireField(form, "redirect_uri"),
        resource,
        codeVerifier: requireField(form, "code_verifier"),
        now: currentTime,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      }),
    );
  }

  if (grantType === "refresh_token") {
    return tokenResponse(
      c,
      await exchangeRefreshToken(deps, {
        refreshToken: requireField(form, "refresh_token"),
        clientId,
        resource,
        ...(requestedScope === undefined ? {} : { requestedScope }),
        now: currentTime,
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      }),
    );
  }

  throw unsupportedGrantType();
}

/**
 * 同意页 GET 的失败出口。
 *
 * 两类失败带副作用：
 * - **绑定不匹配**：删行 + 审计（有劫持嫌疑，行不能再被任何人使用）；
 * - **过期**：删行（这张表只承载 10 分钟内的状态，过期行没有任何用途）。
 *
 * 其余失败（行不存在、未登录）只给页面：此时没有可信的 `redirect_uri`，
 * 不做任何重定向。
 */
async function consentFailurePage(
  c: Context,
  ctx: AppContext,
  rid: string,
  reason: ConsentFailure,
): Promise<Response> {
  if (reason === "metadata_invalid") {
    // 四条件失败的删行 + `mcp_consent_metadata_invalid` 审计**已经由
    // `loadConsentRequest` 的事务提交**（§8.5 边界二）。这里绝不再删一次、
    // 不再审计一次（重复副作用会污染审计计数；重复删除是无意义的写）。
    return htmlError(c, 400, CONSENT_FAILURE_KEYS.metadata_invalid);
  }
  if (reason === "binding_mismatch") {
    await deleteAuthRequest(ctx.db.db, rid);
    await audit(ctx, {
      eventType: "mcp_browser_binding_mismatch",
      detail: { rid, stage: "consent" },
    });
  } else if (reason === "expired") {
    await deleteAuthRequest(ctx.db.db, rid);
  }
  return htmlError(c, 400, CONSENT_FAILURE_KEYS[reason]);
}

/**
 * 同意页 POST 的失败出口。
 *
 * `csrf_mismatch` 的行**已经在 `decideConsent` 里删掉**（那里是事务内删除，
 * 与「表单被篡改」这件事属于同一个决定），这里只补审计与页面。
 */
async function consentSubmitFailure(
  c: Context,
  ctx: AppContext,
  rid: string,
  reason: ConsentFailure | "invalid_request" | "csrf_mismatch" | "invalid_scope" | "no_scope_granted",
  context: { userId?: string | undefined; clientId?: string | undefined },
): Promise<Response> {
  if (reason === "metadata_invalid") {
    // 删行 + 审计已在 `decideConsent` 的事务里提交（POST 分支是**有意拒绝、
    // 正常提交**，不是回滚）。这里只渲染 400 HTML：不 302、不建 Grant / Code、
    // 不再删行、不再审计（任务书 §4.4）。
    return htmlError(c, 400, CONSENT_FAILURE_KEYS.metadata_invalid);
  }

  if (reason === "csrf_mismatch") {
    await audit(ctx, {
      eventType: "mcp_consent_csrf_mismatch",
      userId: context.userId,
      detail: { rid, clientId: context.clientId },
    });
    return htmlError(c, 400, "form_stale");
  }

  if (reason === "binding_mismatch") {
    await deleteAuthRequest(ctx.db.db, rid);
    await audit(ctx, {
      eventType: "mcp_browser_binding_mismatch",
      detail: { rid, stage: "consent_submit" },
    });
    return htmlError(c, 400, "session_mismatch");
  }

  if (reason === "expired") {
    await deleteAuthRequest(ctx.db.db, rid);
  }

  if (reason === "invalid_scope" || reason === "no_scope_granted") {
    // 不删行：这多半是客户端/页面 bug，用户重新打开同意页即可。删行会让
    // 一次可恢复的失败变成「必须重新走 Provider 登录」。
    return htmlError(c, 400, "scope_invalid");
  }

  if (reason === "invalid_request" || reason === "not_found") {
    return htmlError(c, 400, "link_invalid");
  }

  return htmlError(c, 400, CONSENT_FAILURE_KEYS[reason]);
}

/**
 * Provider 侧返回了 `error`：用户拒绝、Provider 故障，或一个我们不认识的错误。
 *
 * ## 错误映射（Phase 1.3.1-C2b 修正）
 *
 * | Provider 返回 | 客户端看到 | 理由 |
 * |---|---|---|
 * | `access_denied` | `access_denied` | 用户确实拒绝了 |
 * | `server_error` | `server_error` | Provider 自己报故障 |
 * | 其他 / 未知 | `server_error` | 不能把未识别的失败说成「用户拒绝」 |
 *
 * C2a 把所有 `error` 都映射成 `access_denied`。那会让客户端在 Provider 宕机
 * 时以为「用户不同意」，于是停止重试并可能把授权标记为被拒绝——一个服务端
 * 故障被记成了用户意愿。
 *
 * ## 重定向的前提
 *
 * **只有拿到已验证且精确匹配的 `redirect_uri` 才允许重定向**。这里的「精确」
 * 由行的来源保证——`redirect_uri` 是 authorize 阶段按注册值逐字符校验后写
 * 进去的，回调阶段只读不写。所以「拿不到行」时必须 400，绝不回跳。
 *
 * 一次性由条件 `DELETE … RETURNING` 保证：同一个 state 拒绝两次，第二次
 * 拿不到行，也就拿不到可重定向的地址。删除条件里带上当时那把 State 的哈希
 * 与浏览器绑定（见 `deleteDeniedProviderRequest`），才能避免「旧 State 的
 * 拒绝回调把同一 rid 上新发起的授权删掉」。
 */
async function handleProviderDenied(
  c: Context,
  input: {
    ctx: AppContext;
    browserOptions: BrowserSessionOptions;
    provider: ProviderName;
    /** Provider 回传的原始 `error` 值。只用于分类，不原样写入审计。 */
    providerError: string;
    stateHash: string;
    binding: string;
    now: Date;
  },
): Promise<Response> {
  const { ctx } = input;

  // 读一次只为**区分失败原因**（绑定不匹配要留证）。判据是下面的条件删除。
  const rows = await ctx.db.db
    .select({
      id: mcpAuthRequests.id,
      provider: mcpAuthRequests.provider,
      browserBindingHash: mcpAuthRequests.browserBindingHash,
    })
    .from(mcpAuthRequests)
    .where(eq(mcpAuthRequests.providerStateHash, input.stateHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.provider !== input.provider) {
    return htmlError(c, 400, "link_invalid");
  }
  if (!row.browserBindingHash || !constantTimeEqual(row.browserBindingHash, input.binding)) {
    /**
     * 与正常回调同一个条件删除（C2b-R1）：预期绑定取**行内读到的那个**，
     * 绝不取请求携带的那个。旧 State 的失配拒绝回调因此不会删掉同一 rid
     * 上新发起的授权。
     */
    const removed = await deleteMismatchedProviderRequest(ctx.db.db, {
      rid: row.id,
      provider: input.provider,
      stateHash: input.stateHash,
      storedBindingHash: row.browserBindingHash,
      now: input.now,
    });
    if (removed) {
      await audit(ctx, {
        eventType: "mcp_browser_binding_mismatch",
        detail: { rid: row.id, stage: "denied", provider: input.provider },
      });
    }
    return htmlError(c, 400, "session_mismatch");
  }

  const deleted = await deleteDeniedProviderRequest(ctx.db.db, {
    rid: row.id,
    provider: input.provider,
    stateHash: input.stateHash,
    bindingHash: input.binding,
    now: input.now,
  });
  // 命中 0 行 = 这一行已经不是「那把被拒绝的 state 对应的授权」了
  // （被新的 Provider 流程覆盖 / 已被消费 / 已过期）。不重定向。
  if (!deleted) return htmlError(c, 400, "link_invalid");

  const clientError = input.providerError === "access_denied" ? "access_denied" : "server_error";
  await audit(ctx, {
    eventType: "mcp_provider_denied",
    detail: {
      rid: deleted.rid,
      provider: input.provider,
      clientError,
      // 只记分类，不记 Provider 的原始字符串（它可能带换行或任意内容）。
      providerErrorKind:
        input.providerError === "access_denied"
          ? "access_denied"
          : input.providerError === "server_error"
            ? "server_error"
            : "other",
    },
  });

  clearBrowserSessionCookie(c, input.browserOptions);
  return c.redirect(
    buildRedirectUri(deleted.redirectUri, {
      error: clientError,
      state: deleted.state ?? undefined,
      iss: ctx.env.baseUrl,
    }),
    302,
  );
}
