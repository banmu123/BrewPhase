import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb, runMigrations } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

/**
 * 迁移测试：在一个干净的独立数据库上验证
 * 1) 迁移可以完整执行；2) 重复执行幂等；3) Schema 关键约束真实存在。
 */

const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "db",
  "migrations",
);

const MIGRATE_DB = "brewphase_cloud_migrate_test";

let admin: postgres.Sql;
let migratedUrl: string;

beforeAll(async () => {
  // 连到 bootstrap 数据库做 create/drop
  admin = postgres(TEST_DATABASE_URL.replace(/\/[^/]+$/, "/postgres"), {
    max: 1,
    prepare: false,
  });
  await admin`drop database if exists ${admin(MIGRATE_DB)}`;
  await admin`create database ${admin(MIGRATE_DB)}`;
  migratedUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${MIGRATE_DB}`);
});

afterAll(async () => {
  await admin`drop database if exists ${admin(MIGRATE_DB)}`;
  await admin.end();
});

describe("database migrations", () => {
  it("applies cleanly on an empty database", async () => {
    const handle = createDb(migratedUrl);
    try {
      await handle.ping();
      await runMigrations(handle.db, MIGRATIONS_FOLDER);
      const tables = await handle.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`;
      const names = tables.map((row) => row.table_name).sort();
      expect(names).toEqual(
        expect.arrayContaining([
          "auth_events",
          "auth_sessions",
          "oauth_codes",
          "oauth_transactions",
          "user_identities",
          "users",
        ]),
      );
    } finally {
      await handle.close();
    }
  });

  it("is idempotent when run twice", async () => {
    const handle = createDb(migratedUrl);
    try {
      await runMigrations(handle.db, MIGRATIONS_FOLDER);
      // 第二次执行不应抛错、不应改变表数量
      const before = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from information_schema.tables where table_schema = 'public'`;
      await runMigrations(handle.db, MIGRATIONS_FOLDER);
      const after = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from information_schema.tables where table_schema = 'public'`;
      expect(after[0]?.count).toBe(before[0]?.count);
    } finally {
      await handle.close();
    }
  });

  it("creates the critical constraints", async () => {
    const handle = createDb(migratedUrl);
    try {
      // 身份唯一锚点 (provider, provider_subject)
      const identityUq = await handle.sql`
        select 1 from pg_indexes
        where schemaname = 'public'
          and tablename = 'user_identities'
          and indexdef like '%UNIQUE%provider, provider_subject%'`;
      expect(identityUq.length).toBe(1);

      // refresh token 哈希唯一
      const sessionUq = await handle.sql`
        select 1 from pg_indexes
        where schemaname = 'public'
          and tablename = 'auth_sessions'
          and indexdef like '%UNIQUE%refresh_token_hash%'`;
      expect(sessionUq.length).toBe(1);

      // provider 只允许 google / github
      const providerCheck = await handle.sql`
        select 1 from pg_constraint
        where conrelid = 'user_identities'::regclass
          and pg_get_constraintdef(oid) like '%google%'`;
      expect(providerCheck.length).toBeGreaterThan(0);

      // users.status 域约束
      const statusCheck = await handle.sql`
        select 1 from pg_constraint
        where conrelid = 'users'::regclass
          and pg_get_constraintdef(oid) like '%active%suspended%deleted%'`;
      expect(statusCheck.length).toBeGreaterThan(0);

      // provider_state_hash 唯一（防重放锚点）
      const txUq = await handle.sql`
        select 1 from pg_indexes
        where schemaname = 'public'
          and tablename = 'oauth_transactions'
          and indexdef like '%UNIQUE%provider_state_hash%'`;
      expect(txUq.length).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
