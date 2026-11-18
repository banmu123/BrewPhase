import { createDb, type DbHandle } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "./env.js";

let shared: DbHandle | undefined;

export async function getTestDb(): Promise<DbHandle> {
  shared ??= createDb(TEST_DATABASE_URL);
  return shared;
}

/** 清空全部业务表（保留 schema），测试之间互相隔离。 */
export async function resetDb(handle: DbHandle): Promise<void> {
  await handle.sql`truncate table mcp_grants, mcp_devices, auth_events, oauth_codes, oauth_transactions, auth_sessions, user_identities, users restart identity cascade`;
}

export async function closeTestDb(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = undefined;
  }
}

export async function ensureDatabaseOrThrow(): Promise<void> {
  const handle = await getTestDb();
  try {
    await handle.ping();
  } catch (err) {
    throw new Error(
      `Integration tests require a reachable PostgreSQL at TEST_DATABASE_URL.\n` +
        `Current: ${TEST_DATABASE_URL}\n` +
        `Start one with: docker run -d --name brewphase-cloud-test-pg -e POSTGRES_USER=brewphase ` +
        `-e POSTGRES_PASSWORD=brewphase -e POSTGRES_DB=brewphase_cloud_test -p 54329:5432 postgres:16-alpine\n` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
