import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mcpDevices } from "../../src/db/schema.js";
import { makeConfirmCode } from "../../src/mcp-devices/service.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  accessTokenFor,
  authHeaders,
  confirmViaApi,
  createTestUser,
  claimViaApi,
  postJson,
  provisionActiveDevice,
  registerViaApi,
} from "../helpers/mcp-devices.js";
import { createHarness, type Harness } from "../helpers/harness.js";

/**
 * Phase 1.2B.1 对 Phase 1.2A 的三处收口。
 *
 * 三条的共同点：**都能在「只跑 1.2A 那套测试」时全绿**。
 * 它们不是回归，是覆盖缺口——所以每条都写了「为什么旧测试看不见」。
 */

describe("device_token 的过期语义（token_expires_at 而不是 expires_at）", () => {
  let h: Harness;
  let userId: string;
  let token: string;

  beforeEach(async () => {
    resetRateLimiter();
    h = await createHarness();
    userId = await createTestUser(h);
    token = await accessTokenFor(h, userId);
  });

  afterEach(async () => {
    await h.close();
  });

  /**
   * 这条用例是整组的关键：它把两个时间字段**同时**摆成一个过期、一个有效。
   *
   * 只要实现里读错了字段，结果就会翻转——而如果只测「已领取设备能连」，
   * 读 `expires_at` 和读 `token_expires_at` 在测试里都是「刚注册所以没过期」，
   * 两种实现都是绿的。
   */
  it("expires_at 已过期但 token_expires_at 仍有效：token 仍可用于认证", async () => {
    const device = await provisionActiveDevice(h, token);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3600_000);

    await h.db.db
      .update(mcpDevices)
      .set({ expiresAt: past, tokenExpiresAt: future })
      .where(eq(mcpDevices.id, device.deviceId));

    // 走真实的自暂停端点：它是唯一「只凭 device_token 就能调用」的已实现接口，
    // 因此可用作认证成功的可观测信号。
    const resp = await h.app.request(`/mcp-devices/${device.deviceId}/suspend`, {
      method: "POST",
      headers: authHeaders(device.deviceToken),
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { status: string }).status).toBe("suspended");
  });

  it("token_expires_at 已过期：即使 expires_at 还有效也必须拒绝", async () => {
    const device = await provisionActiveDevice(h, token);
    await h.db.db
      .update(mcpDevices)
      .set({
        expiresAt: new Date(Date.now() + 3600_000),
        tokenExpiresAt: new Date(Date.now() - 1000),
      })
      .where(eq(mcpDevices.id, device.deviceId));

    const resp = await h.app.request(`/mcp-devices/${device.deviceId}/suspend`, {
      method: "POST",
      headers: authHeaders(device.deviceToken),
    });
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: string }).error).toBe("device_unauthorized");

    const row = await h.db.db
      .select({ status: mcpDevices.status })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, device.deviceId));
    expect(row[0]?.status).toBe("active");
  });

  it("token_expires_at 为 null（历史数据）按已过期处理", async () => {
    const device = await provisionActiveDevice(h, token);
    await h.db.db
      .update(mcpDevices)
      .set({ tokenExpiresAt: null })
      .where(eq(mcpDevices.id, device.deviceId));

    const resp = await h.app.request(`/mcp-devices/${device.deviceId}/suspend`, {
      method: "POST",
      headers: authHeaders(device.deviceToken),
    });
    expect(resp.status).toBe(401);
  });
});

