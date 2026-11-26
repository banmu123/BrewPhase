import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BUCKETS,
  rateLimit,
  rateLimitStats,
  resetRateLimiter,
} from "../../src/security/rate-limit.js";
import { respondError } from "../../src/security/errors.js";

/**
 * N-2：桶硬上限（maxBuckets）与 overflow 桶的**真实** boundary 测试。
 *
 * 上一版名为 `bucket cap` 的用例只发了 3 个请求，从未进入 overflow 分支——
 * 等于这个安全控制完全没有测试。这里通过注入小上限（不是环境变量、不影响生产
 * 默认 10000）真正执行 `bucketKey` 的 overflow 分支，并断言：
 *
 * 1. 达到上限前每个新 IP 各自成桶；
 * 2. 达到上限后，未知来源进入**按端点共享**的 overflow 桶（第 4、第 5 个 IP 同桶）；
 * 3. overflow 桶与正常桶使用同一个 `max` 计数（超限同样 429）；
 * 4. 已存在的正常桶不会被挤进 overflow；
 * 5. 桶总数恒为 `maxBuckets + 端点 overflow 数`，不会随请求数增长；
 * 6. 并发首次请求不会超限创建、不会产生重复 overflow 桶、不抛异常。
 *
 * 断言用的是 `rateLimitStats()`（只返回计数，不返回桶键——桶键含客户端 IP）。
 */

const WINDOW_MS = 60_000;

interface AppOptions {
  /** 端点名（决定桶前缀与 overflow 桶归属）。 */
  name: string;
  /** 同一来源在窗口内允许的请求数。 */
  max: number;
  /** 注入的桶上限。 */
  maxBuckets: number;
  /** 路径，默认 `/${name}`。 */
  path?: string;
}

function mount(app: Hono, options: AppOptions): void {
  const limiter = rateLimit({
    name: options.name,
    max: options.max,
    windowMs: WINDOW_MS,
    trustProxy: true,
    trustedHops: 1,
    maxBuckets: options.maxBuckets,
  });
  app.get(options.path ?? `/${options.name}`, limiter, (c) => c.json({ ok: true }));
}

/**
 * 极简 app：用**生产同一个** `respondError` 收口异常，这样 `rateLimited()` 得到
 * 的是真实的 429 + Retry-After，而不是没有 onError 时的 500。
 */
function createTestApp(): Hono {
  const app = new Hono();
  app.onError((err, c) => respondError(c, err, false));
  return app;
}

async function hit(app: Hono, path: string, ip: string): Promise<number> {
  const resp = await app.request(`http://cloud.test${path}`, {
    headers: { "x-forwarded-for": ip },
  });
  return resp.status;
}

