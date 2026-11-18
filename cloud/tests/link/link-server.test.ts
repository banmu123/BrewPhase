import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KeyObject } from "node:crypto";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { mcpDevices, mcpGrants, users } from "../../src/db/schema.js";
import { sha256Hex } from "../../src/security/crypto.js";
import { signAccessToken } from "../../src/sessions/jwt.js";
import {
  helloSigningPayload,
  REMOTE_CLOSE,
  type Hello,
} from "../../src/link/schemas.js";
import { connect, createLinkHarness, waitForConnection, type LinkHarness } from "../helpers/link-server.js";

/**
 * WSS 接入层的**端到端**测试：真实 HTTP Upgrade + 真实 WebSocket 帧。
 *
 * 这里没有任何 Mock Gateway。客户端是 `ws`（与服务端同一个库，但走的是
 * 完整的 RFC 6455 客户端路径），服务端是生产入口用的 `startCloudServer`。
 *
 * 分组与任务书 §15 的清单一一对应：
 * A. Upgrade 预检 → B. 设备认证 → C. hello / Ed25519 → D. 注册表
 * → E. Grant 快照 → F. 心跳 → G. 撤停联动 → H. 运维
 */

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "remote-mcp", "hello-v1.json"),
    "utf8",
  ),
) as {
  private_key: { seed_base64url: string };
  public_key: { base64url: string };
  hello: Hello;
  canonical_payload: string;
  signature_base64url: string;
};

/** fixture 的固定私钥（与 golden 向量同一把）。 */
function fixtureKey() {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(FIXTURE.private_key.seed_base64url, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
}

/** 另造一把设备私钥（用于「A 的 token + B 的签名」这类用例）。 */
function freshDeviceKey() {
  return generateKeyPairSync("ed25519");
}

function rawPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url");
}

interface SeededDevice {
  deviceId: string;
  deviceToken: string;
  userId: string;
  publicKey: string;
}

/**
 * 直接写库造一台 active 设备（跳过注册流程）。
 *
 * 理由：注册链路由 `tests/mcp-devices/*` 覆盖，这里要测的是握手。
 * 但 `token_hash` 仍然走真实的 `sha256Hex`，所以「按哈希查设备」这条路
 * 是**真**的，不是桩。
 */
async function seedDevice(
  h: LinkHarness,
  overrides: {
    status?: "active" | "pending" | "suspended" | "revoked";
    tokenExpiresAt?: Date;
    expiresAt?: Date;
    publicKey?: string;
    userId?: string;
    grantEpoch?: number;
  } = {},
): Promise<SeededDevice> {
  const userId = overrides.userId ?? (await seedUser(h));
  const publicKey = overrides.publicKey ?? FIXTURE.public_key.base64url;
  const deviceToken = `bp_dev_${"a".repeat(30)}${Math.random().toString(36).slice(2, 8)}`;
  const rows = await h.ctx.db.db
    .insert(mcpDevices)
    .values({
      userId,
      name: "seed",
      platform: "darwin",
      publicKey,
      status: overrides.status ?? "active",
      confirmCodeHash: "unused",
      claimSecretHash: "unused",
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 300_000),
      tokenHash: sha256Hex(deviceToken),
      tokenIssuedAt: new Date(),
      tokenExpiresAt: overrides.tokenExpiresAt ?? new Date(Date.now() + 30 * 24 * 3600_000),
      grantEpoch: overrides.grantEpoch ?? 0,
    })
    .returning({ id: mcpDevices.id });
  const deviceId = rows[0]?.id as string;
  return { deviceId, deviceToken, userId, publicKey };
}

async function seedUser(h: LinkHarness, name = "Link Tester"): Promise<string> {
  const rows = await h.ctx.db.db.insert(users).values({ displayName: name }).returning({ id: users.id });
  return rows[0]?.id as string;
}

/**
 * 构造一个签好名的 hello。
 *
 * `ts` 默认取**当前时间**而不是 fixture 的固定值：协议要求 ±120s 的偏差，
 * 而 fixture 的 ts 是 2025 年的固定向量（专门用于签名一致性，不是用于
 * 端到端连通）。用固定 ts 的代价是所有用例都先撞上「时钟偏差」——
 * 于是它们测的其实是同一件事，而不是各自想测的边界。
 *
 * 每一帧都重新签名（Ed25519 是确定性的，同一输入必然同一签名）。
 */
function buildHello(
  overrides: Partial<Hello> = {},
  options: { key?: ReturnType<typeof fixtureKey> } = {},
): Hello {
  const base: Hello = { ...FIXTURE.hello, ts: Date.now(), nonce: freshNonce(), ...overrides };
  const key = options.key ?? fixtureKey();
  const { sig: _sig, ...signingInput } = base;
  const sig = cryptoSign(null, helloSigningPayload(signingInput), key).toString("base64url");
  return { ...base, sig };
}

// MARK: - A. Upgrade 预检

