import { randomInt } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices } from "../db/schema.js";
import { constantTimeEqual, randomToken, sha256Hex } from "../security/crypto.js";
import {
  confirmExpired,
  deviceExists,
  deviceLimitReached,
  deviceNotFound,
  deviceUnauthorized,
  invalidConfirmCode,
  invalidDeviceState,
  invalidPublicKey,
} from "../security/errors.js";
import { findDeviceByToken, isDeviceTokenExpired } from "./device-token.js";
import { rawPublicKeyByteLength, toDeviceSummary, type DeviceSummary } from "./schemas.js";

/**
 * Remote MCP 设备服务（Phase 1.2A）。
 *
 * 这一层只做「数据 + 状态机」，不碰 HTTP。路由层负责鉴权与响应形状，
 * 所以同一套状态转换将来可以被 Web 设置页或运维脚本复用。
 *
 * ## 三条贯穿全文件的纪律
 *
 * 1. **所有查询都以 `user_id` 为过滤条件之一**，不写「先查出来再判断归属」。
 *    后者会在两条错误路径上留下差别（`设备不存在` vs `不是你的设备`），
 *    而那个差别就是一条存在性探针。
 * 2. **状态转换只用单条带守卫的 UPDATE**，靠 `RETURNING` 行数判断成败。
 *    `SELECT` 再 `UPDATE` 会在两个并发请求之间留下窗口（安全运维 §4.0）。
 * 3. **任何 secret 只以 SHA-256 落库**，明文只存活在本次函数调用的局部变量里。
 */

/** 每个用户最多 5 台 `active + pending` 设备（协议 §3.2）。 */
export /** Postgres 唯一约束冲突（23505）——drizzle/pg 会带 code 抛 PgError。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export const MAX_DEVICES_PER_USER = 5;

/** 确认码连续错误上限；达到后该 pending 行直接置 `revoked`（协议 §3.3）。 */
export const MAX_CONFIRM_ATTEMPTS = 5;

/** `pending` 窗口：注册后 300 秒内必须完成确认 + 领取。 */
export const PENDING_TTL_MS = 300_000;

/** `claim_secret` 的随机字节数（32 字节 = 256 bit）。 */
const CLAIM_SECRET_BYTES = 32;

/** 设备列表/详情共用的列白名单。**新增列默认不出现**，必须显式加到这里。 */
const DEVICE_SUMMARY_COLUMNS = {
  id: mcpDevices.id,
  name: mcpDevices.name,
  platform: mcpDevices.platform,
  status: mcpDevices.status,
  publicKey: mcpDevices.publicKey,
  grantEpoch: mcpDevices.grantEpoch,
  createdAt: mcpDevices.createdAt,
  tokenIssuedAt: mcpDevices.tokenIssuedAt,
  tokenExpiresAt: mcpDevices.tokenExpiresAt,
  lastSeenAt: mcpDevices.lastSeenAt,
  revokedAt: mcpDevices.revokedAt,
} as const;

/**
 * 6 位数字确认码。前导零必须保留，所以用字符串而不是数字。
 *
 * `randomInt(0, 1_000_000)` 而不是 `Math.floor(Math.random() * …)`：
 *
 * - `Math.random()` 是**非密码学** PRNG。它的内部状态可以从少量输出反推，
 *   而确认码恰好是用户唯一持有的凭证——可预测就等于没有。
 * - `randomInt` 用拒绝采样消除模偏差（`Math.random() * 1e6` 的分布是偏的），
 *   且直接读 CSPRNG。
 *
 * 值域是 `[0, 999999]` 闭区间，所以 `padStart(6, "0")` 得到的是**恰好 6 位**：
 * 0 → `"000000"`，999999 → `"999999"`。这与 `confirmDeviceSchema` 的
 * `/^\d{6}$/` 一致。
 *
 * 导出只为了让测试能直接验证分布与形态：走 HTTP 循环注册会在第 31 次
 * 撞上限流、第 6 次撞上设备配额，测出来的东西和被测对象无关。
 */
