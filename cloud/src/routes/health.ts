import type { AppContext, AppHono } from "../context.js";

/**
 * `/health` 只反映进程存活；`/ready` 额外探测数据库可用性。
 * 数据库不可用时 `/ready` 返回 503，应用绝不假装健康。
 *
 * ## `/ready` 为什么还要报 `instance_id` 与 `connection_count`
 *
 * 单副本约束（`GATEWAY_EXPECTED_REPLICAS=1`）在应用层**无法技术强制**：
 * 运维仍可能把副本数改成 2。这两个字段是那种误配的唯一可观测信号——
 * 在 LB 后端逐个拉 `/ready`，如果看到两个不同的 `instance_id` 各自持有连接，
 * 就已经是多实例了（而线上表现会是随机的 `DEVICE_OFFLINE`）。
 *
 * `connection_count` 是**路由表**的条目数，不是 socket 数：它回答的是
 * 「这台实例认为自己能路由到多少台设备」，正是多实例问题的核心量。
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
    // 数据库探测保留原语义（失败 → 503），两个新字段在成功与失败响应里都带：
    // 排障时「数据库挂了」和「我连到哪台实例了」是同时需要的信息。
    const instanceId = ctx.link?.instanceId ?? ctx.instanceId;
    const connectionCount = ctx.link?.connectionCount() ?? 0;
    try {
      await ctx.db.ping();
      return c.json({ status: "ready", instance_id: instanceId, connection_count: connectionCount });
    } catch (err) {
      ctx.logger.warn("readiness_check_failed", { error: err instanceof Error ? err.message : String(err) });
      return c.json(
        {
          status: "degraded",
          detail: "database unavailable",
          instance_id: instanceId,
          connection_count: connectionCount,
        },
        503,
      );
    }
  });
}
