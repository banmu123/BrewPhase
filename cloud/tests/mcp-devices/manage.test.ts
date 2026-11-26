import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../helpers/harness.js";
import {
  accessTokenFor,
  authHeaders,
  createTestUser,
  provisionActiveDevice,
  registerViaApi,
} from "../helpers/mcp-devices.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { mcpGrants } from "../../src/db/schema.js";

/**
 * 设备管理 API（协议 §3.5 / §4.0 状态机）。
 *
 * 三个重点：
 * 1. 用户只能看到自己的设备；别人的设备一律 404（与不存在不可区分）
 * 2. 状态机只能走合法边；`revoked` 是终态
 * 3. **撤销设备不删 grant**（安全运维 §4.1 规则 2）——这是「换电脑不用
 *    重新授权所有 AI 客户端」的基础
 */

let h: Harness;
let userId: string;
let token: string;

beforeEach(async () => {
  resetRateLimiter();
  h = await createHarness();
  userId = await createTestUser(h);
  token = await accessTokenFor(h, userId);
});

async function getDevice(deviceId: string, asToken = token): Promise<Response> {
  return await h.app.request(`/mcp-devices/${deviceId}`, { headers: authHeaders(asToken) });
}

async function listDevices(asToken = token): Promise<Response> {
  return await h.app.request("/mcp-devices", { headers: authHeaders(asToken) });
}

async function action(
  deviceId: string,
  verb: "suspend" | "resume",
  asToken = token,
): Promise<Response> {
  return await h.app.request(`/mcp-devices/${deviceId}/${verb}`, {
    method: "POST",
    headers: authHeaders(asToken),
  });
}

async function del(deviceId: string, asToken = token): Promise<Response> {
  return await h.app.request(`/mcp-devices/${deviceId}`, {
    method: "DELETE",
    headers: authHeaders(asToken),
  });
}

describe("GET /mcp-devices", () => {
  it("只返回当前用户的设备", async () => {
    const otherId = await createTestUser(h, "Other");
    const otherToken = await accessTokenFor(h, otherId);

    await registerViaApi(h, token, { name: "mine" });
    await registerViaApi(h, otherToken, { name: "theirs" });

    const mine = (await (await listDevices()).json()) as { devices: { name: string }[] };
    expect(mine.devices).toHaveLength(1);
    expect(mine.devices[0]?.name).toBe("mine");

    const theirs = (await (await listDevices(otherToken)).json()) as {
      devices: { name: string }[];
    };
    expect(theirs.devices).toHaveLength(1);
    expect(theirs.devices[0]?.name).toBe("theirs");
  });

  it("DTO 只含白名单字段：没有任何哈希或明文凭证", async () => {
    const device = await provisionActiveDevice(h, token);
    const resp = await listDevices();
    const text = await resp.clone().text();
    const body = (await resp.json()) as { devices: Record<string, unknown>[] };

    const allowed = new Set([
      "id",
      "name",
      "platform",
      "status",
      "public_key",
      "grant_epoch",
      "created_at",
      "token_issued_at",
      "token_expires_at",
      "last_seen_at",
      "revoked_at",
    ]);
    for (const key of Object.keys(body.devices[0] ?? {})) {
      expect(allowed.has(key)).toBe(true);
    }

    // 明文 token 与 claim_secret 绝不出现在列表里
    expect(text).not.toContain(device.deviceToken);
    expect(text).not.toContain(device.claimSecret);
    // 哈希字段名与值也都不出现
    for (const forbidden of [
      "token_hash",
      "confirm_code_hash",
      "claim_secret_hash",
      "tokenHash",
      "claimSecretHash",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // 确认码也不出现
    expect(text).not.toContain(device.confirmCode);
  });

  it("未认证 → 401", async () => {
    expect((await h.app.request("/mcp-devices")).status).toBe(401);
  });
});

describe("GET /mcp-devices/:id", () => {
  it("自己的设备可以读", async () => {
    const device = await registerViaApi(h, token);
    const resp = await getDevice(device.deviceId);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: string; status: string };
    expect(body.id).toBe(device.deviceId);
    expect(body.status).toBe("pending");
  });

  it("别人的设备 → 404，且与「不存在」逐字一致", async () => {
    const device = await registerViaApi(h, token);
    const otherId = await createTestUser(h, "Other");
    const otherToken = await accessTokenFor(h, otherId);

    const foreign = await getDevice(device.deviceId, otherToken);
    const missing = await getDevice("00000000-0000-4000-8000-0000000000ff", otherToken);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.clone().text()).toBe(await missing.clone().text());
  });
});