export function makeConfirmCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export interface RegisterResult {
  deviceId: string;
  confirmCode: string;
  claimSecret: string;
  expiresIn: number;
}

/**
 * 注册一台新设备（`status=pending`）。
 *
 * 返回的 `confirmCode` 与 `claimSecret` 是**唯一一次**明文出现的地方：
 * 之后库里只有哈希，任何接口都不会再吐出来。
 */
export async function registerDevice(
  db: Database,
  input: { userId: string; name: string; platform: string; publicKey: string; now?: Date },
): Promise<RegisterResult> {
  // 正则只保证字符集，解码后的字节数必须单独判——「43 个合法字符」仍然可能
  // 解出非 32 字节（末位字符携带多余 bit）。
  if (rawPublicKeyByteLength(input.publicKey) !== 32) {
    throw invalidPublicKey();
  }

  const now = input.now ?? new Date();
  const confirmCode = makeConfirmCode();
  const claimSecret = randomToken(CLAIM_SECRET_BYTES);

  const created = await db.transaction(async (tx) => {
    // 只统计「还活着」的设备：revoked 的不占配额（撤销后应该能重新注册）。
    const used = await tx
      .select({ publicKey: mcpDevices.publicKey })
      .from(mcpDevices)
      .where(and(eq(mcpDevices.userId, input.userId), ne(mcpDevices.status, "revoked")));

    if (used.some((row) => row.publicKey === input.publicKey)) throw deviceExists();
    if (used.length >= MAX_DEVICES_PER_USER) throw deviceLimitReached();

    // 并发加固（0006 唯一索引兜底）：即使两个事务同时通过 SELECT 查重，
    // INSERT 也会被 (user_id, public_key) 的部分唯一索引拒绝——此处捕获
    // 23505 转成与串行路径一致的 deviceExists。
    let rows: { id: string }[];
    try {
      rows = await tx
        .insert(mcpDevices)
        .values({
          userId: input.userId,
          name: input.name,
          platform: input.platform,
          publicKey: input.publicKey,
          status: "pending",
          confirmCodeHash: sha256Hex(confirmCode),
          claimSecretHash: sha256Hex(claimSecret),
          expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
          // grant_epoch 走列默认值 0：显式写 0 会让「默认值变更」在两条路径上不一致。
        })
        .returning({ id: mcpDevices.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw deviceExists();
      throw error;
    }

    const row = rows[0];
    if (!row) throw new Error("device insert returned no row");
    return row;
  });

  return {
    deviceId: created.id,
    confirmCode,
    claimSecret,
    expiresIn: Math.floor(PENDING_TTL_MS / 1000),
  };
}

/**
 * 用户输入确认码（Web 设置页）。
 *
 * 已 `active` 时幂等返回成功：用户重复点确认不该报错，而确认码在激活时
 * 就已经完成使命（不该因为「码没再用一次」而失败）。
 */
export async function confirmDevice(
  db: Database,
  input: { userId: string; deviceId: string; confirmCode: string; now?: Date },
): Promise<{ status: "active" }> {
  const now = input.now ?? new Date();

  const rows = await db
    .select({
      status: mcpDevices.status,
      confirmCodeHash: mcpDevices.confirmCodeHash,
      expiresAt: mcpDevices.expiresAt,
    })
    .from(mcpDevices)
    .where(and(eq(mcpDevices.id, input.deviceId), eq(mcpDevices.userId, input.userId)));
  const device = rows[0];
  if (!device) throw deviceNotFound();

  if (device.status === "active") return { status: "active" };
  if (device.status !== "pending") {
    throw invalidDeviceState("device cannot be confirmed in its current state");
  }
  if (device.expiresAt.getTime() <= now.getTime()) throw confirmExpired();

  if (!constantTimeEqual(sha256Hex(input.confirmCode), device.confirmCodeHash)) {
    // **原子地** +1 并在越线时锁行。
    //
    // 单条 UPDATE 里 `confirm_attempts + 1` 在所有 SET 表达式中读的都是**旧值**，
    // 所以自增与「是否越线」用的是同一个基准，不存在「两个并发请求都读到 4、
    // 都写 5」的窗口。拆成「读计数 → 判断 → 写回」就必然有这个窗口。
    await db
      .update(mcpDevices)
      .set({
        confirmAttempts: sql`${mcpDevices.confirmAttempts} + 1`,
        status: sql`case when ${mcpDevices.confirmAttempts} + 1 >= ${MAX_CONFIRM_ATTEMPTS} then 'revoked' else ${mcpDevices.status} end`,
        // 显式 `::timestamptz` 是必需的：`sql` 模板里的 Date 会被绑成
        // `Date.toString()` 的**字符串**，Postgres 不会自动把它当时间戳。
        revokedAt: sql`case when ${mcpDevices.confirmAttempts} + 1 >= ${MAX_CONFIRM_ATTEMPTS} then ${now.toISOString()}::timestamptz else ${mcpDevices.revokedAt} end`,
      })
      .where(
        and(
          eq(mcpDevices.id, input.deviceId),
          eq(mcpDevices.userId, input.userId),
          eq(mcpDevices.status, "pending"),
        ),
      );
    // 无论是否触顶，对外都是同一个错误：让攻击者无法区分「还差一次」与
    // 「已经锁死」，否则他可以在触顶后立刻换一台设备重试并据此判断进度。
    throw invalidConfirmCode();
  }

  // 正确码：带守卫的 UPDATE。并发两个正确请求只有一个能成功。
  const activated = await db
    .update(mcpDevices)
    .set({ status: "active" })
    .where(
      and(
        eq(mcpDevices.id, input.deviceId),
        eq(mcpDevices.userId, input.userId),
        eq(mcpDevices.status, "pending"),
      ),
    )
    .returning({ id: mcpDevices.id });

  if (activated.length === 0) {
    // 竞争失败：再读一次给出准确原因，而不是笼统报错。
    const reread = await db
      .select({ status: mcpDevices.status })
      .from(mcpDevices)
      .where(and(eq(mcpDevices.id, input.deviceId), eq(mcpDevices.userId, input.userId)));
    if (reread[0]?.status === "active") return { status: "active" };
    throw invalidDeviceState("device state changed during confirmation");
  }
  return { status: "active" };
}

export interface ClaimedCredentials {
  deviceToken: string;
  expiresAt: Date;
}

/** 当前用户的设备列表（不含任何哈希或明文凭证）。 */
export async function listDevices(db: Database, userId: string): Promise<DeviceSummary[]> {
  const rows = await db
    .select(DEVICE_SUMMARY_COLUMNS)
    .from(mcpDevices)
    .where(eq(mcpDevices.userId, userId))
    .orderBy(mcpDevices.createdAt);
  return rows.map(toDeviceSummary);
}

/** 单台设备（同样只返回白名单字段）。不属于该用户时一律 404。 */
export async function getDevice(
  db: Database,
  input: { userId: string; deviceId: string },
): Promise<DeviceSummary> {
  const rows = await db
    .select(DEVICE_SUMMARY_COLUMNS)
    .from(mcpDevices)
    .where(and(eq(mcpDevices.id, input.deviceId), eq(mcpDevices.userId, input.userId)));
  const row = rows[0];
  if (!row) throw deviceNotFound();
  return toDeviceSummary(row);
}

/** `active → suspended`。已 suspended 幂等成功；revoked 是终态，不接受任何操作。 */
export async function suspendDevice(
  db: Database,
  input: { userId: string; deviceId: string },
): Promise<DeviceSummary> {
  return moveState(db, input, ["active"], "suspended", "suspended");
}

/**
 * 设备自己暂停自己（协议 §3.5：`suspend` 接受「用户 Bearer **或** device_token」）。
 *
 * ## 为什么需要这条路径
 *
 * Desktop 的「关闭远程开关」发生在**用户已登录**的前提下，但也发生在
 * 「access token 恰好过期」的时刻。那条路径必须能在只持有设备凭据的情况下
 * 把自己停掉——否则用户关开关失败，设备会一直在 Cloud 上显示在线。
 *
 * ## 四道边界（每一条都有对应测试）
 *
 * 1. **只能停自己**：token → 行 → 行 id 与路径 id 不等就 404。不是 403——
 *    403 等于承认「这个 id 存在但不属于你」。
 * 2. **不保存明文**：查库用的是 `sha256(token)`，此后链路上只有哈希。
 * 3. **状态更新仍是单条带守卫的 UPDATE**（复用 `moveState`）：靠 `RETURNING`
 *    行数判成败，不做「先查状态再写」。设备自己并发点两次开关不会互相覆盖。
 * 4. **token 过期即拒**（401）：过期凭据不该有任何写权限，哪怕只是把
 *    自己从 active 改成 suspended。
 *
 * 明确**不做**的事：不校验 `expires_at`（那是 pending 窗口），也不清
 * `token_hash`（暂停不是撤销，恢复后要继续用同一个 token）。
 */
export async function suspendDeviceWithToken(
  db: Database,
  input: { deviceToken: string; deviceId: string; now?: Date },
): Promise<DeviceSummary> {
  const now = input.now ?? new Date();
  const device = await findDeviceByToken(db, input.deviceToken);
  // 没有这个 token / 从未领取 / 库不可用：同一个错误。
  if (!device) throw deviceUnauthorized();
  if (isDeviceTokenExpired(device, now)) throw deviceUnauthorized();

  // 拿别人的 id 来试：与「设备不存在」完全一致。
  if (device.id !== input.deviceId) throw deviceNotFound();

  return moveState(db, { userId: device.userId, deviceId: device.id }, ["active"], "suspended", "suspended");
}

/** `suspended → active`。撤销后不可恢复（协议 §3.5、安全运维 §4.0 终态）。 */
export async function resumeDevice(
  db: Database,
  input: { userId: string; deviceId: string },
): Promise<DeviceSummary> {
  return moveState(db, input, ["suspended"], "active", "active");
}

/**
 * 任意状态 → `revoked`（终态）。
 *
 * **不删行、不删 grant**：设备行是审计历史的一部分（「谁在什么时候注册过
 * 什么」），删掉就永久消失；grant 属于用户，不因为某台设备消失而失效
 * （安全运维 §4.1 规则 2）。WSS 连接清理属 Phase 1.2B。
 */
export async function revokeDevice(
  db: Database,
  input: { userId: string; deviceId: string; now?: Date },
): Promise<DeviceSummary> {
  const now = input.now ?? new Date();
  const revoked = await db
    .update(mcpDevices)
    .set({ status: "revoked", revokedAt: now })
    .where(
      and(
        eq(mcpDevices.id, input.deviceId),
        eq(mcpDevices.userId, input.userId),
        ne(mcpDevices.status, "revoked"),
      ),
    )
    .returning({ id: mcpDevices.id });

  if (revoked.length === 0) {
    // 守卫没命中：读一次区分「不是他的」（404）与「已经撤销」（幂等成功）。
    const existing = await getDevice(db, input);
    if (existing.status === "revoked") return existing;
    throw invalidDeviceState("device cannot be revoked in its current state");
  }
  return getDevice(db, input);
}

async function moveState(
  db: Database,
  input: { userId: string; deviceId: string },
  from: readonly string[],
  to: "active" | "suspended",
  idempotentWhenAlready: string,
): Promise<DeviceSummary> {
  const updated = await db
    .update(mcpDevices)
    .set({ status: to })
    .where(
      and(
        eq(mcpDevices.id, input.deviceId),
        eq(mcpDevices.userId, input.userId),
        inArray(mcpDevices.status, [...from]),
      ),
    )
    .returning({ id: mcpDevices.id });

  if (updated.length === 0) {
    // 守卫没命中：读一次给出准确原因（404 / 幂等 / 状态冲突）。
    const existing = await getDevice(db, input);
    if (existing.status === "revoked") {
      throw invalidDeviceState("device is revoked and cannot be changed");
    }
    if (existing.status === idempotentWhenAlready) return existing;
    throw invalidDeviceState(`device cannot move from ${existing.status} to ${to}`);
  }
  return getDevice(db, input);
}
