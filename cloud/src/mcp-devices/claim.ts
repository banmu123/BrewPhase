import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices } from "../db/schema.js";
import { constantTimeEqual, sha256Hex } from "../security/crypto.js";
import { generateDeviceToken } from "./device-token.js";
import {
  claimMismatch,
  confirmExpired,
  credentialsAlreadyIssued,
  deviceNotFound,
  invalidDeviceState,
} from "../security/errors.js";

/**
 * 一次性领取 `device_token`（协议 §3.4）。
 *
 * 单独成文件是因为这是整个设备面里**唯一**把明文凭证交出去的地方。
 * 它值得被孤立出来单独审：任何改动都必须回答「会不会让第二次领取成功」。
 *
 * ## 四个不可交换的顺序
 *
 * 1. 按 `(id, user_id)` 查 → 查不到就是 404（不区分「不存在」与「不是你的」）
 * 2. 先比 `claim_secret` 哈希，再判状态
 * 3. `pending` 且未过期 → 返回 `null`（调用方回 202，让 Desktop 继续轮询）
 * 4. `active` 且 `token_issued_at IS NULL` → 单条 UPDATE + RETURNING 定胜负
 *
 * 第 2 条的顺序不是风格问题：如果先判状态，那么「claim 错」与「状态不对」
 * 会得到同一个错误，等于白送攻击者一个 claim 正确性探针。
 */

/** device_token 的有效期（30 天）。 */
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 前缀与 Desktop 侧的 `REMOTE_DEVICE_TOKEN_PATTERN` 必须一致。 */
export const DEVICE_TOKEN_PREFIX = "bp_dev_";

export interface ClaimedCredentials {
  deviceToken: string;
  expiresAt: Date;
}

/**
 * `null` = 「还在等用户确认」，调用方应回 202。
 *
 * 为什么不是抛错：Desktop 的轮询把 4xx 当作终态失败。若 pending 也回 4xx，
 * 一次完全正常的注册会在第一次轮询（注册后 1 秒）就死掉——而「等用户点
 * 确认」恰恰是这条路径的常态。
 */
export type ClaimOutcome = ClaimedCredentials | null;

export async function claimCredentials(
  db: Database,
  input: { userId: string; deviceId: string; claimSecret: string; now?: Date },
): Promise<ClaimOutcome> {
  const now = input.now ?? new Date();

  const rows = await db
    .select({
      status: mcpDevices.status,
      claimSecretHash: mcpDevices.claimSecretHash,
      expiresAt: mcpDevices.expiresAt,
    })
    .from(mcpDevices)
    .where(and(eq(mcpDevices.id, input.deviceId), eq(mcpDevices.userId, input.userId)));
  const device = rows[0];
  if (!device) throw deviceNotFound();

  // 恒定时间比较：与项目内其它凭据比较保持同一纪律（security/crypto.ts）。
  // 比较对象虽是 sha256 hex，仍不偏离 constantTimeEqual 语义。
  if (!constantTimeEqual(sha256Hex(input.claimSecret), device.claimSecretHash)) {
    throw claimMismatch();
  }

  if (device.status === "pending") {
    if (device.expiresAt.getTime() <= now.getTime()) throw confirmExpired();
    return null;
  }
  if (device.status === "suspended") throw invalidDeviceState("device is suspended");
  if (device.status === "revoked") throw deviceNotFound();

  // 与轮换共用同一个生成器：两处各写一份迟早会漂移（见 device-token.ts）。
  const token = generateDeviceToken();
  const expiresAt = new Date(now.getTime() + DEVICE_TOKEN_TTL_MS);

  // 原子领取：守卫 + RETURNING 行数是唯一判据。**不是**「先查 token_issued_at
  // 再更新」——那会让两个并发请求都读到 NULL，于是都拿到 token。
  const updated = await db
    .update(mcpDevices)
    .set({ tokenHash: sha256Hex(token), tokenIssuedAt: now, tokenExpiresAt: expiresAt })
    .where(
      and(
        eq(mcpDevices.id, input.deviceId),
        eq(mcpDevices.userId, input.userId),
        eq(mcpDevices.status, "active"),
        isNull(mcpDevices.tokenIssuedAt),
      ),
    )
    .returning({ id: mcpDevices.id });

  if (updated.length === 0) {
    // 并发领取：另一个请求先赢。**不补发**——补发等于给一个可能已泄漏的
    // claim_secret 第二次机会。
    throw credentialsAlreadyIssued();
  }
  return { deviceToken: token, expiresAt };
}
