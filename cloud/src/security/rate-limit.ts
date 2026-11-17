import type { Context, Next } from "hono";
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
 * - 选中条目必须通过 IP 形态校验，否则回退 socket 地址（拒绝畸形头）。
 * - 桶数量有硬上限（MAX_BUCKETS）：即使某层信任判断被绕过，也无法无限创建新桶，
 *   超出上限的未知来源进入共享 overflow 桶（与正常桶同上限，劣化为全体限速）。
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** 桶硬上限：防御任何 IP 归因缺陷导致的无限建桶（内存耗尽）。 */
const MAX_BUCKETS = 10_000;

/** X-Forwarded-For 单条目的宽松 IP 形态校验（IPv4 / IPv6 字符集）。 */
const IP_ENTRY_PATTERN = /^[0-9a-fA-F.:]{1,45}$/;

/** XFF 头长度上限：正常链路远小于此值，超长视为恶意头直接忽略。 */
const MAX_XFF_LENGTH = 2048;

/** 测试辅助：清空全部计数。 */
export function resetRateLimiter(): void {
  buckets.clear();
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
      if (candidate && IP_ENTRY_PATTERN.test(candidate)) {
        return candidate;
      }
      // 头缺失 / 层数不足 / 选中条目非 IP 形态 → 不信任该头，回退 socket 地址
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
}

function bucketKey(options: RateLimitOptions, c: Context, now: number): string {
  const base = `${options.name}:${clientKey(c, options.trustProxy, options.trustedHops ?? 1)}`;
  const existing = buckets.get(base);
  if (existing && now - existing.windowStart < options.windowMs) {
    return base;
  }
  // 新桶受硬上限约束：超出上限的未知来源进入共享 overflow 桶，
  // 保证伪造头 / IP 归因缺陷不可能无限扩张内存。
  if (!existing && buckets.size >= MAX_BUCKETS) {
    return `${options.name}:__overflow__`;
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
