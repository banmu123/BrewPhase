import type { Context, Next } from "hono";
import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { rateLimited } from "./errors.js";

/**
 * 每 IP 固定窗口限流（内存实现）。
 *
 * 定位说明：限流计数是短生命周期的运行态运营数据，不是授权状态或会话存储，
 * 因此允许使用进程内 Map（规格禁止的是用内存保存授权/会话这类必须持久化的状态）。
 * 当前部署形态是单进程单容器；若未来水平扩容，需替换为共享存储实现（接口不变）。
 *
 * 可信代理信任边界（TRUST_PROXY / TRUST_PROXY_HOPS）：
 * - TRUST_PROXY=false（默认）：完全忽略 X-Forwarded-For，只使用 socket 对端地址，
 *   伪造头不可能影响限流桶。
 * - TRUST_PROXY=true：从 X-Forwarded-For 的**右端**数起，跳过 TRUST_PROXY_HOPS 个
 *   可信代理追加的条目，取其后的地址作为客户端 IP。右端的条目由离服务最近的
 *   可信代理写入，客户端伪造的左侧条目无法改变选中值——伪造 XFF 不可能创建新桶。
 *   前提条件（部署红线）：应用端口不可被客户端绕过代理直接访问，否则直连请求的
 *   自带 XFF 头会占据右端位置（README 有说明与反代配置示例）。
 *   HOPS 只对**追加式**代理链等于「代理层数」；覆盖式代理恒为单条目，必须用 HOPS=1
 *   （详见 README「TRUST_PROXY 信任边界」）。
 * - 选中条目必须是**合法 IP 字面量**（`node:net` 的 `isIP()` 判定，仅接受纯 IPv4 /
 *   IPv6）。带端口、字符填充、多段点分等一律视为不可信，回退 socket 地址——绝不把
 *   未经校验的字符串当限流键（否则每种畸形值都会开一个新桶）。
 * - 桶数量有硬上限（maxBuckets，默认 10000）：即使某层信任判断被绕过，也无法无限
 *   创建新桶，超出上限的未知来源进入按端点共享的 overflow 桶（与正常桶同上限，
 *   劣化为全体限速）。
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** 桶硬上限（生产默认）：防御任何 IP 归因缺陷导致的无限建桶（内存耗尽）。 */
export const DEFAULT_MAX_BUCKETS = 10_000;

/** overflow 桶键后缀：不能是合法 IP，因此不会与任何真实来源碰撞。 */
const OVERFLOW_SUFFIX = "__overflow__";

/** XFF 头长度上限：正常链路远小于此值，超长视为恶意头直接忽略。 */
const MAX_XFF_LENGTH = 2048;

/** 测试辅助：清空全部计数。 */
export function resetRateLimiter(): void {
  buckets.clear();
}

export interface RateLimitStats {
  /** 当前存活的桶总数（含各端点的 overflow 桶）。 */
  total: number;
  /** 其中 overflow 桶的个数（按端点区分，每个端点至多一个）。 */
  overflow: number;
}

/**
 * 只读统计，**仅供测试**断言桶上限是否被遵守。
 *
 * 只返回计数，不返回任何桶键——桶键里含客户端 IP，不对外暴露。
 */
export function rateLimitStats(): RateLimitStats {
  let overflow = 0;
  for (const key of buckets.keys()) {
    if (key.endsWith(OVERFLOW_SUFFIX)) overflow += 1;
  }
  return { total: buckets.size, overflow };
}

/**
 * 取客户端地址。
 * @param trustProxy 是否信任反代写入的 X-Forwarded-For
 * @param trustedHops 服务前面可信代理的层数（≥1）；从 XFF 右端跳过相应条目
 */
export function clientIp(c: Context, trustProxy: boolean, trustedHops = 1): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded && forwarded.length <= MAX_XFF_LENGTH) {
      const entries = forwarded.split(",").map((s) => s.trim());
      const index = entries.length - Math.max(1, trustedHops);
      const candidate = index >= 0 ? entries[index] : undefined;
      // 只接受纯 IP 字面量：isIP 返回 4 / 6，非法或带端口一律返回 0。
      if (candidate && isIP(candidate) !== 0) {
        return candidate;
      }
      // 头缺失 / 层数不足 / 选中条目不是合法 IP → 不信任该头，回退 socket 地址
    }
  }
  try {
    return getConnInfo(c).remote?.address ?? "";
  } catch {
    // 测试环境（app.request）或非 node-server 运行时没有 socket 信息
    return "";
  }
}

export function clientKey(c: Context, trustProxy: boolean, trustedHops = 1): string {
  return clientIp(c, trustProxy, trustedHops) || "unknown";
}

function purgeExpired(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  /** 桶前缀（区分端点）。 */
  name: string;
  max: number;
  windowMs: number;
  trustProxy: boolean;
  /** 可信代理层数（透传给 clientKey）。 */
  trustedHops?: number;
  /**
   * 桶数量上限。生产不配置即用 `DEFAULT_MAX_BUCKETS`；
   * 测试注入小值以便真实触发 overflow 分支（不是环境变量，无法从外部改生产行为）。
   */
  maxBuckets?: number;
}

function overflowKey(name: string): string {
  return `${name}:${OVERFLOW_SUFFIX}`;
}

function bucketKey(options: RateLimitOptions, c: Context, now: number): string {
  const base = `${options.name}:${clientKey(c, options.trustProxy, options.trustedHops ?? 1)}`;
  const existing = buckets.get(base);
  if (existing && now - existing.windowStart < options.windowMs) {
    return base;
  }
  // 新桶受硬上限约束：超出上限的未知来源进入**本端点**的共享 overflow 桶，
  // 保证伪造头 / IP 归因缺陷不可能无限扩张内存。
  // 已存在的正常桶不受影响（上面的分支已返回），不会被挤进 overflow。
  const cap = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  if (!existing && buckets.size >= cap) {
    return overflowKey(options.name);
  }
  return base;
}

export function rateLimit(options: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    const now = Date.now();
    purgeExpired(now, options.windowMs);
    const key = bucketKey(options, c, now);
    const existing = buckets.get(key);
    if (!existing || now - existing.windowStart >= options.windowMs) {
      buckets.set(key, { windowStart: now, count: 1 });
    } else {
      existing.count += 1;
      if (existing.count > options.max) {
        const retryAfterSeconds = Math.ceil(
          (existing.windowStart + options.windowMs - now) / 1000,
        );
        throw rateLimited(retryAfterSeconds);
      }
    }
    await next();
  };
}
