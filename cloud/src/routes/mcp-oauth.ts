import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppContext, AppHono } from "../context.js";
import { recordAuthEvent } from "../db/audit.js";
import { mcpAuthRequests } from "../db/schema.js";
import { providerNotConfigured, type AppError } from "../security/errors.js";
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
  hashProviderSecret,
  isAuthRequestId,
  loadAuthRequest,
  validateAuthorizeParams,
} from "../mcp-oauth/authorize-flow.js";
import { AUTH_PAGE_HEADERS, renderErrorPage, renderLoginPage } from "../mcp-oauth/login-page.js";

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

const BROWSER_EXPIRED_HINT =
  "浏览器会话已失效。请回到发起授权的应用重新开始授权，不要刷新这个页面。";
const LINK_INVALID_HINT = "这个授权链接已失效。请回到发起授权的应用重新开始。";

function htmlError(c: Context, status: number, title: string, message: string): Response {
  return c.html(
    renderErrorPage(title, message),
    status as ContentfulStatusCode,
    AUTH_PAGE_HEADERS,
  );
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

  const now = (): Date => new Date();

  // -------------------------------------------------------------------------
  // GET /mcp/oauth/authorize
  // -------------------------------------------------------------------------

  /**
   * 授权入口。校验全部通过后建 `mcp_auth_requests`，然后 302 到登录页。
   *
   * **失败一律 400 JSON，不做任何重定向**：此刻 `redirect_uri` 还没被验证过，
   * 往一个未验证的地址重定向就是开放重定向。
   */
  app.get("/mcp/oauth/authorize", limiter, async (c) => {
    const validated = await validateAuthorizeParams(
      ctx.db.db,
      { baseUrl: ctx.env.baseUrl },
      {
        responseType: c.req.query("response_type"),
        clientId: c.req.query("client_id"),
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

    await recordAuthEvent(ctx.db.db, {
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
    const rid = c.req.query("rid") ?? "";
    if (!isAuthRequestId(rid)) {
      return htmlError(c, 400, "授权链接无效", "这个授权链接格式不正确。请回到发起授权的应用重新开始。");
    }

    const cookie = await readBrowserSessionCookie(c, browserOptions);
    if (!cookie.ok) {
      // Cookie 缺失/过期/被篡改：**不能**只凭 rid 继续——那会让「拿到 rid」
      // 等于「拿到授权」。正确做法是回到客户端重开流程（authorize 发新 Cookie）。
      return htmlError(c, 400, "浏览器会话已失效", BROWSER_EXPIRED_HINT);
    }

    const binding = browserBindingHash(cookie.session.sid);
    const currentTime = now();
    const bound = await bindBrowser(ctx.db.db, rid, binding, currentTime);

    if (!bound.ok) {
      if (bound.reason === "binding_mismatch") {
        // 有劫持嫌疑：删行 + 审计。删行让「另一个浏览器」也无法继续，
        // 这是 fail-closed 的选择——宁可打断一次合法流程，也不放行一次可疑流程。
        await deleteAuthRequest(ctx.db.db, rid);
        await recordAuthEvent(ctx.db.db, {
          eventType: "mcp_browser_binding_mismatch",
          detail: { rid, stage: "login" },
        });
        return htmlError(
          c,
          400,
          "授权会话不匹配",
          "这个授权链接已在另一个浏览器中打开。请重新开始授权。",
        );
      }
      if (bound.reason === "expired") {
        await deleteAuthRequest(ctx.db.db, rid);
        return htmlError(c, 400, "授权已过期", "这次授权已超过 10 分钟。请回到发起授权的应用重新开始。");
      }
      return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);
    }

    const request = await loadAuthRequest(ctx.db.db, rid);
    if (!request) return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);

    const providerParam = c.req.query("provider");
    if (providerParam === undefined || providerParam.length === 0) {
      // 只列出**真实可用**的 Provider：凭据没配置的那个不该出现在页面上，
      // 否则用户点了会拿到 400，看起来像服务坏了。
      const available = (["google", "github"] as const).filter(
        (name): name is ProviderName => ctx.providers[name] !== undefined,
      );
      return c.html(
        renderLoginPage({ rid, clientName: request.clientName, availableProviders: available }),
        200,
        AUTH_PAGE_HEADERS,
      );
    }

    if (!isProviderName(providerParam)) {
      return htmlError(c, 400, "不支持的登录方式", "这个登录方式不受支持。");
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
        await recordAuthEvent(ctx.db.db, {
          eventType: "mcp_browser_binding_mismatch",
          detail: { rid, stage: "login_provider" },
        });
        return htmlError(
          c,
          400,
          "授权会话不匹配",
          "这个授权链接已在另一个浏览器中打开。请重新开始授权。",
        );
      }
      if (claim.reason === "provider_conflict") {
        return htmlError(
          c,
          400,
          "登录方式冲突",
          "这次授权已经开始了另一个登录方式。请回到发起授权的应用重新开始。",
        );
      }
      if (claim.reason === "expired") {
        await deleteAuthRequest(ctx.db.db, rid);
        return htmlError(c, 400, "授权已过期", "这次授权已超过 10 分钟。请回到发起授权的应用重新开始。");
      }
      return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);
    }

    await recordAuthEvent(ctx.db.db, {
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
      return htmlError(c, 400, "不支持的登录方式", "这个登录方式不受支持。");
    }
    const provider: ProviderName = providerParam;
    const adapter = ctx.providers[provider];
    if (!adapter) throw providerNotConfigured(provider);

    const cookie = await readBrowserSessionCookie(c, browserOptions);
    if (!cookie.ok) {
      return htmlError(c, 400, "浏览器会话已失效", BROWSER_EXPIRED_HINT);
    }
    const binding = browserBindingHash(cookie.session.sid);

    const stateParam = c.req.query("state");
    const errorParam = c.req.query("error");

    // ---- 分支一：用户在 Provider 侧拒绝 ----
    if (errorParam !== undefined) {
      if (!stateParam) {
        return htmlError(
          c,
          400,
          "授权未完成",
          "这次授权没有完成。请回到发起授权的应用重新开始。",
        );
      }
      return await handleProviderDenied(c, {
        ctx,
        browserOptions,
        provider,
        stateHash: hashProviderSecret(stateParam),
        binding,
        now: now(),
      });
    }

    // ---- 分支二：正常回调 ----
    const code = c.req.query("code");
    if (!code) {
      return htmlError(c, 400, "授权未完成", "这次授权没有返回授权码。请回到发起授权的应用重新开始。");
    }
    if (!stateParam) {
      return htmlError(c, 400, "授权未完成", "这次授权缺少状态参数。请回到发起授权的应用重新开始。");
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
        if (consumed.rid) await deleteAuthRequest(ctx.db.db, consumed.rid);
        await recordAuthEvent(ctx.db.db, {
          eventType: "mcp_browser_binding_mismatch",
          detail: { rid: consumed.rid, stage: "callback", provider },
        });
        return htmlError(
          c,
          400,
          "授权会话不匹配",
          "这个授权链接已在另一个浏览器中打开。请重新开始授权。",
        );
      }
      if (consumed.reason === "expired") {
        if (consumed.rid) await deleteAuthRequest(ctx.db.db, consumed.rid);
        await recordAuthEvent(ctx.db.db, {
          eventType: "mcp_provider_callback_failed",
          detail: { rid: consumed.rid, provider, reason: "expired" },
        });
        return htmlError(c, 400, "授权已过期", "这次授权已超过 10 分钟。请回到发起授权的应用重新开始。");
      }
      // unknown_state / provider_mismatch / consumed：对外不透露是哪一种。
      await recordAuthEvent(ctx.db.db, {
        eventType: "mcp_provider_callback_failed",
        detail: { provider, reason: consumed.reason },
      });
      return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);
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
      // 交换失败：清理这一行（已被消费，无法重放），然后把错误如实交给统一
      // 出口。**不伪装成 access_denied**：那是「用户拒绝」的信号，会让客户端
      // 以为用户放弃了，而实际是服务端/Provider 出了问题。
      await deleteAuthRequest(ctx.db.db, request.rid);
      await recordAuthEvent(ctx.db.db, {
        eventType: "mcp_provider_callback_failed",
        detail: {
          rid: request.rid,
          provider,
          reason: "exchange_failed",
          // 只记错误码，不记 Provider 返回的任何内容。
          code: (err as AppError).code ?? "unknown",
        },
      });
      throw err;
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
      await recordAuthEvent(ctx.db.db, {
        eventType: "mcp_provider_callback_failed",
        detail: { rid: request.rid, provider, reason: "user_inactive", userId: resolved.user.id },
      });
      return htmlError(c, 403, "账号不可用", "这个 BrewPhase 账号当前不可用。请联系服务管理员。");
    }

    const attached = await attachUser(ctx.db.db, request.rid, resolved.user.id);
    if (!attached) {
      // 行在交换期间消失，或已被写入别的用户：fail-closed。
      await deleteAuthRequest(ctx.db.db, request.rid);
      return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);
    }

    await recordAuthEvent(ctx.db.db, {
      eventType: "mcp_provider_callback_succeeded",
      userId: resolved.user.id,
      detail: { rid: request.rid, provider, created: resolved.created },
    });

    // **保留**授权请求行：C2b 的同意页还要读它（client / scope / redirect_uri）。
    return c.redirect(`/mcp/oauth/consent?rid=${encodeURIComponent(request.rid)}`, 302);
  });
}

