import { createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { Database } from "../db/client.js";
import { and, eq, isNull } from "drizzle-orm";
import { mcpGrants } from "../db/schema.js";
import { findDeviceByToken, isDeviceTokenExpired, type AuthedDevice } from "../mcp-devices/device-token.js";
import {
  decodeBase64UrlStrict,
  filterScopes,
  helloSchema,
  helloSigningPayload,
  negotiateVersion,
  REMOTE_MAX_CLOCK_SKEW_MS,
  type GrantSnapshot,
  type Hello,
} from "./schemas.js";

/**
 * WSS 握手的认证与验签（协议 §4.3 的 1–8 步）。
 *
 * 这一层**不碰 socket**：输入是 `(token, 原始帧, 当前时间)`，输出是一个
 * 判别联合。这样握手逻辑可以用纯单元测试打穿（时间偏差、公钥长度、
 * 规范串歧义、nonce 重放……），而不需要每条用例都开一个真 WebSocket。
 * 传输层的活（帧大小、close code、timer）全在 `link-server.ts`。
 *
 * ## 校验顺序是安全性的一部分（不可重排）
 *
 * ```
 * 1. Authorization 形态       ← 升级前做（link-server）
 * 2. token_hash 命中
 * 3. status = active
 * 4. token_expires_at > now
 * 5. |now - hello.ts| ≤ 120s
 * 6. Ed25519 验签
 * 7. 原子 nonce check-and-record
 * 8. 版本区间协商
 * ```
 *
 * 两个顺序点值得单独说：
 *
 * - **验签（6）必须早于 nonce（7）**。反过来的话，任何未认证的流量都能
 *   往 nonce 表里塞条目——攻击者用随机 nonce 就能把表灌满，而表满时
 *   真实设备被 fail-closed 拒绝（一条零成本的 DoS）。
 * - **时间偏差（5）早于验签（6）**：便宜的无状态检查先做，省掉一次
 *   公钥重建与签名验证。
 */

export type HandshakeFailure =
  | { kind: "unauthorized" }
  | { kind: "revoked" }
  | { kind: "suspended" }
  | { kind: "version" }
  | { kind: "protocol"; detail: string }
  | { kind: "nonce_capacity" };

export type HandshakeResult =
  | { ok: true; device: AuthedDevice; hello: Hello; negotiatedVersion: number }
  | { ok: false; failure: HandshakeFailure };

/** Ed25519 SPKI DER 的固定 12 字节前缀，其后是裸 32 字节公钥。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_RAW_PUBLIC_KEY_BYTES = 32;

/**
 * 由裸 32 字节公钥重建 KeyObject。
 *
 * **三条断言缺一不可**（每条都对应一个真实攻击面）：
 *
 * 1. 裸公钥必须恰好 32 字节——`createPublicKey` 会接受「合法 DER + 尾部垃圾」，
 *    所以长度要在拼接**之前**查，而不是靠解析是否成功；
 * 2. 拼出的 SPKI 必须恰好 44 字节；
 * 3. `asymmetricKeyType` 必须是 `ed25519`——否则一个 RSA 公钥（DER 结构完全
 *    不同但同样能被解析）会被当成签名密钥，而验签会「成功」地验证错误的东西。
 */
export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject | null {
  if (raw.length !== ED25519_RAW_PUBLIC_KEY_BYTES) return null;
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * 验签。**只认 `=== true`**。
 *
 * Spike 实测（Electron 45 / Node 22+）：`crypto.verify` 对**长度错误**的签名
 * 返回 `false` 而不是抛错。所以「没抛异常」不能当作通过，也不能因为
 * 返回值是 `undefined` 就放行。签名长度还要显式查——有些实现对 63/65 字节
 * 的输入行为不一致，显式拒绝是唯一稳定的判据。
 */
export function verifyHelloSignature(publicKeyRaw: string, hello: Hello): boolean {
  const raw = decodeBase64UrlStrict(publicKeyRaw, ED25519_RAW_PUBLIC_KEY_BYTES);
  if (!raw) return false;
  const key = ed25519PublicKeyFromRaw(raw);
  if (!key) return false;

  const sig = decodeBase64UrlStrict(hello.sig, ED25519_SIGNATURE_BYTES);
  if (!sig) return false;

  const { sig: _ignored, ...signingInput } = hello;
  try {
    return cryptoVerify(null, helloSigningPayload(signingInput), key, sig) === true;
  } catch {
    return false;
  }
}

export interface NonceRecorder {
  checkAndRecord(nonce: string): "ok" | "replay" | "capacity";
}

export interface HandshakeDeps {
  db: Database;
  nonces: NonceRecorder;
  /** epoch 毫秒。**每次握手只读一次**，之后的比较都用这一个值。 */
  now?: () => number;
}

/**
 * 完整握手校验（§4.3 第 2–8 步）。
 *
 * 输入 `raw` 是 hello 帧的原文。解析失败与语义失败都归 `protocol`
 * （→ 4009），但**`v` 不受支持归 `version`**（→ 4002）——
 * 两者是完全不同的故障，混用会让排障方向从第一步就错。
 */
export async function verifyHandshake(
  deps: HandshakeDeps,
  input: { deviceToken: string; raw: string },
): Promise<HandshakeResult> {
  const nowEpoch = (deps.now ?? Date.now)();

  // ---- 第 2 步：token_hash 命中 ----
  const device = await findDeviceByToken(deps.db, input.deviceToken);
  if (!device) return { ok: false, failure: { kind: "unauthorized" } };

  // ---- 第 3 步：状态 ----
  // 顺序：revoked 与 suspended 各有专属 close code（4003 / 4005），
  // 因为它们对 Desktop 的处置完全不同（清私钥 vs 等用户开开关）。
  if (device.status === "revoked") return { ok: false, failure: { kind: "revoked" } };
  if (device.status === "suspended") return { ok: false, failure: { kind: "suspended" } };
  if (device.status !== "active") return { ok: false, failure: { kind: "unauthorized" } };

  // ---- 第 4 步：token 寿命 ----
  // **只读 token_expires_at**。`expires_at` 是 pending 窗口，用它判断
  // 会让每台正常设备在注册 5 分钟后被判死。
  if (isDeviceTokenExpired(device, new Date(nowEpoch))) {
    return { ok: false, failure: { kind: "unauthorized" } };
  }

  // ---- hello 帧本身 ----
  const parsedFrame = parseHelloFrame(input.raw);
  if (!parsedFrame.ok) return { ok: false, failure: parsedFrame.failure };
  const hello = parsedFrame.hello;

  // ---- 第 5 步：时钟偏差 ----
  // `ts` 是 Unix epoch 毫秒（Date.now()），**不是** monotonic——
  // 它要跨进程可比，所以只能用挂钟；而挂钟会被调整，所以只允许 ±120s。
  if (Math.abs(nowEpoch - hello.ts) > REMOTE_MAX_CLOCK_SKEW_MS) {
    return { ok: false, failure: { kind: "protocol", detail: "clock skew" } };
  }

  // ---- 第 4.5 步：hello.device_id 必须就是 token 对应的那台设备 ----
  // 这条挡住的是 ST-2：拿设备 A 的 token、用设备 B 的私钥签名。
  // 没有它，签名验证会「用 A 的公钥验 B 签的名」→ 必然失败，
  // 但失败原因会与「签名坏了」混在一起，而更糟的是：若某天有人把公钥来源
  // 改成「帧里带的公钥」，这就成了纯粹的冒充。
  if (hello.device_id !== device.id) {
    return { ok: false, failure: { kind: "unauthorized" } };
  }

  // ---- 第 6 步：验签 ----
  if (!verifyHelloSignature(device.publicKey, hello)) {
    return { ok: false, failure: { kind: "unauthorized" } };
  }

  // ---- 第 7 步：原子 nonce ----
  const nonce = deps.nonces.checkAndRecord(hello.nonce);
  if (nonce === "replay") return { ok: false, failure: { kind: "unauthorized" } };
  if (nonce === "capacity") return { ok: false, failure: { kind: "nonce_capacity" } };

  // ---- 第 8 步：版本协商 ----
  const negotiated = negotiateVersion(hello.min_version, hello.max_version);
  if (negotiated === null) return { ok: false, failure: { kind: "version" } };

  return { ok: true, device, hello, negotiatedVersion: negotiated };
}

type ParsedHello =
  | { ok: true; hello: Hello }
  | { ok: false; failure: HandshakeFailure };

/**
 * 解析 hello 帧。**先读信封再严格解析**，把「版本不支持」与「形状非法」分开。
 */
export function parseHelloFrame(raw: string): ParsedHello {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, failure: { kind: "protocol", detail: "unparsable frame" } };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, failure: { kind: "protocol", detail: "frame is not an object" } };
  }
  const envelope = json as { v?: unknown; type?: unknown };
  if (envelope.type !== "hello") {
    return { ok: false, failure: { kind: "protocol", detail: "first frame must be hello" } };
  }
  // 版本：只有整数且不等于 1 才判 4002。非整数（`"1"` / `1.5`）属于形状错误。
  if (typeof envelope.v === "number" && Number.isInteger(envelope.v) && envelope.v !== 1) {
    return { ok: false, failure: { kind: "version" } };
  }
  const parsed = helloSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, failure: { kind: "protocol", detail: "hello shape invalid" } };
  }
  return { ok: true, hello: parsed.data };
}

