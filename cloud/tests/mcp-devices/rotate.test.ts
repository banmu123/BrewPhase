import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { mcpDevices } from "../../src/db/schema.js";
import { sha256Hex } from "../../src/security/crypto.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { REMOTE_MAX_CLOCK_SKEW_MS } from "../../src/link/schemas.js";
import {
  ROTATE_MAX_CLOCK_SKEW_MS,
  ROTATE_SIGNING_PREFIX,
  rotateSigningPayload,
  verifyRotationSignature,
} from "../../src/mcp-devices/rotate.js";
import { DEVICE_TOKEN_TTL_MS } from "../../src/mcp-devices/claim.js";
import { accessTokenFor, authHeaders, createTestUser, postJson } from "../helpers/mcp-devices.js";
import { createHarness, type Harness } from "../helpers/harness.js";

/**
 * 设备凭据轮换（协议 §3.5 / 生命周期 §11.6）。
 *
 * ## 这一组要防的核心不是「功能不对」，而是「换了一半」
 *
 * 轮换同时换两样东西：`public_key` 与 `token_hash`。任何一处先落地都会留下
 * 一个**可用的错误组合**——新公钥配旧 token（偷到旧 token 的人仍能连）、
 * 旧公钥配新 token（旧私钥仍能握手）。所以断言里反复出现的是「同一条
 * UPDATE」「旧的一定失效」「新的唯一一次出现」。
 */

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function keyPair(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url"),
  };
}

