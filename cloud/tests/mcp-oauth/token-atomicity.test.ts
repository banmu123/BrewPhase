import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  exchangeCode,
  obtainAuthCode,
  refreshRows,
  sessionCount,
  type AuthCodeFixture,
} from "../helpers/mcp-token.js";

/**
 * 授权码兑换的**事务原子性**（Phase 1.3.1-C3a）。
 *
 * 三件写入必须同生共死：
 *
 * ```
 * UPDATE mcp_auth_codes SET consumed_at   ← 消费
 * INSERT mcp_sessions                     ← 身份
 * INSERT mcp_refresh_tokens (gen 1)       ← 续期能力
 * ```
 *
 * 任何一件单独成立都是一种「半成功」：码被消费却没有 Session（客户端拿不到
 * 凭据、也无法重试）、Session 建了却没有 Refresh Token（15 分钟后彻底失去
 * 续期）。这里用**注入失败的触发器**把第三件打断，看前两件是否一起回滚；
 * 再用行锁构造并发兑换，看是否只产生一条 Session。
 */

const handle = await getTestDb();
let h: McpOAuthHarness;
let fixture: AuthCodeFixture;
const triggers: string[] = [];

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
  fixture = await obtainAuthCode(h);
});

afterEach(async () => {
  for (const [trigger, table] of triggers.splice(0).map((entry) => entry.split("|"))) {
    await handle.sql.unsafe(`drop trigger if exists ${trigger} on ${table}`);
  }
  await handle.sql.unsafe("drop function if exists mcp_reject_insert()");
});

afterAll(async () => {
  await closeTestDb();
});

/** 让某张表的下一次 INSERT 必然失败（用来证明「部分成功」不存在）。 */
async function rejectInsertsOn(table: "mcp_sessions" | "mcp_refresh_tokens"): Promise<void> {
  const trigger = `${table}_reject`;
  await handle.sql.unsafe(`
    create or replace function mcp_reject_insert() returns trigger as $$
    begin raise exception 'injected insert failure on ${table}'; end $$ language plpgsql`);
  await handle.sql.unsafe(`
    create trigger ${trigger} before insert on ${table}
    for each row execute function mcp_reject_insert()`);
  triggers.push(`${trigger}|${table}`);
}

async function codeConsumed(): Promise<boolean> {
  const rows = await handle.sql<{ consumed_at: string | null }[]>`
    select consumed_at::text from mcp_auth_codes`;
  return rows[0]?.consumed_at !== null;
}

describe("失败注入：三件写入同生共死", () => {
  it("Session 插入失败 → 授权码消费回滚，且没有 Refresh Token", async () => {
    await rejectInsertsOn("mcp_sessions");

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(500);

    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);

    // 失败之后仍然可以重试（码没被吃掉）。
    // 注意：这里不能真的重试——表上还挂着触发器，重试仍会失败。只断言状态。
  });

  it("第一代 Refresh Token 插入失败 → Session 与授权码消费一起回滚", async () => {
    await rejectInsertsOn("mcp_refresh_tokens");

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(500);

    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);
  });

  it("失败响应不含授权码、也不含 SQL 细节", async () => {
    await rejectInsertsOn("mcp_sessions");
    const res = await exchangeCode(h, fixture);
    const body = (await res.json()) as { error: string; error_description?: string };

    expect(body.error).toBe("server_error");
    expect(JSON.stringify(body)).not.toContain(fixture.code);
    // 生产用固定文案；测试环境仍不回显 SQL。
    expect(JSON.stringify(body)).not.toContain("insert into");
    expect(JSON.stringify(body)).not.toContain("mcp_sessions");
  });
});

describe("并发兑换同一个授权码", () => {
  it("恰好一个成功，另一个 invalid_grant", async () => {
    const [first, second] = await Promise.all([exchangeCode(h, fixture), exchangeCode(h, fixture)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);

    const failed = first.status === 400 ? first : second;
    expect(((await failed.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("只生成一条 Session 与一条初代 Refresh Token", async () => {
    await Promise.all([exchangeCode(h, fixture), exchangeCode(h, fixture)]);
    expect(await sessionCount(handle, fixture.userId)).toBe(1);
    const rows = await refreshRows(handle, fixture.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generation).toBe(1);
  });

  it("行锁是串行化点：两个请求都阻塞在 SELECT … FOR UPDATE 上", async () => {
    // 外部事务先拿住授权码行。两个兑换都会停在 `FOR UPDATE` 上，
    // 用 `pg_stat_activity` 确认「确实有两个后端在等锁」，再放行。
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });

    const holding = handle.db.transaction(async (tx) => {
      await tx.execute(drizzleSql`select 1 from mcp_auth_codes for update`);
      signal();
      await held;
    });
    await locked;

    const both = Promise.all([exchangeCode(h, fixture), exchangeCode(h, fixture)]);
    try {
      const deadline = Date.now() + 5000;
      let waiters = 0;
      while (Date.now() < deadline) {
        const rows = await handle.sql<{ count: string }[]>`
          select count(*)::text as count
            from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and wait_event_type = 'Lock'`;
        waiters = Number(rows[0]?.count ?? "0");
        if (waiters >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiters, "两个兑换都应进入等锁状态").toBeGreaterThanOrEqual(2);
    } finally {
      release();
      await holding;
    }

    const results = await both;
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
    expect(await sessionCount(handle, fixture.userId)).toBe(1);
  });
});
