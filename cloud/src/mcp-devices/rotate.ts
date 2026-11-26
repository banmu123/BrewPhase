import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices } from "../db/schema.js";
import { sha256Hex } from "../security/crypto.js";
import {
  deviceNotFound,
  deviceUnauthorized,
  invalidDeviceState,
  invalidPublicKey,
} from "../security/errors.js";
import { DEVICE_TOKEN_TTL_MS } from "./claim.js";
import {
  findDeviceByToken,
  generateDeviceToken,
  isDeviceTokenExpired,
} from "./device-token.js";
import { rawPublicKeyByteLength } from "./schemas.js";

/**
 * 设备凭据轮换（协议 §3.5 / 生命周期 §11.6）。
 *
 * ## 它解决什么问题
 *
 * `device_token` 是长期凭据（30 天），`public_key` 是设备身份。二者都会随时间
 * 变得可疑：token 可能在备份里、可能被日志截获；私钥可能因为机器送修而被视为
 * 泄漏。轮换是**不重新配对**就能换掉这两样东西的唯一方式。
 *
 * ## 为什么签名必须覆盖新公钥
 *
 * 只有「持有旧 device_token」时，任何人都能把设备换成**自己的**公钥——
 * 那等于把设备身份交给一个只偷到 token 的人。所以换钥匙必须同时证明
 * 「我还持有旧私钥」。签名原文因此包含 `new_public_key`：
 *
 * ```
 * brewphase.remote.rotate.v1
 * <device_id>
 * <new_public_key>
 * <ts>
 * ```
 *
 * 三行的顺序与首行前缀都是**协议固定**的，不能改：改了会让「同一把私钥在
 * 别处签的消息」与本协议的消息在字节上同形（跨协议签名复用）。
 *
 * ## 并发：只可能有一个成功
 *
 * 事务内 `SELECT ... FOR UPDATE` 锁住设备行，然后重验 `token_hash`。
 * 第二个并发请求会**阻塞到第一个提交**，随后读到已被覆盖的 `token_hash`，
 * 与它带来的旧 token 哈希不符 → 401。
 *
 * 这条判据与 1.2B.1.2 的握手准入用的是**同一把锁**：`UPDATE mcp_devices`
 * 无条件持有行锁，任何写路径都无法绕过。所以「轮换 / 暂停 / 撤销 / 握手」
 * 四者之间天然串行。
 *
 * ## 一个必须写明的顺序
 *
 * 数据库更新**先于**任何连接操作。反过来（先断连接再改库）会留下一个窗口：
 * 旧连接已死、旧凭据仍然有效，攻击者可以拿着旧 token 重新握手。任务书要求
 * 的正是这个顺序，而生命周期 §11.6 的 ②③ 也只是把「更新」放在「断开」之前。
 */

/**
 * 轮换允许的时钟偏差。
 *
 * 与 WSS 握手的 `REMOTE_MAX_CLOCK_SKEW_MS` **必须相同**——两处都是「跨进程
 * 时间戳能否被接受」的判据，取不同值只会让用户在两个入口看到矛盾的行为。
 * 这里不 import 连接层的常量，是为了保持依赖方向（设备面不依赖 link 层）；
 * 相等性由 `tests/mcp-devices/rotate.test.ts` 的断言锁住。
 */
export const ROTATE_MAX_CLOCK_SKEW_MS = 120_000;

/** 签名规范串的域分隔前缀（协议 §3.5，唯一实现）。 */
export const ROTATE_SIGNING_PREFIX = "brewphase.remote.rotate.v1";

/** Ed25519 SPKI DER 的固定 12 字节前缀（其后是裸 32 字节公钥）。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_RAW_PUBLIC_KEY_BYTES = 32;

/**
 * 构造签名原文。**唯一实现**：Desktop 侧有一份同构的 `rotateSigningPayload`，
 * 两端对 `fixtures/remote-mcp/rotate-v1.json` 必须得出同一串（测试锁）。
 *
 * 字段值里出现换行会破坏「一行一个字段」的结构，与 hello 的规范串同理，
 * 但这里更严重：`device_id` 与 `new_public_key` 都来自请求，其中
 * `new_public_key` 是攻击者可控的字符串。含换行直接拒绝生成。
 */
export function rotateSigningPayload(input: {
  deviceId: string;
  newPublicKey: string;
  ts: number;
}): Buffer {
  return Buffer.from(
    [
      ROTATE_SIGNING_PREFIX,
      assertNoLineBreaks("device_id", input.deviceId),
      assertNoLineBreaks("new_public_key", input.newPublicKey),
      String(input.ts),
    ].join("\n"),
    "utf8",
  );
}

function assertNoLineBreaks(field: string, value: string): string {
  if (/[\n\r]/.test(value)) throw new Error(`${field} must not contain line breaks`);
  return value;
}

