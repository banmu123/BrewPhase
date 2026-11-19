import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  authorizeQuery,
  createMcpOAuthHarness,
  seedAuthorizeClient,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  bindBrowser,
  claimProvider,
  consumeProviderCallback,
  deleteMismatchedProviderRequest,
  hashProviderSecret,
  loadAuthRequest,
  validateAuthorizeParams,
} from "../../src/mcp-oauth/authorize-flow.js";
import { browserBindingHash } from "../../src/mcp-oauth/browser-session.js";
import { mcpAuthRequests } from "../../src/db/schema.js";
import type { Database } from "../../src/db/client.js";

/**
 * 授权流程**业务层**的精确判据（Phase 1.3.1-C2a）。
 *
 * ## 为什么不满足于路由层的 400
 *
 * 路由层只能断言「这个请求被拒了」。但授权流程里有两处**纵深防御**：
 *
 * - 重放：读阶段先看 `consumed_at`，UPDATE 的 WHERE 里又看一次；
 * - 跨 provider：读阶段比 provider，UPDATE 的 WHERE 里也比一次。
 *
 * 于是「删掉第一道」时路由层仍然 400 —— 变异存活了，但那不是测试懒得写，
 * 而是**判据不够精确**。这里改用两种只有这一层才有的判据：
 *
 * 1. **`reason`**：内部返回值区分 `provider_mismatch` / `consumed` 等，
 *    删掉第一道检查后 reason 会变（`provider_mismatch` → `consumed`）。
 * 2. **行锁制造的真实交叠**：外部事务持行锁，让两条并发调用的 UPDATE
 *    都阻塞在锁上——这样它们**必然都读到了 `consumed_at IS NULL`**。
 *    提交锁之后，只有条件 UPDATE 能让其中一个失败。
 */

const handle = await getTestDb();

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
});

afterAll(async () => {
  await closeTestDb();
});

const RESOURCE = "https://gateway.example/mcp";

/** 建一行「已走到 Provider 跳转」的授权请求，返回 rid / state / binding。 */
async function seedClaimedRequest(
  h: McpOAuthHarness,
  options: { provider?: "google" | "github"; sid?: string } = {},
): Promise<{ rid: string; state: string; binding: string; cookie: string }> {
  await seedAuthorizeClient(handle);
  const res = await h.app.request(`/mcp/oauth/authorize?${authorizeQuery()}`);
  const rid = new URL(res.headers.get("location")!, "https://x").searchParams.get("rid")!;
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const loginRes = await h.app.request(
    `/mcp/oauth/login?rid=${rid}&provider=${options.provider ?? "google"}`,
    { headers: { cookie } },
  );
  const location = new URL(loginRes.headers.get("location")!);
  const state = location.searchParams.get("state")!;

  const row = await loadAuthRequest(handle.db, rid);
  return { rid, state, binding: row!.browserBindingHash!, cookie };
}

// ---------------------------------------------------------------------------
// consumeProviderCallback：五种 reason 逐项
// ---------------------------------------------------------------------------