describe("bucket cap & overflow buckets (N-2)", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  afterEach(() => {
    resetRateLimiter();
  });

  it("production default is the documented constant", () => {
    // 上限是常量而非环境变量：生产行为不会被部署配置放大。
    expect(DEFAULT_MAX_BUCKETS).toBe(10_000);
  });

  it("caps bucket creation and funnels unknown sources into one shared overflow bucket", async () => {
    const app = createTestApp();
    mount(app, { name: "probe", max: 5, maxBuckets: 3 });
    const ip = (n: number) => `203.0.113.${n}`;

    // —— 1. 上限内：三个不同 IP 各自成桶 ——
    for (const n of [1, 2, 3]) {
      expect(await hit(app, "/probe", ip(n))).toBe(200);
    }
    expect(rateLimitStats()).toEqual({ total: 3, overflow: 0 });

    // —— 2. 第 4 个未知 IP 进入 overflow（不再建新桶）——
    expect(await hit(app, "/probe", ip(4))).toBe(200);
    expect(rateLimitStats()).toEqual({ total: 4, overflow: 1 });

    // —— 3. 第 5 个未知 IP 与第 4 个共享同一个 overflow 桶 ——
    expect(await hit(app, "/probe", ip(5))).toBe(200);
    expect(rateLimitStats()).toEqual({ total: 4, overflow: 1 });

    // —— 4. overflow 桶与正常桶用同一个 max：再补 3 次到 5，下一次即 429 ——
    for (const n of [6, 7, 8]) {
      expect(await hit(app, "/probe", ip(n))).toBe(200); // overflow count 3、4、5
    }
    expect(rateLimitStats()).toEqual({ total: 4, overflow: 1 });
    expect(await hit(app, "/probe", ip(9))).toBe(429); // overflow count 6 > 5

    // —— 5. 已存在的正常桶不会被挤进 overflow：IP 1 的第 2 次仍走自己的桶 ——
    expect(await hit(app, "/probe", ip(1))).toBe(200);
    // 再补一次到 2，仍不 429（若被挤进已耗尽的 overflow，这里会是 429）
    expect(await hit(app, "/probe", ip(1))).toBe(200);
    expect(rateLimitStats()).toEqual({ total: 4, overflow: 1 });

    // —— 6. 继续来新 IP，桶数不再增长（分支被封死）——
    for (const n of [10, 11, 12, 13]) {
      await hit(app, "/probe", ip(n));
    }
    expect(rateLimitStats()).toEqual({ total: 4, overflow: 1 });
  });

  it("each endpoint gets its own overflow bucket, and they do not bleed into each other", async () => {
    const app = createTestApp();
    mount(app, { name: "alpha", max: 1, maxBuckets: 1 });
    mount(app, { name: "beta", max: 1, maxBuckets: 1 });

    const ip = (n: number) => `198.51.100.${n}`;

    // alpha 的第一个 IP 建正常桶（total=1，已达上限）
    expect(await hit(app, "/alpha", ip(1))).toBe(200);
    expect(rateLimitStats()).toEqual({ total: 1, overflow: 0 });

    // alpha 的第二个 IP → alpha 的 overflow（count 1）
    expect(await hit(app, "/alpha", ip(2))).toBe(200);
    expect(rateLimitStats()).toEqual({ total: 2, overflow: 1 });

    // beta 的未知 IP → beta **自己的** overflow（count 1，不是 2）
    // 若两个端点共用一个 overflow，这里会因 2 > max(1) 返回 429
    expect(await hit(app, "/beta", ip(3))).toBe(200);
    expect(rateLimitStats()).toEqual({ total: 3, overflow: 2 });

    // 各自的 overflow 独立计数：beta 再来一个 → 2 > 1 → 429
    expect(await hit(app, "/beta", ip(4))).toBe(429);
    // alpha 的 overflow 仍是 2 → 也 429；两者互不抵消
    expect(await hit(app, "/alpha", ip(5))).toBe(429);
    expect(rateLimitStats()).toEqual({ total: 3, overflow: 2 });
  });

  it("three endpoints (production shape): total = maxBuckets + 3", async () => {
    // 生产恰好三个限流端点（auth / authorize / token）。这里用 maxBuckets=2 验证
    // 「每端点至多一个 overflow 桶」这条推导：2 + 3 = 5，其中 overflow 桶 3 个。
    const app = createTestApp();
    mount(app, { name: "auth", max: 1_000, maxBuckets: 2 });
    mount(app, { name: "authorize", max: 1_000, maxBuckets: 2 });
    mount(app, { name: "token", max: 1_000, maxBuckets: 2 });

    const ip = (n: number) => `192.0.2.${n}`;
    // 每个端点各来 4 个不同来源：前 2 个建成正常桶或触及上限，其余进本端点的 overflow
    for (const name of ["auth", "authorize", "token"]) {
      for (const n of [1, 2, 3, 4]) {
        expect(await hit(app, `/${name}`, ip(n))).toBe(200);
      }
    }

    const stats = rateLimitStats();
    expect(stats).toEqual({ total: 5, overflow: 3 });
    // 公式：上限 + 已创建 overflow 桶的端点数（生产 10000 + 3 = 10003）
    expect(stats.total).toBe(2 + 3);
  });

  it("bucket count stays bounded no matter how many distinct sources arrive", async () => {
    const app = createTestApp();
    mount(app, { name: "probe", max: 1_000, maxBuckets: 5 });

    for (let n = 0; n < 60; n++) {
      expect(await hit(app, "/probe", `10.0.${Math.floor(n / 250)}.${n}`)).toBe(200);
    }

    const stats = rateLimitStats();
    expect(stats).toEqual({ total: 6, overflow: 1 });
    expect(stats.total).toBeLessThanOrEqual(5 + 1);
  });

  it("concurrent first requests from distinct sources never exceed the cap", async () => {
    const app = createTestApp();
    mount(app, { name: "probe", max: 1_000, maxBuckets: 3 });

    // 30 个互不相同的来源同时首次请求（max 很大，不会因计数被 429）
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, n) => hit(app, "/probe", `172.16.0.${n}`)),
    );

    // 全部放行：上限只影响「建几个桶」，不改变限流语义
    expect(statuses).toEqual(Array.from({ length: 30 }, () => 200));

    // 真实状态：3 个正常桶 + 1 个 overflow，只此一个，没有重复
    const stats = rateLimitStats();
    expect(stats).toEqual({ total: 4, overflow: 1 });

    // 再来一批并发，桶数仍然不变（不会二次创建 overflow）
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => hit(app, "/probe", `172.17.0.${n}`)),
    );
    expect(rateLimitStats()).toEqual({ total: 4, overflow: 1 });
  });
});
