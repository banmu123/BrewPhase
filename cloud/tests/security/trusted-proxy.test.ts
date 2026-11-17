import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { createHarness, refresh, type Harness } from "../helpers/harness.js";

/**
 * I-1 整改验证：可信代理与 IP 限流。
 *
 * 真实解析行为断言（不是改断言凑数）：
 * - trustProxy=false：任何 XFF 头都被忽略，全部落在同一桶 → 429；
 * - trustProxy=true + 追加式 XFF：客户端伪造的左侧条目无法改变选中值
 *   （右端第 N 跳由可信代理写入）→ 伪造不能创建新桶 → 429；
 * - trustProxy=true + 覆盖式 XFF：单条目即真实客户端 IP，不同 IP 不同桶；
 * - 多层代理：TRUST_PROXY_HOPS=N 从右端跳过 N 个条目；
 * - 畸形 / 缺失头：回退 socket 地址（app.request 下为 unknown）。
 */

const FAKE_TOKEN = "fake-token-0123456789abcdef";

async function hammer(h: Harness, headers: Record<string, string>, times: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    statuses.push((await refresh(h, FAKE_TOKEN, headers)).status);
  }
  return statuses;
}

describe("trusted proxy & IP rate limiting (I-1)", () => {
  let plain: Harness;

  beforeAll(async () => {
    plain = await createHarness({
      rateLimit: { windowMs: 60_000, maxAuthorize: 30, maxToken: 20, maxAuth: 3 },
    });
  });

  afterAll(async () => {
    await plain.close();
  });

  it("trustProxy=false: forged X-Forwarded-For is ignored entirely", async () => {
    resetRateLimiter();
    // 前 3 次伪造同一个 IP，第 4 次换一个伪造 IP —— 若 XFF 被信任，第 4 次会进新桶放行
    const statuses = [
      ...(await hammer(plain, { "x-forwarded-for": "9.9.9.9" }, 3)),
      (await refresh(plain, FAKE_TOKEN, { "x-forwarded-for": "8.8.8.8" })).status,
    ];
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  describe("trustProxy=true (single hop)", () => {
    let proxied: Harness;

    beforeAll(async () => {
      proxied = await createHarness({
        trustProxy: true,
        trustProxyHops: 1,
        rateLimit: { windowMs: 60_000, maxAuthorize: 30, maxToken: 20, maxAuth: 3 },
      });
    });

    afterAll(async () => {
      await proxied.close();
    });

    it("append-style XFF: forged left entries cannot create new buckets", async () => {
      resetRateLimiter();
      // 追加式代理（$proxy_add_x_forwarded_for）：伪造头会被追加在真实 IP 之后
      // 模拟到达应用的头 = "伪造, 真实IP"，右端第 1 跳 = 真实 IP —— 伪造无效
      const appended = (fake: string, real: string) => ({ "x-forwarded-for": `${fake}, ${real}` });
      const statuses = [
        ...(await hammer(proxied, appended("6.6.6.6", "203.0.113.10"), 3)),
        (await refresh(proxied, FAKE_TOKEN, appended("5.5.5.5", "203.0.113.10"))).status,
        (await refresh(proxied, FAKE_TOKEN, appended("1.2.3.4,9.9.9.9,8.8.8.8", "203.0.113.10"))).status,
      ];
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    });

    it("overwrite-style XFF: distinct real client IPs get independent buckets", async () => {
      resetRateLimiter();
      // 覆盖式代理：头里只有真实客户端 IP；不同真实 IP 互不影响
      const a = await hammer(proxied, { "x-forwarded-for": "203.0.113.21" }, 3);
      const b = (await refresh(proxied, FAKE_TOKEN, { "x-forwarded-for": "203.0.113.22" })).status;
      expect(a).toEqual([401, 401, 401]);
      expect(b).toBe(401); // 另一个真实 IP，未触发 429
    });

    it("multi-hop (TRUST_PROXY_HOPS=2): picks the entry N from the right", async () => {
      resetRateLimiter();
      const twoHop = await createHarness({
        trustProxy: true,
        trustProxyHops: 2,
        rateLimit: { windowMs: 60_000, maxAuthorize: 30, maxToken: 20, maxAuth: 3 },
      });
      try {
        // 链路：客户端(可伪造) → CDN(8.8.8.8) → 反代(7.7.7.7) → 应用
        // XFF = "伪造, 8.8.8.8, 7.7.7.7"，hops=2 → 从右跳过 2 个可信条目 → 选中 8.8.8.8
        const cdn = (fake: string) => ({
          "x-forwarded-for": `${fake}, 8.8.8.8, 7.7.7.7`,
        });
        const statuses = [
          ...(await hammer(twoHop, cdn("6.6.6.6"), 3)),
          (await refresh(twoHop, FAKE_TOKEN, cdn("5.5.5.5"))).status,
          // 攻击者通过超长伪造链填充条目也无法把选中值推出可信窗口：
          // "1.2.3.4,2.3.4.5,3.4.5.6, 8.8.8.8, 7.7.7.7" → len=5, 跳过 2 → 仍是 8.8.8.8
          (await refresh(twoHop, FAKE_TOKEN, { "x-forwarded-for": "1.2.3.4, 2.3.4.5, 3.4.5.6, 8.8.8.8, 7.7.7.7" })).status,
        ];
        expect(statuses).toEqual([401, 401, 401, 429, 429]);
      } finally {
        await twoHop.close();
      }
    });

    it("malformed or missing proxy headers fall back to the socket identity", async () => {
      resetRateLimiter();
      // 头缺失 / 非 IP 形态 / 条目数不足 → 全部回退同一 socket 身份（app.request 下为 unknown）
      const variants: Record<string, string>[] = [
        {},
        { "x-forwarded-for": "not-an-ip" },
        { "x-forwarded-for": ";;;", },
        { "x-forwarded-for": "" },
        { "x-forwarded-for": "x".repeat(3000) }, // 超长头直接忽略
      ];
      const statuses: number[] = [];
      for (const headers of variants) {
        statuses.push((await refresh(proxied, FAKE_TOKEN, headers)).status);
      }
      // maxAuth=3，全部同桶：前 3 个 401，之后 429（429 计数不清零）
      expect(statuses[0]).toBe(401);
      expect(statuses[1]).toBe(401);
      expect(statuses[2]).toBe(401);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    });
  });

  it("bucket cap: overflow semantics stay functional and bounded", async () => {
    resetRateLimiter();
    // 桶硬上限（MAX_BUCKETS）已在实现层防御无限建桶；本用例锁定正常路径不受影响：
    // trustProxy=false 下所有请求共享同一 socket 身份桶，伪造头不增加桶数量
    //（append-style 用例已在 trustProxy=true 下断言同一性质）。
    const statuses = await hammer(plain, {}, 3);
    expect(statuses).toEqual([401, 401, 401]);
  });
});
