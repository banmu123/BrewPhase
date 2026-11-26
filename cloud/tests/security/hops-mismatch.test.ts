import type { Context } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientIp, resetRateLimiter } from "../../src/security/rate-limit.js";
import { createHarness, refresh, type Harness } from "../helpers/harness.js";

/**
 * F-1 回归：`TRUST_PROXY_HOPS` 与真实代理层数**不匹配**时的实际行为。
 *
 * 背景：文档曾经写成「过小 → 回退 socket / 过大 → 一定 fail-open」，两个方向都不准确。
 * 本文件把 `clientIp` 的真实取值锁死，避免文档再次漂移。
 *
 * 算法（`index = entries.length - max(1, hops)`）的三段行为：
 *
 * | HOPS 相对真实层数 N | 客户端是否自带伪造条目 | 选中值 | 后果 |
 * |---|---|---|---|
 * | 偏小（HOPS < N） | 无关 | 上游**代理 IP**（不回退 socket） | 该代理后的用户共享一个桶 → 429（fail-closed） |
 * | 相等（HOPS = N） | 有伪造 | **客户端真实 IP**（伪造被推到左侧） | 伪造无法换桶 |
 * | 偏大（HOPS > N） | 无 | 条目不足 → **回退 socket** | 所有用户共享一个桶 → 429（fail-closed） |
 * | 偏大（HOPS > N） | 有 | **攻击者自填的伪造值** | 每伪造值一个新桶 → 限流被绕过（fail-open） |
 *
 * 唯一需要「修」的是文档；算法本身在上述契约下是正确的——所以本文件只断言行为，
 * 不锁定任何实现细节（不读 `index`、不假设内部变量）。
 */

/** 假 socket 地址：模拟「离服务最近的那一跳」——真实部署里它同样是一个代理。 */
const SOCKET = "10.0.0.99";

const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.11";
const CDN = "198.51.100.1";

/**
 * 构造只含 `clientIp` 所需字段的 Context。
 *
 * `getConnInfo` 的真实实现是读 `c.env.incoming.socket.remoteAddress`，所以给一个假
 * socket 就能精确区分「选中的是 XFF 里的代理 IP」与「回退到了 socket 地址」——
 * 这是 `app.request`（无 socket，回退恒为空串）做不到的。
 */
function fakeCtx(xff: string | undefined, socket = SOCKET): Context {
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? xff : undefined),
    },
    env: { incoming: { socket: { remoteAddress: socket, remotePort: 51_743, remoteFamily: "IPv4" } } },
  } as unknown as Context;
}

