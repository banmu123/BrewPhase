import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { DAY_MS, seedMcpOAuthFixture } from "../helpers/mcp-oauth.js";
import {
  MCP_SESSION_ABSOLUTE_TTL_MS,
  createMcpSession,
  getMcpSessionState,
  revokeMcpSession,
  rotateMcpRefreshToken,
} from "../../src/mcp-oauth/sessions.js";
import { mcpRefreshTokens, mcpSessions } from "../../src/db/schema.js";

/**
 * 90 天绝对期限（设计 §9.9 的 A1–A8）。
 *
 * 这一组是 Phase 1.3.1-B 的**最高优先级**：1.3.0 设计的原始缺陷就是
 * 「每次刷新新建一行 Session，`created_at` 随之重置」，于是
 * `min(now+30d, created_at+90d)` 永远到不了 90 天——会话可以无限续命。
 *
 * 这里全部用注入时钟验证，不 sleep：跨 4 个 30 天窗口的真实等待是 120 天。
 */

const handle = await getTestDb();

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function sessionRow(sessionId: string) {
  const rows = await handle.db.select().from(mcpSessions).where(eq(mcpSessions.id, sessionId));
  const row = rows[0];
  if (!row) throw new Error("session row missing");
  return row;
}

async function tokenCount(sessionId: string): Promise<number> {
  const rows = await handle.db
    .select({ id: mcpRefreshTokens.id })
    .from(mcpRefreshTokens)
    .where(eq(mcpRefreshTokens.sessionId, sessionId));
  return rows.length;
}

describe("A1/A2 连续刷新：sid 与绝对期限不变", () => {
  it("A1：连续 5 次刷新（每次间隔 1 小时）", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const absoluteBefore = (await sessionRow(created.sessionId)).absoluteExpiresAt.getTime();
    const createdAtBefore = (await sessionRow(created.sessionId)).createdAt.getTime();

    let token = created.refreshToken;
    for (let i = 0; i < 5; i += 1) {
      f.clock.advance(60 * 60 * 1000);
      const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: token });
      // sid 跨刷新不变：这是「正常轮换」与「授权被收回」能区分开的唯一依据。
      expect(rotated.sessionId).toBe(created.sessionId);
      token = rotated.refreshToken;
    }

    const after = await sessionRow(created.sessionId);
    expect(after.absoluteExpiresAt.getTime()).toBe(absoluteBefore);
    expect(after.createdAt.getTime()).toBe(createdAtBefore);
    // 起点 + 90 天，不是「最后一次刷新 + 90 天」。
    expect(absoluteBefore).toBe(createdAtBefore + MCP_SESSION_ABSOLUTE_TTL_MS);

    // 初始 + 5 代 = 6 行，前 5 行已被消费。
    const rows = await handle.db
      .select()
      .from(mcpRefreshTokens)
      .where(eq(mcpRefreshTokens.sessionId, created.sessionId))
      .orderBy(mcpRefreshTokens.generation);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.generation)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.slice(0, 5).every((r) => r.consumedAt !== null)).toBe(true);
    expect(rows[5]?.consumedAt).toBeNull();
  });

  it("A2：每一代的有效期都被绝对期限夹住", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    let token = created.refreshToken;
    for (let day = 7; day <= 84; day += 7) {
      f.clock.set(new Date(f.clock.current().getTime() + 7 * DAY_MS));
      const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: token });
      token = rotated.refreshToken;
    }

    const absolute = (await sessionRow(created.sessionId)).absoluteExpiresAt.getTime();
    const rows = await handle.db
      .select()
      .from(mcpRefreshTokens)
      .where(eq(mcpRefreshTokens.sessionId, created.sessionId));
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(row.expiresAt.getTime(), `generation ${row.generation}`).toBeLessThanOrEqual(absolute);
      // 也不能晚于自己的签发时刻 + 30 天。
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(row.createdAt.getTime() + 30 * DAY_MS);
    }
  });
});

describe("A3/A5 跨窗口刷新", () => {
  it("A3：跨 4 个 30 天窗口（第 29/58/87/89 天各刷新一次），绝对期限不变", async () => {
    // 设计原文写的是「+31d / +62d / +89d」，但单代 token 只有 30 天寿命：
    // 第 31 天时第一代**必然已经过期**，那次刷新只能是 token_expired。
    // 要跨窗口就必须在每代到期前刷新一次——所以取 29/58/87/89 天。
    // 语义（跨 4 个窗口后仍成功、绝对期限不变）与设计完全一致，这里修正的
    // 只是那三个数字与 30 天 TTL 的不自洽。
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const absolute = (await sessionRow(created.sessionId)).absoluteExpiresAt.getTime();
    const started = f.clock.current().getTime();

    let token = created.refreshToken;
    for (const day of [29, 58, 87, 89]) {
      f.clock.set(new Date(started + day * DAY_MS));
      const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: token });
      expect(rotated.sessionId).toBe(created.sessionId);
      token = rotated.refreshToken;
      expect((await sessionRow(created.sessionId)).absoluteExpiresAt.getTime()).toBe(absolute);
    }

    // 仍然只有一条 Session。
    expect(await handle.db.select().from(mcpSessions)).toHaveLength(1);
  });

  it("A5：第 89 天刷新，新 token 的到期时间恰好是绝对期限（不是 now+30d）", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const started = f.clock.current().getTime();
    const absolute = (await sessionRow(created.sessionId)).absoluteExpiresAt.getTime();
    // 走到第 89 天：中途必须先刷新，否则第一代在 30 天时就过期了。
    let token = created.refreshToken;
    for (const day of [29, 58, 87, 89]) {
      f.clock.set(new Date(started + day * DAY_MS));
      token = (await rotateMcpRefreshToken(f.deps, { refreshToken: token })).refreshToken;
    }

    const rows = await handle.db
      .select()
      .from(mcpRefreshTokens)
      .where(eq(mcpRefreshTokens.sessionId, created.sessionId))
      .orderBy(mcpRefreshTokens.generation);
    const current = rows.at(-1);
    expect(current).toBeTruthy();
    // 第 89 天签发，正常会是 now+30d（第 119 天），但被绝对期限（第 90 天）夹住。
    expect(current!.expiresAt.getTime()).toBe(absolute);
    expect(current!.expiresAt.getTime()).toBeLessThan(
      current!.createdAt.getTime() + 30 * DAY_MS,
    );
  });
});

