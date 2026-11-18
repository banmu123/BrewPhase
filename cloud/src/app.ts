import { Hono } from "hono";
import { and, eq, lt, or } from "drizzle-orm";
import type { AppContext, AppHono } from "./context.js";
import { createKeyRing, type AccessClaims } from "./sessions/jwt.js";
import { createLogger } from "./logger.js";
import { createDb } from "./db/client.js";
import { mcpAuthRequests, mcpDevices, oauthCodes, oauthTransactions } from "./db/schema.js";
import { loadEnv } from "./env.js";
import { resolveProviderFetch } from "./net/proxy-fetch.js";
import { createProviders } from "./oauth/providers.js";
import { respondError, AppError } from "./security/errors.js";
import { routeAuth } from "./routes/auth.js";
import { routeHealth } from "./routes/health.js";
import { routeOauth } from "./routes/oauth.js";
import { routeMcpDevices } from "./mcp-devices/index.js";
import { routeMcpOAuth } from "./routes/mcp-oauth.js";
import { resolveMcpOAuthEnablement } from "./mcp-oauth/enablement.js";

/** 从进程环境装配完整应用上下文（生产入口用；测试自己构造 AppContext）。 */
export function createContextFromProcessEnv(): AppContext {
  const env = loadEnv(process.env);
  const logger = createLogger(env.logLevel);
  return {
    env,
    db: createDb(env.databaseUrl),
    providers: createProviders(env, resolveProviderFetch(process.env)),
    logger,
    keyRing: createKeyRing(env.jwtSigningKey, env.jwtSigningKeyPrevious),
  };
}

function corsMiddleware(allowedOrigins: string[]) {
  return async (c: { req: { method: string; header(name: string): string | undefined }; header(name: string, value: string): void; body(body: null, status: 204): Response }, next: () => Promise<void>) => {
    const applyHeaders = (): void => {
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      const origin = c.req.header("origin");
      if (origin && allowedOrigins.includes(origin)) {
        c.header("Access-Control-Allow-Origin", origin);
      }
    };
    if (c.req.method === "OPTIONS") {
      applyHeaders();
      return c.body(null, 204);
    }
    await next();
    applyHeaders();
  };
}

export function createApp(ctx: AppContext): AppHono {
  const app: AppHono = new Hono<{ Variables: { authClaims: AccessClaims } }>();

  // 请求日志：只记录方法/路径/状态/耗时，不记录任何头与体（含 Authorization）
  app.use(async (c, next) => {
    const start = Date.now();
    await next();
    const pathname = new URL(c.req.url).pathname;
    ctx.logger.info("http_request", {
      method: c.req.method,
      path: pathname,
      status: c.res.status,
      durationMs: Date.now() - start,
    });
  });

  // CORS 默认关闭；只有显式配置来源才启用，且不含 credentials
  if (ctx.env.corsOrigins.length > 0) {
    app.use("*", corsMiddleware(ctx.env.corsOrigins));
  }

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.status >= 500) {
        ctx.logger.error("request_failed", { code: err.code, status: err.status });
      } else {
        ctx.logger.info("request_rejected", { code: err.code, status: err.status });
      }
    } else {
      ctx.logger.error("unhandled_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return respondError(c, err, ctx.env.isProduction);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  routeHealth(app, ctx);
  routeOauth(app, ctx);
  routeAuth(app, ctx);
  // Remote MCP 设备管理（Phase 1.2A）。挂在这里而不是混进 routeAuth：
  // 设备面的路由与账号面的路由有各自的限流桶与错误码域。
  routeMcpDevices(app, ctx);

  /**
   * MCP 浏览器授权（Phase 1.3.1-C2a）。
   *
   * **能力边界，而不是启动边界**：密钥不合格时这组路由根本不注册（404），
   * 而不是「注册了但每个请求 500」，更不是「用临时密钥凑合用」。
   *
   * 为什么不在 `loadEnv` 里强制要求密钥：Cloud 同时服务 Desktop 登录，
   * 把 MCP 的密钥设成进程必填，会让「只跑 `/oauth/*` 的部署」因为一个尚未
   * 启用的能力起不来——那是把新功能的门禁变成旧功能的故障。
   *
   * 日志只记**原因枚举**，绝不打印密钥或它的任何片段。
   */
  const mcpOAuth = resolveMcpOAuthEnablement(ctx.env);
  if (mcpOAuth.enabled) {
    routeMcpOAuth(app, ctx);
  } else {
    ctx.logger.warn("mcp_oauth_disabled", { reason: mcpOAuth.reason });
  }

  return app;
}

export interface SweepHandle {
  stop(): void;
}

/**
 * 周期清理过期 OAuth Transaction、一次性授权码与过期未确认的设备
 * （测试中可手动调用 sweepOnce）。
 *
 * ## 设备清理的边界（Phase 1.2A）
 *
 * 只删 `status='pending'` 且 `expires_at < now` 的行。
 *
 * **不删 active / suspended / revoked**，理由各不相同：
 * - `active` / `suspended` 是活设备，删了等于未经用户同意撤销；
 * - `revoked` 是**审计历史**（谁在什么时候注册过什么），删了永久消失；
 * - `pending` 且已过期的是「用户点了注册但没去确认」的残骸，留着只会
 *   让设备列表堆满没用的条目，且它的 `claim_secret` 还在（虽然已过期）。
 *
 * 另外注意用的是 `expiresAt`（pending 窗口）而**不是** `tokenExpiresAt`
 * （device_token 寿命）：后者过期只意味着需要重新领取/轮换，
 * 不代表设备该消失。
 */
export function startSweep(ctx: AppContext, intervalMs = 60_000): SweepHandle {
  const sweepOnce = async (): Promise<void> => {
    const now = new Date();
    const transactions = await ctx.db.db
      .delete(oauthTransactions)
      .where(lt(oauthTransactions.expiresAt, now))
      .returning({ id: oauthTransactions.id });
    const codes = await ctx.db.db
      .delete(oauthCodes)
      .where(lt(oauthCodes.expiresAt, now))
      .returning({ hash: oauthCodes.codeHash });
    const devices = await ctx.db.db
      .delete(mcpDevices)
      .where(and(eq(mcpDevices.status, "pending"), lt(mcpDevices.expiresAt, now)))
      .returning({ id: mcpDevices.id });
    /**
     * 过期/已消费的 MCP 授权请求。
     *
     * `mcp_auth_requests` 是浏览器授权流程的短期状态（10 分钟），一次成功的
     * 流程会在 C2b 的同意页里删掉它。没走完的（用户关掉页面、Provider 拒绝后
     * 没回跳）必须有人清——否则这张表会随每次「点了授权又放弃」无限增长。
     *
     * 已消费的也清：`provider_consumed_at` 非空意味着这次回调已经用掉，
     * 行要么在同意页被删，要么就是残骸。
     */
    const authRequests = await ctx.db.db
      .delete(mcpAuthRequests)
      .where(
        or(
          lt(mcpAuthRequests.expiresAt, now),
          lt(mcpAuthRequests.providerConsumedAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      )
      .returning({ id: mcpAuthRequests.id });
    if (
      transactions.length > 0 ||
      codes.length > 0 ||
      devices.length > 0 ||
      authRequests.length > 0
    ) {
      ctx.logger.info("sweep_completed", {
        expiredTransactions: transactions.length,
        expiredCodes: codes.length,
        expiredDevices: devices.length,
        expiredMcpAuthRequests: authRequests.length,
      });
    }
  };
  const timer = setInterval(() => {
    void sweepOnce().catch((err) => {
      ctx.logger.warn("sweep_failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