/**
 * 用户主动拒绝（`error=access_denied` 等）。
 *
 * 关键约束：**只有拿到已验证且精确匹配的 `redirect_uri` 才允许重定向**。
 * 这里的「精确」由行的来源保证——`redirect_uri` 是 authorize 阶段按注册值
 * 逐字符校验后写进去的，回调阶段只读不写。
 *
 * 一次性由 `DELETE ... RETURNING` 保证：同一个 state 拒绝两次，第二次拿不到行，
 * 也就拿不到可重定向的地址。
 */
async function handleProviderDenied(
  c: Context,
  input: {
    ctx: AppContext;
    browserOptions: BrowserSessionOptions;
    provider: ProviderName;
    stateHash: string;
    binding: string;
    now: Date;
  },
): Promise<Response> {
  const { ctx } = input;

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
    return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);
  }
  if (row.browserBindingHash !== input.binding) {
    await deleteAuthRequest(ctx.db.db, row.id);
    await recordAuthEvent(ctx.db.db, {
      eventType: "mcp_browser_binding_mismatch",
      detail: { rid: row.id, stage: "denied", provider: input.provider },
    });
    return htmlError(
      c,
      400,
      "授权会话不匹配",
      "这个授权链接已在另一个浏览器中打开。请重新开始授权。",
    );
  }

  // 原子删除：同一个 state 只可能换来一次重定向。
  const deleted = await ctx.db.db
    .delete(mcpAuthRequests)
    .where(
      and(
        eq(mcpAuthRequests.id, row.id),
        isNull(mcpAuthRequests.providerConsumedAt),
        gt(mcpAuthRequests.expiresAt, input.now),
      ),
    )
    .returning({ redirectUri: mcpAuthRequests.redirectUri, state: mcpAuthRequests.state });
  const hit = deleted[0];
  if (!hit) return htmlError(c, 400, "授权链接无效", LINK_INVALID_HINT);

  await recordAuthEvent(ctx.db.db, {
    eventType: "mcp_provider_denied",
    detail: { rid: row.id, provider: input.provider },
  });

  clearBrowserSessionCookie(c, input.browserOptions);
  return c.redirect(
    buildRedirectUri(hit.redirectUri, {
      error: "access_denied",
      state: hit.state ?? undefined,
      iss: ctx.env.baseUrl,
    }),
    302,
  );
}