describe("状态机：suspend / resume / revoke", () => {
  it("active → suspended → active", async () => {
    const device = await provisionActiveDevice(h, token);

    const suspended = await action(device.deviceId, "suspend");
    expect(suspended.status).toBe(200);
    expect((await suspended.json() as { status: string }).status).toBe("suspended");

    const resumed = await action(device.deviceId, "resume");
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as { status: string }).status).toBe("active");
  });

  it("重复 suspend 幂等成功", async () => {
    const device = await provisionActiveDevice(h, token);
    await action(device.deviceId, "suspend");
    const again = await action(device.deviceId, "suspend");
    expect(again.status).toBe(200);
    expect((await again.json() as { status: string }).status).toBe("suspended");
  });

  it("pending 设备不能 suspend（状态机不允许）", async () => {
    const device = await registerViaApi(h, token);
    const resp = await action(device.deviceId, "suspend");
    expect(resp.status).toBe(409);
    expect((await resp.json() as { error: string }).error).toBe("invalid_device_state");
  });

  it("pending 设备不能 resume", async () => {
    const device = await registerViaApi(h, token);
    const resp = await action(device.deviceId, "resume");
    expect(resp.status).toBe(409);
  });

  it("revoked 是终态：不能 resume，也不能再 suspend", async () => {
    const device = await provisionActiveDevice(h, token);
    await del(device.deviceId);

    for (const verb of ["resume", "suspend"] as const) {
      const resp = await action(device.deviceId, verb);
      expect(resp.status).toBe(409);
      expect((await resp.json() as { error: string }).error).toBe("invalid_device_state");
    }
    expect(((await (await getDevice(device.deviceId)).json()) as { status: string }).status).toBe(
      "revoked",
    );
  });

  it("撤销 pending 设备也可以（用户取消注册）", async () => {
    const device = await registerViaApi(h, token);
    const resp = await del(device.deviceId);
    expect(resp.status).toBe(200);
    expect((await resp.json() as { status: string }).status).toBe("revoked");
  });

  it("重复撤销幂等成功", async () => {
    const device = await provisionActiveDevice(h, token);
    await del(device.deviceId);
    const again = await del(device.deviceId);
    expect(again.status).toBe(200);
    expect((await again.json() as { status: string }).status).toBe("revoked");
  });

  it("别人的设备不能 suspend / resume / 撤销（404）", async () => {
    const device = await provisionActiveDevice(h, token);
    const otherId = await createTestUser(h, "Other");
    const otherToken = await accessTokenFor(h, otherId);

    expect((await action(device.deviceId, "suspend", otherToken)).status).toBe(404);
    expect((await action(device.deviceId, "resume", otherToken)).status).toBe(404);
    expect((await del(device.deviceId, otherToken)).status).toBe(404);

    // 原用户视角状态没变
    const body = (await (await getDevice(device.deviceId)).json()) as { status: string };
    expect(body.status).toBe("active");
  });

  it("撤销后 revoked_at 被写入，行被保留（不删行）", async () => {
    const device = await provisionActiveDevice(h, token);
    await del(device.deviceId);

    const rows = await h.db.sql<{ status: string; revoked_at: Date | null }[]>`
      select status, revoked_at from mcp_devices where id = ${device.deviceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("revoked");
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it("**撤销设备不删除该用户的 grant**（两者正交）", async () => {
    const device = await provisionActiveDevice(h, token);
    const grantRows = await h.db.db
      .insert(mcpGrants)
      .values({
        userId,
        clientId: "chatgpt",
        clientName: "ChatGPT",
        scopes: ["records:read"],
        resource: "https://cloud.example/mcp",
      })
      .returning({ id: mcpGrants.id });
    const grantId = grantRows[0]?.id;
    expect(grantId).toBeTruthy();

    await del(device.deviceId);

    const after = await h.db.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_grants where id = ${grantId as string}`;
    expect(after[0]?.count).toBe("1");
    // 且 grant 未被撤销
    const revoked = await h.db.sql<{ revoked_at: Date | null }[]>`
      select revoked_at from mcp_grants where id = ${grantId as string}`;
    expect(revoked[0]?.revoked_at).toBeNull();
  });

  it("删除用户时设备与 grant 都级联删除（user 是两者唯一的父）", async () => {
    await provisionActiveDevice(h, token);
    await h.db.db.insert(mcpGrants).values({
      userId,
      clientId: "chatgpt",
      clientName: "ChatGPT",
      scopes: ["records:read"],
      resource: "https://cloud.example/mcp",
    });

    await h.db.sql`delete from users where id = ${userId}`;

    const devices = await h.db.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_devices`;
    const grants = await h.db.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_grants`;
    expect(devices[0]?.count).toBe("0");
    expect(grants[0]?.count).toBe("0");
  });
});
