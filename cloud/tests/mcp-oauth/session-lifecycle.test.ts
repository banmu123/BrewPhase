import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { DAY_MS, MCP_TEST_PEPPER, seedMcpOAuthFixture } from "../helpers/mcp-oauth.js";
import {
  createMcpSession,
  getMcpSessionState,
  revokeMcpSession,
  revokeMcpSessionsByGrant,
  rotateMcpRefreshToken,
} from "../../src/mcp-oauth/sessions.js";
import { authSessions, mcpDevices, mcpGrants, mcpRefreshTokens, mcpSessions } from "../../src/db/schema.js";
import {
  createSession,
  logoutByRefreshToken,
  rotateRefreshToken as rotateDesktopRefreshToken,
} from "../../src/sessions/session-service.js";
import { sha256Hex } from "../../src/security/crypto.js";

/**
 * Session 生命周期与三方隔离（设计 §9.11 / §12 的 B3 组）。
 *
 * 「隔离」是这一组真正的主题：MCP 会话、Desktop 登录会话、设备凭据是三个
 * 互不相干的域，任一方的撤销都不该波及另两方。§9.11 那张矩阵是 OQ-3 的
 * 验收本体，任何一行出现跨列联动即违反决策。
 */

const handle = await getTestDb();

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function sessions(): Promise<Array<typeof mcpSessions.$inferSelect>> {
  return handle.db.select().from(mcpSessions);
}

describe("Session 身份稳定", () => {
  it("sid 创建后稳定，刷新不产生第二条 Session", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    let token = created.refreshToken;
    for (let i = 0; i < 3; i += 1) {
      f.clock.advance(60_000);
      const rotated = await rotateMcpRefreshToken(f.deps, { refreshToken: token });
      expect(rotated.sessionId).toBe(created.sessionId);
      token = rotated.refreshToken;
    }

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.sessionId);
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it("正常刷新不延长 90 天期限，也不换 client/resource", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const before = (await sessions())[0]!;

    f.clock.advance(30 * DAY_MS - 1000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    const after = (await sessions())[0]!;
    expect(after.absoluteExpiresAt.getTime()).toBe(before.absoluteExpiresAt.getTime());
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.clientId).toBe(before.clientId);
    expect(after.resource).toBe(before.resource);
    expect(after.issuedScope).toEqual(before.issuedScope);
  });

  it("四条状态判定：active / revoked / expired / missing", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    expect(await getMcpSessionState(handle.db, created.sessionId, f.clock.current())).toBe(
      "active",
    );
    expect(
      await getMcpSessionState(handle.db, "00000000-0000-0000-0000-000000000000", f.clock.current()),
    ).toBe("missing");
    expect(
      await getMcpSessionState(handle.db, created.sessionId, new Date(
        f.clock.current().getTime() + 90 * DAY_MS + 1,
      )),
    ).toBe("expired");

    await revokeMcpSession(f.deps, { sessionId: created.sessionId, reason: "user_revoke" });
    // 已撤销优先于已过期：两者都成立时，「被人撤销」信息量更大。
    expect(
      await getMcpSessionState(handle.db, created.sessionId, new Date(
        f.clock.current().getTime() + 91 * DAY_MS,
      )),
    ).toBe("revoked");
  });
});

