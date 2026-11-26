import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices } from "../db/schema.js";

/**
 * 握手准入：**在设备行锁的保护下**重新验证并建立路由（Phase 1.2B.1.2）。
 *
 * ## 它修的是什么
 *
 * `verifyHandshake()` 读到的设备状态是一个**快照**。在它与 `registry.bind()`
 * 之间隔着若干次 await（加载 grant 快照、生成 `grant_ctx`……），而这段时间里
 * 另一条 HTTP 请求完全可以把设备改成 `suspended` / `revoked`：
 *
 * ```
 * 握手: 读到 active ────────────────────────────┐ bind() ← 幽灵上线
 * 撤销:            UPDATE status='revoked' ✅ ──┘ 查连接表：还没有，无需清理
 * ```
 *
 * 结果就是数据库说「已撤销」、路由表说「在线」。这不是理论问题：
 * `disconnectDevice()` 按 deviceId 查表，查不到就返回——它没有任何办法
 * 预知一个正在 bind 的连接。
 *
 * ## 为什么选「行锁 + 事务内 bind」而不是进程内互斥
 *
 * | 方案 | 谁必须记得参与 | 失效方式 |
 * |---|---|---|
 * | 进程内 per-device mutex | **每一个**写设备状态的代码路径（现在有 3 条，将来还会有） | 新增一条写路径忘了加锁 → 静默回归，测试也可能仍然绿 |
 * | **PostgreSQL 行锁（采用）** | **没有任何人**——`UPDATE mcp_devices SET status` 自动持有行锁 | 写路径根本无法绕过；除非有人显式 `SET LOCAL ... ` 降级隔离级别 |
 *
 * 也就是说：行锁把「必须参与互斥」从一个**约定**变成了一个**数据库事实**。
 * 这正是任务书要求「不能只在握手内部加锁」的落地方式。
 *
 * ## 线性化顺序
 *
 * `registry.bind()` 在事务**内**执行，`COMMIT` 是线性化点：
 *
 * ```
 * 分支 1（握手先）  握手拿到行锁 → 校验通过 → bind → COMMIT
 *                  → suspend 的 UPDATE 排队等锁 → 提交为 suspended
 *                  → cleanupConnection 查表**查得到** → bye + close 4005     ✅
 *
 * 分支 2（撤停先）  suspend 的 UPDATE 拿到行锁 → 提交为 suspended
 *                  → 握手的 SELECT ... FOR UPDATE 排队 → 读到 suspended
 *                  → 拒绝，不 bind                                              ✅
 * ```
 *
 * 没有第三种结果。两条分支的差别只在于「谁先拿到那把行锁」。
 *
 * ## 一个必须写明的边界
 *
 * 事务内做内存 bind，意味着**行锁的持有时间包含一次内存写入**（微秒级）。
 * 若将来 `ConnectionRegistry` 换成 Redis，`bind` 会变成一次网络往返，行锁
 * 就会被持有到那个往返结束。届时应改为「锁内只做状态判定 + 预占，
 * 锁外补全网络写」，或者把路由表也换成同一套 DB 表。**现在不做**：单实例
 * 内存实现下这个窗口是不可观测的，提前优化只会增加复杂度。
 */

/** 准入失败的原因。映射到 close code 由调用方负责（见 link-server）。 */
export type AdmissionFailure = "unauthorized" | "suspended" | "revoked";

export interface AdmittedDevice {
  id: string;
  userId: string;
  grantEpoch: number;
}

export type AdmissionOutcome<T> =
  | { ok: true; device: AdmittedDevice; value: T }
  | { ok: false; failure: AdmissionFailure };

/**
 * 在设备行锁内重新验证 `(token_hash, status, token_expires_at)`，
 * 校验通过后在**同一个事务里**执行 `admit`（由调用方传入 `registry.bind`）。
 *
 * 三个「必须重新读」的理由：
 *
 * 1. **token_hash**：设备可能在这段时间里被轮换（B13 之后会真的发生）。
 *    只信一开始那次查询，会让一把已经失效的 token 建立新连接。
 * 2. **status**：`suspended` / `revoked` 必须在这里被判死——这是唯一能
 *    与那两条 UPDATE 线性化的位置。
 * 3. **token_expires_at**：握手可能跨越很长的排队时间（DB 抖动）。
 *    早先读到的「未过期」不能当作事实。
 *
 * `admit` 抛错 → 事务回滚 → 调用方按内部错误处理。此时**不会有**路由残留，
 * 因为 `admit` 的副作用是调用方自己的责任，而本函数的契约要求它要么完整
 * 完成、要么抛错（内存实现天然满足：先 set 后算 displaced，两者之间无 await）。
 */
export async function admitDevice<T>(
  db: Database,
  input: { deviceId: string; tokenHash: string; now: Date },
  admit: (device: AdmittedDevice) => Promise<T> | T,
): Promise<AdmissionOutcome<T>> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: mcpDevices.id,
        userId: mcpDevices.userId,
        status: mcpDevices.status,
        tokenHash: mcpDevices.tokenHash,
        tokenExpiresAt: mcpDevices.tokenExpiresAt,
        grantEpoch: mcpDevices.grantEpoch,
      })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, input.deviceId))
      // FOR UPDATE：与任何 `UPDATE mcp_devices SET status=...` 争同一把行锁。
      // 这不是「再查一次」——再查一次仍然有 TOCTOU 窗口，而锁没有。
      .for("update");

    const row = rows[0];
    // 设备在握手期间被删除（理论上只有级联删用户会这样）：当成凭据错误。
    if (!row) return { ok: false, failure: "unauthorized" } as const;

    // token_hash 不符：设备被轮换过，或这本来就不是它的 token。
    if (row.tokenHash === null || row.tokenHash !== input.tokenHash) {
      return { ok: false, failure: "unauthorized" } as const;
    }

    // 顺序：revoked / suspended 各有专属 close code，先判它们才能给出准确原因。
    if (row.status === "revoked") return { ok: false, failure: "revoked" } as const;
    if (row.status === "suspended") return { ok: false, failure: "suspended" } as const;
    if (row.status !== "active") return { ok: false, failure: "unauthorized" } as const;

    // 这两个「为 null / 已过期」都归 4001：它们是凭据问题，不是设备状态问题。
    if (row.tokenExpiresAt === null) return { ok: false, failure: "unauthorized" } as const;
    if (row.tokenExpiresAt.getTime() <= input.now.getTime()) {
      return { ok: false, failure: "unauthorized" } as const;
    }

    const device: AdmittedDevice = { id: row.id, userId: row.userId, grantEpoch: row.grantEpoch };
    const value = await admit(device);
    return { ok: true, device, value } as const;
  });
}