describe("A. Upgrade 预检（失败必须是 HTTP 响应，不是 close frame）", () => {
  it("正确 path + Host + 子协议 + token → 101", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      expect(conn.ok).toBe(true);
      if (conn.ok) conn.ws.close(1000);
    } finally {
      await h.close();
    }
  });

  it("错误 path → 404", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken, url: `ws://127.0.0.1:${h.server.port}/device` });
      expect(conn.ok).toBe(false);
      if (!conn.ok) expect(conn.rejection.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("路径带查询串 → 400（token 不放 URL 的强制手段）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      // 注意不测裸 `?`：URL 序列化会把它吃掉，请求到服务端时就是 `/device-link`，
      // 那时放行是**正确**的（它确实没有查询串）。
      for (const query of [`?token=${device.deviceToken}`, "?v=1", "?a=b&c=d"]) {
        const conn = await connect(h, {
          token: device.deviceToken,
          url: `ws://127.0.0.1:${h.server.port}/device-link${query}`,
        });
        expect(conn.ok, `${query} 必须被拒绝`).toBe(false);
        if (!conn.ok) expect(conn.rejection.status).toBe(400);
      }
    } finally {
      await h.close();
    }
  });

  it("伪造 Host 头 → 403（不看 X-Forwarded-Host）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, {
        token: device.deviceToken,
        headers: { host: "evil.example.com" },
      });
      expect(conn.ok).toBe(false);
      if (!conn.ok) expect(conn.rejection.status).toBe(403);

      // 带上伪造的 X-Forwarded-Host 也不能救回来：它压根不参与判断。
      const withForwarded = await connect(h, {
        token: device.deviceToken,
        headers: { host: "evil.example.com", "x-forwarded-host": "127.0.0.1" },
      });
      expect(withForwarded.ok).toBe(false);
      if (!withForwarded.ok) expect(withForwarded.rejection.status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it("子协议缺失 / 错误 → 400", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      for (const protocols of [null, ["brewphase.remote.v2"], ["chat", "other"]]) {
        const conn = await connect(h, { token: device.deviceToken, protocols });
        expect(conn.ok, `protocols=${JSON.stringify(protocols)}`).toBe(false);
        if (!conn.ok) expect(conn.rejection.status).toBe(400);
      }
    } finally {
      await h.close();
    }
  });

  it("token 缺失 / 形态错误 → 401", async () => {
    const h = await createLinkHarness();
    try {
      const cases: Array<string | null> = [null, "", "not-a-token", "bp_dev_short", `bp_mcp_${"a".repeat(30)}`];
      for (const token of cases) {
        const conn = await connect(h, { token });
        expect(conn.ok, `token=${String(token)}`).toBe(false);
        if (!conn.ok) expect(conn.rejection.status).toBe(401);
      }
    } finally {
      await h.close();
    }
  });

  it("token 不存在于库中 → Upgrade 成功，随后 close 4001（不是 401）", async () => {
    const h = await createLinkHarness();
    try {
      const conn = await connect(h, { token: `bp_dev_${"z".repeat(30)}` });
      expect(conn.ok).toBe(true);
      if (!conn.ok) return;
      conn.ws.send(JSON.stringify(buildHello()));
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("Origin 不在白名单 → 403；没有 Origin（原生客户端）→ 放行", async () => {
    const h = await createLinkHarness({ corsOrigins: ["https://cloud.brewphase.app"] });
    try {
      const device = await seedDevice(h);
      const bad = await connect(h, { token: device.deviceToken, origin: "https://evil.example.com" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.rejection.status).toBe(403);

      const good = await connect(h, { token: device.deviceToken, origin: "https://cloud.brewphase.app" });
      expect(good.ok).toBe(true);
      if (good.ok) good.ws.close(1000);

      // Electron net.WebSocket 不发 Origin
      const native = await connect(h, { token: device.deviceToken });
      expect(native.ok).toBe(true);
      if (native.ok) native.ws.close(1000);
    } finally {
      await h.close();
    }
  });

  it("CORS 开启后普通 HTTP 路由仍然正常（upgrade 没有破坏响应头处理）", async () => {
    const h = await createLinkHarness({ corsOrigins: ["https://cloud.brewphase.app"] });
    try {
      const resp = await fetch(`http://127.0.0.1:${h.server.port}/health`, {
        headers: { origin: "https://cloud.brewphase.app" },
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("access-control-allow-origin")).toBe("https://cloud.brewphase.app");

      // 404 与非设备路由不受影响
      const notFound = await fetch(`http://127.0.0.1:${h.server.port}/nope`);
      expect(notFound.status).toBe(404);

      // 身份路由仍要求 Bearer（不被 WSS 的 401 语义污染）
      const me = await fetch(`http://127.0.0.1:${h.server.port}/auth/me`);
      expect(me.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("HTTP 访问日志不包含 token（wss 的 Authorization 也不进日志）", async () => {
    const h = await createLinkHarness({ logLevel: "debug" });
    try {
      const device = await seedDevice(h);
      const logs: string[] = [];
      const original = h.ctx.logger.info;
      // 只记录**参数**，不回放原始实现：`original` 是对象方法，
      // 脱离 `this` 调用可能抛错，而它会在 ws 的 message 回调里抛——
      // 那会把一次握手变成 unhandled rejection，测试失败原因完全错位。
      h.ctx.logger.info = ((event: string, fields?: Record<string, unknown>) => {
        logs.push(`${event} ${JSON.stringify(fields ?? {})}`);
      }) as typeof h.ctx.logger.info;

      const conn = await connect(h, { token: device.deviceToken });
      if (conn.ok) {
        conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId })));
        await waitForConnection(h, device.deviceId);
        conn.ws.close(1000);
        await conn.closeInfo;
      }
      h.ctx.logger.info = original;

      // 反向断言：确实记录了这次连接（否则「没有 token」是空过）。
      expect(logs.some((line) => line.includes("link_established"))).toBe(true);
      expect(logs.some((line) => line.includes(device.deviceToken))).toBe(false);
      expect(logs.some((line) => line.includes("bp_dev_"))).toBe(false);
    } finally {
      await h.close();
    }
  });
});

// MARK: - B. 设备认证

describe("B. 设备认证（§4.3 第 2–4 步）", () => {
  it("active + token 未过期 → 握手成功", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId })));
      const helloOk = await conn.next((f) => f.type === "hello_ok");
      expect(helloOk.type).toBe("hello_ok");
    } finally {
      await h.close();
    }
  });

  it("pending → 4001", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h, { status: "pending" });
      await expectCloseCode(h, device, buildHello({ device_id: device.deviceId }), REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("suspended → 4005", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h, { status: "suspended" });
      await expectCloseCode(h, device, buildHello({ device_id: device.deviceId }), REMOTE_CLOSE.DEVICE_SUSPENDED);
    } finally {
      await h.close();
    }
  });

  it("revoked → 4003", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h, { status: "revoked" });
      await expectCloseCode(h, device, buildHello({ device_id: device.deviceId }), REMOTE_CLOSE.DEVICE_REVOKED);
    } finally {
      await h.close();
    }
  });

  it("token_expires_at 已过期 → 4001（即使 expires_at 还有效）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h, {
        tokenExpiresAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await expectCloseCode(h, device, buildHello({ device_id: device.deviceId }), REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("expires_at 已过期但 token_expires_at 有效 → **允许**握手（1.2A 欠账的回归锁）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h, {
        expiresAt: new Date(Date.now() - 60_000),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      });
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId })));
      const helloOk = await conn.next((f) => f.type === "hello_ok");
      expect(helloOk.type).toBe("hello_ok");
    } finally {
      await h.close();
    }
  });

  it("ST-2：A 的 token + B 的签名 → 4001", async () => {
    const h = await createLinkHarness();
    try {
      // A 的 token 与公钥；用 B 的私钥签名。
      const deviceA = await seedDevice(h);
      const keyB = freshDeviceKey();
      const helloFromB = buildHello(
        { device_id: deviceA.deviceId },
        { key: keyB.privateKey },
      );
      await expectCloseCode(h, deviceA, helloFromB, REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("hello.device_id 与 token 对应设备不一致 → 4001", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const other = await seedDevice(h, { publicKey: rawPublicKey(freshDeviceKey().publicKey) });
      // 用 A 的 token，hello 里写 B 的 id（签名仍用 A 的私钥 → 签名有效但 id 不匹配）
      await expectCloseCode(
        h,
        device,
        buildHello({ device_id: other.deviceId }),
        REMOTE_CLOSE.UNAUTHORIZED,
      );
    } finally {
      await h.close();
    }
  });
});

