import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  countRows,
  seedGrant,
  seedRefreshToken,
  seedSession,
  seedUser,
} from "../helpers/oauth-db.js";

/**
 * Phase 1.3.1-A：Refresh Token 的数据库约束。
 *
 * 这一组只回答一个问题：**「同一会话同时最多一条有效 refresh token」
 * 是不是库在保证**。如果这条只写在应用代码里，两个并发刷新就能各自签出
 * 一个有效 token，重放检测随之失去意义。
 */

const handle = await getTestDb();
const sql = handle.sql;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function sessionFixture(): Promise<{ userId: string; grantId: string; sessionId: string }> {
  const userId = await seedUser(sql);
  const grantId = await seedGrant(sql, userId);
  const sessionId = await seedSession(sql, { userId, grantId });
  return { userId, grantId, sessionId };
}

async function activeTokens(sessionId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from mcp_refresh_tokens
     where session_id = ${sessionId} and consumed_at is null`;
  return Number(rows[0]?.count ?? "0");
}

describe("「每个会话最多一条有效凭据」由数据库强制", () => {
  it("第一条有效 token 可以写，第二条被部分唯一索引拒绝", async () => {
    const { sessionId } = await sessionFixture();
    await seedRefreshToken(sql, { sessionId, tokenHash: "gen1", generation: 1 });
    expect(await activeTokens(sessionId)).toBe(1);

    await expect(
      seedRefreshToken(sql, { sessionId, tokenHash: "gen1-dup-active", generation: 2 }),
    ).rejects.toThrow(/mcp_refresh_tokens_session_active_uq/);

    // 失败的那次没有留下任何行。
    expect(await activeTokens(sessionId)).toBe(1);
    expect(await countRows(sql, "mcp_refresh_tokens")).toBe(1);
  });

  it("消费掉当前这代之后，下一代才能成为「当前」", async () => {
    const { sessionId } = await sessionFixture();
    const first = await seedRefreshToken(sql, { sessionId, tokenHash: "g1", generation: 1 });

    await sql`update mcp_refresh_tokens set consumed_at = now() where id = ${first}`;
    const second = await seedRefreshToken(sql, { sessionId, tokenHash: "g2", generation: 2 });

    expect(await activeTokens(sessionId)).toBe(1);
    const active = await sql<{ id: string }[]>`
      select id from mcp_refresh_tokens where session_id = ${sessionId} and consumed_at is null`;
    expect(active[0]?.id).toBe(second);
  });

  it("已消费的历史行可以有任意多条（重放检测要靠它们）", async () => {
    const { sessionId } = await sessionFixture();
    for (let generation = 1; generation <= 8; generation += 1) {
      await seedRefreshToken(sql, {
        sessionId,
        tokenHash: `history-${generation}`,
        generation,
        consumedAt: new Date(),
      });
    }
    await seedRefreshToken(sql, { sessionId, tokenHash: "current", generation: 9 });

    expect(await countRows(sql, "mcp_refresh_tokens")).toBe(9);
    expect(await activeTokens(sessionId)).toBe(1);
  });

  it("并发插入两条有效 token：恰好一条成功", async () => {
    const { sessionId } = await sessionFixture();
    const results = await Promise.allSettled([
      seedRefreshToken(sql, { sessionId, tokenHash: "race-a", generation: 1 }),
      seedRefreshToken(sql, { sessionId, tokenHash: "race-b", generation: 2 }),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const reason = (failed[0] as PromiseRejectedResult).reason as { code?: string; message?: string };
    // 23505 = unique_violation。断言错误码而不是文案：文案会随 PG 版本变，
    // 但「这条约束赢了竞争」这个事实不变。
    expect(reason.code).toBe("23505");
    expect(reason.message).toContain("mcp_refresh_tokens_session_active_uq");
    expect(await activeTokens(sessionId)).toBe(1);
  });

  it("不同会话各自有自己的有效 token（索引是 per-session 的）", async () => {
    const userId = await seedUser(sql);
    const grantId = await seedGrant(sql, userId);
    const a = await seedSession(sql, { userId, grantId });
    const b = await seedSession(sql, { userId, grantId });

    await seedRefreshToken(sql, { sessionId: a, tokenHash: "a1", generation: 1 });
    await seedRefreshToken(sql, { sessionId: b, tokenHash: "b1", generation: 1 });

    expect(await activeTokens(a)).toBe(1);
    expect(await activeTokens(b)).toBe(1);
  });
});

describe("轮换与级联删除", () => {
  it("一次典型轮换：旧代不删、标 consumed_at，新代接上", async () => {
    const { sessionId } = await sessionFixture();
    const gen1 = await seedRefreshToken(sql, { sessionId, tokenHash: "r1", generation: 1 });

    // 模拟未来服务端的轮换事务（1.3.1-B 会实现，这里只验证结构允许它）。
    const gen2 = await sql.begin(async (tx) => {
      await tx`update mcp_refresh_tokens set consumed_at = now() where id = ${gen1}`;
      const rows = await tx<{ id: string }[]>`
        insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at, replaced_by)
        values (${sessionId}, 'r2', 2, now() + interval '30 days', null)
        returning id`;
      const nextId = rows[0]?.id as string;
      await tx`update mcp_refresh_tokens set replaced_by = ${nextId} where id = ${gen1}`;
      return nextId;
    });

    const rows = await sql<{ id: string; consumed_at: Date | null; replaced_by: string | null }[]>`
      select id, consumed_at, replaced_by from mcp_refresh_tokens
       where session_id = ${sessionId} order by generation`;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.consumed_at).not.toBeNull();
    expect(rows[0]?.replaced_by).toBe(gen2);
    expect(rows[1]?.consumed_at).toBeNull();
  });

  it("删除会话即删除它的全部代凭据（历史行也不留）", async () => {
    const userId = await seedUser(sql);
    const grantId = await seedGrant(sql, userId);
    const doomed = await seedSession(sql, { userId, grantId });
    const keeper = await seedSession(sql, { userId, grantId });

    await seedRefreshToken(sql, { sessionId: doomed, tokenHash: "d1", generation: 1, consumedAt: new Date() });
    await seedRefreshToken(sql, { sessionId: doomed, tokenHash: "d2", generation: 2 });
    await seedRefreshToken(sql, { sessionId: keeper, tokenHash: "k1", generation: 1 });

    await sql`delete from mcp_sessions where id = ${doomed}`;

    expect(await countRows(sql, "mcp_refresh_tokens")).toBe(1);
    const left = await sql<{ session_id: string }[]>`
      select session_id from mcp_refresh_tokens`;
    expect(left[0]?.session_id).toBe(keeper);
  });

  it("孤儿插入被外键拒绝（session 不存在）", async () => {
    await expect(
      sql`insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at)
          values (gen_random_uuid(), 'orphan', 1, now() + interval '30 days')`,
    ).rejects.toThrow(/mcp_refresh_tokens_session_id_mcp_sessions_id_fk/);
  });
});