/**
 * 由裸 32 字节公钥重建 KeyObject，并断言它**确实是** Ed25519。
 *
 * 三条断言缺一不可（与握手侧同一套理由）：长度必须在拼接**之前**查
 * （`createPublicKey` 会接受「合法 DER + 尾部垃圾」）；拼出的 SPKI 必须恰好
 * 44 字节；类型必须是 ed25519。
 */
function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject | null {
  if (raw.length !== ED25519_RAW_PUBLIC_KEY_BYTES) return null;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/**
 * 校验 base64url 文本是**规范的** 32 字节公钥编码。
 *
 * `Buffer.from(text, "base64url")` 是宽松的：它忽略非法字符、接受非规范的
 * 末尾填充位。所以三步都要做——字符集、解码长度、**重新编码逐字符相同**。
 * 没有最后一步，同一把公钥会有多种文本表示，而设备表里存的是文本。
 */
function canonicalRawPublicKey(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const raw = Buffer.from(text, "base64url");
  if (raw.length !== ED25519_RAW_PUBLIC_KEY_BYTES) return null;
  if (raw.toString("base64url") !== text) return null;
  return raw;
}

/** 用旧公钥验 rotate 签名。**只认 `=== true`**（错误长度的签名不抛错，返回 false）。 */
export function verifyRotationSignature(input: {
  oldPublicKey: string;
  deviceId: string;
  newPublicKey: string;
  ts: number;
  sig: string;
}): boolean {
  const rawPub = canonicalRawPublicKey(input.oldPublicKey);
  if (!rawPub) return false;
  const key = ed25519PublicKeyFromRaw(rawPub);
  if (!key) return false;

  const sig = Buffer.from(input.sig, "base64url");
  if (sig.length !== ED25519_SIGNATURE_BYTES) return false;
  if (sig.toString("base64url") !== input.sig) return false;

  let payload: Buffer;
  try {
    payload = rotateSigningPayload({
      deviceId: input.deviceId,
      newPublicKey: input.newPublicKey,
      ts: input.ts,
    });
  } catch {
    // 字段含换行 → 规范串有歧义 → 拒绝，而不是拼出一个可被重解释的串。
    return false;
  }

  try {
    return cryptoVerify(null, payload, key, sig) === true;
  } catch {
    return false;
  }
}

export interface RotatedCredentials {
  deviceToken: string;
  expiresAt: Date;
}

export interface RotateInput {
  /** 路径里的设备 id。必须与 token 反查到的行完全一致。 */
  deviceId: string;
  /** 请求头里的**旧** device_token 明文。 */
  deviceToken: string;
  newPublicKey: string;
  ts: number;
  sig: string;
  now?: Date;
}

/**
 * 执行轮换。成功时返回**唯一一次**出现的新 token 明文。
 *
 * ## 检查顺序（不可重排）
 *
 * | # | 检查 | 失败 |
 * |---|---|---|
 * | 1 | 旧 token → 设备行 | 401 |
 * | 2 | 路径 device_id == 行 id | 404 |
 * | 3 | 状态 active | 409 |
 * | 4 | token 未过期 | 401 |
 * | 5 | 新公钥是规范 32 字节 | 400 |
 * | 6 | ts 在 ±120s 内 | 401 |
 * | 7 | 旧公钥验签 | 401 |
 * | 8 | 事务：行锁 + 重验 + 原子更新 | 401 / 409 |
 *
 * 为什么 **5 早于 7**：新公钥进了签名原文。先拒绝一个不可能是合法公钥的
 * 输入，省掉一次验签；而且「公钥长度不对」与「签名不对」是两种完全不同的
 * 故障（前者是客户端 bug，后者是攻击或密钥问题），错误码分开才有排障价值。
 *
 * 为什么 **6 早于 7**：与握手同一条理由——便宜的无状态检查先做。
 *
 * 为什么第 8 步还要重验一遍：第 1–7 步读到的都是**快照**。从读过到写回之间
 * 隔着一次签名验证（微秒级，但仍是窗口），而并发的另一个轮换请求可能已经
 * 提交。行锁 + `token_hash` 重验把窗口关掉，且让「两个并发轮换只有一个成功」
 * 成为结构事实而不是概率事件。
 */
export async function rotateDevice(
  db: Database,
  input: RotateInput,
): Promise<RotatedCredentials> {
  const now = input.now ?? new Date();

  // ---- 1. 旧 token → 设备行 ----
  const device = await findDeviceByToken(db, input.deviceToken);
  if (!device) throw deviceUnauthorized();

  // ---- 2. 路径 id 必须就是这台设备 ----
  // 拿别人的 id 来试：与「设备不存在」完全一致（不给出存在性探针）。
  if (device.id !== input.deviceId) throw deviceNotFound();

  // ---- 3. 状态：撤销 / 暂停都不允许轮换 ----
  // 顺序上先判它们，才能给出准确的 409；先判 active 会把两者都折成 401，
  // 而它们是**完全不同的处置**（撤销要重新配对，暂停只需用户开开关）。
  if (device.status === "revoked") throw invalidDeviceState("device is revoked and cannot be rotated");
  if (device.status === "suspended") {
    throw invalidDeviceState("device is suspended and cannot be rotated");
  }
  if (device.status !== "active") throw deviceUnauthorized();

  // ---- 4. token 寿命 ----
  if (isDeviceTokenExpired(device, now)) throw deviceUnauthorized();

  // ---- 5. 新公钥形态 ----
  if (rawPublicKeyByteLength(input.newPublicKey) !== ED25519_RAW_PUBLIC_KEY_BYTES) {
    throw invalidPublicKey();
  }
  const newRaw = canonicalRawPublicKey(input.newPublicKey);
  if (!newRaw) throw invalidPublicKey();

  // ---- 6. 时间戳 ----
  if (Math.abs(now.getTime() - input.ts) > ROTATE_MAX_CLOCK_SKEW_MS) throw deviceUnauthorized();

  // ---- 7. 用**旧**公钥验签 ----
  if (
    !verifyRotationSignature({
      oldPublicKey: device.publicKey,
      deviceId: device.id,
      newPublicKey: input.newPublicKey,
      ts: input.ts,
      sig: input.sig,
    })
  ) {
    throw deviceUnauthorized();
  }

  // ---- 8. 原子更新（行锁 + 重验） ----
  const oldTokenHash = sha256Hex(input.deviceToken);
  const newToken = generateDeviceToken();
  const newTokenHash = sha256Hex(newToken);
  const expiresAt = new Date(now.getTime() + DEVICE_TOKEN_TTL_MS);

  /**
   * 事务内失败的**原因**。
   *
   * 不能折成一个布尔：并发场景下「suspend 抢先提交」与「另一个轮换抢先提交」
   * 都会让更新落空，但前者是 `409 invalid_device_state`（用户只需开开关），
   * 后者是 `401`（旧凭据已失效，必须用新凭据）。
   * 折起来会得到一个**自相矛盾**的错误面：串行请求拿到 409、并发请求拿到 401，
   * 而 Desktop 要靠错误码决定「重试 / 提示用户 / 重新配对」。
   */
  type TxOutcome = { ok: true } | { ok: false; reason: "token" | "suspended" | "revoked" | "other" };

  const outcome = await db.transaction(async (tx): Promise<TxOutcome> => {
    const rows = await tx
      .select({
        status: mcpDevices.status,
        tokenHash: mcpDevices.tokenHash,
        tokenExpiresAt: mcpDevices.tokenExpiresAt,
      })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, input.deviceId))
      // 与 suspend / revoke / 握手准入争同一把行锁。不是「再查一次」——
      // 再查一次仍然有 TOCTOU 窗口，而锁没有。
      .for("update");

    const row = rows[0];
    if (!row) return { ok: false, reason: "token" };
    // 旧 token 已被别人轮换过（并发的第二个请求走到这里）。
    if (row.tokenHash === null || row.tokenHash !== oldTokenHash) return { ok: false, reason: "token" };
    if (row.status === "revoked") return { ok: false, reason: "revoked" };
    if (row.status === "suspended") return { ok: false, reason: "suspended" };
    if (row.status !== "active") return { ok: false, reason: "other" };
    if (row.tokenExpiresAt === null || row.tokenExpiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: "token" };
    }

    const updated = await tx
      .update(mcpDevices)
      .set({
        // 换钥匙与换 token 必须**同一条** UPDATE：分开写会留下「新公钥 + 旧
        // token」或「旧公钥 + 新 token」的中间态，而两种中间态都是可用的
        // 错误组合（前者让偷到旧 token 的人仍能连，后者让旧私钥仍能握手）。
        publicKey: input.newPublicKey,
        tokenHash: newTokenHash,
        tokenIssuedAt: now,
        tokenExpiresAt: expiresAt,
        keyRotatedAt: now,
        // 明确**不动**的列，写在这里是为了让 review 一眼看到边界：
        //   user_id（设备归属不随轮换改变）
        //   status（轮换不是状态迁移）
        //   grant_epoch / grant 表（授权属于用户，不因设备换钥匙失效）
        //   confirm_* / claim_secret_hash（注册面已关闭，token_issued_at 非空）
      })
      .where(and(eq(mcpDevices.id, input.deviceId), eq(mcpDevices.tokenHash, oldTokenHash)))
      .returning({ id: mcpDevices.id });

    return updated.length === 1 ? { ok: true } : { ok: false, reason: "token" };
  });

  if (!outcome.ok) {
    switch (outcome.reason) {
      case "revoked":
        throw invalidDeviceState("device is revoked and cannot be rotated");
      case "suspended":
        throw invalidDeviceState("device is suspended and cannot be rotated");
      case "other":
        throw invalidDeviceState("device cannot be rotated in its current state");
      case "token":
      default:
        throw deviceUnauthorized();
    }
  }

  return { deviceToken: newToken, expiresAt };
}