describe("suspend 的双重认证", () => {
  let h: Harness;
  let aliceId: string;
  let aliceToken: string;

  beforeEach(async () => {
    resetRateLimiter();
    h = await createHarness();
    aliceId = await createTestUser(h, "Alice");
    aliceToken = await accessTokenFor(h, aliceId);
  });

  afterEach(async () => {
    await h.close();
  });

  it("device_token 可以暂停它自己那台", async () => {
    const device = await provisionActiveDevice(h, aliceToken);
    const resp = await postJsonAsDevice(h, `/mcp-devices/${device.deviceId}/suspend`, device.deviceToken);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe("suspended");
  });

  it("device_token 不能暂停同用户的另一台设备（404，不区分存在性）", async () => {
    const first = await provisionActiveDevice(h, aliceToken);
    const second = await provisionActiveDevice(h, aliceToken);

    const resp = await postJsonAsDevice(h, `/mcp-devices/${second.deviceId}/suspend`, first.deviceToken);
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as { error: string }).error).toBe("device_not_found");

    // 目标设备状态未变——「拒绝了」与「什么都没发生」必须同时成立。
    const row = await h.db.db
      .select({ status: mcpDevices.status })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, second.deviceId));
    expect(row[0]?.status).toBe("active");
  });

  it("device_token 不能暂停其他用户的设备（同样是 404）", async () => {
    const bobId = await createTestUser(h, "Bob");
    const bobToken = await accessTokenFor(h, bobId);
    const bobDevice = await provisionActiveDevice(h, bobToken);
    const aliceDevice = await provisionActiveDevice(h, aliceToken);

    const resp = await postJsonAsDevice(h, `/mcp-devices/${bobDevice.deviceId}/suspend`, aliceDevice.deviceToken);
    expect(resp.status).toBe(404);

    const row = await h.db.db
      .select({ status: mcpDevices.status })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, bobDevice.deviceId));
    expect(row[0]?.status).toBe("active");
  });

  it("用户 Bearer 仍然可以暂停自己名下任意设备", async () => {
    const device = await provisionActiveDevice(h, aliceToken);
    const resp = await postJson(h, `/mcp-devices/${device.deviceId}/suspend`, aliceToken, {});
    expect(resp.status).toBe(200);
  });

  it("用户 Bearer 不能暂停其他用户的设备", async () => {
    const bobId = await createTestUser(h, "Bob");
    const bobToken = await accessTokenFor(h, bobId);
    const bobDevice = await provisionActiveDevice(h, bobToken);

    const resp = await postJson(h, `/mcp-devices/${bobDevice.deviceId}/suspend`, aliceToken, {});
    expect(resp.status).toBe(404);
  });

  it("无效的 Bearer 既不被当成设备凭据也不被当作用户凭据", async () => {
    const device = await provisionActiveDevice(h, aliceToken);
    // 形态像设备 token 但库里没有 → 401 device_unauthorized
    const resp = await h.app.request(`/mcp-devices/${device.deviceId}/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer bp_dev_AAAAAAAAAAAAAAAAAAAAAAAA", "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: string }).error).toBe("device_unauthorized");

    // 既不像设备 token 也不是合法 JWT → 401 invalid_token
    const junk = await h.app.request(`/mcp-devices/${device.deviceId}/suspend`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-token", "content-type": "application/json" },
    });
    expect(junk.status).toBe(401);
    expect(((await junk.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("已 suspended 再暂停是幂等 200（两种凭据都是）", async () => {
    const device = await provisionActiveDevice(h, aliceToken);
    const first = await postJsonAsDevice(h, `/mcp-devices/${device.deviceId}/suspend`, device.deviceToken);
    expect(first.status).toBe(200);
    const second = await postJsonAsDevice(h, `/mcp-devices/${device.deviceId}/suspend`, device.deviceToken);
    expect(second.status).toBe(200);
    const viaUser = await postJson(h, `/mcp-devices/${device.deviceId}/suspend`, aliceToken, {});
    expect(viaUser.status).toBe(200);
  });

  it("已 revoked 的设备两种凭据都不能暂停（409 / 401）", async () => {
    const device = await provisionActiveDevice(h, aliceToken);
    await h.db.db
      .update(mcpDevices)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(mcpDevices.id, device.deviceId));

    const viaUser = await postJson(h, `/mcp-devices/${device.deviceId}/suspend`, aliceToken, {});
    expect(viaUser.status).toBe(409);

    // 撤销不清 token_hash，所以设备能通过认证，但状态机不允许这条迁移。
    const viaDevice = await postJsonAsDevice(h, `/mcp-devices/${device.deviceId}/suspend`, device.deviceToken);
    expect(viaDevice.status).toBe(409);
  });
});

describe("确认码必须来自 CSPRNG", () => {
  it("形态恒为 6 位数字，且能覆盖到前导零", () => {
    const codes = Array.from({ length: 2000 }, () => makeConfirmCode());
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);

    // 前导零是 `padStart` 存在的唯一理由。2000 次里出现 `0xxxxx` 的期望约 200 次，
    // 一次都没有意味着实现其实返回的是数字再转字符串（前导零被吃掉）。
    expect(codes.some((code) => code.startsWith("0"))).toBe(true);
  });

  it("2000 次取值不塌缩（不只是「看起来随机」）", () => {
    // 这条不是为了做统计检验，而是廉价的可观测性：如果实现退化成
    // 低熵来源（时间戳取模、小周期 PRNG），重复率会明显上升。
    const codes = Array.from({ length: 2000 }, () => makeConfirmCode());
    expect(new Set(codes).size).toBeGreaterThan(1900);
    // 首位覆盖全部 10 个桶（2000 样本里每个桶期望 200 次）
    const firstDigits = new Set(codes.map((code) => code[0]));
    expect(firstDigits.size).toBe(10);
  });

  it("端到端仍返回 6 位码并能激活（CSPRNG 没有破坏正常路径）", async () => {
    resetRateLimiter();
    const h = await createHarness();
    try {
      const userId = await createTestUser(h);
      const token = await accessTokenFor(h, userId);
      const device = await registerViaApi(h, token);
      expect(device.confirmCode).toMatch(/^\d{6}$/);

      const confirmed = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
      expect(confirmed.status).toBe(200);
      const claimed = await claimViaApi(h, token, device.deviceId, device.claimSecret);
      expect(claimed.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("五次错误后行转 revoked，且对外始终是同一个错误码", async () => {
    resetRateLimiter();
    const h = await createHarness();
    try {
      const userId = await createTestUser(h);
      const token = await accessTokenFor(h, userId);
      const device = await registerViaApi(h, token);
      const wrong = device.confirmCode === "000000" ? "111111" : "000000";

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const resp = await confirmViaApi(h, token, device.deviceId, wrong);
        expect(resp.status).toBe(400);
        expect(((await resp.json()) as { error: string }).error).toBe("invalid_confirm_code");
      }

      const row = await h.db.db
        .select({ status: mcpDevices.status, attempts: mcpDevices.confirmAttempts })
        .from(mcpDevices)
        .where(eq(mcpDevices.id, device.deviceId));
      expect(row[0]?.attempts).toBe(5);
      expect(row[0]?.status).toBe("revoked");

      // 第 6 次（这次是对的）也只能得到「状态不允许」，不能暴露「已锁定」。
      const after = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
      expect(after.status).toBe(409);
    } finally {
      await h.close();
    }
  });
});

/** 用 `Authorization: Bearer bp_dev_…` 发一个无体 POST。 */
async function postJsonAsDevice(h: Harness, path: string, deviceToken: string): Promise<Response> {
  return await h.app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
  });
}
