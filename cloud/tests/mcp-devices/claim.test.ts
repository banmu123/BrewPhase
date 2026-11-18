import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../helpers/harness.js";
import {
  accessTokenFor,
  claimViaApi,
  confirmViaApi,
  createTestUser,
  registerViaApi,
  type RegisteredDevice,
} from "../helpers/mcp-devices.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";

/**
 * `POST /mcp-devices/:id/credentials`（协议 §3.4）。
 *
 * 这是整个设备面里**唯一**把明文凭证交出去的地方，所以断言比别处更硬：
 * 每条失败路径都同时确认「库里没被写入 token_hash」——一次失败的领取如果
 * 顺手写了 token_hash，这台设备就永久无法领取了（`token_issued_at` 非空即拒）。
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

async function rowOf(deviceId: string): Promise<{
  status: string;
  token_hash: string | null;
  token_issued_at: Date | null;
  token_expires_at: Date | null;
}> {
  const rows = await h.db.sql<
    { status: string; token_hash: string | null; token_issued_at: Date | null; token_expires_at: Date | null }[]
  >`select status, token_hash, token_issued_at, token_expires_at from mcp_devices where id = ${deviceId}`;
  const row = rows[0];
  if (!row) throw new Error("device row missing");
  return row;
}

describe("POST /mcp-devices/:id/credentials", () => {
  it("正常领取：返回 bp_dev_ 前缀 token，库里只存哈希与到期时间", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);

    const resp = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { device_token: string; expires_at: number };

    expect(body.device_token).toMatch(/^bp_dev_[A-Za-z0-9_-]{16,}$/);
    expect(typeof body.expires_at).toBe("number");
    // 30 天后（允许 1 分钟误差）
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(body.expires_at - (Date.now() + thirtyDays))).toBeLessThan(60_000);

    const row = await rowOf(device.deviceId);
    expect(row.token_hash).not.toBeNull();
    // 明文绝不落库
    expect(row.token_hash).not.toBe(body.device_token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_issued_at).not.toBeNull();
    expect(row.token_expires_at).not.toBeNull();
  });

  it("pending 状态 → 202（可重试），且不写入 token", async () => {
    const resp = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { status: string; retry_after_ms: number };
    expect(body.status).toBe("pending");
    expect(body.retry_after_ms).toBe(1000);

    const row = await rowOf(device.deviceId);
    expect(row.token_hash).toBeNull();
    expect(row.token_issued_at).toBeNull();
  });

  it("缺少 claim_secret → 400，不写 token", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const resp = await h.app.request(`/mcp-devices/${device.deviceId}/credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
    expect((await rowOf(device.deviceId)).token_hash).toBeNull();
  });

  it("claim_secret 错误 → 403 claim_mismatch，不写 token", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const resp = await claimViaApi(
      h,
      token,
      device.deviceId,
      "wrong_claim_secret_000000000000",
    );
    expect(resp.status).toBe(403);
    expect((await resp.json() as { error: string }).error).toBe("claim_mismatch");
    expect((await rowOf(device.deviceId)).token_hash).toBeNull();
  });

  it("claim 错误优先级高于状态：pending + 错 claim → 403（不是 202）", async () => {
    // 若先判状态，攻击者能靠 202/403 的差别判断 claim 是否正确。
    const resp = await claimViaApi(h, token, device.deviceId, "wrong_claim_secret_000000000000");
    expect(resp.status).toBe(403);
  });

  it("过期 → 410 confirm_expired", async () => {
    await h.db.sql`update mcp_devices set expires_at = now() - interval '1 second' where id = ${device.deviceId}`;
    const resp = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(resp.status).toBe(410);
    expect((await rowOf(device.deviceId)).token_hash).toBeNull();
  });

  it("suspended → 409，不写 token", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    await h.db.sql`update mcp_devices set status = 'suspended' where id = ${device.deviceId}`;
    const resp = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(resp.status).toBe(409);
    expect((await resp.json() as { error: string }).error).toBe("invalid_device_state");
    expect((await rowOf(device.deviceId)).token_hash).toBeNull();
  });

  it("revoked → 404（与「不存在」一致，不确认它曾经存在过）", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    await h.db.sql`update mcp_devices set status = 'revoked', revoked_at = now() where id = ${device.deviceId}`;
    const resp = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(resp.status).toBe(404);
    expect((await rowOf(device.deviceId)).token_hash).toBeNull();
  });

  it("别人的设备 → 404，且与「不存在」响应逐字一致", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const otherId = await createTestUser(h, "Other");
    const otherToken = await accessTokenFor(h, otherId);

    const foreign = await claimViaApi(h, otherToken, device.deviceId, device.claimSecret);
    const missing = await claimViaApi(
      h,
      otherToken,
      "00000000-0000-4000-8000-0000000000ff",
      device.claimSecret,
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.clone().text()).toBe(await missing.clone().text());
    // 即使 claim_secret 正确也领不到：归属校验在 claim 校验之前
    expect((await rowOf(device.deviceId)).token_hash).toBeNull();
  });

  it("重复领取 → 409 credentials_already_issued，**不补发**", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const first = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(first.status).toBe(200);
    const firstToken = ((await first.json()) as { device_token: string }).device_token;

    const second = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    expect(second.status).toBe(409);
    expect((await second.json() as { error: string }).error).toBe("credentials_already_issued");
    // 第一次的 token 未被覆盖（哈希不变）
    const rows = await h.db.sql<{ token_hash: string }[]>`
      select token_hash from mcp_devices where id = ${device.deviceId}`;
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(firstToken);
  });

  it("并发领取：Promise.all 两个请求，**恰好一个** 200，另一个 409", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);

    const [a, b] = await Promise.all([
      claimViaApi(h, token, device.deviceId, device.claimSecret),
      claimViaApi(h, token, device.deviceId, device.claimSecret),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    // 只有一个 token 被发出；库里只有一份哈希
    const winner = a.status === 200 ? a : b;
    const body = (await winner.json()) as { device_token: string };
    expect(body.device_token).toMatch(/^bp_dev_/);
    const rows = await h.db.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_devices
       where id = ${device.deviceId} and token_issued_at is not null`;
    expect(rows[0]?.count).toBe("1");
  });

  it("更多并发也只成功一次", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimViaApi(h, token, device.deviceId, device.claimSecret)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it("claim_secret 不出现在任何响应里（包括成功响应的其它字段）", async () => {
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const resp = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    const text = await resp.clone().text();
    expect(text).not.toContain(device.claimSecret);
    expect(text).not.toContain("claim_secret");
  });
});
