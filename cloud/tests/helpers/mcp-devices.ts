import { generateKeyPairSync } from "node:crypto";
import { users } from "../../src/db/schema.js";
import { signAccessToken } from "../../src/sessions/jwt.js";
import type { Harness } from "./harness.js";

/**
 * Remote MCP 设备测试的共用原语。
 *
 * 刻意**不走**完整的 Google/GitHub 登录链路：设备面只依赖「有一个已登录用户
 * 的 access token」，而把 6 步 OAuth 塞进每条用例会让失败原因难以定位。
 * 这里直接建用户 + 直接用同一个 keyRing 签 token，验证的仍然是**同一条**
 * `createRequireAuth` 路径（同一个 keyRing、同一个 issuer）。
 */

/** 生成一把真实的 Ed25519 公钥，返回裸 32 字节的 base64url（43 字符）。 */
export function makeRawPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  // 固定 12 字节头 + 32 字节裸公钥；与 Desktop 侧 ed25519RawPublicKey 同一条规则。
  return spki.subarray(spki.length - 32).toString("base64url");
}

/** 直接建一个用户行（设备表的 user_id 有外键，必须有真实用户）。 */
export async function createTestUser(h: Harness, displayName = "Device Tester"): Promise<string> {
  const rows = await h.db.db.insert(users).values({ displayName }).returning({ id: users.id });
  const row = rows[0];
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

/** 用与生产完全相同的 keyRing / issuer 签一个 access token。 */
export async function accessTokenFor(h: Harness, userId: string): Promise<string> {
  return await signAccessToken(
    h.ctx.keyRing,
    { userId, sessionId: "00000000-0000-4000-8000-000000000001" },
    { issuer: h.env.baseUrl, ttlSeconds: h.env.accessTokenTtlSeconds },
  );
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function postJson(
  h: Harness,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return await h.app.request(path, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

export interface RegisteredDevice {
  deviceId: string;
  confirmCode: string;
  claimSecret: string;
  publicKey: string;
}

/** 走真实的 register 端点（唯一一次拿到明文 claim_secret 的路径）。 */
export async function registerViaApi(
  h: Harness,
  token: string,
  overrides: Partial<{ name: string; platform: string; public_key: string; app_version: string }> = {},
): Promise<RegisteredDevice> {
  const publicKey = overrides.public_key ?? makeRawPublicKey();
  const resp = await postJson(h, "/mcp-devices/register", token, {
    name: overrides.name ?? "Test Mac",
    platform: overrides.platform ?? "darwin",
    public_key: publicKey,
    app_version: overrides.app_version ?? "0.1.5",
  });
  if (resp.status !== 200) {
    throw new Error(`register failed with ${resp.status}: ${await resp.text()}`);
  }
  const body = (await resp.json()) as {
    device_id: string;
    confirm_code: string;
    claim_secret: string;
  };
  return {
    deviceId: body.device_id,
    confirmCode: body.confirm_code,
    claimSecret: body.claim_secret,
    publicKey,
  };
}

export async function confirmViaApi(
  h: Harness,
  token: string,
  deviceId: string,
  confirmCode: string,
): Promise<Response> {
  return await postJson(h, `/mcp-devices/${deviceId}/confirm`, token, {
    confirm_code: confirmCode,
  });
}

export async function claimViaApi(
  h: Harness,
  token: string,
  deviceId: string,
  claimSecret: string,
): Promise<Response> {
  return await postJson(h, `/mcp-devices/${deviceId}/credentials`, token, {
    claim_secret: claimSecret,
  });
}

/** 注册 + 确认 + 领取，得到一台可直接用于后续断言的 active 设备。 */
export async function provisionActiveDevice(
  h: Harness,
  token: string,
): Promise<RegisteredDevice & { deviceToken: string }> {
  const device = await registerViaApi(h, token);
  const confirmed = await confirmViaApi(h, token, device.deviceId, device.confirmCode);
  if (confirmed.status !== 200) {
    throw new Error(`confirm failed with ${confirmed.status}`);
  }
  const claimed = await claimViaApi(h, token, device.deviceId, device.claimSecret);
  if (claimed.status !== 200) {
    throw new Error(`claim failed with ${claimed.status}: ${await claimed.text()}`);
  }
  const body = (await claimed.json()) as { device_token: string };
  return { ...device, deviceToken: body.device_token };
}

/**
 * 哨兵字符串：一旦出现在日志/响应/错误里就说明泄漏了。
 *
 * 用**非秘密字段**承载它（name / platform），这样才能证明「即使请求体里
 * 有敏感内容，也不会被写进日志」——否则它被脱敏是理所当然的，测不出东西。
 */
export const SENTINEL_CLAIM = "SENTINEL-CLAIM-4b1d";
export const SENTINEL_DEVICE_TOKEN = "SENTINEL-DEVICE-TOKEN-7f3a";
