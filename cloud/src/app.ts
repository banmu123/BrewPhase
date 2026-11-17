import { Hono } from "hono";
import { lt } from "drizzle-orm";
import type { AppContext, AppHono } from "./context.js";
import { createKeyRing, type AccessClaims } from "./sessions/jwt.js";
import { createLogger } from "./logger.js";
import { createDb } from "./db/client.js";
import { oauthCodes, oauthTransactions } from "./db/schema.js";
import { loadEnv } from "./env.js";
import { createProviders } from "./oauth/providers.js";
import { respondError, AppError } from "./security/errors.js";
import { routeAuth } from "./routes/auth.js";
import { routeHealth } from "./routes/health.js";
import { routeOauth } from "./routes/oauth.js";

/** 从进程环境装配完整应用上下文（生产入口用；测试自己构造 AppContext）。 */
export function createContextFromProcessEnv(): AppContext {
  const env = loadEnv(process.env);
  const logger = createLogger(env.logLevel);
  return {
    env,
    db: createDb(env.databaseUrl),
    providers: createProviders(env),
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

  return app;
}

export interface SweepHandle {
  stop(): void;
}

/** 周期清理过期 OAuth Transaction 与一次性授权码（测试中可手动调用 sweepOnce）。 */
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
    if (transactions.length > 0 || codes.length > 0) {
      ctx.logger.info("sweep_completed", {
        expiredTransactions: transactions.length,
        expiredCodes: codes.length,
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
