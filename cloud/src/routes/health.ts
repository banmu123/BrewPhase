import type { AppContext, AppHono } from "../context.js";

/**
 * /health 只反映进程存活；/ready 额外探测数据库可用性。
 * 数据库不可用时 /ready 返回 503，应用绝不假装健康。
 */
export function routeHealth(app: AppHono, ctx: AppContext): void {
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "brewphase-cloud",
      time: new Date().toISOString(),
    }),
  );

  app.get("/ready", async (c) => {
    try {
      await ctx.db.ping();
      return c.json({ status: "ready" });
    } catch (err) {
      ctx.logger.warn("readiness_check_failed", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ status: "degraded", detail: "database unavailable" }, 503);
    }
  });
}
