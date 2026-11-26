import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import {
  codesOf,
  grantsOf,
  startConsentFlow,
  submitConsent,
  tableCount,
} from "../helpers/mcp-consent.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { MCP_RESOURCE } from "../helpers/oauth-db.js";

/**
 * 同意提交的并发收口（Phase 1.3.1-C2b）。
 *
 * ## 这一组为什么不能用 sleep 制造并发
 *
 * 要测的是「两个人同时按下允许」这类交错。用 `setTimeout` 去碰那个时间窗，
 * 测的是调度运气：机器快时永远碰不到（假绿），机器慢时碰到别的交错（偶发红）。
 *
 * 这里全部用**数据库自身的锁**当同步原语：
 *
 * ```
 * 外部事务拿住目标行 → 启动 N 个请求（它们必然阻塞）→
 * pg_stat_activity 确认「确实有 N 个后端在等锁」→ 释放 → 断言唯一合法结果
 * ```
 *
 * `wait_event_type = 'Lock'` 而不是 `pg_blocking_pids()`：行锁队列里第二个
 * 等待者的直接阻塞者可能是前一个等待者，按阻塞者计数会少数一个。
 */

const handle = await getTestDb();

let h: McpOAuthHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function flow(scope = "records:read coffee:read") {
  return startConsentFlow(h, {
    query: new URLSearchParams({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: "https://client.example/callback",
      scope,
      state: "s",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://gateway.example/mcp",
    }).toString(),
  });
}

function approve(
  session: { rid: string; cookie: string; csrf: string },
  scopes: readonly string[],
) {
  return submitConsent(h, {
    rid: session.rid,
    cookie: session.cookie,
    csrf: session.csrf,
    decision: "allow",
    scopes,
  });
}

async function waitForLockWaiters(n: number): Promise<number> {
  const deadline = Date.now() + 5000;
  let seen = 0;
  while (Date.now() < deadline) {
    const rows = await handle.sql<{ count: string }[]>`
      select count(*)::text as count
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'`;
    seen = Number(rows[0]?.count ?? "0");
    if (seen >= n) return seen;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return seen;
}

/**
 * 拿住某一行，跑完 `body`，再释放。
 *
 * `body` 里启动的请求会阻塞在行锁上；我们确认「至少 n 个后端在等锁」之后
 * 才释放，所以交错是**被构造出来的**，不是撞出来的。
 */
async function withRowLock<T>(
  rid: string,
  waiters: number,
  body: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: () => void;
  const locked = new Promise<void>((resolve) => {
    signal = resolve;
  });

  const holding = handle.db.transaction(async (tx) => {
    await tx.execute(drizzleSql`select 1 from mcp_auth_requests where id = ${rid} for update`);
    signal();
    await held;
  });
  await locked;

  const running = body();
  try {
    const seen = await waitForLockWaiters(waiters);
    expect(seen, "请求必须真的进入等锁状态").toBeGreaterThanOrEqual(waiters);
  } finally {
    release();
    await holding;
  }
  return await running;
}

describe("同一 rid 的并发提交", () => {
  it("两个 allow 同时提交 → 只有一个成功，只产生一个 code", async () => {
    const session = await flow("records:read");

    const [first, second] = await withRowLock(session.rid, 2, () =>
      Promise.all([
        approve(session, ["records:read"]),
        approve(session, ["records:read"]),
      ]),
    );

    const statuses = [first!.status, second!.status].sort();
    expect(statuses).toEqual([302, 400]);

    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(1);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(1);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);

    // 失败的那个拿不到任何重定向（没有可信的 redirect_uri 可回）。
    const failed = first!.status === 400 ? first! : second!;
    expect(failed.headers.get("location")).toBeNull();
  });

  it("一个 allow、一个 deny 同时提交 → 只有一个生效且库内自洽", async () => {
    const session = await flow("records:read");

    const [allowRes, denyRes] = await withRowLock(session.rid, 2, () =>
      Promise.all([
        approve(session, ["records:read"]),
        submitConsent(h, {
          rid: session.rid,
          cookie: session.cookie,
          csrf: session.csrf,
          decision: "deny",
        }),
      ]),
    );

    const statuses = [allowRes!.status, denyRes!.status].sort();
    expect(statuses).toEqual([302, 400]);

    const codes = await tableCount(handle.sql, "mcp_auth_codes");
    const grants = await tableCount(handle.sql, "mcp_grants");
    // 允许赢 → 有 grant 有 code；拒绝赢 → 两者都没有。不允许出现「有 code 没 grant」。
    expect([codes, grants]).toEqual(codes === 1 ? [1, 1] : [0, 0]);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
  });
});

