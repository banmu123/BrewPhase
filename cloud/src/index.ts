import { createApp, createContextFromProcessEnv, startSweep } from "./app.js";
import { loadLocalEnvFile } from "./env-file.js";
import { createLinkServer } from "./link/index.js";
import { startCloudServer } from "./server.js";

/**
 * 生产/开发入口。启动纪律：
 * - 环境变量校验失败 → 直接退出（含 `GATEWAY_EXPECTED_REPLICAS > 1`）；
 * - 数据库不可达 → 直接退出（不假装启动成功）；
 * - SIGTERM/SIGINT → 有序停机：
 *   停收新 WSS → 停心跳 → drain/bye/close 所有连接 → 清路由表 →
 *   停 sweep → 关 HTTP → **最后**关数据库连接池。
 *
 * 「最后关数据库」不是风格问题：心跳收尾会写 `last_seen_at`，连接清理会读
 * `mcp_devices`。先关池会让那些收尾动作全部抛错，日志里出现一堆「停机期间
 * 的数据库错误」，而真正的停机原因反而被淹没。
 */

async function main(): Promise<void> {
  // 本地开发：.env 只补缺，不覆盖已注入的进程环境；生产直接跳过。
  const envFile = loadLocalEnvFile();

  const ctx = createContextFromProcessEnv();
  if (envFile) {
    ctx.logger.info("env_file_loaded", { path: envFile });
  }

  try {
    await ctx.db.ping();
  } catch (err) {
    ctx.logger.error("database_unreachable_at_startup", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const app = createApp(ctx);

  /**
   * WSS 接入层。**必须在 `createApp` 之前造好并挂到 ctx 上**：路由层
   * （suspend / revoke）需要 `ctx.link` 才能在持久化之后清理连接。
   *
   * 主机白名单来自 env（显式配置，或从 `BASE_URL` 推导）。Origin 白名单复用
   * `CORS_ORIGINS`：浏览器能连的源与能发 CORS 请求的源应当是同一个集合，
   * 分成两份配置迟早会出现「CORS 放行了但 WS 连不上」。
   */
  const link = createLinkServer({
    ctx,
    allowedHosts: ctx.env.gateway.allowedHosts,
    allowedOrigins: ctx.env.corsOrigins,
  });
  ctx.link = link;
  ctx.instanceId = link.instanceId;

  const sweep = startSweep(ctx, 60_000);
  const server = await startCloudServer({ app, ctx, link, port: ctx.env.port });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.info("shutting_down", { signal, connections: link.connectionCount() });

    // 兜底：8 秒内没有正常退出则强制退出（避免卡在一条不配合的 TCP 上）。
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();

    void (async () => {
      try {
        // 1–4. 停收新连接 / 停心跳 / drain+bye+close / 清路由表
        await server.close();
        // 5. 停周期清理
        sweep.stop();
        // 6–7. 关闭数据库连接池（**最后**）
        await ctx.db.close();
        clearTimeout(force);
        process.exit(0);
      } catch (err) {
        ctx.logger.error("shutdown_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
