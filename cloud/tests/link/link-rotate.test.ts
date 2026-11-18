import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { mcpDevices } from "../../src/db/schema.js";
import { sha256Hex } from "../../src/security/crypto.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { helloSigningPayload, REMOTE_CLOSE, type Hello } from "../../src/link/schemas.js";
import { rotateSigningPayload } from "../../src/mcp-devices/rotate.js";
import { connect, createLinkHarness, waitForConnection, type LinkHarness } from "../helpers/link-server.js";

/**
 * 轮换与连接层的交界（协议 §11.6 / ST-3）。
 *
 * 这一组要回答的问题只有一个：**换完凭据之后，旧身份还能不能碰到任何东西**。
 * 四种触碰方式都要被挡住：
 *
 * 1. 旧 token 重新握手 → 4001；
 * 2. 新 token + 旧私钥握手 → 4001；
 * 3. 旧连接继续被路由（`lookup` 返回 null）；
 * 4. 旧连接继续收发（已 bye + 4010 关闭）。
 */

/** 一轮设备 + 密钥，便于「旧私钥 / 新私钥」对照。 */
interface Keyed {
  privateKey: KeyObject;
  publicKey: string;
}

function keyPair(): Keyed {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url"),
  };
}

async function seedDevice(
  h: LinkHarness,
  keys: Keyed = keyPair(),
): Promise<{ deviceId: string; deviceToken: string; userId: string; keys: Keyed }> {
  const users = await h.ctx.db.db
    .insert((await import("../../src/db/schema.js")).users)
    .values({ displayName: "Rotate Link" })
    .returning({ id: (await import("../../src/db/schema.js")).users.id });
  const userId = users[0]?.id as string;
  const deviceToken = `bp_dev_${randomBytes(24).toString("base64url")}`;
  const rows = await h.ctx.db.db
    .insert(mcpDevices)
    .values({
      userId,
      name: "rotate",
      platform: "darwin",
      publicKey: keys.publicKey,
      status: "active",
      confirmCodeHash: "unused",
      claimSecretHash: "unused",
      expiresAt: new Date(Date.now() + 300_000),
      tokenHash: sha256Hex(deviceToken),
      tokenIssuedAt: new Date(),
      tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
    })
    .returning({ id: mcpDevices.id });
  return { deviceId: rows[0]?.id as string, deviceToken, userId, keys };
}

function buildHello(
  deviceId: string,
  keys: Keyed,
  overrides: Partial<Omit<Hello, "sig">> = {},
): Hello {
  const base: Omit<Hello, "sig"> = {
    v: 1,
    type: "hello",
    ts: Date.now(),
    device_id: deviceId,
    nonce: randomBytes(16).toString("base64url"),
    min_version: 1,
    max_version: 1,
    app_version: "0.1.5",
    platform: "darwin",
    capabilities: ["cancel", "drain", "tools.call"],
    serviceable: true,
    ...overrides,
  };
  return {
    ...base,
    sig: cryptoSign(null, helloSigningPayload(base), keys.privateKey).toString("base64url"),
  };
}

function signRotate(
  deviceId: string,
  keys: Keyed,
  newPublicKey: string,
  ts = Date.now(),
): { new_public_key: string; ts: number; sig: string } {
  const payload = rotateSigningPayload({ deviceId, newPublicKey, ts });
  return {
    new_public_key: newPublicKey,
    ts,
    sig: cryptoSign(null, payload, keys.privateKey).toString("base64url"),
  };
}

