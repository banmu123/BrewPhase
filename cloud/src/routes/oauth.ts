import { z } from "zod";
import type { AppContext, AppHono } from "../context.js";
import { providerNotConfigured } from "../security/errors.js";
import { rateLimit } from "../security/rate-limit.js";
import { signAccessToken } from "../sessions/jwt.js";
import { validateAuthorizeInput } from "../oauth/authorization.js";
import { handleProviderCallback } from "../oauth/callback.js";
import { createOauthTransaction } from "../oauth/state.js";
import { exchangeAuthorizationCode } from "../oauth/token-exchange.js";
import { readStringFields, parseOr400, sessionMetaFromRequest, tokenRequestSchema } from "./body.js";

const authorizeQuerySchema = z.object({
  provider: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  redirect_uri: z.string().optional(),
});

export function routeOauth(app: AppHono, ctx: AppContext): void {
  const authorizeLimiter = rateLimit({
    name: "authorize",
    max: ctx.env.rateLimit.maxAuthorize,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
  });
  const tokenLimiter = rateLimit({
    name: "token",
    max: ctx.env.rateLimit.maxToken,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
  });

  /**
   * 授权入口。校验全部通过后创建 OAuth Transaction（双 State 哈希落库），
   * 302 到 Provider 授权页。校验失败一律 400 JSON，不做任何重定向。
   */
  app.get("/oauth/authorize", authorizeLimiter, async (c) => {
    const query = parseOr400(authorizeQuerySchema, {
      provider: c.req.query("provider"),
      state: c.req.query("state"),
      code_challenge: c.req.query("code_challenge"),
      redirect_uri: c.req.query("redirect_uri"),
    });
    const input = validateAuthorizeInput(query);

    const adapter = ctx.providers[input.provider];
    if (!adapter) {
      throw providerNotConfigured(input.provider);
    }

    const transaction = await createOauthTransaction(ctx.db.db, {
      provider: input.provider,
      clientState: input.clientState,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      ttlSeconds: ctx.env.oauthTransactionTtlSeconds,
    });

    const authorizeUrl = adapter.buildAuthorizeUrl({
      cloudRedirectUri: `${ctx.env.baseUrl}/oauth/callback/${input.provider}`,
      combinedState: transaction.combinedProviderState,
      nonce: transaction.nonce,
    });
    return c.redirect(authorizeUrl, 302);
  });

  /**
   * Provider 回调（Google / GitHub）。内部完成：Provider State 校验、
   * Provider 授权码换取并验证身份、用户映射、一次性授权码签发。
   * 成功 302 到 Desktop 本机回调（code + client_state）。
   */
  app.get("/oauth/callback/:provider", async (c) => {
    const outcome = await handleProviderCallback(
      {
        db: ctx.db.db,
        providers: ctx.providers,
        baseUrl: ctx.env.baseUrl,
        oauthCodeTtlSeconds: ctx.env.oauthCodeTtlSeconds,
      },
      {
        provider: c.req.param("provider"),
        code: c.req.query("code"),
        state: c.req.query("state"),
      },
      sessionMetaFromRequest(c, ctx.env),
    );
    return c.redirect(outcome.redirectUrl, 302);
  });

  /**
   * Desktop 用一次性授权码换 BrewPhase 会话。
   * 授权码原子消费 + PKCE S256 + redirect_uri 完全匹配。
   */
  app.post("/oauth/token", tokenLimiter, async (c) => {
    const fields = await readStringFields(c);
    const input = parseOr400(tokenRequestSchema, fields);

    const result = await exchangeAuthorizationCode(
      ctx.db.db,
      {
        pepper: ctx.env.sessionTokenPepper,
        sessionTtlSeconds: ctx.env.refreshSessionTtlSeconds,
      },
      {
        code: input.code,
        codeVerifier: input.code_verifier,
        redirectUri: input.redirect_uri,
      },
      sessionMetaFromRequest(c, ctx.env),
    );

    const accessToken = await signAccessToken(
      ctx.keyRing,
      { userId: result.userId, sessionId: result.sessionId },
      { issuer: ctx.env.baseUrl, ttlSeconds: ctx.env.accessTokenTtlSeconds },
    );

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ctx.env.accessTokenTtlSeconds,
      refresh_token: result.refreshToken,
    });
  });
}
