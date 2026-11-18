import { describe, expect, it } from "vitest";
import { createHeartbeat, HEARTBEAT_MISS_LIMIT } from "../../src/link/heartbeat.js";
import { REMOTE_CLOSE, type PingFrame } from "../../src/link/schemas.js";

/**
 * 心跳节拍（协议 §5.1）。
 *
 * 全部用「手动时钟 + 手动 tick」：真等 60 秒的测试既慢又会在 CI 上偶发失败，
 * 而这里要验证的恰恰是「时钟走了多远之后会发生什么」。
 *
 * 关键设计：`setInterval` 被替换成「把回调存起来」，测试自己决定何时触发。
 * 这样每条用例都能精确落在「第 N 次 tick」上，不必依赖真实调度。
 */

interface Harness {
  start(): void;
  tick(): void;
  pong(seq: number): boolean;
  sent: PingFrame[];
  rtts: number[];
  timeouts: Array<{ code: number; reason: string }>;
  advance(ms: number): void;
  stop(): void;
  running(): boolean;
}

function makeHarness(options: { heartbeatMs?: number; idleTimeoutMs?: number } = {}): Harness {
  let current = 0;
  let scheduled: (() => void) | null = null;
  const sent: PingFrame[] = [];
  const rtts: number[] = [];
  const timeouts: Array<{ code: number; reason: string }> = [];

  const controller = createHeartbeat({
    heartbeatMs: options.heartbeatMs ?? 20_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    now: () => current,
    send: (frame) => sent.push(frame),
    onTimeout: (code, reason) => timeouts.push({ code, reason }),
    onRtt: (rtt) => rtts.push(rtt),
    setInterval: (fn) => {
      scheduled = fn;
      return { fake: true };
    },
    clearInterval: () => {
      scheduled = null;
    },
  });

  return {
    start: () => controller.start(),
    tick() {
      scheduled?.();
    },
    pong: (seq: number) => controller.onPong(seq),
    sent,
    rtts,
    timeouts,
    advance(ms) {
      current += ms;
    },
    stop: () => controller.stop(),
    running: () => controller.running(),
  };
}

describe("心跳", () => {
  it("默认策略与协议一致（20s / 60s / 3 次）", () => {
    expect(HEARTBEAT_MISS_LIMIT).toBe(3);
  });

  it("start 后每次 tick 发一个 ping，seq 递增", () => {
    const h = makeHarness();
    h.start();
    h.tick();
    h.advance(20_000);
    h.tick();
    h.advance(20_000);
    h.tick();

    expect(h.sent).toHaveLength(3);
    expect(h.sent.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(h.sent.every((p) => p.type === "ping" && p.v === 1)).toBe(true);
    // ts 是 epoch 毫秒（用于诊断），不是 monotonic
    expect(h.sent[0]?.ts).toBeGreaterThan(1_700_000_000_000);
  });

  it("正确 seq 的 pong 被接受，并算出单调时钟 RTT", () => {
    const h = makeHarness();
    h.start();
    h.tick();
    h.advance(15);
    expect(h.pong(1)).toBe(true);
    expect(h.rtts).toEqual([15]);
  });

  it("错误 seq 的 pong 不被接受（也不刷新心跳）", () => {
    const h = makeHarness();
    h.start();
    h.tick();
    expect(h.pong(99)).toBe(false);
    expect(h.rtts).toEqual([]);
  });

  it("连续 3 次没有 pong → close 4008", () => {
    const h = makeHarness();
    h.start();
    // 第 1 次 tick 发 ping#1（此时没有「未回应」可计）
    h.tick();
    h.advance(20_000);
    // 第 2 次：ping#1 没被回应 → missed=1，发 ping#2
    h.tick();
    expect(h.timeouts).toHaveLength(0);
    h.advance(20_000);
    // 第 3 次：ping#2 没被回应 → missed=2
    h.tick();
    expect(h.timeouts).toHaveLength(0);
    h.advance(20_000);
    // 第 4 次：ping#3 没被回应 → missed=3 → 判死
    h.tick();
    expect(h.timeouts).toEqual([{ code: REMOTE_CLOSE.HEARTBEAT_TIMEOUT, reason: "heartbeat timeout" }]);
    expect(h.running()).toBe(false);
  });

  it("收到 pong 后计数归零（不会因为历史 miss 累积而误杀）", () => {
    const h = makeHarness();
    h.start();
    h.tick(); // ping#1
    h.advance(20_000);
    h.tick(); // missed=1, ping#2
    h.advance(100);
    expect(h.pong(2)).toBe(true); // 归零
    h.advance(19_900);
    h.tick(); // ping#3（ping#2 已被回应，不增 miss）
    expect(h.timeouts).toHaveLength(0);
    h.advance(20_000);
    h.tick(); // missed=1
    expect(h.timeouts).toHaveLength(0);
  });

  it("idle 超过 60s 即使「没发过 ping」也判死（半开连接最常见形态）", () => {
    const h = makeHarness();
    h.start();
    // 一次 tick 都不触发，但时钟走了 60s：说明定时器被节流/卡住，
    // 这也是一种「链路已死」。判据不能只依赖 miss 计数。
    h.advance(60_000);
    h.tick();
    expect(h.timeouts).toHaveLength(1);
    expect(h.timeouts[0]?.code).toBe(REMOTE_CLOSE.HEARTBEAT_TIMEOUT);
  });

  it("stop 之后不再发 ping、不再判超时（timer 不泄漏）", () => {
    const h = makeHarness();
    h.start();
    h.tick();
    h.stop();
    expect(h.running()).toBe(false);
    h.advance(120_000);
    h.tick(); // 已 clearInterval，回调不应再被调度
    expect(h.sent).toHaveLength(1);
    expect(h.timeouts).toHaveLength(0);
  });

  it("重复 start 不会起两个定时器", () => {
    const h = makeHarness();
    h.start();
    h.start();
    h.tick();
    expect(h.sent).toHaveLength(1);
  });

  it("判死之后 stop 不再重复触发（onTimeout 只调一次）", () => {
    const h = makeHarness();
    h.start();
    h.tick();
    for (let i = 0; i < 6; i += 1) {
      h.advance(20_000);
      h.tick();
    }
    expect(h.timeouts).toHaveLength(1);
  });
});