// MARK: - C. hello / Ed25519

describe("C. hello / Ed25519 与协议边界", () => {
  it("错误签名 → 4001", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const good = buildHello({ device_id: device.deviceId });
      const flipped = Buffer.from(good.sig, "base64url");
      flipped[0] = (flipped[0] ?? 0) ^ 0xff;
      await expectCloseCode(
        h,
        device,
        { ...good, sig: flipped.toString("base64url") },
        REMOTE_CLOSE.UNAUTHORIZED,
      );
    } finally {
      await h.close();
    }
  });

  it("时间偏差超过 120 秒 → 4001", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const skewed = buildHello({ device_id: device.deviceId, ts: Date.now() + 121_000, nonce: freshNonce() });
      await expectCloseCode(h, device, skewed, REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("nonce 重放 → 4001", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const nonce = freshNonce();
      const hello = buildHello({ device_id: device.deviceId, nonce, ts: Date.now() });

      const first = await connect(h, { token: device.deviceToken });
      if (!first.ok) throw new Error("upgrade failed");
      first.ws.send(JSON.stringify(hello));
      await first.next((f) => f.type === "hello_ok");
      first.ws.close(1000);
      await first.closeInfo;

      // 同一个 nonce 再连一次（新连接、新 socket，签名仍然有效）
      await expectCloseCode(h, device, hello, REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("版本区间无交集 → 4002", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const hello = buildHello({ device_id: device.deviceId, min_version: 2, max_version: 3, nonce: freshNonce() });
      await expectCloseCode(h, device, hello, REMOTE_CLOSE.VERSION_UNSUPPORTED);
    } finally {
      await h.close();
    }
  });

  it("hello 未知字段 → 4001（闭合键集）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const hello = { ...buildHello({ device_id: device.deviceId }), sneaky: true };
      await expectCloseCode(h, device, hello, REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("第一帧不是 hello → 4001；非 JSON → 4001", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      await expectCloseCode(h, device, { v: 1, type: "ping", ts: 1, seq: 1 }, REMOTE_CLOSE.UNAUTHORIZED);
      await expectCloseCode(h, device, "not json at all", REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });

  it("hello 超时（5s 内没发）→ 4007", async () => {
    const h = await createLinkHarness({ helloTimeoutMs: 120 });
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.HELLO_TIMEOUT);
    } finally {
      await h.close();
    }
  });

  it("二进制帧 → 4009", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.PROTOCOL_VIOLATION);
    } finally {
      await h.close();
    }
  });

  it("单帧超过 1 MiB → 4009（传输层拒绝，不解析）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      // 1 MiB + 1 字节的**合法 JSON**：如果实现是「先收下来再解析」，
      // 它会得到一个 hello 形状错误（4001）而不是帧超限（4009）。
      const oversized = JSON.stringify({ v: 1, type: "hello", pad: "x".repeat(1024 * 1024) });
      expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(1024 * 1024);
      conn.ws.send(oversized);
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.PROTOCOL_VIOLATION);
    } finally {
      await h.close();
    }
  });

  it("golden fixture 原样通过真实链路（Cloud 时钟被固定到 fixture 的 ts）", async () => {
    // fixture 的 ts 是固定的历史时刻，所以把**服务端**时钟也固定到那一刻。
    // 这是唯一能证明「fixture 的签名在线上真的会被接受」的方式——
    // 只验 fixture 的 payload 相等，证明的是自洽，不是兼容。
    const h = await createLinkHarness({ now: () => FIXTURE.hello.ts });
    try {
      const device = await seedDevice(h);
      // fixture 的 device_id 是固定值，直接把设备 id 改成它。
      await h.ctx.db.db
        .update(mcpDevices)
        .set({ id: FIXTURE.hello.device_id })
        .where(eq(mcpDevices.id, device.deviceId));

      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(FIXTURE.hello));
      const helloOk = await conn.next((f) => f.type === "hello_ok");
      expect(helloOk.type).toBe("hello_ok");
      expect(helloOk.connection_id).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("改动 fixture 的 ts → 4001（证明签名真的被验，不是摆设）", async () => {
    const h = await createLinkHarness({ now: () => FIXTURE.hello.ts });
    try {
      const device = await seedDevice(h);
      await h.ctx.db.db
        .update(mcpDevices)
        .set({ id: FIXTURE.hello.device_id })
        .where(eq(mcpDevices.id, device.deviceId));

      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify({ ...FIXTURE.hello, ts: FIXTURE.hello.ts + 1 }));
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.UNAUTHORIZED);
    } finally {
      await h.close();
    }
  });
});

