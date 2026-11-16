import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "../src/db/client.js";

/**
 * Vitest globalSetup：把迁移应用到测试数据库。
 * 数据库不可达时直接失败（测试绝不允许在没有真实 PostgreSQL 的情况下假装通过）。
 */

export async function setup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://brewphase:brewphase@127.0.0.1:54329/brewphase_cloud_test";
  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "db",
    "migrations",
  );
  const handle = createDb(url);
  try {
    await handle.ping();
    await runMigrations(handle.db, migrationsFolder);
  } catch (err) {
    throw new Error(
      `[global-setup] cannot reach test PostgreSQL at ${url}\n` +
        `Start it with: docker run -d --name brewphase-cloud-test-pg -e POSTGRES_USER=brewphase ` +
        `-e POSTGRES_PASSWORD=brewphase -e POSTGRES_DB=brewphase_cloud_test -p 54329:5432 postgres:16-alpine\n` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await handle.close();
  }
}
