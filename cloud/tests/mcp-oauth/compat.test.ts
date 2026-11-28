import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

/**
 * Phase 1.3.1-A：migration 0003 对**既有表**必须零影响。
 *
 * 这里不手写「期望结构」——那等于把测试写成自己的答案。做法是自己造基线：
 * 先只应用 0000–0002，快照既有 8 张表的列 / 约束 / 索引；再应用全部迁移，
 * 逐字比对。任何一种「顺手改旧表」都会在这里变红。
 */

const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "db",
  "migrations",
);

/** 0003 之前就存在的表。前 6 张是账号体系，后 2 张是 1.2A 的设备与授权。 */
const EXISTING_TABLES = [
  "users",
  "user_identities",
  "auth_sessions",
  "oauth_transactions",
  "oauth_codes",
  "auth_events",
  "mcp_devices",
  "mcp_grants",
];

/**
 * 0003 之后**有意**落在既有表上的 schema 变更登记（按表名）。
 * 兼容性测试允许这里的差异，其余任何列/约束/索引变化都要红。
 * - 0006（2026-11-28 安全审计 P1-3）：mcp_devices 加 (user_id, public_key)
 *   部分唯一索引（排除 revoked），把「同公钥查重」下沉为数据库约束。
 */
const INTRODUCED_INDEXES: Record<string, string[]> = {
  mcp_devices: ["mcp_devices_user_pubkey_active_uq"],
};

const NEW_TABLES = [
  "mcp_oauth_clients",
  "mcp_auth_requests",
  "mcp_auth_codes",
  "mcp_sessions",
  "mcp_refresh_tokens",
];

const DB = "brewphase_cloud_0003_compat_test";

let admin: postgres.Sql;
let url: string;
let partialDir: string;

