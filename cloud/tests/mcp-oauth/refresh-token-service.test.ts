import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeTestDb,
  ensureDatabaseOrThrow,
  getTestDb,
  resetDb,
} from "../helpers/db.js";
import { DAY_MS, MCP_TEST_PEPPER, seedMcpOAuthFixture } from "../helpers/mcp-oauth.js";
import {
  MCP_REFRESH_TOKEN_TTL_MS,
  createMcpSession,
  mcpRefreshTokenHash,
  rotateMcpRefreshToken,
} from "../../src/mcp-oauth/sessions.js";
import { refreshTokenHash } from "../../src/sessions/refresh-token.js";
import { mcpGrants, mcpRefreshTokens, mcpSessions, users } from "../../src/db/schema.js";

/**
 * Refresh Token 服务（设计 §12 的 B 组，≥14 条）。
 *
 * 全部跑在真实 PostgreSQL 上：这里被测的是**事务与行锁**，Mock 掉的数据库
 * 会把待验证的东西一并 Mock 掉（并发读写、部分唯一索引、READ COMMITTED 下
 * `FOR UPDATE` 的重读语义）。
 */

const handle = await getTestDb();

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function tokenRows(sessionId: string) {
  return handle.db
    .select()
    .from(mcpRefreshTokens)
    .where(eq(mcpRefreshTokens.sessionId, sessionId))
    .orderBy(mcpRefreshTokens.generation);
}