describe("consumeProviderCallback 的拒绝原因必须精确", () => {
  it("未知 state → unknown_state", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    const out = await consumeProviderCallback(handle.db, {
      provider: "google",
      state: "never-issued",
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(out).toEqual({ ok: false, reason: "unknown_state" });
  });

  it("provider 不匹配 → provider_mismatch（不是 consumed）", async () => {
    // 这条是 M6 的判据：把读阶段的 provider 比较删掉后，UPDATE 会因 WHERE 里的
    // provider 判据命中 0 行，于是返回 `consumed` —— 与正确实现区分得开。
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h, { provider: "google" });

    const out = await consumeProviderCallback(handle.db, {
      provider: "github",
      state: started.state,
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(out).toEqual({ ok: false, reason: "provider_mismatch" });

    // 而且合法流程没有被破坏（跨 provider 的尝试不该消费掉它）。
    const after = await loadAuthRequest(handle.db, started.rid);
    expect(after!.providerConsumedAt).toBeNull();
  });

  it("已消费 → consumed", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    const first = await consumeProviderCallback(handle.db, {
      provider: "google",
      state: started.state,
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(first.ok).toBe(true);

    const second = await consumeProviderCallback(handle.db, {
      provider: "google",
      state: started.state,
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(second).toEqual({ ok: false, reason: "consumed" });
  });

  it("已过期 → expired，并带上 rid（调用方要删行）", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${started.rid}`;

    const out = await consumeProviderCallback(handle.db, {
      provider: "google",
      state: started.state,
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(out).toMatchObject({ ok: false, reason: "expired", rid: started.rid });
  });

  it("绑定不匹配 → binding_mismatch，并带上 rid", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    const out = await consumeProviderCallback(handle.db, {
      provider: "google",
      state: started.state,
      bindingHash: browserBindingHash("z".repeat(43)),
      now: new Date(),
    });
    expect(out).toMatchObject({ ok: false, reason: "binding_mismatch", rid: started.rid });
    // 没有被消费：删行由调用方做（它要同时写审计）。
    const after = await loadAuthRequest(handle.db, started.rid);
    expect(after!.providerConsumedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 并发：用行锁让两条调用**必然**都读到「未消费」
// ---------------------------------------------------------------------------

async function backendPid(db: Database): Promise<number> {
  const rows = await db.execute<{ pid: number }>(drizzleSql`select pg_backend_pid() as pid`);
  const pid = (rows as unknown as { pid: number }[])[0]?.pid;
  if (typeof pid !== "number") throw new Error("could not read pg_backend_pid()");
  return pid;
}

/**
 * 等「至少 n 个后端正在等锁」。
 *
 * **不能用 `pg_blocking_pids(pid) = holderPid`**：行锁队列里第二个等待者的
 * 直接阻塞者可能是前一个等待者而不是 holder，于是那条查询只能数到 1
 * （这个坑是实测出来的，不是推测）。这里改成数「处于 Lock 等待态的后端」，
 * 与阻塞者是谁无关——我们要确认的事实是「两条 UPDATE 都已经进入等锁」。
 */
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

describe("并发消费：条件 UPDATE 是唯一判据", () => {
  it("两条调用都读到「未消费」时，恰好一条成功", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    // 外部事务先持住这一行的行锁。普通 SELECT 在 MVCC 下**不加锁**，
    // 所以两条并发调用仍能读到 consumed_at IS NULL；而它们的 UPDATE
    // 会一起阻塞在这里。
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockPid = 0;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const holding = handle.db.transaction(async (tx) => {
      lockPid = await backendPid(tx as unknown as Database);
      await tx.execute(
        drizzleSql`select 1 from mcp_auth_requests where id = ${started.rid} for update`,
      );
      signalLocked();
      await holdLock;
    });
    await locked;
    expect(lockPid).toBeGreaterThan(0);

    const call = () =>
      consumeProviderCallback(handle.db, {
        provider: "google",
        state: started.state,
        bindingHash: started.binding,
        now: new Date(),
      });

    const both = Promise.all([call(), call()]);
    let blocked = 0;
    try {
      // ★ 确定性判据：两条 UPDATE 都确实在等锁。
      // 「数到 2」意味着**两条都越过了读阶段** —— 正是要复现的交叠。
      blocked = await waitForLockWaiters(2);
    } finally {
      releaseLock();
      await holding.catch(() => undefined);
    }

    const results = await both;
    const ok = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);

    expect(blocked, "两条 UPDATE 应当都进入等锁状态").toBeGreaterThanOrEqual(2);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 失败的那条必须报 consumed（不是别的）：它唯一可能的原因就是
    // 条件 UPDATE 没命中。
    expect((rejected[0] as { reason: string }).reason).toBe("consumed");
  });

  // ---- 读与写之间的变化：条件 UPDATE 必须全部覆盖（Phase 1.3.1-C2b）----

  /**
   * 在「读已经通过、UPDATE 正阻塞」的那一刻改动这一行。
   *
   * 这是唯一能确定性复现「SELECT 与 UPDATE 之间被改」的做法：行锁让 UPDATE
   * 停在锁上，`pg_stat_activity` 让我们确认它**确实**已经停在锁上，然后才
   * 在持锁事务里改数据并提交。提交后 READ COMMITTED 会让那条 UPDATE 针对
   * 新版本重新求值 WHERE——这正是要验证的语义。
   */
  async function consumeWithConcurrentMutation(
    started: { rid: string; state: string; binding: string },
    mutate: (tx: Database) => Promise<void>,
  ) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });

    const holding = handle.db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`select 1 from mcp_auth_requests where id = ${started.rid} for update`,
      );
      signal();
      await held;
      await mutate(tx as unknown as Database);
    });
    await locked;

    const consuming = consumeProviderCallback(handle.db, {
      provider: "google",
      state: started.state,
      bindingHash: started.binding,
      now: new Date(),
    });
    try {
      const waiters = await waitForLockWaiters(1);
      expect(waiters, "UPDATE 必须已经进入等锁状态").toBeGreaterThanOrEqual(1);
    } finally {
      release();
      await holding;
    }
    return await consuming;
  }

  it("SELECT 与 UPDATE 之间过期 → 不消费（fail-closed）", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    const out = await consumeWithConcurrentMutation(started, async (tx) => {
      await tx.execute(
        drizzleSql`update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${started.rid}`,
      );
    });

    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe("consumed");
    // 没有被写成「已消费」——那一列一旦写上就再也不能重试。
    expect((await loadAuthRequest(handle.db, started.rid))!.providerConsumedAt).toBeNull();
  });

  it("SELECT 与 UPDATE 之间换了浏览器绑定 → 不消费", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    const out = await consumeWithConcurrentMutation(started, async (tx) => {
      await tx.execute(
        drizzleSql`update mcp_auth_requests set browser_binding_hash = ${"f".repeat(64)} where id = ${started.rid}`,
      );
    });

    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe("consumed");
    expect((await loadAuthRequest(handle.db, started.rid))!.providerConsumedAt).toBeNull();
  });

  it("SELECT 与 UPDATE 之间换了 Provider State → 不消费", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    const out = await consumeWithConcurrentMutation(started, async (tx) => {
      await tx.execute(
        drizzleSql`update mcp_auth_requests set provider_state_hash = ${hashProviderSecret("newer-state")} where id = ${started.rid}`,
      );
    });

    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe("consumed");
    expect((await loadAuthRequest(handle.db, started.rid))!.providerConsumedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteMismatchedProviderRequest：六个条件逐一
// ---------------------------------------------------------------------------

/**
 * 绑定失败后的清理必须是**条件删除**（Phase 1.3.1-C2b-R1）。
 *
 * 这一组把每个条件单独破坏一次，断言删除命中 0 行。路由层只能观察到 400，
 * 看不出是哪一个条件挡住了它——所以判据必须在这一层逐项钉死。
 */
describe("deleteMismatchedProviderRequest 的条件判据", () => {
  /** 传入「刚才读到」的值；调用方可以覆盖任意一项来模拟状态变化。 */
  async function cleanup(
    started: { rid: string; state: string; binding: string },
    overrides: Partial<{
      provider: "google" | "github";
      stateHash: string;
      storedBindingHash: string | null;
      now: Date;
    }> = {},
  ): Promise<boolean> {
    return deleteMismatchedProviderRequest(handle.db, {
      rid: started.rid,
      provider: overrides.provider ?? "google",
      stateHash: overrides.stateHash ?? hashProviderSecret(started.state),
      // `??` 会把显式传入的 null 当成「没传」而回退——这里必须区分。
      storedBindingHash: "storedBindingHash" in overrides
        ? (overrides.storedBindingHash ?? null)
        : started.binding,
      now: overrides.now ?? new Date(),
    });
  }

  it("全部条件都成立 → 删除一行", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    expect(await cleanup(started)).toBe(true);
    expect(await loadAuthRequest(handle.db, started.rid)).toBeUndefined();
  });

  it("Provider State 已被替换 → 不删除", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    await handle.sql`
      update mcp_auth_requests set provider_state_hash = ${hashProviderSecret("state-s2")}
       where id = ${started.rid}`;

    expect(await cleanup(started)).toBe(false);
    const row = await loadAuthRequest(handle.db, started.rid);
    expect(row).toBeTruthy();
    expect(row!.providerConsumedAt).toBeNull();
  });

  it("Provider 不一致 → 不删除", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h, { provider: "google" });

    expect(await cleanup(started, { provider: "github" })).toBe(false);
    expect(await loadAuthRequest(handle.db, started.rid)).toBeTruthy();
  });

  it("已经被正常回调消费 → 不删除", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    await handle.sql`
      update mcp_auth_requests set provider_consumed_at = now() where id = ${started.rid}`;

    expect(await cleanup(started)).toBe(false);
    expect(await loadAuthRequest(handle.db, started.rid)).toBeTruthy();
  });

  it("已经过期 → 不删除", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${started.rid}`;

    expect(await cleanup(started)).toBe(false);
    expect(await loadAuthRequest(handle.db, started.rid)).toBeTruthy();
  });

  it("浏览器绑定已经变化（预期值取的是旧的那个）→ 不删除", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    await handle.sql`
      update mcp_auth_requests set browser_binding_hash = ${"f".repeat(64)}
       where id = ${started.rid}`;

    // 预期绑定仍是「刚才读到的那个」——正是它挡住了这次删除。
    expect(await cleanup(started)).toBe(false);
    expect(await loadAuthRequest(handle.db, started.rid)).toBeTruthy();
  });

  it("行内绑定为 NULL 时按 NULL 匹配（可删除）", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    await handle.sql`
      update mcp_auth_requests set browser_binding_hash = null where id = ${started.rid}`;

    expect(await cleanup(started, { storedBindingHash: null })).toBe(true);
    expect(await loadAuthRequest(handle.db, started.rid)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bindBrowser / claimProvider 的 reason
// ---------------------------------------------------------------------------

describe("bindBrowser 的 TOFU 语义", () => {
  it("NULL 时首次绑定；同值再次进入是 alreadyBound；不同值 → binding_mismatch", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    // 重置绑定，回到「尚未绑定」
    await handle.db
      .update(mcpAuthRequests)
      .set({ browserBindingHash: null })
      .where(eq(mcpAuthRequests.id, started.rid));

    const first = await bindBrowser(handle.db, started.rid, started.binding, new Date());
    expect(first).toEqual({ ok: true, alreadyBound: false });

    const again = await bindBrowser(handle.db, started.rid, started.binding, new Date());
    expect(again).toEqual({ ok: true, alreadyBound: true });

    const other = await bindBrowser(handle.db, started.rid, browserBindingHash("q".repeat(43)), new Date());
    expect(other).toEqual({ ok: false, reason: "binding_mismatch" });
  });

  it("不存在的 rid → not_found；已过期 → expired", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    const missing = await bindBrowser(
      handle.db,
      "00000000-0000-0000-0000-000000000000",
      started.binding,
      new Date(),
    );
    expect(missing).toEqual({ ok: false, reason: "not_found" });

    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${started.rid}`;
    await handle.db
      .update(mcpAuthRequests)
      .set({ browserBindingHash: null })
      .where(eq(mcpAuthRequests.id, started.rid));
    const expired = await bindBrowser(handle.db, started.rid, started.binding, new Date());
    expect(expired).toEqual({ ok: false, reason: "expired" });
  });
});

describe("claimProvider 的占用语义", () => {
  it("首次占用成功；换 provider → provider_conflict；同 provider 允许重发", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);

    const again = await claimProvider(handle.db, {
      rid: started.rid,
      provider: "google",
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      // 每次重发都换一把新的 PR / nonce。
      expect(hashProviderSecret(again.claim.providerState)).toBeTruthy();
      expect(again.claim.providerState).not.toBe(started.state);
    }

    const conflict = await claimProvider(handle.db, {
      rid: started.rid,
      provider: "github",
      bindingHash: started.binding,
      now: new Date(),
    });
    expect(conflict).toEqual({ ok: false, reason: "provider_conflict" });
  });

  it("绑定不对 → binding_mismatch（不会替别人启动 Provider 流程）", async () => {
    const h = await createMcpOAuthHarness();
    const started = await seedClaimedRequest(h);
    const out = await claimProvider(handle.db, {
      rid: started.rid,
      provider: "google",
      bindingHash: browserBindingHash("w".repeat(43)),
      now: new Date(),
    });
    expect(out).toEqual({ ok: false, reason: "binding_mismatch" });
  });
});

describe("validateAuthorizeParams 的判据", () => {
  const base = {
    responseType: "code",
    clientId: "test-client",
    redirectUri: "https://client.example/callback",
    scope: "records:read",
    state: undefined,
    codeChallenge: "a".repeat(43),
    codeChallengeMethod: "S256",
    resource: RESOURCE,
  };

  it("合法输入返回归一化结果（state 缺省 → null）", async () => {
    await seedAuthorizeClient(handle);
    const out = await validateAuthorizeParams(handle.db, { baseUrl: "https://gateway.example" }, base);
    expect(out).toMatchObject({
      clientId: "test-client",
      clientName: "Test Client",
      redirectUri: "https://client.example/callback",
      scope: ["records:read"],
      state: null,
      codeChallenge: "a".repeat(43),
    });
  });

  it("state 为空串也归一成 null（不写空串）", async () => {
    await seedAuthorizeClient(handle);
    const out = await validateAuthorizeParams(
      handle.db,
      { baseUrl: "https://gateway.example" },
      { ...base, state: "" },
    );
    expect(out.state).toBeNull();
  });

  it("每一项都能独立触发拒绝", async () => {
    await seedAuthorizeClient(handle);
    const cases: Array<[string, Partial<typeof base>]> = [
      ["responseType", { responseType: "token" }],
      ["clientId", { clientId: "nope" }],
      ["redirectUri", { redirectUri: "https://client.example/callback/" }],
      ["scope", { scope: "records:write" }],
      ["codeChallenge", { codeChallenge: "short" }],
      ["codeChallengeMethod", { codeChallengeMethod: "plain" }],
      ["resource", { resource: `${RESOURCE}/` }],
    ];
    for (const [label, patch] of cases) {
      await expect(
        validateAuthorizeParams(handle.db, { baseUrl: "https://gateway.example" }, { ...base, ...patch }),
        label,
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });
});
