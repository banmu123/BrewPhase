import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices } from "../db/schema.js";
import { sha256Hex } from "../security/crypto.js";

/**
 * `device_token` → 设备行。**两处共用**：设备自暂停（HTTPS）与 WSS 握手。
 *
 * 合成一个文件而不是各写一份查询，理由很直接：这是整个系统里**唯一**
 * 用 `token_hash` 反查身份的地方。两份实现迟早会在「要不要检查
 * `token_expires_at`」这种细节上分叉，而分叉的那一侧就是漏洞。
 *
 * ## 三个时间字段的语义（混用会出人命）
 *
 * | 字段 | 含义 | 谁该读 |
 * |---|---|---|
 * | `expires_at` | **pending 注册窗口**（注册后 300s 内必须确认 + 领取） | 确认、领取、sweep |
 * | `token_issued_at` | device_token **首次**领取的时间点（非空 = 已领取） | 领取的一次性判据 |
 * | `token_expires_at` | device_token 自身寿命（30 天） | **WSS 握手、设备自暂停** |
 *
 * 用 `expires_at` 判断已领取设备是否过期，会让**每一台正常设备在注册 5 分钟后
 * 全部被判死**——因为那个字段在领取之后再也没有被推进过。
 */

/** 前缀与 Desktop 侧 `REMOTE_DEVICE_TOKEN_PATTERN` 必须一致。 */
export const DEVICE_TOKEN_PREFIX = "bp_dev_";

/**
 * 设备 token 的形态检查。**不是**安全判据（真正的判据是哈希命中），
 * 作用是廉价地挡掉「拿错凭据域」（用户 access token、`bp_mcp_*`、空串）。
 *
 * 与 Desktop 的 `REMOTE_DEVICE_TOKEN_PATTERN` 逐字符相同；两处都有测试锁。
 */
export const DEVICE_TOKEN_PATTERN = /^bp_dev_[A-Za-z0-9_-]{16,}$/;

export interface AuthedDevice {
  id: string;
  userId: string;
  /** 裸 32 字节 Ed25519 公钥的 base64url（43 字符）。 */
  publicKey: string;
  status: "pending" | "active" | "suspended" | "revoked";
  tokenExpiresAt: Date | null;
  grantEpoch: number;
}

/**
 * 按明文 token 查设备。**不比较、不记录明文**：进来就立刻哈希，
 * 之后整条链路上只有 `token_hash`。
 *
 * 返回 `null` 有四种原因（token 不存在 / 从未领取 / 哈希对不上 / 库不可用），
 * 调用方**不得**把它们区分开——那会变成一条「这个 token 存在吗」的探针。
 */
export async function findDeviceByToken(
  db: Database,
  token: string,
): Promise<AuthedDevice | null> {
  const rows = await db
    .select({
      id: mcpDevices.id,
      userId: mcpDevices.userId,
      publicKey: mcpDevices.publicKey,
      status: mcpDevices.status,
      tokenExpiresAt: mcpDevices.tokenExpiresAt,
      grantEpoch: mcpDevices.grantEpoch,
    })
    .from(mcpDevices)
    .where(eq(mcpDevices.tokenHash, sha256Hex(token)));
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    publicKey: row.publicKey,
    status: row.status as AuthedDevice["status"],
    tokenExpiresAt: row.tokenExpiresAt,
    grantEpoch: row.grantEpoch,
  };
}

/**
 * device_token 是否已过期。
 *
 * `tokenExpiresAt === null` 视为**已过期**（fail-closed）：它为 null 只有两种
 * 可能——没领取过（那也不该有 token 在跑），或历史数据缺列。两种都不该放行。
 *
 * 明确**只读 `tokenExpiresAt`**，永远不看 `expiresAt`。这条不变量由
 * `tests/mcp-devices/device-token.test.ts` 用「expires_at 过期但 token 有效」
 * 的用例锁住。
 */
export function isDeviceTokenExpired(device: AuthedDevice, now: Date): boolean {
  if (device.tokenExpiresAt === null) return true;
  return device.tokenExpiresAt.getTime() <= now.getTime();
}
