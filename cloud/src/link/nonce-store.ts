import { REMOTE_NONCE_WINDOW_MS } from "./schemas.js";

/**
 * 握手 nonce 的防重放存储（协议 §4.3 第 7 步）。
 *
 * ## 三条硬约束，每一条都能被测试单独打红
 *
 * 1. **check-and-record 必须在一次同步调用内完成**。
 *    拆成 `has()` → `await something` → `set()` 会让两个并发的重放请求
 *    都通过——因为两者都在对方写入之前读到了「没见过」。
 *    所以本类的公开方法**没有 async**，这是结构上的保证，不是纪律。
 *
 * 2. **容量满时 fail-closed**。
 *    天真的做法是「满了就淘汰最旧的一半」。问题在于：攻击者可以先用
 *    8192 个随机 nonce 把表灌满，等着真实设备的 nonce 被淘汰，然后重放它。
 *    淘汰「仍有效」的项等于**主动打开重放窗口**。所以这里到达上限后
 *    直接拒绝新 nonce（调用方按资源耗尽处理），绝不驱逐未过期项。
 *
 * 3. **时间用 monotonic**。
 *    `Date.now()` 会被系统时间调整（NTP 回拨、用户改表）影响，一次回拨
 *    就能让一堆过期项「复活」。`performance.now()` 只增不减。
 *
 * ## 一个必须如实记录的边界
 *
 * 这是**进程内**实现：Cloud 重启后表清空。也就是说，重启前发出的 nonce
 * 在重启后可以再被用一次。这是可接受的，因为：
 * - nonce 只在握手时用，且每次握手必须带**新的** `hello.ts`（±120s 窗口）；
 * - 重放一个旧 `hello` 需要同时满足「时间在窗口内」与「签名有效」，
 *   而它换来的只是**一条新连接**，不是任何数据。
 *
 * 若将来改多实例，nonce 表必须换共享存储 —— 与 ConnectionRegistry 同一批工作。
 */

export type NonceRecordResult = "ok" | "replay" | "capacity";

export interface NonceStoreStats {
  size: number;
  capacity: number;
}

export class NonceStore {
  /** nonce → 记录时的 monotonic 毫秒。 */
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: { windowMs?: number; capacity?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? REMOTE_NONCE_WINDOW_MS;
    // 8192 个 22 字符的键 ≈ 数百 KB。120 秒窗口内正常握手量级是个位数，
    // 这个容量足够容纳任何真实突发，同时给内存一个硬上限。
    this.capacity = options.capacity ?? 8192;
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * 原子地「查 + 记」。**没有 await，也不允许有。**
   *
   * 返回 `"capacity"` 时调用方必须 fail-closed（本实现映射成 1011），
   * **不能**把它当成「通过」——那会让容量耗尽变成一条绕过重放检测的路径。
   */
  checkAndRecord(nonce: string): NonceRecordResult {
    const nowMono = this.now();
    this.prune(nowMono);

    const existing = this.seen.get(nonce);
    if (existing !== undefined && nowMono - existing < this.windowMs) return "replay";

    if (this.seen.size >= this.capacity) {
      // 不驱逐未过期项：见类注释第 2 条。
      return "capacity";
    }

    this.seen.set(nonce, nowMono);
    return "ok";
  }

  stats(): NonceStoreStats {
    return { size: this.seen.size, capacity: this.capacity };
  }

  /**
   * 只清过期项。容量压力**不**在这里处理（见 checkAndRecord）。
   *
   * `Map` 的迭代顺序是插入顺序，而插入时间是单调递增的，所以**遇到第一个
   * 未过期项就可以停**。没有这个提前退出，一次容量攻击会让每次握手都扫满
   * 8192 项（也是可达成的 DoS 放大器）。
   */
  private prune(nowMono: number): void {
    for (const [nonce, recordedAt] of this.seen) {
      if (nowMono - recordedAt < this.windowMs) return;
      this.seen.delete(nonce);
    }
  }
}
