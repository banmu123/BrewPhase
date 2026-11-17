import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "../db/client.js";

/**
 * 数据库迁移入口（生产部署专用命令）。
 *   开发：pnpm db:migrate
 *   容器：pnpm db:migrate:prod（跑 dist 编译产物，迁移文件随构建复制）
 *
 * 迁移只需要 DATABASE_URL —— 刻意不走完整 env 校验，
 * 生产部署时迁移命令可以在服务凭据尚未注入的环境（CI/一次性 Job）中先行执行。
 */

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL is required");
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // src/scripts/migrate.ts → ../db/migrations；dist/scripts/migrate.js → dist/db/migrations（构建时复制）
  const migrationsFolder = join(here, "..", "db", "migrations");

  const handle = createDb(databaseUrl);
  try {
    await handle.ping();
    await runMigrations(handle.db, migrationsFolder);
    console.log("[migrate] database migrations applied");
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
