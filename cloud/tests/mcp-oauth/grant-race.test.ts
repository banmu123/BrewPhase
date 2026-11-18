import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { MCP_TEST_PEPPER, seedMcpOAuthFixture } from "../helpers/mcp-oauth.js";
import {
  createMcpSession,
  revokeMcpSessionsByGrant,
  rotateMcpRefreshToken,
} from "../../src/mcp-oauth/sessions.js";
import { mcpGrants, mcpRefreshTokens, mcpSessions } from "../../src/db/schema.js";
import type { Database } from "../../src/db/client.js";

/**
 * Grant 撤销 × Session 创建的并发收口（Phase 1.3.1-C1）。
 *
 * ## 这一组为什么不能靠 sleep
 *
 * 要测的是「A 在 SELECT 与 INSERT 之间被 B 插进来」。用 `setTimeout` 去碰
 * 那个交错，测的是调度运气：机器快时永远碰不到（假绿），机器慢时碰到别的
 * 交错（偶发红）。
 *
 * 这里用**数据库行锁本身**当同步原语：先在外部事务里拿住 grant 行，
 * 再启动 createMcpSession（它必然阻塞在 `SELECT … FOR UPDATE` 上），
 * 然后用 `pg_blocking_pids()` 读到「确实有人在等这把锁」这个**事实**，
 * 最后提交/回滚外部事务并断言唯一合法结果。
 *
 * `pg_blocking_pids` 让「等锁」从「sleep 一会儿应该差不多了」变成一个可
 * 观测的确定性条件——没有它，测试只能靠时间猜。
 */

const handle = await getTestDb();

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * 等到有会话**确实**被 `blockerPid` 挡住。
 *
 * 这一步是整组的关键：它把「另一条协程已经走到 FOR UPDATE」变成可观测事实，
 * 之后我们才去提交 blocker。若不等这一步就提交，createMcpSession 可能还没
 * 开始（于是它读到的就是撤销后的状态），测试会变成「碰巧通过」。
 */