describe("撤销语义", () => {
  it("撤销只打标记，不删 Session 也不删历史 token", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(60_000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    const result = await revokeMcpSession(f.deps, {
      sessionId: created.sessionId,
      reason: "client_revoke",
    });
    expect(result.revoked).toBe(true);

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.revokedReason).toBe("client_revoke");
    // 两代 token 都还在。
    expect(
      await handle.db
        .select({ id: mcpRefreshTokens.id })
        .from(mcpRefreshTokens)
        .where(eq(mcpRefreshTokens.sessionId, created.sessionId)),
    ).toHaveLength(2);
  });

  it("重复撤销是幂等的：第二次返回 false，不覆盖原因", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    expect((await revokeMcpSession(f.deps, { sessionId: created.sessionId, reason: "user_revoke" })).revoked).toBe(true);
    expect((await revokeMcpSession(f.deps, { sessionId: created.sessionId, reason: "grant_revoked" })).revoked).toBe(false);

    // 第一次的原因保留：撤销原因是历史事实，不是可覆盖的当前值。
    expect((await sessions())[0]?.revokedReason).toBe("user_revoke");
  });

  it("按 Grant 撤销：影响该 Grant 的全部 Session，不影响其它 Grant", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const other = await seedMcpOAuthFixture(handle, { clientId: "other-grant-client" });

    // 同一 Grant 上三条会话（多次授权 / 多客户端实例）。
    const sameGrant = [];
    for (let i = 0; i < 3; i += 1) {
      sameGrant.push(
        await createMcpSession(f.deps, {
          userId: f.userId,
          grantId: f.grantId,
          issuedScope: ["records:read"],
        }),
      );
    }
    const untouched = await createMcpSession(other.deps, {
      userId: other.userId,
      grantId: other.grantId,
      issuedScope: ["records:read"],
    });

    const result = await revokeMcpSessionsByGrant(f.deps, {
      grantId: f.grantId,
      reason: "grant_revoked",
    });
    expect(result.revokedCount).toBe(3);

    const revoked = await handle.db
      .select()
      .from(mcpSessions)
      .where(eq(mcpSessions.grantId, f.grantId));
    expect(revoked).toHaveLength(3);
    expect(revoked.every((row) => row.revokedAt !== null)).toBe(true);
    expect(revoked.every((row) => row.revokedReason === "grant_revoked")).toBe(true);

    // 另一个 Grant 的会话不受影响。
    const stillActive = await getMcpSessionState(
      handle.db,
      untouched.sessionId,
      other.clock.current(),
    );
    expect(stillActive).toBe("active");

    // 被撤的三条都无法刷新。
    for (const session of sameGrant) {
      await expect(
        rotateMcpRefreshToken(f.deps, { refreshToken: session.refreshToken }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    }
  });

  it("撤销 Grant 时不删除 Grant 行（撤销 ≠ 删除）", async () => {
    const f = await seedMcpOAuthFixture(handle);
    await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    // 应用层的「撤销授权」= 打标记 + 撤会话，两步都在，但没有 DELETE。
    await handle.db
      .update(mcpGrants)
      .set({ revokedAt: f.clock.current() })
      .where(eq(mcpGrants.id, f.grantId));
    await revokeMcpSessionsByGrant(f.deps, { grantId: f.grantId, reason: "grant_revoked" });

    expect(await handle.db.select().from(mcpGrants)).toHaveLength(1);
    expect(await sessions()).toHaveLength(1);
  });

  it("按 Grant 撤销可以嵌进调用方的事务（设计 §9.6 第 5 条要求原子）", async () => {
    const f = await seedMcpOAuthFixture(handle);
    await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    // 正常路径：两件事在同一事务里提交。
    await handle.db.transaction(async (tx) => {
      await tx
        .update(mcpGrants)
        .set({ revokedAt: f.clock.current() })
        .where(eq(mcpGrants.id, f.grantId));
      // 传进去的是 tx，不是 handle.db：函数自身不会再开一层事务，
      // 因此「grant 已撤、session 还能刷」的窗口在这里被关掉。
      await revokeMcpSessionsByGrant(
        { db: tx, pepper: MCP_TEST_PEPPER, now: f.clock.now },
        { grantId: f.grantId, reason: "grant_revoked" },
      );
    });

    expect((await sessions())[0]?.revokedAt).not.toBeNull();

    // 反证：外层回滚时，撤销与会话标记一起回滚——证明它没有被内部提前提交。
    const second = await seedMcpOAuthFixture(handle, { clientId: "rollback-client" });
    await createMcpSession(second.deps, {
      userId: second.userId,
      grantId: second.grantId,
      issuedScope: ["records:read"],
    });
    await expect(
      handle.db.transaction(async (tx) => {
        await revokeMcpSessionsByGrant(
          { db: tx, pepper: MCP_TEST_PEPPER, now: second.clock.now },
          { grantId: second.grantId, reason: "grant_revoked" },
        );
        throw new Error("caller aborted the transaction");
      }),
    ).rejects.toThrow("caller aborted");

    const rollbackRows = await handle.db
      .select()
      .from(mcpSessions)
      .where(eq(mcpSessions.grantId, second.grantId));
    expect(rollbackRows).toHaveLength(1);
    expect(rollbackRows[0]?.revokedAt).toBeNull();
  });
});