// MARK: - Grant 快照

export interface GrantRow {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  userId: string;
  epoch: number;
}

/**
 * 取该用户的全部有效 grant（§4.3 第 10 步，`revoked_at IS NULL`）。
 *
 * 三件事刻意不做：
 * - **不读请求里的 user_id**（根本没有这条路径）：用户身份只来自
 *   `device.userId`，而它来自 token 哈希。任何「按帧里的 id 过滤」的设计
 *   都会制造第二个事实来源。
 * - **不跨用户查**：`where user_id = device.userId` 是 SQL 条件，不是
 *   「查出来再过滤」——后者会把别人的行读进进程内存。
 * - **不因 scopes 为空而丢弃 grant**：授权存在但一个可用 scope 都没有，
 *   是用户该看见的状态（Desktop 会显示「已授权，但范围为空」），
 *   悄悄消失只会让人以为授权丢了。
 */
export async function loadGrantRows(db: Database, userId: string): Promise<GrantRow[]> {
  const rows = await db
    .select({
      id: mcpGrants.id,
      clientId: mcpGrants.clientId,
      clientName: mcpGrants.clientName,
      scopes: mcpGrants.scopes,
      userId: mcpGrants.userId,
      epoch: mcpGrants.epoch,
    })
    .from(mcpGrants)
    .where(and(eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt)));
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    scopes: row.scopes,
    userId: row.userId,
    epoch: row.epoch,
  }));
}