async function waitForBlockedSession(blockerPid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await handle.sql<{ count: string }[]>`
      select count(*)::text as count
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and ${blockerPid} = any(pg_blocking_pids(pid))`;
    if (Number(rows[0]?.count ?? "0") > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a session blocked by ${blockerPid} (${label})`);
}

/** 读当前连接自己的 backend pid。 */
async function backendPid(db: Database): Promise<number> {
  const rows = await db.execute<{ pid: number }>(drizzleSql`select pg_backend_pid() as pid`);
  const pid = (rows as unknown as { pid: number }[])[0]?.pid;
  if (typeof pid !== "number") throw new Error("could not read pg_backend_pid()");
  return pid;
}

async function grants(): Promise<Array<typeof mcpGrants.$inferSelect>> {
  return handle.db.select().from(mcpGrants);
}

async function sessions(): Promise<Array<typeof mcpSessions.$inferSelect>> {
  return handle.db.select().from(mcpSessions);
}

describe("撤销先拿到锁：创建必须被拒绝", () => {
  it("外部事务持 grant 行锁并撤销 → createMcpSession 阻塞 → 提交后读到 revoked 并拒绝", async () => {
    const f = await seedMcpOAuthFixture(handle);

    // 外部事务（扮演「Web 撤销授权」）：拿住 grant 行，标记撤销，撤会话。
    // 它**故意慢**——中间留一道 await，好让 createMcpSession 有机会冲进来。
    // 不给 createMcpSession 任何机会是另一条用例（下面那条）。
    let releaseRevoke!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    /**
     * 「grant 行锁已经拿到」的显式信号。
     *
     * 只等 `revokePid !== 0` 是**不够的**：pid 在事务刚开、`FOR UPDATE` 还没
     * 执行时就已经有值了。那时若立刻启动 createMcpSession，它可能先拿到锁，
     * 于是这条用例测的交错与名字里的相反——而且能通过，属于假绿。
     *
     * 这个 Deferred 在 `select ... for update` **返回之后**才 resolve，
     * 因此 await 它就等于「撤销方确实握着那把锁」。
     */
    let signalGrantLocked!: () => void;
    const grantLocked = new Promise<void>((resolve) => {
      signalGrantLocked = resolve;
    });

    let revokePid = 0;
    const revoking = handle.db.transaction(async (tx) => {
      revokePid = await backendPid(tx as unknown as Database);
      await tx.execute(drizzleSql`select 1 from mcp_grants where id = ${f.grantId} for update`);
      // ← 到这一行，锁已经在撤销方手里了。
      signalGrantLocked();
      await tx
        .update(mcpGrants)
        .set({ revokedAt: f.clock.current() })
        .where(eq(mcpGrants.id, f.grantId));
      await tx.execute(
        drizzleSql`update mcp_sessions set revoked_at = now(), revoked_reason = 'grant_revoked' where grant_id = ${f.grantId} and revoked_at is null`,
      );
      await held;
    });

    // 等的是**锁**，不是 pid。
    await grantLocked;
    expect(revokePid).toBeGreaterThan(0);

    const creating = createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    // 把 creating 的失败先接住，避免 unhandled rejection。
    const creatingOutcome = creating.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // ★ 确定性判据：确实有一条会话被 revokePid 挡住。
    try {
      await waitForBlockedSession(revokePid, "createMcpSession blocked on grant FOR UPDATE");
    } finally {
      // **必须**在 finally 里放行：断言失败时若把持锁事务留在打开状态，
      // 后面所有用例的 truncate 都会等这把锁，失败会级联成一串 hook 超时，
      // 真正的错误反而被淹没。
      releaseRevoke();
      await revoking.catch(() => undefined);
    }
    const outcome = await creatingOutcome;
    // 撤销先提交 → 创建必须被拒。
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ code: "invalid_grant" });
    }

    // 库里没有任何 Session（创建的整笔事务回滚了）。
    expect(await sessions()).toHaveLength(0);
    expect(await handle.db.select().from(mcpRefreshTokens)).toHaveLength(0);
  });
});

describe("创建先拿到锁：撤销必须能看到并撤掉它", () => {
  it("createMcpSession 持有锁并已插入 → 撤销阻塞在 grant 行上 → 提交后撤到那条新 Session", async () => {
    const f = await seedMcpOAuthFixture(handle);

    // 要让「创建先拿到锁」成为事实，钩子必须放在**业务逻辑之后、提交之前**：
    // 那时 create 已经锁住 grant 行并插入了 session，但事务还没提交。
    // 把延时放在 fn 之前没有意义——那只是「还没开始」，撤销会先提交，
    // 于是退化成上一条用例的形状（两件事并不相同）。
    //
    // 这里包的是 drizzle 的 `transaction` 回调，属于**测试侧**的观测点：
    // 生产代码不知道它存在，也没有为它留任何入口。
    let createPid = 0;
    let signalInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    let releaseCommit!: () => void;
    const canCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });

    const wrappedDb = new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              createPid = await backendPid(tx as unknown as Database);
              // 业务逻辑全部跑完：grant 行已锁、session 与 token 已插入。
              const result = await fn(tx);
              signalInserted();
              // 停在这里不提交，等测试把撤销事务启动起来。
              await canCommit;
              return result;
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const creating = createMcpSession(
      { db: wrappedDb as Database, pepper: MCP_TEST_PEPPER, now: f.clock.now },
      { userId: f.userId, grantId: f.grantId, issuedScope: ["records:read"] },
    );
    await inserted;
    expect(createPid).toBeGreaterThan(0);

    // 撤销事务：先 UPDATE grant（会阻塞在创建事务的 FOR UPDATE 上），
    // 再撤该 grant 的会话。它必须等到创建提交后才继续，从而看到新行。
    let revokePid = 0;
    const revoking = handle.db.transaction(async (tx) => {
      revokePid = await backendPid(tx as unknown as Database);
      await tx.execute(
        drizzleSql`update mcp_grants set revoked_at = now() where id = ${f.grantId}`,
      );
      await tx.execute(
        drizzleSql`update mcp_sessions set revoked_at = now(), revoked_reason = 'grant_revoked' where grant_id = ${f.grantId} and revoked_at is null`,
      );
    });

    // ★ 确定性判据：撤销事务确实被创建事务挡在 grant 行上。
    // 若 createMcpSession 没有 FOR UPDATE，这里会超时（没有阻塞），
    // 后面的断言也就会在一个「撤销跑在插入之前」的世界里执行。
    let created: Awaited<typeof creating>;
    try {
      await waitFor(() => revokePid !== 0, "revoke transaction started");
      await waitForBlockedSession(createPid, "revoke blocked on grant FOR UPDATE");
    } finally {
      // 同前：断言失败也要放行，否则 create 的事务一直开着、后续 truncate 全挂。
      releaseCommit();
      created = await creating;
      await revoking.catch(() => undefined);
    }

    // 结果只能是：Session 存在，但**已被那次撤销扫到**。
    // 若撤销的 UPDATE 发生在提交之前（也就是没有行锁），它扫不到这一行，
    // 于是下面会是 revoked_at === null —— 那正是要防的第三种结果。
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.sessionId);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.revokedReason).toBe("grant_revoked");

    // 撤销 Grants 标记也在。
    const grantRows = await grants();
    expect(grantRows[0]?.revokedAt).not.toBeNull();

    // 那条 Session 再也刷不出新 token。
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("并发跑 8 次「创建 vs 撤销」：不存在「撤销完成后仍有有效 Session」的结果", async () => {
    // 前两条用例各钉住一个确定的交错。这一条做**批量重复**，覆盖
    // 「谁先拿到锁」由数据库调度决定的情形：无论怎么交错，不变量都必须成立。
    for (let round = 0; round < 8; round += 1) {
      await resetDb(handle);
      const f = await seedMcpOAuthFixture(handle, {
        clientId: `race-client-${round}`,
        userId: undefined,
      });

      const creating = createMcpSession(f.deps, {
        userId: f.userId,
        grantId: f.grantId,
        issuedScope: ["records:read"],
      }).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );

      const revoking = handle.db.transaction(async (tx) => {
        await tx.execute(
          drizzleSql`update mcp_grants set revoked_at = now() where id = ${f.grantId}`,
        );
        await tx.execute(
          drizzleSql`update mcp_sessions set revoked_at = now(), revoked_reason = 'grant_revoked' where grant_id = ${f.grantId} and revoked_at is null`,
        );
      });

      const [createdResult] = await Promise.all([creating, revoking]);
      const rows = await sessions();

      if (!createdResult.ok) {
        // 撤销赢了：不许有 Session。
        expect(rows, `round ${round}`).toHaveLength(0);
      } else {
        // 创建赢了：Session 必须已被撤销（撤销事务在它提交后重新读到它）。
        expect(rows, `round ${round}`).toHaveLength(1);
        expect(rows[0]?.revokedAt, `round ${round} 撤销完成后不能留下有效 Session`).not.toBeNull();
      }
    }
  });
});

describe("锁序不引入死锁", () => {
  it("创建与会话撤销并发 20 轮：没有 40P01（deadlock_detected）", async () => {
    // 锁序约定是「grant 行 → session 行」。revokeMcpSessionsByGrant 会锁
    // session 行；createMcpSession 会锁 grant 行再插 session 行。两者都先
    // 碰 grant（撤销路径由调用方先 UPDATE grant），所以不该形成环。
    //
    // 这条用例的价值是**在 PostgreSQL 真的报 40P01 时变红**，而不是靠
    // 阅读代码相信它不会。
    const errors: unknown[] = [];
    for (let round = 0; round < 20; round += 1) {
      await resetDb(handle);
      const f = await seedMcpOAuthFixture(handle, { clientId: `deadlock-${round}` });

      const creating = createMcpSession(f.deps, {
        userId: f.userId,
        grantId: f.grantId,
        issuedScope: ["records:read"],
      }).catch((error: unknown) => {
        errors.push(error);
        return null;
      });

      // 另一条路径：直接按 grant 撤会话（锁 session 行），同时撤 grant。
      const revoking = (async () => {
        await handle.db.transaction(async (tx) => {
          await tx.execute(
            drizzleSql`update mcp_grants set revoked_at = now() where id = ${f.grantId}`,
          );
          await revokeMcpSessionsByGrant(
            { db: tx as unknown as Database, pepper: MCP_TEST_PEPPER, now: f.clock.now },
            { grantId: f.grantId, reason: "grant_revoked" },
          );
        });
      })().catch((error: unknown) => {
        errors.push(error);
      });

      await Promise.all([creating, revoking]);
    }

    const deadlocks = errors.filter((error) => {
      const code = (error as { code?: string }).code;
      return code === "40P01";
    });
    expect(deadlocks, `unexpected deadlocks: ${JSON.stringify(errors.map((e) => (e as { code?: string }).code))}`).toHaveLength(0);
  });
});

/** 等一个可观察条件成立（只用于等真实事件，不用于「制造」并发）。 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