async function httpRotate(
  h: LinkHarness,
  device: { deviceId: string; deviceToken: string },
  body: unknown,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${device.deviceId}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 轮换一次并读出**新** token（明文只在这一条响应里出现）。
 *
 * 单独抽出来是因为好几条用例都要「轮换 → 用新 token 做点什么」。
 * 从库里读不回明文（只有哈希），所以必须在这里截住。
 */
async function rotateOnce(
  h: LinkHarness,
  device: { deviceId: string; deviceToken: string; keys: Keyed },
  newPublicKey: string,
): Promise<{ status: number; newToken: string | null }> {
  const resp = await httpRotate(h, device, signRotate(device.deviceId, device.keys, newPublicKey));
  if (resp.status !== 200) return { status: resp.status, newToken: null };
  const body = (await resp.json()) as { device_token: string };
  return { status: resp.status, newToken: body.device_token };
}

/** 打开连接并完成握手，返回 ws 与关闭信息。 */
async function online(h: LinkHarness, device: Awaited<ReturnType<typeof seedDevice>>) {
  const conn = await connect(h, { token: device.deviceToken });
  if (!conn.ok) throw new Error(`upgrade failed with ${conn.rejection.status}`);
  conn.ws.send(JSON.stringify(buildHello(device.deviceId, device.keys)));
  const helloOk = await conn.next((f) => f.type === "hello_ok");
  expect(helloOk.type).toBe("hello_ok");
  await waitForConnection(h, device.deviceId);
  return { ws: conn.ws, next: conn.next, closed: conn.closeInfo };
}

/** 等一个可观察条件成立（只用于等真实事件，不用于制造并发）。 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met: ${label}`);
}

beforeEach(() => resetRateLimiter());

describe("轮换与连接层", () => {
  let h: LinkHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("③ 新 token 能够重新握手，④ 旧私钥不能", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    const next = keyPair();

    const rotated = await rotateOnce(h, device, next.publicKey);
    expect(rotated.status).toBe(200);
    const newToken = rotated.newToken as string;

    // 新 token + 新私钥 → 成功。
    const ok = await connect(h, { token: newToken });
    if (!ok.ok) throw new Error("upgrade failed");
    ok.ws.send(JSON.stringify(buildHello(device.deviceId, next)));
    const helloOk = await ok.next((f) => f.type === "hello_ok");
    expect(helloOk.type).toBe("hello_ok");

    // 新 token + **旧**私钥 → 4001（公钥已被覆盖，签名对不上）。
    const stale = await connect(h, { token: newToken });
    if (!stale.ok) throw new Error("upgrade failed");
    stale.ws.send(JSON.stringify(buildHello(device.deviceId, device.keys)));
    expect((await stale.closeInfo).code).toBe(REMOTE_CLOSE.UNAUTHORIZED);

    // 旧 token + 新私钥 → 401（Upgrade 前就被拒，因为没有有效 token）。
    const oldToken = await connect(h, { token: device.deviceToken });
    if (oldToken.ok) {
      oldToken.ws.send(JSON.stringify(buildHello(device.deviceId, next)));
      expect((await oldToken.closeInfo).code).toBe(REMOTE_CLOSE.UNAUTHORIZED);
    } else {
      expect(oldToken.rejection.status).toBe(401);
    }
  });

  it("⑰⑱ 在线轮换：路由项被清除，旧连接收到 bye(rotated) 与 4010", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    const live = await online(h, device);
    expect(h.link.connectionCount()).toBe(1);

    const next = keyPair();
    const resp = await httpRotate(h, device, signRotate(device.deviceId, device.keys, next.publicKey));
    expect(resp.status).toBe(200);

    // 先看到 bye(rotated)，再看到 close 4010。
    const bye = await live.next((f) => f.type === "bye");
    expect(bye.reason).toBe("rotated");
    const closed = await live.closed;
    expect(closed.code).toBe(REMOTE_CLOSE.CREDENTIALS_ROTATED);
    expect(closed.reason).toBe("credentials rotated");

    // 路由项必须已被清除：这是「旧身份不能再被路由」的可观测证据。
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
    expect(await h.link.registry.lookup(device.userId, device.deviceId)).toBeNull();
    expect(h.link.connectionCount()).toBe(0);
    // 收敛是异步的（等对端回 shut 握手）：等到 live 表清空再断言，
    // 否则测的是「关闭帧已发出」而不是「连接已收敛」。
    await waitUntil(() => h!.link.inspect().length === 0, "connection converged");
    expect(h.link.inspect()).toHaveLength(0);
  });

  it("rotating 标记在关闭前可见，收敛后消失（否则新连接会被永久误判）", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    // 用 gateway 内部的 registry 观察中间态：轮换返回时标记已置。
    await online(h, device);

    const next = keyPair();
    const rotated = await rotateOnce(h, device, next.publicKey);
    expect(rotated.status).toBe(200);

    // 关闭是异步的（要等对端回 shut 握手），但 rotating 与「不可路由」是同步生效的。
    expect(await h.link.isRotating(device.deviceId)).toBe(true);
    expect(await h.link.registry.lookup(device.userId, device.deviceId)).toBeNull();

    // 收敛之后必须消失：新凭据重连时不能被当成 rotating。
    await h.link.awaitHandshakes();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await h.link.isRotating(device.deviceId)).toBe(false);

    const fresh = await connect(h, { token: rotated.newToken as string });
    if (!fresh.ok) throw new Error("upgrade failed");
    fresh.ws.send(JSON.stringify(buildHello(device.deviceId, next)));
    await fresh.next((f) => f.type === "hello_ok");
    // 新连接可以正常被路由。
    expect(await h.link.isRotating(device.deviceId)).toBe(false);
    expect(await h.link.registry.lookup(device.userId, device.deviceId)).not.toBeNull();
  });

  it("离线轮换：不伪造在线连接，但凭据真的换了", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    const next = keyPair();

    const rotated = await rotateOnce(h, device, next.publicKey);
    expect(rotated.status).toBe(200);
    expect(h.link.connectionCount()).toBe(0);
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
    // rotating 只在「有一条连接在退场」时才有意义；离线轮换不应留下残留标记。
    expect(await h.link.isRotating(device.deviceId)).toBe(false);

    // 新凭据能握手（证明轮换真的生效，而不是只写了个 200）。
    const conn = await connect(h, { token: rotated.newToken as string });
    if (!conn.ok) throw new Error("upgrade failed");
    conn.ws.send(JSON.stringify(buildHello(device.deviceId, next)));
    expect((await conn.next((f) => f.type === "hello_ok")).type).toBe("hello_ok");
  });

  it("⑲ 轮换后同设备用新凭据重连：新连接不被旧连接的清理误删", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    const live = await online(h, device);
    const oldConnectionId = (await h.link.registry.lookupByDevice(device.deviceId))?.connectionId;

    const next = keyPair();
    const rotated = await rotateOnce(h, device, next.publicKey);
    expect(rotated.status).toBe(200);
    await live.closed;

    // 新连接上线。
    const fresh = await connect(h, { token: rotated.newToken as string });
    if (!fresh.ok) throw new Error("upgrade failed");
    fresh.ws.send(JSON.stringify(buildHello(device.deviceId, next)));
    const helloOk = await fresh.next((f) => f.type === "hello_ok");

    // 旧连接的 connectionId 已经不具备任何权力：用它的身份来解绑必须失败。
    const staleUnbind = await h.link.registry.unbind(device.userId, device.deviceId, String(oldConnectionId));
    expect(staleUnbind).toBe(false);

    const info = await h.link.registry.lookupByDevice(device.deviceId);
    expect(info?.connectionId).toBe(helloOk.connection_id);
    expect(info?.connectionId).not.toBe(oldConnectionId);
    expect(h.link.connectionCount()).toBe(1);
  });

  it("轮换与撤销并发：撤销之后旧 token 一定不能重连", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    const live = await online(h, device);
    const next = keyPair();

    const userToken = await import("../../src/sessions/jwt.js").then(({ signAccessToken }) =>
      signAccessToken(
        h!.ctx.keyRing,
        { userId: device.userId, sessionId: "00000000-0000-4000-8000-000000000001" },
        { issuer: h!.ctx.env.baseUrl, ttlSeconds: 900 },
      ),
    );

    const [rotated] = await Promise.all([
      rotateOnce(h, device, next.publicKey),
      fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${device.deviceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${userToken}` },
      }),
    ]);

    live.ws.terminate();
    await live.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = await h.ctx.db.db
      .select({ status: mcpDevices.status })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, device.deviceId));
    expect(row[0]?.status).toBe("revoked");

    // 旧 token 与新 token 都不能握手：撤销是终态。
    const candidates = [device.deviceToken, rotated.newToken].filter((t): t is string => Boolean(t));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    for (const token of candidates) {
      const conn = await connect(h, { token });
      if (!conn.ok) continue; // Upgrade 401 也算拒绝
      conn.ws.send(JSON.stringify(buildHello(device.deviceId, next)));
      const { code } = await conn.closeInfo;
      // 两个码都对，但含义不同，都必须是**拒绝**：
      // - 4003：token 仍然指向这一行，行已 revoked；
      // - 4001：token 已被轮换覆盖，根本查不到行（撤销保留了新 token 的哈希）。
      // 断言「二者之一」而不是钉死一个，是因为并发下两种顺序都合法。
      expect([REMOTE_CLOSE.DEVICE_REVOKED, REMOTE_CLOSE.UNAUTHORIZED]).toContain(code);
    }
    expect(h.link.connectionCount()).toBe(0);
  });
});