describe("三方隔离（§9.11 矩阵）", () => {
  /** 造一条真实的 Desktop 登录会话（走既有服务，不手写行）。 */
  async function seedDesktopSession(userId: string) {
    return createSession(
      handle.db,
      { pepper: MCP_TEST_PEPPER, ttlSeconds: 30 * 24 * 3600 },
      userId,
      { userAgent: "desktop-test", ipHash: sha256Hex("127.0.0.1") },
    );
  }

  it("MCP Session 撤销不影响 Desktop 登录会话", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const mcp = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const desktop = await seedDesktopSession(f.userId);

    await revokeMcpSession(f.deps, { sessionId: mcp.sessionId, reason: "user_revoke" });

    const desktopRows = await handle.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, desktop.sessionId));
    expect(desktopRows).toHaveLength(1);
    expect(desktopRows[0]?.revokedAt).toBeNull();

    // 而且 Desktop token 还能正常轮换（那一族没被动过）。
    const rotated = await rotateDesktopRefreshToken(
      handle.db,
      { pepper: MCP_TEST_PEPPER, ttlSeconds: 30 * 24 * 3600 },
      desktop.refreshToken,
      { userAgent: "desktop-test", ipHash: "" },
    );
    expect(rotated.sessionId).not.toBe(desktop.sessionId);
  });

  it("Desktop 登出（撤销整个 token family）不撤销 MCP Session", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const mcp = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    const desktop = await seedDesktopSession(f.userId);

    const logout = await logoutByRefreshToken(
      handle.db,
      { pepper: MCP_TEST_PEPPER },
      desktop.refreshToken,
      { userAgent: "desktop-test", ipHash: "" },
    );
    expect(logout.found).toBe(true);
    expect(logout.revokedCount).toBe(1);

    const mcpRows = await sessions();
    expect(mcpRows).toHaveLength(1);
    expect(mcpRows[0]?.revokedAt).toBeNull();

    // MCP token 仍可轮换 —— 这是「Desktop 登出不影响 MCP」最硬的证据。
    f.clock.advance(1000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: mcp.refreshToken }),
    ).resolves.toMatchObject({ sessionId: mcp.sessionId });
  });

  it("MCP 刷新不写 auth_sessions（两套表零耦合）", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });
    f.clock.advance(60_000);
    await rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken });

    expect(await handle.db.select().from(authSessions)).toHaveLength(0);
  });

  it("设备撤销不会被误当成 MCP OAuth Session 撤销", async () => {
    const f = await seedMcpOAuthFixture(handle);
    const created = await createMcpSession(f.deps, {
      userId: f.userId,
      grantId: f.grantId,
      issuedScope: ["records:read"],
    });

    // 造一台 active 设备，然后撤销它（安全运维 §4.1 规则 2：设备与 grant 正交）。
    const device = await handle.db
      .insert(mcpDevices)
      .values({
        userId: f.userId,
        name: "device",
        platform: "darwin",
        publicKey: "k",
        status: "revoked",
        confirmCodeHash: "h",
        claimSecretHash: "h",
        expiresAt: new Date(f.clock.current().getTime() + 300_000),
        revokedAt: f.clock.current(),
      })
      .returning({ id: mcpDevices.id });
    expect(device[0]?.id).toBeTruthy();

    expect(await getMcpSessionState(handle.db, created.sessionId, f.clock.current())).toBe(
      "active",
    );
    f.clock.advance(1000);
    await expect(
      rotateMcpRefreshToken(f.deps, { refreshToken: created.refreshToken }),
    ).resolves.toMatchObject({ sessionId: created.sessionId });
  });
});
