import { randomBytes, sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mcpDevices, mcpGrants, users } from "../../src/db/schema.js";
import { helloSigningPayload, type Hello } from "../../src/link/schemas.js";
import { gatewayResource } from "../../src/link/dispatch-guard.js";
import { sha256Hex } from "../../src/security/crypto.js";
import type { WebSocket } from "ws";
import { connect, type LinkHarness } from "./link-server.js";

/**
 * 请求转发测试的共用原语（Phase 1.2B.2.2）。
 *
 * ## 这里刻意造一个「假 Desktop」
 *
 * 它不是 Mock Gateway（那条路在 1.1B 证明过会自证正确）。这里被测的是
 * **Cloud 的转发层**，所以对端只需要准确地扮演「一台按协议回 `res` 的设备」：
 *
 * - 收到 `req` 就回一条内容可预测的 `res`（或按测试指定的方式回）；
 * - 收到 `grant_update` 就回 `grant_update_ack`（可指定 applied）；
 * - 需要时可以**什么都不回**（测超时）。
 *
 * 真实的 Desktop 侧行为由 Desktop 自己的 1300 条测试保证。两端通过
 * `fixtures/remote-mcp/req-v1.json` 与协议字段对齐。
 */

export interface DeviceKeys {
  privateKey: KeyObject;
  publicKey: string;
}

export function keyPair(): DeviceKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url"),
  };
}

export async function seedUser(h: LinkHarness, name = "Forward Tester"): Promise<string> {
  const rows = await h.ctx.db.db.insert(users).values({ displayName: name }).returning({ id: users.id });
  const userId = rows[0]?.id;
  if (!userId) throw new Error("user insert returned no row");
  return userId;
}

export async function seedDevice(
  h: LinkHarness,
  userId: string,
  overrides: {
    keys?: DeviceKeys;
    status?: "active" | "suspended" | "revoked" | "pending";
    tokenExpiresAt?: Date | null;
    grantEpoch?: number;
  } = {},
): Promise<{ deviceId: string; deviceToken: string; keys: DeviceKeys }> {
  const keys = overrides.keys ?? keyPair();
  const deviceToken = `bp_dev_${randomBytes(24).toString("base64url")}`;
  const rows = await h.ctx.db.db
    .insert(mcpDevices)
    .values({
      userId,
      name: "forward",
      platform: "darwin",
      publicKey: keys.publicKey,
      status: overrides.status ?? "active",
      confirmCodeHash: "unused",
      claimSecretHash: "unused",
      expiresAt: new Date(Date.now() + 300_000),
      tokenHash: sha256Hex(deviceToken),
      tokenIssuedAt: new Date(),
      tokenExpiresAt:
        overrides.tokenExpiresAt === undefined ? new Date(Date.now() + 30 * 24 * 3600_000) : overrides.tokenExpiresAt,
      grantEpoch: overrides.grantEpoch ?? 0,
    })
    .returning({ id: mcpDevices.id });
  const deviceId = rows[0]?.id;
  if (!deviceId) throw new Error("device insert returned no row");
  return { deviceId, deviceToken, keys };
}

export async function seedGrant(
  h: LinkHarness,
  userId: string,
  overrides: {
    clientId?: string;
    clientName?: string;
    scopes?: string[];
    resource?: string;
    epoch?: number;
    revokedAt?: Date | null;
  } = {},
): Promise<string> {
  const rows = await h.ctx.db.db
    .insert(mcpGrants)
    .values({
      userId,
      clientId: overrides.clientId ?? "chatgpt",
      clientName: overrides.clientName ?? "ChatGPT",
      scopes: overrides.scopes ?? ["records:read"],
      resource: overrides.resource ?? gatewayResource(h.ctx.env.baseUrl),
      epoch: overrides.epoch ?? 1,
      revokedAt: overrides.revokedAt ?? null,
    })
    .returning({ id: mcpGrants.id });
  const grantId = rows[0]?.id;
  if (!grantId) throw new Error("grant insert returned no row");
  return grantId;
}