describe("Grant 的并发 upsert", () => {
  it("首次授权撞上未提交的同一 (user, client, resource) → 走更新分支，只有一行", async () => {
    const session = await flow("records:read");

    // 外部事务插入一条**未提交**的 grant：它占住了唯一索引，但别的会话看不见。
    // 同意提交的 INSERT 会阻塞在这里，提交后转成 ON CONFLICT DO UPDATE。
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: () => void;
    const inserted = new Promise<void>((resolve) => {
      signal = resolve;
    });

    const holding = handle.db.transaction(async (tx) => {
      await tx.execute(drizzleSql`
        insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
        values (${session.userId}, 'test-client', 'Test Client',
                array['records:read'], ${MCP_RESOURCE}, 4)`);
      signal();
      await held;
    });
    await inserted;

    const posting = approve(session, ["records:read"]);
    try {
      const seen = await waitForLockWaiters(1);
      expect(seen).toBeGreaterThanOrEqual(1);
    } finally {
      release();
      await holding;
    }

    expect((await posting).status).toBe(302);
    const grants = await grantsOf(handle.sql, session.userId);
    expect(grants).toHaveLength(1);
    // 更新分支保住了原 epoch（scope 没变），也证明没有第二条 INSERT。
    expect(grants[0]!.epoch).toBe(4);
  });

  it("同一用户两个 scope 更新并发 → 只有一行，epoch 递增", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);
    const grantId = (await grantsOf(handle.sql, first.userId))[0]!.id;

    const a = await flow("records:read coffee:read");
    const b = await flow("records:read tags:read");

    // 拿住 grant 行：两个 POST 都会在 upsert 处排队。
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const holding = handle.db.transaction(async (tx) => {
      await tx.execute(drizzleSql`select 1 from mcp_grants where id = ${grantId} for update`);
      signal();
      await held;
    });
    await locked;

    const both = Promise.all([approve(a, ["coffee:read"]), approve(b, ["tags:read"])]);
    try {
      const seen = await waitForLockWaiters(2);
      expect(seen).toBeGreaterThanOrEqual(2);
    } finally {
      release();
      await holding;
    }

    const results = await both;
    expect(results.map((res) => res.status)).toEqual([302, 302]);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants).toHaveLength(1);
    // 两次提交都改了 scope，所以至少涨到 3（串行化下的最小可能值）。
    expect(grants[0]!.epoch).toBeGreaterThanOrEqual(3);
    // 最终 scope 必须是两次提交之一，不能是「两个都丢」。
    const finalScopes = grants[0]!.scopes;
    expect([
      ["records:read", "coffee:read"],
      ["records:read", "tags:read"],
    ]).toContainEqual(finalScopes);
    // 两次授权各签发一把码（它们是两个独立授权请求）。
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(3);
  });

  it("撤销在提交前落库 → 授权把它重新激活，epoch +1，revoked_at 清空", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    const second = await flow("records:read");
    // 在它阻塞于授权请求行锁期间撤销 grant。
    const [res] = await withRowLock(second.rid, 1, async () => {
      await handle.sql`update mcp_grants set revoked_at = now() where user_id = ${first.userId}`;
      return [await approve(second, ["records:read"])];
    });

    expect(res!.status).toBe(302);
    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.revoked_at).toBeNull();
    expect(grants[0]!.epoch).toBe(2);
  });
});

describe("事务边界", () => {
  it("同一个 rid 不可能签发两把码（第二次连行都找不到）", async () => {
    const session = await flow("records:read");
    const first = await approve(session, ["records:read"]);
    expect(first.status).toBe(302);

    const second = await approve(session, ["records:read"]);
    expect(second.status).toBe(400);

    const codes = await codesOf(handle.sql, session.userId);
    expect(codes).toHaveLength(1);
  });

  it("提交后审计失败不会回滚授权（审计写不进去时仍然 302）", async () => {
    const session = await flow("records:read");

    // 让 auth_events 的插入必然失败：临时改列类型不现实，用触发器最直接。
    await handle.sql.unsafe(`
      create or replace function auth_events_reject() returns trigger as $$
      begin raise exception 'injected audit failure'; end $$ language plpgsql`);
    await handle.sql.unsafe(`
      create trigger auth_events_reject before insert on auth_events
      for each row execute function auth_events_reject()`);

    try {
      const res = await approve(session, ["records:read"]);
      expect(res.status).toBe(302);
      expect(await tableCount(handle.sql, "mcp_grants")).toBe(1);
      expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(1);
      expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
    } finally {
      await handle.sql.unsafe("drop trigger if exists auth_events_reject on auth_events");
      await handle.sql.unsafe("drop function if exists auth_events_reject()");
    }
  });
});