describe("clientIp: HOPS 与真实代理层数不匹配 (F-1)", () => {
  describe("① 单层追加式（N=1），HOPS=1 —— 正确", () => {
    it("客户端不带伪造时选中客户端 IP", () => {
      expect(clientIp(fakeCtx(CLIENT_A), true, 1)).toBe(CLIENT_A);
    });

    it("客户端自带伪造条目也选中客户端 IP（伪造被推到左侧）", () => {
      expect(clientIp(fakeCtx(`1.2.3.4, ${CLIENT_A}`), true, 1)).toBe(CLIENT_A);
      expect(clientIp(fakeCtx(`5.5.5.5, 6.6.6.6, ${CLIENT_A}`), true, 1)).toBe(CLIENT_A);
    });
  });

  describe("② 两层追加式（N=2），HOPS=2 —— 正确", () => {
    it("无伪造时选中客户端 IP", () => {
      expect(clientIp(fakeCtx(`${CLIENT_A}, ${CDN}`), true, 2)).toBe(CLIENT_A);
    });

    it("有伪造时仍选中客户端 IP", () => {
      expect(clientIp(fakeCtx(`5.5.5.5, ${CLIENT_A}, ${CDN}`), true, 2)).toBe(CLIENT_A);
    });
  });

  describe("③ 覆盖式代理：XFF 恒为单条", () => {
    it("单层覆盖式 HOPS=1 → 客户端 IP", () => {
      expect(clientIp(fakeCtx(CLIENT_A), true, 1)).toBe(CLIENT_A);
    });

    it("多层覆盖式设成 HOPS=2 → 条目不足，回退 socket（这就是只能配 1 的原因）", () => {
      expect(clientIp(fakeCtx(CLIENT_A), true, 2)).toBe(SOCKET);
    });
  });

  describe("④ HOPS 偏小（< N）：选中上游代理 IP，**不是** socket", () => {
    it("两层链路只配 HOPS=1 → 选中 CDN 的 IP", () => {
      const picked = clientIp(fakeCtx(`${CLIENT_A}, ${CDN}`), true, 1);
      expect(picked).toBe(CDN);
      // 关键否定断言：文档曾声称这里「回退 socket」，实际并没有
      expect(picked).not.toBe(SOCKET);
    });

    it("同一代理后的不同客户端塌缩成同一个限流身份（fail-closed，不是绕过）", () => {
      const a = clientIp(fakeCtx(`${CLIENT_A}, ${CDN}`), true, 1);
      const b = clientIp(fakeCtx(`${CLIENT_B}, ${CDN}`), true, 1);
      expect(a).toBe(b);
      expect(a).toBe(CDN);
    });

    it("客户端在偏小配置下自带伪造条目也不会改变结果（伪造被推到左侧）", () => {
      expect(clientIp(fakeCtx(`9.9.9.9, ${CLIENT_A}, ${CDN}`), true, 1)).toBe(CDN);
    });
  });

  describe("⑤ HOPS 偏大（> N）且客户端**没有**伪造：回退 socket", () => {
    it("单层链路配 HOPS=2 → socket", () => {
      expect(clientIp(fakeCtx(CLIENT_A), true, 2)).toBe(SOCKET);
    });

    it("两层链路配 HOPS=3 → socket", () => {
      expect(clientIp(fakeCtx(`${CLIENT_A}, ${CDN}`), true, 3)).toBe(SOCKET);
    });

    it("不同客户端都落到同一个 socket 身份（fail-closed）", () => {
      const a = clientIp(fakeCtx(CLIENT_A), true, 2);
      const b = clientIp(fakeCtx(CLIENT_B), true, 2);
      expect(a).toBe(SOCKET);
      expect(a).toBe(b);
    });
  });

  describe("⑥ HOPS 偏大（> N）且客户端**自带**伪造：选中伪造值（fail-open）", () => {
    it("单层链路配 HOPS=2，伪造条目被选中", () => {
      expect(clientIp(fakeCtx(`1.2.3.4, ${CLIENT_A}`), true, 2)).toBe("1.2.3.4");
    });

    it("两层链路配 HOPS=3，伪造条目被选中", () => {
      expect(clientIp(fakeCtx(`5.5.5.5, ${CLIENT_A}, ${CDN}`), true, 3)).toBe("5.5.5.5");
    });

    it("伪造值可任意轮换——同一客户端每次都能换一个新的限流身份", () => {
      const keys = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((forged) =>
        clientIp(fakeCtx(`${forged}, ${CLIENT_A}`), true, 2),
      );
      expect(keys).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
      expect(new Set(keys).size).toBe(3);
    });
  });

  describe("⑦ TRUST_PROXY=false：HOPS 完全不参与", () => {
    it("任何 XFF 与任何 HOPS 都只取 socket 地址", () => {
      for (const xff of [CLIENT_A, `1.2.3.4, ${CLIENT_A}`, "deadbeef", undefined]) {
        for (const hops of [1, 2, 5]) {
          expect(clientIp(fakeCtx(xff), false, hops)).toBe(SOCKET);
        }
      }
    });
  });
});

/**
 * 端到端：同样的三段行为必须体现在**最终限流身份**上（不只是 `clientIp` 的返回值）。
 *
 * 手法：`maxAuth=1`，两个不同取值各发一次——被判为同桶则第二次 429，判为不同桶则 401。
 * `app.request` 没有 socket，回退值为空串（`clientKey` 里变成 `"unknown"`），因此
 * 「代理 IP」与「回退 socket」在观测上是两个不同的桶，可以区分。
 */