export function buildHello(deviceId: string, keys: DeviceKeys, overrides: Partial<Omit<Hello, "sig">> = {}): Hello {
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
  return { ...base, sig: cryptoSign(null, helloSigningPayload(base), keys.privateKey).toString("base64url") };
}

export interface OnlineDevice {
  ws: WebSocket;
  /** 收到的全部帧（按序），测试可随时读。 */
  frames: Array<Record<string, unknown>>;
  /** 已经到达但还没被 `next()` 取走的帧。 */
  pending: Record<string, unknown>[];
  closeInfo: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  /** 等一帧满足条件的入站帧。 */
  next(predicate?: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** 等到第 n 条 `req`（用于「不该有第二条」这类断言）。 */
  waitForReqCount(count: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** 连接 + 完整握手，返回一个可以收发帧的「设备」。 */
export async function goOnline(h: LinkHarness, device: { deviceId: string; deviceToken: string; keys: DeviceKeys }): Promise<OnlineDevice> {
  const opened = await connect(h, { token: device.deviceToken });
  if (!opened.ok) throw new Error(`upgrade rejected with ${opened.rejection.status}`);

  const frames: Array<Record<string, unknown>> = [];
  const pending: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];

  opened.ws.on("message", (data: Buffer) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    frames.push(frame);
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index !== -1) {
      const waiter = waiters[index] as (typeof waiters)[number];
      waiters.splice(index, 1);
      waiter.resolve(frame);
      return;
    }
    pending.push(frame);
  });

  const waitFor = (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> => {
    const existing = pending.find(predicate);
    if (existing) {
      pending.splice(pending.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === wrapped);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for a frame; saw ${JSON.stringify(frames.map((f) => f.type))}`));
      }, timeoutMs);
      timer.unref?.();
      const wrapped = (frame: Record<string, unknown>): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      waiters.push({ predicate, resolve: wrapped });
    });
  };

  opened.ws.send(JSON.stringify(buildHello(device.deviceId, device.keys)));
  await waitFor((frame) => frame.type === "hello_ok");

  return {
    ws: opened.ws,
    frames,
    pending,
    closeInfo: opened.closeInfo,
    send(frame) {
      opened.ws.send(JSON.stringify(frame));
    },
    next: waitFor,
    async waitForReqCount(count, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (frames.filter((frame) => frame.type === "req").length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(
        `expected ${count} req frame(s), saw ${frames.filter((frame) => frame.type === "req").length}`,
      );
    },
    close() {
      opened.ws.close();
    },
  };
}

/** 一条成功的 `res`。 */
export function okRes(id: string, data: unknown, meta: { duration_ms?: number; cached?: boolean } = {}): Record<string, unknown> {
  return {
    v: 1,
    type: "res",
    id,
    ts: Date.now(),
    ok: true,
    data,
    meta: { duration_ms: meta.duration_ms ?? 1, cached: meta.cached ?? false },
  };
}

/** 一条失败的 `res`。 */
export function errRes(
  id: string,
  code: string,
  message = "failed",
  retryable = false,
): Record<string, unknown> {
  return {
    v: 1,
    type: "res",
    id,
    ts: Date.now(),
    ok: false,
    error: { code, message, retryable },
    meta: { duration_ms: 0, cached: false },
  };
}

/** `grant_update_ack`。 */
export function grantAck(epoch: number, applied: boolean, reason = ""): Record<string, unknown> {
  return { v: 1, type: "grant_update_ack", ts: Date.now(), grant_epoch: epoch, applied, reason };
}

/** 等到条件成立（只在等真实事件时用，不用来制造并发）。 */
export async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met: ${label}`);
}

/** 把帧里的 `req` 全部取出来（顺序）。 */
export function reqFrames(device: OnlineDevice): Array<Record<string, unknown>> {
  return device.frames.filter((frame) => frame.type === "req");
}
