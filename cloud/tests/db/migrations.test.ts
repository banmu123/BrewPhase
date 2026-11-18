import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb, runMigrations } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

/** 六张既有账号体系表的完整结构快照（列名 + 类型 + 可空性）。 */
async function snapshotLegacyTables(
  handle: ReturnType<typeof createDb>,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of [
    "users",
    "user_identities",
    "auth_sessions",
    "oauth_transactions",
    "oauth_codes",
    "auth_events",
  ]) {
    const rows = await handle.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = ${table}
       order by column_name`;
    out[table] = rows.map(
      (r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default ?? ""}`,
    );
  }
  return out;
}

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
          "mcp_devices",
          "mcp_grants",
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


/**
 * Phase 1.2A 的迁移（`0001_remote_mcp_devices`）。
 *
 * 这一组的存在理由：迁移是最容易「本地跑过就行」的东西。一旦它顺手改了
 * 旧表（哪怕只是加个默认值），线上已经存在的账号/会话数据就可能被重写。
 * 所以这里用 information_schema 做**结构快照比对**，而不是只看「表还在」。
 */

describe("Phase 1.2A migration (mcp_devices / mcp_grants)", () => {
  it("六张既有表的结构一字未改（与「只应用 0000」的基线逐列比对）", async () => {
    // 手写一份「期望结构」等于把测试写成了自己的答案：类型记错一格就红，
    // 而真的改了旧表却可能因为抄对了新值而绿。正确做法是**自己造一个基线**：
    // 先只应用 0000，快照六张旧表；再应用全部迁移，快照一次；两者必须逐字相等。
    const legacyDb = "brewphase_cloud_legacy_test";
    await admin`drop database if exists ${admin(legacyDb)}`;
    await admin`create database ${admin(legacyDb)}`;

    const tmpDir = mkdtempSync(join(tmpdir(), "brewphase-migrations-0000-"));
    const legacyUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${legacyDb}`);

    try {
      // 只保留 0000 的迁移目录（journal 也裁到只含 idx 0）
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      const first = journal.entries.find((entry) => entry.idx === 0);
      expect(first).toBeTruthy();
      mkdirSync(join(tmpDir, "meta"), { recursive: true });
      copyFileSync(
        join(MIGRATIONS_FOLDER, `${first!.tag}.sql`),
        join(tmpDir, `${first!.tag}.sql`),
      );
      writeFileSync(
        join(tmpDir, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: [first] }, null, 2),
      );

      const legacy = createDb(legacyUrl);
      try {
        await runMigrations(legacy.db, tmpDir);
        const baseline = await snapshotLegacyTables(legacy);

        await runMigrations(legacy.db, MIGRATIONS_FOLDER);
        const after = await snapshotLegacyTables(legacy);

        expect(after).toEqual(baseline);
        // 基线本身不能是空的（否则比对毫无意义）
        expect(Object.keys(baseline)).toHaveLength(6);
        expect(Object.values(baseline).every((cols) => cols.length > 0)).toBe(true);
      } finally {
        await legacy.close();
      }
    } finally {
      await admin`drop database if exists ${admin(legacyDb)}`;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("新表存在且 grant_epoch 默认值为 0", async () => {
    const handle = createDb(migratedUrl);
    try {
      const columns = await handle.sql<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
        select column_name, column_default, is_nullable
          from information_schema.columns
         where table_schema = 'public' and table_name = 'mcp_devices'`;
      const byName = new Map(columns.map((c) => [c.column_name, c]));

      // 契约字段逐个在位
      for (const required of [
        "id",
        "user_id",
        "name",
        "platform",
        "public_key",
        "status",
        "confirm_code_hash",
        "claim_secret_hash",
        "expires_at",
        "token_hash",
        "token_issued_at",
        "key_rotated_at",
        "last_seen_at",
        "revoked_at",
        "created_at",
      ]) {
        expect(byName.has(required), `缺少列 ${required}`).toBe(true);
      }

      // grant_epoch：NOT NULL + DEFAULT 0（契约值，不是「未初始化」）
      const grantEpoch = byName.get("grant_epoch");
      expect(grantEpoch).toBeTruthy();
      expect(grantEpoch?.is_nullable).toBe("NO");
      expect(grantEpoch?.column_default).toBe("0");

      // 三个 secret 列必须可空（领取前确实是 null）
      expect(byName.get("token_hash")?.is_nullable).toBe("YES");
      expect(byName.get("token_issued_at")?.is_nullable).toBe("YES");
      // 而三个哈希列必须非空（注册时就写入）
      for (const notNull of ["confirm_code_hash", "claim_secret_hash", "public_key"]) {
        expect(byName.get(notNull)?.is_nullable, `${notNull} 不应可空`).toBe("NO");
      }
    } finally {
      await handle.close();
    }
  });

  it("mcp_grants 的 scopes 是 text[]，且带 user 外键", async () => {
    const handle = createDb(migratedUrl);
    try {
      const cols = await handle.sql<{ column_name: string; data_type: string }[]>`
        select column_name, data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'mcp_grants'`;
      const scopes = cols.find((c) => c.column_name === "scopes");
      expect(scopes?.data_type).toBe("ARRAY");

      const fks = await handle.sql<{ constraint_name: string }[]>`
        select constraint_name from information_schema.table_constraints
         where table_schema = 'public' and table_name = 'mcp_grants'
           and constraint_type = 'FOREIGN KEY'`;
      // 只应有指向 users 的那一条
      expect(fks).toHaveLength(1);
      expect(fks[0]?.constraint_name).toContain("user_id");
    } finally {
      await handle.close();
    }
  });

  it("mcp_devices 与 mcp_grants 之间**没有**外键（两表正交）", async () => {
    const handle = createDb(migratedUrl);
    try {
      const between = await handle.sql<{ constraint_name: string }[]>`
        select tc.constraint_name
          from information_schema.table_constraints tc
          join information_schema.constraint_column_usage ccu
            on ccu.constraint_name = tc.constraint_name
         where tc.constraint_type = 'FOREIGN KEY'
           and tc.table_schema = 'public'
           and ((tc.table_name = 'mcp_devices' and ccu.table_name = 'mcp_grants')
             or (tc.table_name = 'mcp_grants' and ccu.table_name = 'mcp_devices'))`;
      expect(between).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it("迁移重跑不丢失已有账号与会话数据", async () => {
    const handle = createDb(migratedUrl);
    try {
      // 先插入一条用户与一条会话（模拟「线上已有数据」）
      const userRows = await handle.sql<{ id: string }[]>`
        insert into users (display_name) values ('existing') returning id`;
      const userId = userRows[0]?.id as string;
      await handle.sql`
        insert into auth_sessions (user_id, refresh_token_hash, token_family, expires_at)
        values (${userId}, 'existing-hash', gen_random_uuid(), now() + interval '1 day')`;

      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      const users = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from users where id = ${userId}`;
      const sessions = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from auth_sessions where user_id = ${userId}`;
      expect(users[0]?.count).toBe("1");
      expect(sessions[0]?.count).toBe("1");

      // 清理，避免影响同一数据库上的其它断言
      await handle.sql`delete from users where id = ${userId}`;
    } finally {
      await handle.close();
    }
  });

  it("mcp_devices.status 有域约束，非法状态写不进去", async () => {
    const handle = createDb(migratedUrl);
    try {
      const userRows = await handle.sql<{ id: string }[]>`
        insert into users (display_name) values ('status-check') returning id`;
      const userId = userRows[0]?.id as string;

      await expect(
        handle.sql`
          insert into mcp_devices
            (user_id, public_key, status, confirm_code_hash, claim_secret_hash, expires_at)
          values (${userId}, 'k', 'bogus', 'h', 'h', now() + interval '5 minutes')`,
      ).rejects.toThrow();

      // 合法状态可以写入，且 grant_epoch 自动是 0
      const inserted = await handle.sql<{ grant_epoch: number }[]>`
        insert into mcp_devices
          (user_id, public_key, status, confirm_code_hash, claim_secret_hash, expires_at)
        values (${userId}, 'k', 'pending', 'h', 'h', now() + interval '5 minutes')
        returning grant_epoch`;
      expect(inserted[0]?.grant_epoch).toBe(0);

      await handle.sql`delete from users where id = ${userId}`;
    } finally {
      await handle.close();
    }
  });
});

/**
 * Phase 1.2B.1 的迁移（`0002_mcp_grant_epoch`）。
 *
 * 这一组要回答的问题只有一个：**给一张已有数据的表加 NOT NULL 列，
 * 旧行会得到什么**。答案必须是 1（协议 §6.5 的 `grants[].epoch` 起点），
 * 而不是 NULL（会让 Desktop 的 `z.number().int().nonnegative()` 直接拒绝）
 * 或 0（协议里 0 没有定义，排障时会被误读成「未初始化」）。
 */
describe("Phase 1.2B.1 migration (mcp_grants.epoch)", () => {
  /** 只保留前 N 个迁移的临时目录（用来造「迁移前的库」）。 */
  function makePartialMigrationsDir(keep: number): string {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const entries = journal.entries.filter((entry) => entry.idx < keep);
    expect(entries).toHaveLength(keep);
    const dir = mkdtempSync(join(tmpdir(), `brewphase-migrations-${keep}-`));
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

  async function snapshotColumns(
    handle: ReturnType<typeof createDb>,
    table: string,
  ): Promise<string[]> {
    const rows = await handle.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = ${table}
       order by column_name`;
    return rows.map((r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default ?? ""}`);
  }

  it("旧数据的 epoch 自动是 1，且数据本身不丢", async () => {
    const dbName = "brewphase_cloud_epoch_migration_test";
    await admin`drop database if exists ${admin(dbName)}`;
    await admin`create database ${admin(dbName)}`;
    const url = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`);
    const partialDir = makePartialMigrationsDir(2);
    const handle = createDb(url);
    try {
      // 只应用到 0001：此时 mcp_grants 还没有 epoch 列。
      await runMigrations(handle.db, partialDir);
      const columns = await handle.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'mcp_grants'`;
      expect(columns.map((c) => c.column_name)).not.toContain("epoch");

      // 造一条「迁移前就存在」的 grant。
      const userRows = await handle.sql<{ id: string }[]>`
        insert into users (display_name) values ('legacy') returning id`;
      const userId = userRows[0]?.id as string;
      const grantRows = await handle.sql<{ id: string }[]>`
        insert into mcp_grants (user_id, client_id, client_name, scopes, resource)
        values (${userId}, 'chatgpt', 'ChatGPT', array['records:read'], 'https://gw.example/mcp')
        returning id`;
      const grantId = grantRows[0]?.id as string;

      // 再应用全部迁移。
      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      const after = await handle.sql<{ epoch: number; client_name: string; scopes: string[] }[]>`
        select epoch, client_name, scopes from mcp_grants where id = ${grantId}`;
      expect(after[0]?.epoch).toBe(1);
      expect(after[0]?.client_name).toBe("ChatGPT");
      expect(after[0]?.scopes).toEqual(["records:read"]);
    } finally {
      await handle.close();
      rmSync(partialDir, { recursive: true, force: true });
      await admin`drop database if exists ${admin(dbName)}`;
    }
  });

  it("只增加 mcp_grants.epoch：mcp_devices 的结构一字未改", async () => {
    const dbName = "brewphase_cloud_epoch_shape_test";
    await admin`drop database if exists ${admin(dbName)}`;
    await admin`create database ${admin(dbName)}`;
    const url = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`);
    const partialDir = makePartialMigrationsDir(2);
    const handle = createDb(url);
    try {
      await runMigrations(handle.db, partialDir);
      const devicesBefore = await snapshotColumns(handle, "mcp_devices");
      const grantsBefore = await snapshotColumns(handle, "mcp_grants");
      // 基线本身不能是空的，否则下面的比对毫无意义。
      expect(devicesBefore.length).toBeGreaterThan(10);
      expect(grantsBefore.length).toBeGreaterThan(5);

      await runMigrations(handle.db, MIGRATIONS_FOLDER);

      expect(await snapshotColumns(handle, "mcp_devices")).toEqual(devicesBefore);

      const grantsAfter = await snapshotColumns(handle, "mcp_grants");
      // 只多一列，且正是 epoch。
      expect(grantsAfter).toHaveLength(grantsBefore.length + 1);
      const added = grantsAfter.filter((col) => !grantsBefore.includes(col));
      expect(added).toHaveLength(1);
      expect(added[0]).toContain("epoch|integer|NO|1");
      // 原有列逐字不变（顺序无关：snapshotColumns 已按列名排序）。
      expect(grantsAfter.filter((col) => col.includes("epoch") === false)).toEqual(grantsBefore);
    } finally {
      await handle.close();
      rmSync(partialDir, { recursive: true, force: true });
      await admin`drop database if exists ${admin(dbName)}`;
    }
  });

  it("epoch 有正数约束：0 与负数写不进去，默认值可重复应用", async () => {
    const handle = createDb(migratedUrl);
    try {
      const userRows = await handle.sql<{ id: string }[]>`
        insert into users (display_name) values ('epoch-check') returning id`;
      const userId = userRows[0]?.id as string;

      for (const bad of [0, -1]) {
        await expect(
          handle.sql`
            insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
            values (${userId}, 'chatgpt', 'ChatGPT', array['records:read'], 'https://gw.example/mcp', ${bad})`,
        ).rejects.toThrow();
      }

      const inserted = await handle.sql<{ epoch: number }[]>`
        insert into mcp_grants (user_id, client_id, client_name, scopes, resource)
        values (${userId}, 'chatgpt', 'ChatGPT', array['records:read'], 'https://gw.example/mcp')
        returning epoch`;
      expect(inserted[0]?.epoch).toBe(1);

      // 重复执行迁移：列还在、值不变。
      await runMigrations(handle.db, MIGRATIONS_FOLDER);
      const after = await handle.sql<{ epoch: number }[]>`
        select epoch from mcp_grants where user_id = ${userId}`;
      expect(after[0]?.epoch).toBe(1);

      await handle.sql`delete from users where id = ${userId}`;
    } finally {
      await handle.close();
    }
  });
});
