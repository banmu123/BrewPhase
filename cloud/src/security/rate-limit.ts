import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { rateLimited } from "./errors.js";

/**
 * 每 IP 固定窗口限流（内存实现）。
 *
 * 定位说明：限流计数是短生命周期的运行态运营数据，不是授权状态或会话存储，
 * 因此允许使用进程内 Map（规格禁止的是用内存保存授权/会话这类必须持久化的状态）。
 * 当前部署形态是单进程单容器；若未来水平扩容，需替换为共享存储实现（接口不变）。
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** 测试辅助：清空全部计数。 */
export function resetRateLimiter(): void {
  buckets.clear();
}

/** 取客户端地址。trustProxy 时优先 X-Forwarded-For 的第一跳；否则用 socket 地址。 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote?.address ?? "";
  } catch {
    // 测试环境（app.request）或非 node-server 运行时没有 socket 信息
    return "";
  }
}

function purgeExpired(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

export function clientKey(c: Context, trustProxy: boolean): string {
  return clientIp(c, trustProxy) || "unknown";
}

export interface RateLimitOptions {
  /** 桶前缀（区分端点）。 */
  name: string;
  max: number;
  windowMs: number;
  trustProxy: boolean;
}

export function rateLimit(options: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    const now = Date.now();
    purgeExpired(now, options.windowMs);
    const key = `${options.name}:${clientKey(c, options.trustProxy)}`;
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