/**
 * `grant_ctx`：**每次连接新生成**的不透明引用（协议 §6.5）。
 *
 * 不持久化、不复用、不参与签名。它唯一的作用是让 `req` 引用「这条连接上的
 * 这一条授权」，而不是引用一个可能被别处猜到的 `grant_id`。
 *
 * 用 `crypto.randomUUID()` 而不是自增/时间戳：后者可预测，而 `grant_ctx`
 * 一旦可预测，「猜一个 ctx 去试探授权」就成立了。
 */
export function makeGrantContext(): string {
  return `gc_${randomHex(12)}`;
}

/** `conn_` 前缀的 connection_id。与 Desktop 的 Mock 命名习惯一致。 */
export function makeConnectionId(): string {
  return `conn_${randomHex(9)}`;
}

/** `gw_` 前缀的实例 id，每次启动生成一个。 */
export function makeInstanceId(): string {
  return `gw_${randomHex(4)}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** 把数据库行转成 `hello_ok.grants[]`（scope 已过白名单）。 */
export function toGrantSnapshots(rows: readonly GrantRow[], ctxOf: (grantId: string) => string): GrantSnapshot[] {
  return rows.map((row) => ({
    grant_ctx: ctxOf(row.id),
    grant_id: row.id,
    client_id: row.clientId,
    client_name: row.clientName,
    scopes: filterScopes(row.scopes),
    bound_user_id: row.userId,
    epoch: row.epoch,
  }));
}