describe("签发", () => {
  it("首代 token 只存哈希，明文不出现在库里", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    // 256 bit 随机值的 base64url 形态：43 字符。
    expect(created.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await tokenRows(created.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.generation).toBe(1);
    expect(rows[0]?.consumedAt).toBeNull();
    expect(rows[0]?.tokenHash).toBe(mcpRefreshTokenHash(MCP_TEST_PEPPER, created.refreshToken));

    // 明文一个字节都不该进库：既能按值查不到，也查不到任何包含它的行。
    const byValue = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens
       where token_hash = ${created.refreshToken}`;
    expect(byValue[0]?.count).toBe("0");
    const bySubstring = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens
       where token_hash like '%' || ${created.refreshToken} || '%'`;
    expect(bySubstring[0]?.count).toBe("0");
  });

  it("哈希域是 mcp-refresh，与 Desktop 的 refresh-token 域不通", async () => {
    const raw = "same-raw-token-value";
    const mcpHash = mcpRefreshTokenHash(MCP_TEST_PEPPER, raw);
    const desktopHash = refreshTokenHash(MCP_TEST_PEPPER, raw);

    expect(mcpHash).not.toBe(desktopHash);
    // 同一个 pepper 下两个域互不相通：一条 Desktop token 的哈希绝不会与
    // 某条 MCP token 的哈希相等，跨域重放在结构上不可能。
    expect(mcpHash).toBe(mcpRefreshTokenHash(MCP_TEST_PEPPER, raw));
  });

  it("首代有效期 = min(now+30d, absolute)", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read", "coffee:read"],
    });

    const rows = await tokenRows(created.sessionId);
    const token = rows[0];
    expect(token).toBeTruthy();
    expect(token!.expiresAt.getTime()).toBe(f.clock.current().getTime() + MCP_REFRESH_TOKEN_TTL_MS);
    // 90 天内，所以 30 天上限生效，没有被绝对期限夹到。
    expect(token!.expiresAt.getTime()).toBeLessThan(created.absoluteExpiresAt.getTime());

    const sessions = await handle.db.select().from(mcpSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.absoluteExpiresAt.getTime()).toBe(
      f.clock.current().getTime() + 90 * DAY_MS,
    );
    expect(sessions[0]?.issuedScope).toEqual(["records:read", "coffee:read"]);
    // client_id / resource 从 Grant 取，不受调用方影响。
    expect(sessions[0]?.clientId).toBe(f.clientId);
  });

  it("scope 必须是 Grant 的子集，且不能为空", async () => {
    const f = await seedMcpOAuthFixture(handle);

    await expect(
      createMcpSession(f.deps, {
        userId: f.userId,
        grantId: f.grantId,
        issuedScope: ["canvas:read"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await expect(
      createMcpSession(f.deps, { userId: f.userId, grantId: f.grantId, issuedScope: [] }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    // 失败后没有任何残留行。
    expect(await handle.db.select().from(mcpSessions)).toHaveLength(0);
    expect(await handle.db.select().from(mcpRefreshTokens)).toHaveLength(0);
  });

  it("不属于该用户的 Grant 无法创建 Session", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const other = await seedMcpOAuthFixture(handle, { clientId: "other-client" });

    await expect(
      createMcpSession(f.deps, {
        userId: f.userId,
        grantId: other.grantId,
        issuedScope: ["records:read"],
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await handle.db.select().from(mcpSessions)).toHaveLength(0);
  });

  it("已撤销的 Grant 无法创建 Session", async () => {
    const f = await seedMcpOAuthFixture(handle);
    await handle.db
      .update(mcpGrants)
      .set({ revokedAt: f.clock.current() })
      .where(eq(mcpGrants.id, f.grantId));

    await expect(
      createMcpSession(f.deps, {
        userId: f.userId,
        grantId: f.grantId,
        issuedScope: ["records:read"],
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("轮换", () => {
  it("正常轮换：旧代被消费、指向上新代，新代 generation+1", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    f.clock.advance(60_000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    expect(rotated.sessionId).toBe(created.sessionId);
    expect(rotated.generation).toBe(2);
    expect(rotated.refreshToken).not.toBe(created.refreshToken);

    const rows = await tokenRows(created.sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.consumedAt).not.toBeNull();
    expect(rows[0]?.replacedBy).toBe(rows[1]?.id);
    expect(rows[1]?.consumedAt).toBeNull();
    expect(rows[1]?.generation).toBe(2);
    // 旧行**保留**：重放检测要靠它。
    expect(rows[0]?.tokenHash).toBe(mcpRefreshTokenHash(MCP_TEST_PEPPER, created.refreshToken));
  });

  it("generation 单调递增，历史行全部保留", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    let token = created.refreshToken;
    for (let i = 0; i < 4; i += 1) {
      f.clock.advance(60_000);
      const next = await rotateMcpRefreshToken(f.deps, { refreshToken: token });
      expect(next.generation).toBe(i + 2);
      token = next.refreshToken;
    }

    const rows = await tokenRows(created.sessionId);
    expect(rows.map((r) => r.generation)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.filter((r) => r.consumedAt === null)).toHaveLength(1);
    expect(rows.at(-1)?.consumedAt).toBeNull();
  });

  it("任何时刻同一 Session 只有一条未消费 token", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(60_000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    const active = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens
       where session_id = ${created.sessionId} and consumed_at is null`;
    expect(active[0]?.count).toBe("1");

    // 直接插第二条未消费行必须被部分唯一索引挡住——这是「只能有一条」
    // 由库保证、而不是由应用自觉保证的证据。
    await expect(
      handle.sql`
        insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at)
        values (${created.sessionId}, 'forced-second-active', 99, now() + interval '30 days')`,
    ).rejects.toThrow(/mcp_refresh_tokens_session_active_uq/);
  });

  it("轮换返回的 effectiveScope 是 issued ∩ grant", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    // Grant 侧多给一个 coffee:read，但这次授权没勾选它 → 交集仍是单元素。
    f.clock.advance(1000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });
    expect(rotated.issuedScope).toEqual(["records:read"]);
    expect(rotated.effectiveScope).toEqual(["records:read"]);
  });
});

describe("并发与重放", () => {
  it("并发刷新同一个 token：恰好一个成功，会话不被撤销", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);

    const results = await Promise.allSettled([
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "invalid_grant" });

    // 会话仍 active；胜者的新 token 还能继续刷新。
    const sessions = await handle.db.select().from(mcpSessions);
    expect(sessions[0]?.revokedAt).toBeNull();
    const winner = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof rotateMcpRefreshToken>>>)
      .value;
    f.clock.advance(1000);
    const next = await rotateMcpRefreshToken(f.deps, { refreshToken: winner.refreshToken });
    expect(next.generation).toBe(3);
  });

  it("宽限期内重放：invalid_grant，但不撤销会话", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    // **必须让时钟走一段**再重放。若在同一毫秒重放，`sinceConsumedMs` 恰好是 0，
    // 于是「宽限窗口 = 0」这种错误实现也能通过——变异验证在这里发现过这个假绿。
    f.clock.advance(5_000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const sessions = await handle.db.select().from(mcpSessions);
    expect(sessions[0]?.revokedAt).toBeNull();
    expect(sessions[0]?.revokedReason).toBeNull();

    // 现役 token 仍可用 → 整条会话没被误杀。
    f.clock.advance(1000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: rotated.refreshToken }),
    ).resolves.toMatchObject({ generation: 3 });
  });

  it("宽限期外重放：撤销整条 Session，现役 token 同时失效", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    // 越过 30 秒宽限窗口。
    f.clock.advance(31_000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const sessions = await handle.db.select().from(mcpSessions);
    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[0]?.revokedReason).toBe("refresh_reuse");

    // 现役（尚未消费）的那代也刷新不了：撤销是会话级的。
    f.clock.advance(1000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: rotated.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("响应丢失后重试旧 token：不恢复新 token，也不新增行", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });
    const before = (await tokenRows(created.sessionId)).length;

    const retry = await rotateMcpRefreshToken(f.deps, {
      refreshToken: created.refreshToken,
    }).catch((err: unknown) => err);
    // 关键：拒绝是**抛错**，不是返回上一次的新 token。想「恢复」就必须
    // 在服务端暂存明文，而那违反「只存哈希」。
    expect(retry).not.toHaveProperty("refreshToken");
    expect(retry).toMatchObject({ code: "invalid_grant" });
    expect(await tokenRows(created.sessionId)).toHaveLength(before);
  });

  it("未知 token：统一 invalid_grant，且不写任何行", async () => {
    const f = await seedMcpOAuthFixture(handle);
    await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const before = (await handle.db.select().from(mcpRefreshTokens)).length;

    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: "not-a-real-token" }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    expect(await handle.db.select().from(mcpRefreshTokens)).toHaveLength(before);
  });

  it("四种拒绝路径的错误码与文案完全一致（不泄露内部状态）", async () => {
    // 这条是「统一 invalid_grant 安全语义」的验收本体：把
    // 不存在 / 过期 / 已消费（宽限内）/ 会话已撤销 四种情况放在一起，
    // 断言调用方**无法从错误里区分**它们。
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    // 注意每条都要用**自己的** deps：时钟与 pepper 都在 deps 里，
    // 拿 f.deps 去刷 other 的 token 会用到错误的「现在」（那样过期用例
    // 会因时钟还没推进而成功）。
    const collect = async (deps: typeof f.deps, token: string) => {
      const err = (await rotateMcpRefreshToken(deps, { refreshToken: token }).catch(
        (e: unknown) => e,
      )) as { code?: string; message?: string };
      return { code: err.code, message: err.message };
    };

    const unknown = await collect(f.deps, "no-such-token");

    // 已消费（宽限内）
    f.clock.advance(1000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });
    const consumed = await collect(f.deps, created.refreshToken);

    // 过期：另造一条会话，把时钟推到 31 天后
    const other = await seedMcpOAuthFixture(handle, { clientId: "expired-client" });
    const otherSession = await createMcpSession(other.deps, {
      userId: other.userId,
      grantId: other.grantId,
      issuedScope: ["records:read"],
    });
    other.clock.advance(31 * DAY_MS);
    const expired = await collect(other.deps, otherSession.refreshToken);

    // 会话已撤销
    const third = await seedMcpOAuthFixture(handle, { clientId: "revoked-client" });
    const thirdSession = await createMcpSession(third.deps, {
      userId: third.userId,
      grantId: third.grantId,
      issuedScope: ["records:read"],
    });
    await handle.db
      .update(mcpSessions)
      .set({ revokedAt: third.clock.current(), revokedReason: "user_revoke" })
      .where(eq(mcpSessions.id, thirdSession.sessionId));
    const revoked = await collect(third.deps, thirdSession.refreshToken);

    for (const result of [consumed, expired, revoked]) {
      expect(result).toEqual(unknown);
    }
    expect(unknown.code).toBe("invalid_grant");
  });
});

describe("前置条件变化后无法刷新", () => {
  it("会话已撤销 → invalid_grant", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    await handle.db
      .update(mcpSessions)
      .set({ revokedAt: f.clock.current(), revokedReason: "user_revoke" })
      .where(eq(mcpSessions.id, created.sessionId));

    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("用户状态非 active → invalid_grant", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    await handle.db.update(users).set({ status: "suspended" }).where(eq(users.id, f.userId));

    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("Grant 在会话创建之后被撤销 → invalid_grant（轮换自己回查，不依赖同步撤销）", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    // 只撤 grant、**不动** session：模拟「应用层同步撤销还没跑」或漏跑。
    await handle.db
      .update(mcpGrants)
      .set({ revokedAt: f.clock.current() })
      .where(eq(mcpGrants.id, f.grantId));

    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("单代 token 过期（30 天）→ invalid_grant，但会话本身还没到期", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(31 * DAY_MS);

    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    // 会话仍未撤销（token 过期不是安全事件）。
    const sessions = await handle.db.select().from(mcpSessions);
    expect(sessions[0]?.revokedAt).toBeNull();
  });
});

describe("审计", () => {
  it("签发/刷新写审计，且不含明文 token", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    const events = await handle.sql<{ event_type: string; detail: unknown }[]>`
      select event_type, detail from auth_events
       where event_type like 'mcp_%' order by created_at, event_type`;
    const types = events.map((e) => e.event_type);
    expect(types).toContain("mcp_session_created");
    expect(types).toContain("mcp_refresh_success");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(created.refreshToken);
    expect(serialized).not.toContain(rotated.refreshToken);
  });

  it("宽限内重试与宽限外盗用各写一条不同的安全事件", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(1000);
    const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    // 同样留出 5 秒，确保这一次落进宽限窗口而不是「恰好 0ms」。
    f.clock.advance(5_000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }).catch(() => {});
    f.clock.advance(31_000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }).catch(() => {});

    const counts = await handle.sql<{ event_type: string; count: string }[]>`
      select event_type, count(*)::text as count from auth_events
       where event_type in ('mcp_refresh_grace_reuse', 'mcp_refresh_reuse_detected', 'mcp_session_revoked')
       group by event_type order by event_type`;
    const byType = new Map(counts.map((c) => [c.event_type, Number(c.count)]));
    expect(byType.get("mcp_refresh_grace_reuse")).toBe(1);
    // 宽限外的那次是重放（会话此时仍 active，所以既记 reuse 又记 revoke）。
    expect(byType.get("mcp_refresh_reuse_detected")).toBe(1);
    expect(byType.get("mcp_session_revoked")).toBe(1);

    // 落库事实与审计一致
    const sessions = await handle.db.select().from(mcpSessions);
    expect(sessions[0]?.revokedReason).toBe("refresh_reuse");
    expect(rotated.sessionId).toBe(created.sessionId);
  });
});