// MARK: - D. ConnectionRegistry

describe("D. 连接注册表与顶替", () => {
  it("hello_ok 里的 connection_id 与 registry 一致（bind 先于 hello_ok）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId })));
      const helloOk = await conn.next((f) => f.type === "hello_ok");
      const info = await h.link.registry.lookup(device.userId, device.deviceId);
      expect(info?.connectionId).toBe(helloOk.connection_id);
    } finally {
      await h.close();
    }
  });

  it("同用户第二台设备上线：旧连接收到 drain + close 4006", async () => {
    const h = await createLinkHarness();
    try {
      const user = await seedUser(h);
      const keyA = freshDeviceKey();
      const keyB = freshDeviceKey();
      const deviceA = await seedDevice(h, { userId: user, publicKey: rawPublicKey(keyA.publicKey) });
      const deviceB = await seedDevice(h, { userId: user, publicKey: rawPublicKey(keyB.publicKey) });

      const a = await connect(h, { token: deviceA.deviceToken });
      if (!a.ok) throw new Error("upgrade failed");
      a.ws.send(JSON.stringify(buildHello({ device_id: deviceA.deviceId, nonce: freshNonce() }, { key: keyA.privateKey })));
      await a.next((f) => f.type === "hello_ok");

      const b = await connect(h, { token: deviceB.deviceToken });
      if (!b.ok) throw new Error("upgrade failed");
      b.ws.send(JSON.stringify(buildHello({ device_id: deviceB.deviceId, nonce: freshNonce() }, { key: keyB.privateKey })));
      await b.next((f) => f.type === "hello_ok");

      // 旧连接：先收到 drain，然后 close 4006
      const drain = await a.next((f) => f.type === "drain");
      expect(drain.grace_ms).toBe(0);
      const closedA = await a.closeInfo;
      expect(closedA.code).toBe(REMOTE_CLOSE.SUPERSEDED);

      // 新连接仍然有效
      expect(await h.link.registry.lookupByDevice(deviceB.deviceId)).not.toBeNull();
      // 旧设备的 id 查不到（不能把新连接「借」给旧设备）
      expect(await h.link.registry.lookupByDevice(deviceA.deviceId)).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("旧连接的迟到 close 不会删除新连接", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const first = await connect(h, { token: device.deviceToken });
      if (!first.ok) throw new Error("upgrade failed");
      first.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await first.next((f) => f.type === "hello_ok");
      const firstConnectionId = (await h.link.registry.lookupByDevice(device.deviceId))?.connectionId as string;

      // 同一台设备再连一次（新 nonce）→ 顶替
      const second = await connect(h, { token: device.deviceToken });
      if (!second.ok) throw new Error("upgrade failed");
      second.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      const helloOk2 = await second.next((f) => f.type === "hello_ok");
      await first.closeInfo;

      // 旧连接已经关掉了，但它的 close 回调**不能**删掉新表项
      const info = await h.link.registry.lookupByDevice(device.deviceId);
      expect(info?.connectionId).toBe(helloOk2.connection_id);
      expect(info?.connectionId).not.toBe(firstConnectionId);
      expect(h.link.connectionCount()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("两个并发 hello 最终只保留一个连接", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const [a, b] = await Promise.all([
        connect(h, { token: device.deviceToken }),
        connect(h, { token: device.deviceToken }),
      ]);
      if (!a.ok || !b.ok) throw new Error("upgrade failed");
      a.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      b.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));

      const results = await Promise.all([
        a.next((f) => f.type === "hello_ok").then(() => "ok" as const).catch(() => "fail" as const),
        b.next((f) => f.type === "hello_ok").then(() => "ok" as const).catch(() => "fail" as const),
      ]);
      expect(results.filter((r) => r === "ok").length).toBeGreaterThanOrEqual(1);
      expect(h.link.connectionCount()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("Cloud 重启（新实例）后 registry 不保留旧 socket", async () => {
    const first = await createLinkHarness();
    let second: LinkHarness | null = null;
    try {
      const device = await seedDevice(first);
      const conn = await connect(first, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await conn.next((f) => f.type === "hello_ok");
      expect(first.link.connectionCount()).toBe(1);

      await first.close();
      expect(first.link.connectionCount()).toBe(0);

      // 「重启」= 新进程级对象，但数据库还是同一个（所以不能 resetDb）。
      second = await createLinkHarness({ resetDb: false });
      expect(second.link.connectionCount()).toBe(0);
      expect(await second.link.registry.lookupByDevice(device.deviceId)).toBeNull();

      // 设备重新握手：nonce store 也清空了，所以旧 nonce 可以再用
      // （这是进程内实现的事实，已记录在 nonce-store.ts 的注释里）。
      const reconnected = await connect(second, { token: device.deviceToken });
      if (!reconnected.ok) throw new Error("upgrade failed after restart");
      reconnected.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      const helloOk = await reconnected.next((f) => f.type === "hello_ok");
      expect(helloOk.type).toBe("hello_ok");
    } finally {
      if (second) await second.close();
      await first.close();
    }
  });
});

// MARK: - E. Grant 快照

describe("E. hello_ok 的 Grant 快照", () => {
  async function seedGrant(
    h: LinkHarness,
    userId: string,
    overrides: Partial<{ clientId: string; scopes: string[]; revokedAt: Date | null; epoch: number }> = {},
  ) {
    const rows = await h.ctx.db.db
      .insert(mcpGrants)
      .values({
        userId,
        clientId: overrides.clientId ?? "chatgpt",
        clientName: "ChatGPT",
        scopes: overrides.scopes ?? ["records:read", "coffee:read"],
        resource: "https://gw.example/mcp",
        revokedAt: overrides.revokedAt ?? null,
        epoch: overrides.epoch ?? 1,
      })
      .returning({ id: mcpGrants.id });
    return rows[0]?.id as string;
  }

  async function handshake(h: LinkHarness, device: SeededDevice): Promise<Record<string, unknown>> {
    const conn = await connect(h, { token: device.deviceToken });
    if (!conn.ok) throw new Error("upgrade failed");
    conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
    return await conn.next((f) => f.type === "hello_ok");
  }

  it("只包含该用户的 grant，字段齐全", async () => {
    const h = await createLinkHarness();
    try {
      const user = await seedUser(h);
      const device = await seedDevice(h, { userId: user, grantEpoch: 7 });
      const grantId = await seedGrant(h, user, { epoch: 3 });

      const helloOk = await handshake(h, device);
      expect(helloOk.grant_epoch).toBe(7);
      const grants = helloOk.grants as Array<Record<string, unknown>>;
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        grant_id: grantId,
        client_id: "chatgpt",
        client_name: "ChatGPT",
        scopes: ["records:read", "coffee:read"],
        bound_user_id: user,
        epoch: 3,
      });
      // grant_ctx 是不透明引用，不是 grant_id
      expect(grants[0]?.grant_ctx).toMatch(/^gc_[0-9a-f]{24}$/);
      expect(grants[0]?.grant_ctx).not.toBe(grantId);
    } finally {
      await h.close();
    }
  });

  it("revoked grant 不出现；别的用户的 grant 不出现", async () => {
    const h = await createLinkHarness();
    try {
      const user = await seedUser(h);
      const other = await seedUser(h, "Other");
      const device = await seedDevice(h, { userId: user });
      await seedGrant(h, user, { clientId: "alive" });
      await seedGrant(h, user, { clientId: "dead", revokedAt: new Date() });
      await seedGrant(h, other, { clientId: "someone-else" });

      const helloOk = await handshake(h, device);
      const clients = (helloOk.grants as Array<Record<string, unknown>>).map((g) => g.client_id);
      expect(clients).toEqual(["alive"]);
    } finally {
      await h.close();
    }
  });

  it("空 grants 不影响握手（仍然允许连接）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const helloOk = await handshake(h, device);
      expect(helloOk.grants).toEqual([]);
      expect(await h.link.registry.lookupByDevice(device.deviceId)).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it("白名单外的 scope 被过滤掉（不是整条 grant 失败）", async () => {
    const h = await createLinkHarness();
    try {
      const user = await seedUser(h);
      const device = await seedDevice(h, { userId: user });
      await seedGrant(h, user, {
        clientId: "mixed",
        scopes: ["records:read", "records:write", "admin", "canvas:read"],
      });
      const helloOk = await handshake(h, device);
      const grants = helloOk.grants as Array<Record<string, unknown>>;
      expect(grants[0]?.scopes).toEqual(["records:read", "canvas:read"]);
    } finally {
      await h.close();
    }
  });

  it("grant_ctx 每次连接都不同（不可复用、不可预测）", async () => {
    const h = await createLinkHarness();
    try {
      const user = await seedUser(h);
      const device = await seedDevice(h, { userId: user });
      await seedGrant(h, user);

      const first = await handshake(h, device);
      const ctx1 = (first.grants as Array<Record<string, unknown>>)[0]?.grant_ctx;
      const second = await handshake(h, device);
      const ctx2 = (second.grants as Array<Record<string, unknown>>)[0]?.grant_ctx;
      expect(ctx1).toBeTruthy();
      expect(ctx1).not.toBe(ctx2);
    } finally {
      await h.close();
    }
  });

  it("hello_ok 的固定字段与策略值", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      const helloOk = await handshake(h, device);
      expect(helloOk).toMatchObject({
        v: 1,
        type: "hello_ok",
        instance_id: h.link.instanceId,
        heartbeat_ms: 20_000,
        idle_timeout_ms: 60_000,
        max_inflight: 2,
        max_frame_bytes: 1024 * 1024,
      });
      expect(helloOk.allowed_tools).toEqual([
        "search_records",
        "get_record",
        "list_record_tags",
        "list_beans",
        "list_brews",
        "list_tastings",
        "list_canvases",
        "get_canvas",
      ]);
      // 不许出现的东西
      expect(helloOk).not.toHaveProperty("serviceable");
      expect(helloOk).not.toHaveProperty("device_token");
      expect(JSON.stringify(helloOk)).not.toContain("bp_dev_");
    } finally {
      await h.close();
    }
  });
});

// MARK: - F. 心跳

describe("F. 心跳", () => {
  it("连接建立后按周期发 ping，正确 pong 会被接受并写 last_seen_at", async () => {
    const h = await createLinkHarness({ heartbeatMs: 60 });
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      const helloOk = await conn.next((f) => f.type === "hello_ok");
      expect(helloOk.heartbeat_ms).toBe(60);

      const ping = await conn.next((f) => f.type === "ping");
      expect(ping.seq).toBe(1);
      conn.ws.send(JSON.stringify({ v: 1, type: "pong", ts: Date.now(), seq: ping.seq, inflight: 0 }));

      // last_seen_at 由有效 pong 推进
      await waitFor(async () => {
        const rows = await h.ctx.db.db
          .select({ lastSeenAt: mcpDevices.lastSeenAt })
          .from(mcpDevices)
          .where(eq(mcpDevices.id, device.deviceId));
        return rows[0]?.lastSeenAt !== null;
      });
      conn.ws.close(1000);
      await conn.closeInfo;
    } finally {
      await h.close();
    }
  });

  it("不回 pong → close 4008", async () => {
    const h = await createLinkHarness({ heartbeatMs: 40, idleTimeoutMs: 120 });
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await conn.next((f) => f.type === "hello_ok");
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.HEARTBEAT_TIMEOUT);
      expect(closed.reason).toBe("heartbeat timeout");
    } finally {
      await h.close();
    }
  });

  it("只发 status 帧不算心跳回应（不能靠别的帧续命）", async () => {
    const h = await createLinkHarness({ heartbeatMs: 40, idleTimeoutMs: 120 });
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await conn.next((f) => f.type === "hello_ok");

      // 疯狂发 status，但从不回 pong
      const spam = setInterval(() => {
        if (conn.ws.readyState === conn.ws.OPEN) {
          conn.ws.send(JSON.stringify({ v: 1, type: "status", ts: Date.now(), serviceable: true }));
        }
      }, 20);
      const closed = await conn.closeInfo;
      clearInterval(spam);
      expect(closed.code).toBe(REMOTE_CLOSE.HEARTBEAT_TIMEOUT);
    } finally {
      await h.close();
    }
  });

  it("错误 seq 的 pong 不刷新心跳（同样会超时）", async () => {
    const h = await createLinkHarness({ heartbeatMs: 40, idleTimeoutMs: 120 });
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await conn.next((f) => f.type === "hello_ok");

      const spam = setInterval(() => {
        if (conn.ws.readyState === conn.ws.OPEN) {
          conn.ws.send(JSON.stringify({ v: 1, type: "pong", ts: Date.now(), seq: 999, inflight: 0 }));
        }
      }, 20);
      const closed = await conn.closeInfo;
      clearInterval(spam);
      expect(closed.code).toBe(REMOTE_CLOSE.HEARTBEAT_TIMEOUT);
    } finally {
      await h.close();
    }
  });

  it("断开后定时器全部清除（进程不再被 timer 拖住）", async () => {
    const h = await createLinkHarness({ heartbeatMs: 30 });
    try {
      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await conn.next((f) => f.type === "hello_ok");
      conn.ws.close(1000);
      await conn.closeInfo;
      await waitFor(async () => h.link.connectionCount() === 0);
      expect(h.link.connectionCount()).toBe(0);
    } finally {
      await h.close();
    }
  });
});

