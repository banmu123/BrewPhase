import { describe, expect, it } from "vitest";
import { NonceStore } from "../../src/link/nonce-store.js";

/**
 * NonceStore 的六条边界（任务书 §7 逐条对应）。
 *
 * 全部用注入的单调时钟：这个类的语义就是「在 120 秒窗口内记住一个串」，
 * 靠 `setTimeout` 去等真实时间既慢又不稳定。
 */

function makeClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("NonceStore 防重放", () => {
  it("同一 nonce 第一次通过、第二次拒绝", () => {
    const store = new NonceStore({ now: makeClock().now });
    expect(store.checkAndRecord("nonce-a")).toBe("ok");
    expect(store.checkAndRecord("nonce-a")).toBe("replay");
  });

  it("不同 nonce 都能通过", () => {
    const store = new NonceStore({ now: makeClock().now });
    for (let i = 0; i < 100; i += 1) {
      expect(store.checkAndRecord(`nonce-${i}`)).toBe("ok");
    }
    expect(store.stats().size).toBe(100);
  });

  it("过期后可以重用（窗口语义，不是永久黑名单）", () => {
    const clock = makeClock();
    const store = new NonceStore({ windowMs: 120_000, now: clock.now });
    expect(store.checkAndRecord("nonce-a")).toBe("ok");
    clock.advance(119_999);
    expect(store.checkAndRecord("nonce-a")).toBe("replay");
    clock.advance(1);
    // 恰好到达窗口边界即过期（>= 而不是 >）。
    expect(store.checkAndRecord("nonce-a")).toBe("ok");
  });

  it("过期项会被清理（内存不无限增长）", () => {
    const clock = makeClock();
    const store = new NonceStore({ windowMs: 1000, now: clock.now });
    for (let i = 0; i < 50; i += 1) store.checkAndRecord(`old-${i}`);
    expect(store.stats().size).toBe(50);

    clock.advance(1000);
    // 触发一次 prune（写一个新 nonce）
    expect(store.checkAndRecord("fresh")).toBe("ok");
    expect(store.stats().size).toBe(1);
  });

  it("并发相同 nonce 只有一个通过（同步临界段）", async () => {
    const store = new NonceStore({ now: makeClock().now });
    // checkAndRecord 不是 async，所以「并发」只能发生在微任务层面。
    // 这里同时开 8 个 Promise，每个都先让出一次微任务再检查——
    // 如果实现里在「查」与「记」之间有任何 await，多个都会拿到 ok。
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        await Promise.resolve();
        return store.checkAndRecord("shared-nonce");
      }),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "replay")).toHaveLength(7);
  });

  it("容量上限不驱逐仍有效的 nonce（fail-closed）", () => {
    const clock = makeClock();
    const store = new NonceStore({ windowMs: 120_000, capacity: 4, now: clock.now });

    for (let i = 0; i < 4; i += 1) expect(store.checkAndRecord(`n-${i}`)).toBe("ok");
    // 表满：新 nonce 被拒（调用方按资源耗尽处理，close 1011）
    expect(store.checkAndRecord("overflow")).toBe("capacity");
    // 而**已有**的 nonce 仍然被记得（没有被淘汰掉换成新的）
    for (let i = 0; i < 4; i += 1) expect(store.checkAndRecord(`n-${i}`)).toBe("replay");

    // 过期之后容量自然释放
    clock.advance(120_000);
    expect(store.checkAndRecord("after-window")).toBe("ok");
  });

  it("容量满时不会因为「重放已有 nonce」而误判 capacity", () => {
    const clock = makeClock();
    const store = new NonceStore({ windowMs: 120_000, capacity: 2, now: clock.now });
    store.checkAndRecord("a");
    store.checkAndRecord("b");
    // 重放优先级高于容量：它必须是 replay（否则调用方会按 1011 处理，
    // 而真实原因是一个重放攻击）。
    expect(store.checkAndRecord("a")).toBe("replay");
  });

  it("统计信息反映容量", () => {
    const store = new NonceStore({ capacity: 7 });
    expect(store.stats()).toEqual({ size: 0, capacity: 7 });
  });
});