/** 只保留前 N 个迁移的临时目录（用来造「0003 之前的库」）。 */
function makePartialMigrationsDir(keep: number): string {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((entry) => entry.idx < keep);
  expect(entries).toHaveLength(keep);
  const dir = mkdtempSync(join(tmpdir(), `brewphase-migrations-keep${keep}-`));
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

type Handle = ReturnType<typeof createDb>;

async function snapshotColumns(handle: Handle, table: string): Promise<string[]> {
  const rows = await handle.sql<
    { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  >`
    select column_name, data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by column_name`;
  return rows.map(
    (r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default ?? ""}`,
  );
}

async function snapshotConstraints(handle: Handle, table: string): Promise<string[]> {
  const rows = await handle.sql<{ conname: string; def: string }[]>`
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = ${table}::regclass
     order by conname`;
  return rows.map((r) => `${r.conname}|${r.def}`);
}

async function snapshotIndexes(handle: Handle, table: string): Promise<string[]> {
  const rows = await handle.sql<{ indexname: string; indexdef: string }[]>`
    select indexname, indexdef from pg_indexes
     where schemaname = 'public' and tablename = ${table}
     order by indexname`;
  return rows.map((r) => `${r.indexname}|${r.indexdef}`);
}

async function snapshotTable(handle: Handle, table: string) {
  return {
    columns: await snapshotColumns(handle, table),
    constraints: await snapshotConstraints(handle, table),
    indexes: await snapshotIndexes(handle, table),
  };
}

async function tableNames(handle: Handle): Promise<string[]> {
  const rows = await handle.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`;
  return rows.map((r) => r.table_name);
}

beforeAll(async () => {
  admin = postgres(TEST_DATABASE_URL.replace(/\/[^/]+$/, "/postgres"), {
    max: 1,
    prepare: false,
  });
  await admin`drop database if exists ${admin(DB)}`;
  await admin`create database ${admin(DB)}`;
  url = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${DB}`);
  partialDir = makePartialMigrationsDir(3); // 0000, 0001, 0002
});

afterAll(async () => {
  rmSync(partialDir, { recursive: true, force: true });
  await admin`drop database if exists ${admin(DB)}`;
  await admin.end();
});

describe("migration 0003 的兼容性", () => {
  it("既有 8 张表的列与约束一字未改；索引只允许登记过的有意新增（0006）", async () => {
    const handle = createDb(url);
    try {
      await runMigrations(handle.db, partialDir);

      // 基线必须非空，否则比对毫无意义。
      const baseline: Record<string, Awaited<ReturnType<typeof snapshotTable>>> = {};
      for (const table of EXISTING_TABLES) {
        baseline[table] = await snapshotTable(handle, table);
        expect(baseline[table].columns.length, `${table} 基线为空`).toBeGreaterThan(0);
      }
      const before = await tableNames(handle);
      // 0003 之前的库里不该有任何新表。
      for (const table of NEW_TABLES) expect(before).not.toContain(table);

      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      for (const table of EXISTING_TABLES) {
        const before = baseline[table]!;
        const after = await snapshotTable(handle, table);
        expect(after.columns, `${table} 的列被后续迁移改动了`).toEqual(before.columns);
        expect(after.constraints, `${table} 的约束被后续迁移改动了`).toEqual(before.constraints);
        // 索引：允许「登记过的新增」（0006 的设备公钥唯一索引）；删除、改名、
        // 意外新增、既有索引被改，仍然全部要红。
        const allowed = new Set(INTRODUCED_INDEXES[table] ?? []);
        const addedNames = after.indexes
          .filter((idx) => !before.indexes.includes(idx))
          .map((idx) => idx.split("|")[0]!)
          .sort();
        expect(addedNames, `${table} 出现了未登记的索引变更`).toEqual([...allowed].sort());
        const kept = after.indexes.filter((idx) => !allowed.has(idx.split("|")[0]!));
        expect(kept, `${table} 的既有索引被改动了`).toEqual(before.indexes);
      }
    } finally {
      await handle.close();
    }
  });

  it("应用 0003 之后恰好多出五张表，且没有别的副作用", async () => {
    const handle = createDb(url);
    try {
      // 不依赖上一个用例是否跑过：迁移本身幂等，这里显式应用一次。
      await runMigrations(handle.db, MIGRATIONS_FOLDER);
      const after = await tableNames(handle);
      for (const table of NEW_TABLES) expect(after).toContain(table);

      const expected = [...EXISTING_TABLES, ...NEW_TABLES].sort();
      expect(after).toEqual(expected);
    } finally {
      await handle.close();
    }
  });

  it("在本次新建的数据库上，0003 的关键约束与索引都真实产出", async () => {
    // 这一条与 schema.test.ts 的区别：那些跑在**共享测试库**上（可能残留上一次
    // 手工 DDL），这里跑在 beforeAll 刚建的库里，结构只可能来自迁移文件。
    const handle = createDb(url);
    try {
      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      const partial = await handle.sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = 'public' and tablename = 'mcp_refresh_tokens'
           and indexname = 'mcp_refresh_tokens_session_active_uq'`;
      expect(partial).toHaveLength(1);
      expect(partial[0]?.indexdef).toMatch(/WHERE .*consumed_at IS NULL/);

      const fks = await handle.sql<{ count: string }[]>`
        select count(*)::text as count
          from information_schema.table_constraints
         where table_schema = 'public' and constraint_type = 'FOREIGN KEY'
           and table_name = any(${NEW_TABLES}::text[])`;
      expect(fks[0]?.count).toBe("6");

      const cardinality = await handle.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'mcp_oauth_clients'::regclass
           and conname = 'mcp_oauth_clients_redirect_uris_check'`;
      expect(cardinality[0]?.def).toContain("cardinality");
    } finally {
      await handle.close();
    }
  });

  it("迁移重跑幂等：五张表仍在，行数不变", async () => {
    const handle = createDb(url);
    try {
      const user = await handle.sql<{ id: string }[]>`
        insert into users (display_name) values ('compat') returning id`;
      const userId = user[0]?.id as string;
      const grant = await handle.sql<{ id: string }[]>`
        insert into mcp_grants (user_id, client_id, client_name, scopes, resource)
        values (${userId}, 'chatgpt', 'ChatGPT', array['records:read'], 'https://gw.example/mcp')
        returning id`;
      const grantId = grant[0]?.id as string;
      await handle.sql`
        insert into mcp_oauth_clients (client_id, client_name, redirect_uris, registration_source)
        values ('compat-client', 'Compat', array['https://c.example/cb'], 'pre_registered')`;

      const countsBefore = await Promise.all([
        handle.sql<{ count: string }[]>`select count(*)::text as count from mcp_oauth_clients`,
        handle.sql<{ count: string }[]>`select count(*)::text as count from mcp_grants`,
      ]);

      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      const countsAfter = await Promise.all([
        handle.sql<{ count: string }[]>`select count(*)::text as count from mcp_oauth_clients`,
        handle.sql<{ count: string }[]>`select count(*)::text as count from mcp_grants`,
      ]);
      expect(countsAfter.map((r) => r[0]?.count)).toEqual(countsBefore.map((r) => r[0]?.count));

      // 0002 之前的旧行（epoch 回填）也没被碰。
      const epoch = await handle.sql<{ epoch: number }[]>`
        select epoch from mcp_grants where id = ${grantId}`;
      expect(epoch[0]?.epoch).toBe(1);

      await handle.sql`delete from users where id = ${userId}`;
      await handle.sql`delete from mcp_oauth_clients where client_id = 'compat-client'`;
    } finally {
      await handle.close();
    }
  });

  it("升到 0003 时已有的 grant 数据不丢（纯 CREATE TABLE，不触碰旧表）", async () => {
    const dbName = "brewphase_cloud_0003_data_test";
    await admin`drop database if exists ${admin(dbName)}`;
    await admin`create database ${admin(dbName)}`;
    const dataUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`);
    const handle = createDb(dataUrl);
    try {
      await runMigrations(handle.db, partialDir);
      const user = await handle.sql<{ id: string }[]>`
        insert into users (display_name) values ('legacy') returning id`;
      const userId = user[0]?.id as string;
      const grant = await handle.sql<{ id: string }[]>`
        insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
        values (${userId}, 'chatgpt', 'ChatGPT', array['records:read','coffee:read'],
                'https://gw.example/mcp', 3)
        returning id`;
      const grantId = grant[0]?.id as string;

      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      const rows = await handle.sql<
        { client_name: string; scopes: string[]; epoch: number; resource: string }[]
      >`select client_name, scopes, epoch, resource from mcp_grants where id = ${grantId}`;
      expect(rows[0]).toEqual({
        client_name: "ChatGPT",
        scopes: ["records:read", "coffee:read"],
        epoch: 3,
        resource: "https://gw.example/mcp",
      });
      // 旧 grant 在 0003 之后仍能直接挂上 session（外键指向它而非反过来）。
      const session = await handle.sql<{ id: string }[]>`
        insert into mcp_sessions
          (user_id, grant_id, client_id, issued_scope, resource, absolute_expires_at)
        values (${userId}, ${grantId}, 'chatgpt', array['records:read'],
                'https://gw.example/mcp', now() + interval '90 days')
        returning id`;
      expect(session[0]?.id).toBeTruthy();
    } finally {
      await handle.close();
      await admin`drop database if exists ${admin(dbName)}`;
    }
  });
});