function privateKeyFromSeed(seedBase64Url: string): KeyObject {
  const seed = Buffer.from(seedBase64Url, "base64url");
  expect(seed).toHaveLength(32);
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

interface Device {
  deviceId: string;
  deviceToken: string;
  userId: string;
  privateKey: KeyObject;
  publicKey: string;
}

/** 注册 + 确认 + 领取，**保留私钥**（注册辅助函数会把它丢掉）。 */
async function provision(h: Harness, userId: string, userToken: string): Promise<Device> {
  const keys = keyPair();
  const registered = await postJson(h, "/mcp-devices/register", userToken, {
    name: "Rotate Test",
    platform: "darwin",
    public_key: keys.publicKey,
    app_version: "0.1.5",
  });
  expect(registered.status).toBe(200);
  const body = (await registered.json()) as {
    device_id: string;
    confirm_code: string;
    claim_secret: string;
  };

  const confirmed = await postJson(h, `/mcp-devices/${body.device_id}/confirm`, userToken, {
    confirm_code: body.confirm_code,
  });
  expect(confirmed.status).toBe(200);

  const claimed = await postJson(h, `/mcp-devices/${body.device_id}/credentials`, userToken, {
    claim_secret: body.claim_secret,
  });
  expect(claimed.status).toBe(200);
  const { device_token: deviceToken } = (await claimed.json()) as { device_token: string };

  return {
    deviceId: body.device_id,
    deviceToken,
    userId,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  };
}

function signedRotate(
  device: Device,
  input: { newPublicKey: string; ts?: number; privateKey?: KeyObject; deviceId?: string },
): { new_public_key: string; ts: number; sig: string } {
  const ts = input.ts ?? Date.now();
  const payload = rotateSigningPayload({
    // 签名用的 device_id 可以是「伪造」的那个：用来构造 §5/§6 的负例。
    deviceId: input.deviceId ?? device.deviceId,
    newPublicKey: input.newPublicKey,
    ts,
  });
  const sig = cryptoSign(null, payload, input.privateKey ?? device.privateKey).toString("base64url");
  return { new_public_key: input.newPublicKey, ts, sig };
}

async function rotateViaApi(
  h: Harness,
  device: Device,
  body: unknown,
): Promise<Response> {
  return await h.app.request(`/mcp-devices/${device.deviceId}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tokenRow(h: Harness, deviceId: string) {
  const rows = await h.ctx.db.db
    .select({
      tokenHash: mcpDevices.tokenHash,
      publicKey: mcpDevices.publicKey,
      tokenIssuedAt: mcpDevices.tokenIssuedAt,
      tokenExpiresAt: mcpDevices.tokenExpiresAt,
      keyRotatedAt: mcpDevices.keyRotatedAt,
      status: mcpDevices.status,
      userId: mcpDevices.userId,
      grantEpoch: mcpDevices.grantEpoch,
    })
    .from(mcpDevices)
    .where(eq(mcpDevices.id, deviceId));
  return rows[0]!;
}

describe("rotate 签名规范串（与 Desktop 共用 golden fixture）", () => {
  const FIXTURE = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "remote-mcp", "rotate-v1.json"),
      "utf8",
    ),
  ) as {
    protocol: string;
    old_private_key: { seed_base64url: string };
    old_public_key: { base64url: string };
    new_public_key: { base64url: string };
    request: { device_id: string; new_public_key: string; ts: number };
    canonical_payload: string;
    signature_base64url: string;
  };

  it("域分隔前缀与协议一致", () => {
    expect(ROTATE_SIGNING_PREFIX).toBe("brewphase.remote.rotate.v1");
    expect(FIXTURE.protocol).toBe(ROTATE_SIGNING_PREFIX);
  });

  it("Cloud 的规范串逐字节等于 fixture", () => {
    const payload = rotateSigningPayload({
      deviceId: FIXTURE.request.device_id,
      newPublicKey: FIXTURE.request.new_public_key,
      ts: FIXTURE.request.ts,
    });
    expect(payload.toString("utf8")).toBe(FIXTURE.canonical_payload);
  });

  it("用 fixture 的固定私钥能复现同一个签名（Ed25519 确定性）", () => {
    const sig = cryptoSign(
      null,
      Buffer.from(FIXTURE.canonical_payload, "utf8"),
      privateKeyFromSeed(FIXTURE.old_private_key.seed_base64url),
    ).toString("base64url");
    expect(sig).toBe(FIXTURE.signature_base64url);
  });

  it("Cloud 验签接受 fixture（用 fixture 的旧公钥）", () => {
    expect(
      verifyRotationSignature({
        oldPublicKey: FIXTURE.old_public_key.base64url,
        deviceId: FIXTURE.request.device_id,
        newPublicKey: FIXTURE.request.new_public_key,
        ts: FIXTURE.request.ts,
        sig: FIXTURE.signature_base64url,
      }),
    ).toBe(true);
  });

  it("轮换的时钟偏差判据与握手相同（两处取不同值会让用户看到矛盾行为）", () => {
    expect(ROTATE_MAX_CLOCK_SKEW_MS).toBe(REMOTE_MAX_CLOCK_SKEW_MS);
  });

  it("new_public_key 里带换行 → 拒绝生成规范串（否则可重解释字段边界）", () => {
    expect(() =>
      rotateSigningPayload({
        deviceId: "d",
        newPublicKey: "abc\ndef",
        ts: 1,
      }),
    ).toThrow(/line breaks/);
  });
});

describe("POST /mcp-devices/:id/rotate", () => {
  let h: Harness;
  let userId: string;
  let userToken: string;

  beforeEach(async () => {
    resetRateLimiter();
    h = await createHarness();
    userId = await createTestUser(h);
    userToken = await accessTokenFor(h, userId);
  });

  afterEach(async () => {
    await h.close();
  });

  it("① 正常轮换成功：同一条 UPDATE 换掉公钥与 token 哈希", async () => {
    const device = await provision(h, userId, userToken);
    const before = await tokenRow(h, device.deviceId);
    const next = keyPair();
    const ts = Date.now();

    const resp = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey, ts }));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { device_token: string; expires_at: number };

    // 新 token 形态正确，且**不等于**旧 token。
    expect(body.device_token).toMatch(/^bp_dev_[A-Za-z0-9_-]{16,}$/);
    expect(body.device_token).not.toBe(device.deviceToken);

    const after = await tokenRow(h, device.deviceId);
    expect(after.publicKey).toBe(next.publicKey);
    expect(after.publicKey).not.toBe(before.publicKey);
    // 库里只有哈希，且是新 token 的哈希。
    expect(after.tokenHash).toBe(sha256Hex(body.device_token));
    expect(after.tokenHash).not.toBe(before.tokenHash);
    // 明文绝不落库。
    expect(after.tokenHash).not.toContain(body.device_token);

    // 生命周期字段：issued_at 前移、expires_at = now + TTL、key_rotated_at 落值。
    expect(after.tokenIssuedAt!.getTime()).toBeGreaterThanOrEqual(before.tokenIssuedAt!.getTime());
    // 过期时间以**服务端** now 为准，不是请求里的 ts（客户端的时钟不可信）。
    expect(Math.abs(after.tokenExpiresAt!.getTime() - (ts + DEVICE_TOKEN_TTL_MS))).toBeLessThan(5_000);
    expect(after.keyRotatedAt).not.toBeNull();

    // 归属与授权上下文**不动**。
    expect(after.userId).toBe(device.userId);
    expect(after.status).toBe("active");
    expect(after.grantEpoch).toBe(before.grantEpoch);

    // 响应的 expires_at 与库里一致（Desktop 要靠它算轮换时机）。
    expect(body.expires_at).toBe(after.tokenExpiresAt!.getTime());
  });

  it("② 旧 token 立即失效", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();
    const ok = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey }));
    expect(ok.status).toBe(200);

    // 用旧 token 再轮换 → 401（哈希已不匹配）。
    const retry = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: keyPair().publicKey }));
    expect(retry.status).toBe(401);
    expect(((await retry.json()) as { error: string }).error).toBe("device_unauthorized");

    // 旧 token 的设备自暂停通道同样失效（它走同一条 token_hash 查表）。
    const suspend = await h.app.request(`/mcp-devices/${device.deviceId}/suspend`, {
      method: "POST",
      headers: authHeaders(device.deviceToken),
    });
    expect(suspend.status).toBe(401);
  });

  it("⑤ 篡改签名 → 401", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();
    const body = signedRotate(device, { newPublicKey: next.publicKey });
    const sig = Buffer.from(body.sig, "base64url");
    sig[0] = (sig[0] ?? 0) ^ 0xff;

    const resp = await rotateViaApi(h, device, { ...body, sig: sig.toString("base64url") });
    expect(resp.status).toBe(401);
    // 失败必须是**完全没发生**：公钥与 token 都不变。
    const row = await tokenRow(h, device.deviceId);
    expect(row.publicKey).toBe(device.publicKey);
    expect(row.tokenHash).toBe(sha256Hex(device.deviceToken));
  });

  it("⑤b 签名被换成另一把私钥 → 401", async () => {
    const device = await provision(h, userId, userToken);
    const attacker = keyPair();
    // 攻击者用自己的私钥签一份「把设备换成自己公钥」的请求。
    const forged = signedRotate(device, { newPublicKey: attacker.publicKey, privateKey: attacker.privateKey });

    const resp = await rotateViaApi(h, device, forged);
    expect(resp.status).toBe(401);
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("⑥ 篡改 device_id（签名覆盖的是别的 id）→ 401", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();
    // 签名原文里写另一个 device_id，但请求打到真实设备上。
    const body = signedRotate(device, { newPublicKey: next.publicKey, deviceId: "00000000-0000-4000-8000-000000000000" });

    const resp = await rotateViaApi(h, device, body);
    expect(resp.status).toBe(401);
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("⑦ 拿 A 的 token 换 B 的 id → 404（不泄露存在性）", async () => {
    const a = await provision(h, userId, userToken);
    const b = await provision(h, userId, userToken);
    const next = keyPair();
    // 用 A 的私钥与 A 的 token 签，但路径写 B。
    const body = signedRotate(a, { newPublicKey: next.publicKey, deviceId: a.deviceId });

    const resp = await h.app.request(`/mcp-devices/${b.deviceId}/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as { error: string }).error).toBe("device_not_found");
    // 两台设备都没被改。
    expect((await tokenRow(h, a.deviceId)).publicKey).toBe(a.publicKey);
    expect((await tokenRow(h, b.deviceId)).publicKey).toBe(b.publicKey);
  });

  it("⑦b 用用户 Bearer 轮换 → 401（设备身份不能降级成账号密码）", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();
    const body = signedRotate(device, { newPublicKey: next.publicKey });

    const resp = await h.app.request(`/mcp-devices/${device.deviceId}/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(401);
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("⑧ 新公钥形态非法 → 400（正则挡住的与解码后不符的各走各的错误码）", async () => {
    const device = await provision(h, userId, userToken);

    // 第一类：连字符集/长度都不对 → zod 的 invalid_request。
    for (const bad of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, "not-base64!!", ""]) {
      const resp = await rotateViaApi(h, device, {
        new_public_key: bad,
        ts: Date.now(),
        sig: "A".repeat(86),
      });
      expect(resp.status, `new_public_key=${bad}`).toBe(400);
      expect(((await resp.json()) as { error: string }).error).toBe("invalid_request");
    }

    // 第二类：**43 个合法字符、解码也是 32 字节，但不是规范编码**。
    // 43 个 base64url 字符 = 258 bit，末位有 2 bit 填充位；把末位换成同组
    // 内另一个字符，解出的字节完全相同而文本不同——如果不做「重新编码逐字
    // 相同」检查，同一把公钥会有多种文本表示。
    const valid = keyPair().publicKey;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = valid.at(-1)!;
    const idx = alphabet.indexOf(last);
    let nonCanonical: string | null = null;
    for (let d = 1; d < 4; d += 1) {
      const candidate = valid.slice(0, -1) + alphabet[(idx & ~3) + ((idx + d) & 3)];
      if (candidate === valid) continue;
      if (!Buffer.from(candidate, "base64url").equals(Buffer.from(valid, "base64url"))) continue;
      nonCanonical = candidate;
      break;
    }
    expect(nonCanonical, "没能构造出非规范编码的样本").toBeTruthy();
    const resp = await rotateViaApi(h, device, {
      new_public_key: nonCanonical,
      ts: Date.now(),
      sig: "A".repeat(86),
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_public_key");

    // 全部失败路径都不能改动库里的公钥。
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("⑨ 时间戳过期 / 超前 → 401", async () => {
    const device = await provision(h, userId, userToken);
    for (const delta of [-(ROTATE_MAX_CLOCK_SKEW_MS + 5_000), ROTATE_MAX_CLOCK_SKEW_MS + 5_000]) {
      const next = keyPair();
      const resp = await rotateViaApi(h, device, {
        ...signedRotate(device, { newPublicKey: next.publicKey, ts: Date.now() + delta }),
      });
      expect(resp.status, `delta=${delta}`).toBe(401);
    }
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("⑨b 时间戳在窗口内（边界附近）→ 成功", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();
    const resp = await rotateViaApi(h, device, {
      ...signedRotate(device, { newPublicKey: next.publicKey, ts: Date.now() - 60_000 }),
    });
    expect(resp.status).toBe(200);
  });

  it("⑩ token 已过期 → 401", async () => {
    const device = await provision(h, userId, userToken);
    await h.db.sql`
      update mcp_devices set token_expires_at = now() - interval '1 second'
       where id = ${device.deviceId}`;
    const next = keyPair();
    const resp = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey }));
    expect(resp.status).toBe(401);
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("⑪ suspended 设备不能轮换 → 409 且状态不变", async () => {
    const device = await provision(h, userId, userToken);
    await postJson(h, `/mcp-devices/${device.deviceId}/suspend`, userToken, {});
    const next = keyPair();

    const resp = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey }));
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_device_state");
    const row = await tokenRow(h, device.deviceId);
    expect(row.status).toBe("suspended");
    expect(row.publicKey).toBe(device.publicKey);
  });

  it("⑫ revoked 设备不能轮换 → 409，且旧 token 本身也已不可用", async () => {
    const device = await provision(h, userId, userToken);
    const revoked = await h.app.request(`/mcp-devices/${device.deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(revoked.status).toBe(200);
    const next = keyPair();

    const resp = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey }));
    expect(resp.status).toBe(409);
    const row = await tokenRow(h, device.deviceId);
    expect(row.status).toBe("revoked");
    expect(row.publicKey).toBe(device.publicKey);
  });

  it("⑬ 同一个旧 token 并发轮换：恰好一个成功", async () => {
    const device = await provision(h, userId, userToken);
    const keyA = keyPair();
    const keyB = keyPair();

    const [a, b] = await Promise.all([
      rotateViaApi(h, device, signedRotate(device, { newPublicKey: keyA.publicKey })),
      rotateViaApi(h, device, signedRotate(device, { newPublicKey: keyB.publicKey })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    // 成功的那个必须与库里的状态完全一致——不能出现「200 说 A，库里是 B」。
    const winner = a.status === 200 ? keyA : keyB;
    const row = await tokenRow(h, device.deviceId);
    expect(row.publicKey).toBe(winner.publicKey);
  });

  it("⑭ 轮换与 suspend 并发：最终状态自洽（不允许「已暂停但凭据已换」的错配）", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();

    const [rotate, suspend] = await Promise.all([
      rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey })),
      postJson(h, `/mcp-devices/${device.deviceId}/suspend`, userToken, {}),
    ]);

    expect(suspend.status).toBe(200);
    const row = await tokenRow(h, device.deviceId);
    // 无论谁先拿到行锁，最终设备都是 suspended。
    expect(row.status).toBe("suspended");
    // 两种合法线性化：轮换先（200，库里有新公钥）或 suspend 先（409，公钥不变）。
    if (rotate.status === 200) {
      expect(row.publicKey).toBe(next.publicKey);
    } else {
      expect(rotate.status).toBe(409);
      expect(row.publicKey).toBe(device.publicKey);
    }
  });

  it("⑮ 轮换与 revoke 并发：撤销是终态，不能被轮换覆盖", async () => {
    const device = await provision(h, userId, userToken);
    const next = keyPair();

    const [rotate, revoke] = await Promise.all([
      rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey })),
      h.app.request(`/mcp-devices/${device.deviceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${userToken}` },
      }),
    ]);

    expect(revoke.status).toBe(200);
    const row = await tokenRow(h, device.deviceId);
    expect(row.status).toBe("revoked");
    // 撤销之后旧 token 一定不可用（哈希可能已被换掉，也可能没有——两种都行，
    // 关键是**撤销状态本身**不能因为轮换而回退）。
    expect(["revoked"]).toContain(row.status);
    if (rotate.status !== 200) expect(rotate.status).toBeGreaterThanOrEqual(400);
  });

  it("⑯ 轮换时旧连接不存在（设备离线）→ 仍然成功", async () => {
    const device = await provision(h, userId, userToken);
    // 这条用例的 harness 根本没有 link 层（纯 HTTP），等价于「没有任何在线连接」。
    const next = keyPair();
    const resp = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey }));
    expect(resp.status).toBe(200);
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(next.publicKey);
  });

  it("新 token 的过期时间落在 TTL 上（Desktop 靠它算轮换时机）", async () => {
    const device = await provision(h, userId, userToken);
    const before = Date.now();
    const resp = await rotateViaApi(h, device, signedRotate(device, { newPublicKey: keyPair().publicKey }));
    const body = (await resp.json()) as { expires_at: number };
    // 允许 5 秒执行余量。
    expect(body.expires_at).toBeGreaterThanOrEqual(before + DEVICE_TOKEN_TTL_MS - 5_000);
    expect(body.expires_at).toBeLessThanOrEqual(Date.now() + DEVICE_TOKEN_TTL_MS + 5_000);
  });

  it("请求体缺字段 / 类型错 → 400（不走 401，便于区分客户端 bug）", async () => {
    const device = await provision(h, userId, userToken);
    for (const body of [{}, { new_public_key: "x" }, { new_public_key: "A".repeat(43), ts: "1", sig: "x" }]) {
      const resp = await rotateViaApi(h, device, body);
      expect(resp.status).toBe(400);
    }
    expect((await tokenRow(h, device.deviceId)).publicKey).toBe(device.publicKey);
  });

  it("旧公钥与旧 token 的哈希在任何失败路径上都不被改动（逐项比对）", async () => {
    const device = await provision(h, userId, userToken);
    const before = await tokenRow(h, device.deviceId);
    const next = keyPair();

    // 一组会失败的请求：坏签名、坏公钥、坏时间戳。
    await rotateViaApi(h, device, { ...signedRotate(device, { newPublicKey: next.publicKey }), sig: "A".repeat(86) });
    await rotateViaApi(h, device, { new_public_key: "A".repeat(42), ts: Date.now(), sig: "A".repeat(86) });
    await rotateViaApi(h, device, signedRotate(device, { newPublicKey: next.publicKey, ts: 1 }));

    const after = await tokenRow(h, device.deviceId);
    expect(after.publicKey).toBe(before.publicKey);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.tokenExpiresAt!.getTime()).toBe(before.tokenExpiresAt!.getTime());
    expect(after.keyRotatedAt).toBeNull();
  });
});
