import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../helpers/harness.js";
import {
  accessTokenFor,
  createTestUser,
  makeRawPublicKey,
  postJson,
  registerViaApi,
} from "../helpers/mcp-devices.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { MAX_DEVICES_PER_USER } from "../../src/mcp-devices/service.js";

/**
 * `POST /mcp-devices/register`（协议 §3.2）。
 *
 * 断言不止看状态码：每条失败用例都同时确认「没有留下半成品行」——
 * 一个 400 之后库里多出一台 pending 设备，比返回 500 更难发现。
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

async function deviceCount(): Promise<number> {
  const rows = await h.db.sql<{ count: string }[]>`select count(*)::text as count from mcp_devices`;
  return Number(rows[0]?.count ?? "0");
}

describe("POST /mcp-devices/register", () => {
  it("正常注册：返回 device_id / 6 位确认码 / 32 字节 claim_secret / 300 秒", async () => {
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "My Mac",
      platform: "darwin",
      public_key: makeRawPublicKey(),
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;

    expect(typeof body.device_id).toBe("string");
    expect(body.confirm_code).toMatch(/^\d{6}$/);
    expect(body.expires_in).toBe(300);
    // 32 字节 base64url = 43 字符
    expect(typeof body.claim_secret).toBe("string");
    expect(Buffer.from(String(body.claim_secret), "base64url").length).toBe(32);

    // 库里必须是 pending，且只存哈希
    const rows = await h.db.sql<
      { status: string; token_hash: string | null; confirm_code_hash: string; claim_secret_hash: string }[]
    >`select status, token_hash, confirm_code_hash, claim_secret_hash from mcp_devices`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.token_hash).toBeNull();
    // 确认码与 claim_secret 的明文都不在库里
    expect(rows[0]?.confirm_code_hash).not.toBe(body.confirm_code);
    expect(rows[0]?.claim_secret_hash).not.toBe(body.claim_secret);
    // 两个哈希都是 64 位十六进制
    expect(rows[0]?.confirm_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.claim_secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("grant_epoch 默认为 0（契约值，不是「未初始化」）", async () => {
    await registerViaApi(h, token);
    const rows = await h.db.sql<{ grant_epoch: number }[]>`select grant_epoch from mcp_devices`;
    expect(rows[0]?.grant_epoch).toBe(0);
  });

  it("缺少 Authorization → 401，且不建行", async () => {
    const resp = await h.app.request("/mcp-devices/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "x",
        platform: "darwin",
        public_key: makeRawPublicKey(),
        app_version: "0.1.5",
      }),
    });
    expect(resp.status).toBe(401);
    expect((await resp.json() as { error: string }).error).toBe("invalid_token");
    expect(await deviceCount()).toBe(0);
  });

  it("无效用户 token → 401", async () => {
    for (const bad of ["not-a-jwt", "a.b.c"]) {
      const resp = await postJson(h, "/mcp-devices/register", bad, {
        name: "x",
        platform: "darwin",
        public_key: makeRawPublicKey(),
        app_version: "0.1.5",
      });
      expect(resp.status).toBe(401);
    }
    expect(await deviceCount()).toBe(0);
  });

  it("公钥解码后不是 32 字节 → 400 invalid_public_key", async () => {
    // 43 个合法字符但解码出 33 字节：base64url 的末位字符可携带多余 bit。
    const tooLong = Buffer.alloc(33, 7).toString("base64url");
    expect(tooLong).toHaveLength(44);
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "x",
      platform: "darwin",
      // 44 字符会被正则挡掉
      public_key: tooLong,
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(400);
    expect((await resp.json() as { error: string }).error).toBe("invalid_request");

    // 32 字节的正则合法字符，但用一个必然解出非 32 字节的短串
    const short = Buffer.alloc(31, 1).toString("base64url");
    const resp2 = await postJson(h, "/mcp-devices/register", token, {
      name: "x",
      platform: "darwin",
      public_key: short,
      app_version: "0.1.5",
    });
    expect(resp2.status).toBe(400);
    expect(await deviceCount()).toBe(0);
  });

  it("非法公钥编码（非 base64url 字符）→ 400", async () => {
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "x",
      platform: "darwin",
      public_key: "!!!!not-base64url!!!!not-base64url!!!!!!!!",
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(400);
    expect(await deviceCount()).toBe(0);
  });

  it("超过设备数量上限 → 429 device_limit", async () => {
    for (let i = 0; i < MAX_DEVICES_PER_USER; i += 1) {
      await registerViaApi(h, token, { name: `dev-${i}` });
    }
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "one-too-many",
      platform: "darwin",
      public_key: makeRawPublicKey(),
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(429);
    expect((await resp.json() as { error: string }).error).toBe("device_limit");
    expect(await deviceCount()).toBe(MAX_DEVICES_PER_USER);
  });

  it("同一用户重复注册同一公钥 → 409 device_exists", async () => {
    const publicKey = makeRawPublicKey();
    await registerViaApi(h, token, { public_key: publicKey });
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "again",
      platform: "darwin",
      public_key: publicKey,
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(409);
    expect((await resp.json() as { error: string }).error).toBe("device_exists");
    expect(await deviceCount()).toBe(1);
  });

  it("撤销后同一公钥可以重新注册（revoked 不占配额、不算重复）", async () => {
    const publicKey = makeRawPublicKey();
    const first = await registerViaApi(h, token, { public_key: publicKey });
    await h.app.request(`/mcp-devices/${first.deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "re-registered",
      platform: "darwin",
      public_key: publicKey,
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(200);
    // 旧行保留（审计历史），新行独立
    expect(await deviceCount()).toBe(2);
  });

  it("不同用户可以用同一把公钥各自注册（唯一性是「每用户」而非「全局」）", async () => {
    const otherId = await createTestUser(h, "Other");
    const otherToken = await accessTokenFor(h, otherId);
    const publicKey = makeRawPublicKey();

    await registerViaApi(h, token, { public_key: publicKey });
    const resp = await postJson(h, "/mcp-devices/register", otherToken, {
      name: "same key, other user",
      platform: "darwin",
      public_key: publicKey,
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(200);
  });

  it("请求体里的 user_id 被完全忽略（不能替别人注册设备）", async () => {
    const victimId = await createTestUser(h, "Victim");
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: "attempt",
      platform: "darwin",
      public_key: makeRawPublicKey(),
      app_version: "0.1.5",
      user_id: victimId,
    });
    expect(resp.status).toBe(200);
    const rows = await h.db.sql<{ user_id: string }[]>`select user_id from mcp_devices`;
    // 落库的是**调用者**的 id，不是请求体里那个
    expect(rows[0]?.user_id).toBe(userId);
    expect(rows[0]?.user_id).not.toBe(victimId);
  });
});