// MARK: - G. suspend / revoke 联动

describe("G. 设备暂停与撤销的联动", () => {
  async function onlineDevice(h: LinkHarness) {
    const device = await seedDevice(h);
    const conn = await connect(h, { token: device.deviceToken });
    if (!conn.ok) throw new Error("upgrade failed");
    conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
    await conn.next((f) => f.type === "hello_ok");
    return { device, conn };
  }

  it("suspend：收到 bye(suspended) + close 4005，registry 清空", async () => {
    const h = await createLinkHarness();
    try {
      const { device, conn } = await onlineDevice(h);
      await h.link.disconnectDevice(device.deviceId, "suspended");

      const bye = await conn.next((f) => f.type === "bye");
      expect(bye.reason).toBe("suspended");
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.DEVICE_SUSPENDED);
      expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
      expect(h.link.connectionCount()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("revoke：收到 bye(revoked) + close 4003", async () => {
    const h = await createLinkHarness();
    try {
      const { device, conn } = await onlineDevice(h);
      await h.link.disconnectDevice(device.deviceId, "revoked");

      const bye = await conn.next((f) => f.type === "bye");
      expect(bye.reason).toBe("revoked");
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.DEVICE_REVOKED);
      expect(h.link.connectionCount()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("设备离线时 disconnect 是空操作（不抛错）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      await expect(h.link.disconnectDevice(device.deviceId, "revoked")).resolves.toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("ST-12：撤销后旧 token 不能重新握手", async () => {
    const h = await createLinkHarness();
    try {
      const { device, conn } = await onlineDevice(h);
      // 模拟 route 层：先落库，再清连接
      await h.ctx.db.db
        .update(mcpDevices)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(mcpDevices.id, device.deviceId));
      await h.link.disconnectDevice(device.deviceId, "revoked");
      await conn.closeInfo;

      await expectCloseCode(h, device, buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() }), REMOTE_CLOSE.DEVICE_REVOKED);
    } finally {
      await h.close();
    }
  });

  it("registry 清理失败时，DB 里的 revoked 仍然有效（旧 token 被拒）", async () => {
    const h = await createLinkHarness();
    try {
      const { device, conn } = await onlineDevice(h);
      // 故障注入：registry.unbind 抛错
      const original = h.link.registry.unbind.bind(h.link.registry);
      h.link.registry.unbind = async () => {
        throw new Error("registry failure");
      };

      await h.ctx.db.db
        .update(mcpDevices)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(mcpDevices.id, device.deviceId));

      // 清理抛错：必须**逃出** disconnectDevice（由 route 层的 cleanupConnection 兜住）
      await expect(h.link.disconnectDevice(device.deviceId, "revoked")).rejects.toThrow("registry failure");

      h.link.registry.unbind = original;
      conn.ws.close(1000);
      await conn.closeInfo;

      // 关键断言：即使清理失败，撤销依然生效。
      await expectCloseCode(h, device, buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() }), REMOTE_CLOSE.DEVICE_REVOKED);
    } finally {
      await h.close();
    }
  });

  it("撤销设备不删除 mcp_grants（grant 属于用户）", async () => {
    const h = await createLinkHarness();
    try {
      const { device } = await onlineDevice(h);
      const rows = await h.ctx.db.db
        .insert(mcpGrants)
        .values({
          userId: device.userId,
          clientId: "chatgpt",
          clientName: "ChatGPT",
          scopes: ["records:read"],
          resource: "https://gw.example/mcp",
        })
        .returning({ id: mcpGrants.id });

      await h.ctx.db.db
        .update(mcpDevices)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(mcpDevices.id, device.deviceId));
      await h.link.disconnectDevice(device.deviceId, "revoked");

      const grants = await h.ctx.db.db
        .select({ id: mcpGrants.id, revokedAt: mcpGrants.revokedAt })
        .from(mcpGrants)
        .where(eq(mcpGrants.userId, device.userId));
      expect(grants).toHaveLength(1);
      expect(grants[0]?.id).toBe(rows[0]?.id);
      expect(grants[0]?.revokedAt).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("HTTP 撤销路由：先落库再清连接（真实 DELETE）", async () => {
    const h = await createLinkHarness();
    try {
      const { device, conn } = await onlineDevice(h);
      const token = await signAccessToken(
        h.ctx.keyRing,
        { userId: device.userId, sessionId: "00000000-0000-4000-8000-000000000001" },
        { issuer: h.ctx.env.baseUrl, ttlSeconds: 900 },
      );

      const resp = await fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${device.deviceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { status: string }).status).toBe("revoked");

      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.DEVICE_REVOKED);
      expect(h.link.connectionCount()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("HTTP 暂停路由：device_token 自暂停也会清连接", async () => {
    const h = await createLinkHarness();
    try {
      const { device, conn } = await onlineDevice(h);
      const resp = await fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${device.deviceId}/suspend`, {
        method: "POST",
        // 这里**只有** device_token，没有用户 Bearer。
        headers: { authorization: `Bearer ${device.deviceToken}` },
      });
      expect(resp.status).toBe(200);
      const closed = await conn.closeInfo;
      expect(closed.code).toBe(REMOTE_CLOSE.DEVICE_SUSPENDED);
    } finally {
      await h.close();
    }
  });
});

// MARK: - H. 运维

describe("H. 运维与停机", () => {
  it("/ready 返回 instance_id 与 connection_count", async () => {
    const h = await createLinkHarness();
    try {
      const before = await fetch(`http://127.0.0.1:${h.server.port}/ready`);
      const body = (await before.json()) as { status: string; instance_id: string; connection_count: number };
      expect(before.status).toBe(200);
      expect(body.status).toBe("ready");
      expect(body.instance_id).toBe(h.link.instanceId);
      expect(body.connection_count).toBe(0);

      const device = await seedDevice(h);
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
      await conn.next((f) => f.type === "hello_ok");

      const after = await fetch(`http://127.0.0.1:${h.server.port}/ready`);
      expect(((await after.json()) as { connection_count: number }).connection_count).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("数据库断开时 /ready 仍返回 503（并带上两个新字段）", async () => {
    const h = await createLinkHarness();
    try {
      const original = h.ctx.db.ping;
      h.ctx.db.ping = async () => {
        throw new Error("database is gone");
      };
      const resp = await fetch(`http://127.0.0.1:${h.server.port}/ready`);
      expect(resp.status).toBe(503);
      const body = (await resp.json()) as { status: string; instance_id: string; connection_count: number };
      expect(body.status).toBe("degraded");
      expect(body.instance_id).toBe(h.link.instanceId);
      expect(body.connection_count).toBe(0);
      h.ctx.db.ping = original;
    } finally {
      await h.close();
    }
  });

  it("停机：连接收到 drain + bye + close 1001，连接数归零", async () => {
    const h = await createLinkHarness();
    const device = await seedDevice(h);
    const conn = await connect(h, { token: device.deviceToken });
    if (!conn.ok) throw new Error("upgrade failed");
    conn.ws.send(JSON.stringify(buildHello({ device_id: device.deviceId, nonce: freshNonce(), ts: Date.now() })));
    await conn.next((f) => f.type === "hello_ok");

    await h.server.close();

    const closed = await conn.closeInfo;
    expect(closed.code).toBe(REMOTE_CLOSE.GOING_AWAY);
    expect(closed.reason).toBe("going away");
    expect(h.link.connectionCount()).toBe(0);
  });

  it("停机期间的新 upgrade 被 503 拒绝（WSS 先停，HTTP 后停）", async () => {
    const h = await createLinkHarness();
    try {
      const device = await seedDevice(h);
      // 只停 WSS 层：HTTP 仍在监听，所以这条**能**观测到 503。
      // 如果等到 server.close() 之后，TCP 连接都建不起来（ECONNREFUSED），
      // 那时断言 503 是错的——「连接被拒」与「升级被拒」是两件事。
      await h.link.shutdown();

      const after = await connect(h, { token: device.deviceToken });
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.rejection.status).toBe(503);
    } finally {
      await h.close();
    }
  });

  it("停机时没有连接也能正常返回（不会卡住）", async () => {
    const h = await createLinkHarness();
    await expect(h.close()).resolves.toBeUndefined();
    expect(h.link.connectionCount()).toBe(0);
  });
});

// MARK: - 工具

function freshNonce(): string {
  return randomBytes(16).toString("base64url");
}

async function expectCloseCode(
  h: LinkHarness,
  device: SeededDevice,
  hello: unknown,
  expected: number,
): Promise<void> {
  const conn = await connect(h, { token: device.deviceToken });
  if (!conn.ok) throw new Error(`upgrade failed with ${conn.rejection.status}`);
  conn.ws.send(typeof hello === "string" ? hello : JSON.stringify(hello));
  const closed = await conn.closeInfo;
  expect(closed.code).toBe(expected);
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}
