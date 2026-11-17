import { serve } from "@hono/node-server";
import { createApp, createContextFromProcessEnv, startSweep } from "./app.js";
import { loadLocalEnvFile } from "./env-file.js";

/**
 * 生产/开发入口。启动纪律：
 * - 环境变量校验失败 → 直接退出；
 * - 数据库不可达 → 直接退出（不假装启动成功）；
 * - SIGTERM/SIGINT → 优雅停机（停 sweep → 关 HTTP → 关数据库连接池）。
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
  const sweep = startSweep(ctx, 60_000);

  const server = serve({ fetch: app.fetch, port: ctx.env.port }, (info) => {
    ctx.logger.info("server_listening", { port: info.port, env: ctx.env.nodeEnv });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.info("shutting_down", { signal });
    sweep.stop();
    server.close(() => {
      void ctx.db.close().then(() => process.exit(0));
    });
    // 兜底：8 秒内没有正常退出则强制退出
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