describe("A4/A6/A7 到期、撤销、重放", () => {
  it("A4：第 90 天 +1 秒刷新失败，Session 判定为 expired", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const started = f.clock.current().getTime();
    let token = created.refreshToken;
    for (const day of [29, 58, 87, 89]) {
      f.clock.set(new Date(started + day * DAY_MS));
      token = (await rotateMcpRefreshToken(f.deps, { refreshToken: token })).refreshToken;
    }

    // 越过绝对上限 1 秒。
    f.clock.set(new Date(started + 90 * DAY_MS + 1000));
    await expect(rotateMcpRefreshToken(f.deps, { refreshToken: token })).rejects.toMatchObject({
      code: "invalid_grant",
    });

    // 过期不写 revoked_at：它是时间的函数，不是一次事件。
    const row = await sessionRow(created.sessionId);
    expect(row.revokedAt).toBeNull();
    expect(await getMcpSessionState(handle.db, created.sessionId, f.clock.current())).toBe(
      "expired",
    );
  });

  it("A6：撤销后刷新失败，且不新增任何 token 行", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const before = await tokenCount(created.sessionId);

    const revoked = await revokeMcpSession(f.deps, {
      sessionId: created.sessionId,
      reason: "user_revoke",
    });
    expect(revoked.revoked).toBe(true);

    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await tokenCount(created.sessionId)).toBe(before);
  });

  it("A7：宽限外重放 → 撤销 Session，全部代凭据一起失效", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    f.clock.advance(31_000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const row = await sessionRow(created.sessionId);
    expect(row.revokedReason).toBe("refresh_reuse");
    expect(await getMcpSessionState(handle.db, created.sessionId, f.clock.current())).toBe(
      "revoked",
    );

    // 未被消费的那一代也无法使用。
    f.clock.advance(1000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: rotated.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    // 历史行仍在（撤销不删数据）。
    expect(await tokenCount(created.sessionId)).toBe(2);
  });
});

describe("A8 没有任何 UPDATE 能碰不可变字段", () => {
  const SESSIONS_SRC = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "mcp-oauth",
    "sessions.ts",
  );

  it("静态扫描：所有 .set({...}) 都不含 createdAt / absoluteExpiresAt", () => {
    const src = readFileSync(SESSIONS_SRC, "utf8");
    // `.set(` 只出现在 UPDATE 语句里；把每个调用的参数块抽出来逐个检查。
    const blocks = [...src.matchAll(/\.set\(\{([\s\S]*?)\}\)/g)].map((m) => m[1] ?? "");
    expect(blocks.length).toBeGreaterThan(0); // 否则这条测试是空转

    for (const block of blocks) {
      expect(block).not.toContain("createdAt");
      expect(block).not.toContain("absoluteExpiresAt");
    }
  });

  /**
   * 去掉注释再扫。
   *
   * 源码里本来就有 `absolute_expires_at = created_at + 90 days` 这样的
   * **说明性**注释（它解释规则，不是执行规则）。不剥掉注释的话，这条静态
   * 扫描会永远红——而一条永远红的测试等于没有测试。
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  }

  it("静态扫描：不存在任何写 absolute_expires_at / created_at 的 SQL 片段", () => {
    const src = stripComments(readFileSync(SESSIONS_SRC, "utf8")).toLowerCase();
    // 只查「赋值」形态：`set absolute_expires_at = …` 或 `absolute_expires_at = …`。
    expect(src).not.toMatch(/set\s+absolute_expires_at\s*=/);
    expect(src).not.toMatch(/set\s+created_at\s*=/);
    expect(src).not.toMatch(/absolute_expires_at\s*=/);
    expect(src).not.toMatch(/created_at\s*=/);
  });

  it("运行期：5 次刷新后 Session 行除 last_used_at 外逐字段不变", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    const snapshot = async (): Promise<string> => {
      // 用裸 SQL 取全列，绕开 drizzle 的列投影：将来加列时这条断言自动覆盖新列。
      const rows = await handle.sql<Record<string, unknown>[]>`
        select * from mcp_sessions where id = ${created.sessionId}`;
      const row = { ...rows[0] };
      delete row.last_used_at;
      // Date 序列化成 ISO，逐字节可比的字符串。
      return JSON.stringify(row);
    };

    const before = await snapshot();
    let token = created.refreshToken;
    for (let i = 0; i < 5; i += 1) {
      f.clock.advance(3600_000);
      token = (await rotateMcpRefreshToken(f.deps, { refreshToken: token })).refreshToken;
    }
    expect(await snapshot()).toBe(before);

    // 反证：last_used_at 确实被推进了，否则上面的「不变」可能只是
    // 因为整条 UPDATE 根本没执行。
    const row = await sessionRow(created.sessionId);
    expect(row.lastUsedAt.getTime()).toBe(f.clock.current().getTime());
    expect(row.lastUsedAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
  });
});