describe("限流身份：HOPS 配置错误的三段后果 (F-1)", () => {
  const FAKE_TOKEN = "fake-token-0123456789abcdef";

  let hops1: Harness;
  let hops2: Harness;

  beforeAll(async () => {
    hops1 = await createHarness({
      trustProxy: true,
      trustProxyHops: 1,
      rateLimit: { windowMs: 60_000, maxAuthorize: 30, maxToken: 20, maxMcp: 120, maxAuth: 1 },
    });
    hops2 = await createHarness({
      trustProxy: true,
      trustProxyHops: 2,
      rateLimit: { windowMs: 60_000, maxAuthorize: 30, maxToken: 20, maxMcp: 120, maxAuth: 1 },
    });
  });

  afterAll(async () => {
    await hops1.close();
    await hops2.close();
  });

  beforeEach(() => {
    resetRateLimiter();
  });

  const status = async (h: Harness, xff?: string): Promise<number> =>
    (await refresh(h, FAKE_TOKEN, xff === undefined ? {} : { "x-forwarded-for": xff })).status;

  it("偏小：同代理后的两个客户端被算成同一个身份 → 第二次 429", async () => {
    expect(await status(hops1, `${CLIENT_A}, ${CDN}`)).toBe(401);
    // 不同客户端，但 HOPS=1 只取到 CDN → 同桶
    expect(await status(hops1, `${CLIENT_B}, ${CDN}`)).toBe(429);
  });

  it("偏小：选中的是代理 IP，不是 socket —— 不带 XFF 时是另一个桶", async () => {
    expect(await status(hops1, `${CLIENT_A}, ${CDN}`)).toBe(401); // 桶 = CDN
    expect(await status(hops1)).toBe(401); // 桶 = unknown（socket 回退）→ 证明 CDN ≠ socket
    expect(await status(hops1)).toBe(429); // 再次 socket → 同桶
  });

  it("相等：伪造条目无法换桶（两层链路配 HOPS=2）", async () => {
    expect(await status(hops2, `5.5.5.5, ${CLIENT_A}, ${CDN}`)).toBe(401);
    expect(await status(hops2, `6.6.6.6, ${CLIENT_A}, ${CDN}`)).toBe(429); // 换伪造值仍同桶
  });

  it("偏大且无伪造：全部回退 socket → 不同客户端共享一个桶", async () => {
    expect(await status(hops2, CLIENT_A)).toBe(401); // 单条目 + HOPS=2 → unknown
    expect(await status(hops2, CLIENT_B)).toBe(429); // 另一个客户端也落到 unknown
  });

  it("偏大且有伪造：伪造值决定桶 → 轮换伪造即可绕过限流（fail-open）", async () => {
    // 同一个客户端，伪造值每次不同：三次都是新桶，max=1 也拦不住
    expect(await status(hops2, `1.1.1.1, ${CLIENT_A}`)).toBe(401);
    expect(await status(hops2, `2.2.2.2, ${CLIENT_A}`)).toBe(401);
    expect(await status(hops2, `3.3.3.3, ${CLIENT_A}`)).toBe(401);
    // 对照组：同样三次但伪造值固定 → 第二次就被拦
    expect(await status(hops2, `9.9.9.9, ${CLIENT_A}`)).toBe(401);
    expect(await status(hops2, `9.9.9.9, ${CLIENT_A}`)).toBe(429);
  });

  it("偏大且伪造值不是合法 IP：回退 socket（isIP 校验兜住畸形值）", async () => {
    expect(await status(hops2, `not-an-ip, ${CLIENT_A}`)).toBe(401); // 回退 unknown
    expect(await status(hops2, `also-bad, ${CLIENT_B}`)).toBe(429); // 同样回退 unknown
  });
});
