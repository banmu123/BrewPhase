import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../helpers/harness.js";
import {
  accessTokenFor,
  confirmViaApi,
  createTestUser,
  postJson,
  registerViaApi,
  type RegisteredDevice,
} from "../helpers/mcp-devices.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { MAX_CONFIRM_ATTEMPTS } from "../../src/mcp-devices/service.js";

/**
 * `POST /mcp-devices/:id/confirm`（协议 §3.3）。
 *
 * 三个重点：
 * 1. 别人的设备必须与「不存在」**完全一致**（同状态码、同错误码）
 * 2. 确认码错误要原子累计，达到上限锁行
 * 3. 已 active 幂等成功，但 revoked/suspended 不能被确认
 */

let h: Harness;
let userId: string;
let token: string;
let device: RegisteredDevice;

beforeEach(async () => {
  resetRateLimiter();
  h = await createHarness();
  userId = await createTestUser(h);
  token = await accessTokenFor(h, userId);
  device = await registerViaApi(h, token);
});

async function statusOf(deviceId: string): Promise<string> {
  const rows = await h.db.sql<{ status: string }[]>`
    select status from mcp_devices where id = ${deviceId}`;
  return rows[0]?.status ?? "missing";
}

async function attemptsOf(deviceId: string): Promise<number> {
  const rows = await h.db.sql<{ confirm_attempts: number }[]>`
    select confirm_attempts from mcp_devices where id = ${deviceId}`;
  return rows[0]?.confirm_attempts ?? -1;
}

function wrongCode(correct: string): string {
  return correct === "000000" ? "111111" : "000000";
}

describe("POST /mcp-devices/:id/confirm", () => {
  it("正确确认码 → pending 变 active", async () => {
    const resp = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    expect(resp.status).toBe(200);
    expect((await resp.json() as { status: string }).status).toBe("active");
    expect(await statusOf(device.deviceId)).toBe("active");
  });

  it("确认码错误 → 400 invalid_confirm_code，计数 +1，状态仍 pending", async () => {
    const resp = await confirmViaApi(h, token, device.deviceId, wrongCode(device.confirmCode));
    expect(resp.status).toBe(400);
    expect((await resp.json() as { error: string }).error).toBe("invalid_confirm_code");
    expect(await attemptsOf(device.deviceId)).toBe(1);
    expect(await statusOf(device.deviceId)).toBe("pending");
  });

  it("错误次数达到上限 → 该行置 revoked（需重新注册）", async () => {
    for (let i = 0; i < MAX_CONFIRM_ATTEMPTS - 1; i += 1) {
      const resp = await confirmViaApi(h, token, device.deviceId, wrongCode(device.confirmCode));
      expect(resp.status).toBe(400);
    }
    expect(await statusOf(device.deviceId)).toBe("pending");

    const last = await confirmViaApi(h, token, device.deviceId, wrongCode(device.confirmCode));
    expect(last.status).toBe(400);
    expect(await statusOf(device.deviceId)).toBe("revoked");
    expect(await attemptsOf(device.deviceId)).toBe(MAX_CONFIRM_ATTEMPTS);

    // 锁定之后即使给正确码也不能激活
    const after = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    expect(after.status).toBe(409);
    expect(await statusOf(device.deviceId)).toBe("revoked");
  });

  it("并发错误尝试不会超过上限（原子自增）", async () => {
    // 10 个并发错误码：允许最多到上限，但绝不能出现 attempts > 上限，
    // 也不能出现「读到 4 之后两个都写 5」导致的计数丢失。
    await Promise.all(
      Array.from({ length: 10 }, () =>
        confirmViaApi(h, token, device.deviceId, wrongCode(device.confirmCode)),
      ),
    );
    const attempts = await attemptsOf(device.deviceId);
    expect(attempts).toBeLessThanOrEqual(MAX_CONFIRM_ATTEMPTS);
    expect(attempts).toBeGreaterThan(0);
    expect(await statusOf(device.deviceId)).toBe("revoked");
  });

  it("过期 → 410 confirm_expired，且不激活", async () => {
    await h.db.sql`update mcp_devices set expires_at = now() - interval '1 second' where id = ${device.deviceId}`;
    const resp = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    expect(resp.status).toBe(410);
    expect((await resp.json() as { error: string }).error).toBe("confirm_expired");
    expect(await statusOf(device.deviceId)).toBe("pending");
  });

  it("别人的设备 → 404，且与「不存在的设备」响应完全一致", async () => {
    const otherId = await createTestUser(h, "Other");
    const otherToken = await accessTokenFor(h, otherId);

    const foreign = await confirmViaApi(h, otherToken, device.deviceId, device.confirmCode);
    const missing = await confirmViaApi(
      h,
      otherToken,
      "00000000-0000-4000-8000-0000000000ff",
      "123456",
    );

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // 状态码、错误码、错误文案全部一致：不能靠响应区分「存在但不是你的」
    expect(await foreign.clone().text()).toBe(await missing.clone().text());
    expect(await statusOf(device.deviceId)).toBe("pending");
  });

  it("已 active 再确认 → 200 幂等（不校验确认码）", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const again = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    expect(again.status).toBe(200);
    expect((await again.json() as { status: string }).status).toBe("active");

    // 即使给错码也成功：确认码在激活时已完成使命
    const withWrong = await confirmViaApi(h, token, device.deviceId, wrongCode(device.confirmCode));
    expect(withWrong.status).toBe(200);
  });

  it("已 revoked 的设备不能被确认", async () => {
    await h.db.sql`update mcp_devices set status = 'revoked', revoked_at = now() where id = ${device.deviceId}`;
    const resp = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    expect(resp.status).toBe(409);
    expect((await resp.json() as { error: string }).error).toBe("invalid_device_state");
  });

  it("确认码格式非法（非 6 位数字）→ 400，且不计入尝试次数", async () => {
    for (const bad of ["abc", "12345", "1234567", "12 34"]) {
      const resp = await postJson(h, `/mcp-devices/${device.deviceId}/confirm`, token, {
        confirm_code: bad,
      });
      expect(resp.status).toBe(400);
      expect((await resp.json() as { error: string }).error).toBe("invalid_request");
    }
    // 格式错误在 schema 层就被挡掉，不会消耗尝试次数
    expect(await attemptsOf(device.deviceId)).toBe(0);
    expect(await statusOf(device.deviceId)).toBe("pending");
  });

  it("并发两个正确码：都成功或都幂等，状态仍然是 active", async () => {
    const results = await Promise.all([
      confirmViaApi(h, token, device.deviceId, device.confirmCode),
      confirmViaApi(h, token, device.deviceId, device.confirmCode),
    ]);
    for (const resp of results) expect([200, 409]).toContain(resp.status);
    expect(results.some((resp) => resp.status === 200)).toBe(true);
    expect(await statusOf(device.deviceId)).toBe("active");
  });
});
