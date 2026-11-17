import type { Context, Next } from "hono";
import { z } from "zod";
import type { AppContext, AppHono } from "../context.js";
import { invalidToken } from "../security/errors.js";
import { rateLimit } from "../security/rate-limit.js";
import {
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from "../sessions/jwt.js";
import { findUserById } from "../users/user-service.js";
import { listIdentities } from "../users/identity-service.js";
import {
  logoutByRefreshToken,
  rotateRefreshToken,
} from "../sessions/session-service.js";
import {
  readStringFields,
  parseOr400,
  refreshTokenSchema,
  sessionMetaFromRequest,
} from "./body.js";

export function createRequireAuth(ctx: AppContext) {
  return async (c: Context<{ Variables: { authClaims: AccessClaims } }>, next: Next) => {
    const header = c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      throw invalidToken();
    }
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(ctx.keyRing, header.slice(7), {
        issuer: ctx.env.baseUrl,
      });
    } catch {
      throw invalidToken();
    }
    c.set("authClaims", claims);
    await next();
  };
}

/**
 * 统一的用户可见性检查：/auth/me 与 /auth/identities 共用，
 * 保证「用户不存在或已删除」在所有带 Bearer 的读接口上一致返回 401。
 * suspended 用户保留只读可见性（响应携带 status 供客户端响应，约定见实施报告）。
 */
async function loadAuthedUser(ctx: AppContext, userId: string) {
  const user = await findUserById(ctx.db.db, userId);
  if (!user || user.status === "deleted") {
    throw invalidToken();
  }
  return user;
}

export function routeAuth(app: AppHono, ctx: AppContext): void {
  const authLimiter = rateLimit({
    name: "auth",
    max: ctx.env.rateLimit.maxAuth,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
  });
  const requireAuth = createRequireAuth(ctx);

  const tokenResponse = async (userId: string, sessionId: string, refreshToken: string) => ({
    access_token: await signAccessToken(
      ctx.keyRing,
      { userId, sessionId },
      { issuer: ctx.env.baseUrl, ttlSeconds: ctx.env.accessTokenTtlSeconds },
    ),
    token_type: "Bearer",
    expires_in: ctx.env.accessTokenTtlSeconds,
    refresh_token: refreshToken,
  });

  /** 刷新会话：Refresh Token Rotation + 重放检测（宽限窗口语义）。 */
  app.post("/auth/refresh", authLimiter, async (c) => {
    const fields = await readStringFields(c);
    const { refresh_token: rawToken } = parseOr400(
      z.object({ refresh_token: refreshTokenSchema.shape.refresh_token }),
      fields,
    );

    const rotated = await rotateRefreshToken(
      ctx.db.db,
      { pepper: ctx.env.sessionTokenPepper, ttlSeconds: ctx.env.refreshSessionTtlSeconds },
      rawToken,
      sessionMetaFromRequest(c, ctx.env),
    );

    return c.json(await tokenResponse(rotated.userId, rotated.sessionId, rotated.refreshToken));
  });

  /** 退出登录：撤销整个 token family；未知 token 幂等成功。 */
  app.post("/auth/logout", authLimiter, async (c) => {
    const fields = await readStringFields(c);
    const { refresh_token: rawToken } = parseOr400(
      z.object({ refresh_token: refreshTokenSchema.shape.refresh_token }),
      fields,
    );

    await logoutByRefreshToken(
      ctx.db.db,
      { pepper: ctx.env.sessionTokenPepper },
      rawToken,
      sessionMetaFromRequest(c, ctx.env),
    );
    return c.json({ ok: true });
  });

  /** 当前用户资料（Renderer 永远只拿 DTO，拿不到任何 Token）。 */
  app.get("/auth/me", requireAuth, async (c) => {
    const claims = c.get("authClaims");
    const user = await loadAuthedUser(ctx, claims.userId);
    return c.json({
      id: user.id,
      status: user.status,
      display_name: user.displayName,
      avatar_url: user.avatarUrl,
      created_at: user.createdAt.toISOString(),
    });
  });

  /** 当前用户绑定的第三方身份列表（无任何凭据信息）。与 /auth/me 一致的用户状态检查。 */
  app.get("/auth/identities", requireAuth, async (c) => {
    const claims = c.get("authClaims");
    await loadAuthedUser(ctx, claims.userId);
    const identities = await listIdentities(ctx.db.db, claims.userId);
    return c.json({
      identities: identities.map((identity) => ({
        provider: identity.provider,
        email: identity.email,
        email_verified: identity.emailVerified,
        created_at: identity.createdAt.toISOString(),
      })),
    });
  });
}
