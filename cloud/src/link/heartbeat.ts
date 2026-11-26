import {
  REMOTE_CLOSE,
  REMOTE_CLOSE_REASON,
  REMOTE_HEARTBEAT_MS,
  REMOTE_IDLE_TIMEOUT_MS,
  type PingFrame,
} from "./schemas.js";

/**
 * Cloud 侧的连接心跳（协议 §5.1）。
 *
 * ```
 * Cloud → Desktop  每 20s    {v:1,type:"ping",ts,seq}
 * Desktop → Cloud            {v:1,type:"pong",ts,seq,inflight}
 * ```
 *
 * ## 三个容易写错的地方
 *
 * 1. **空闲判据必须从「连接建立」起算，不能等第一个 pong。**
 *    旧实现在 `lastPongAt === null` 时直接 `return`，于是「握手成功但 Cloud
 *    再没收到过 pong」这种**最常见的半开连接**永远不会被判死
 *    （NAT 超时、LB 掉表都会这样）。这里把连接建立时刻作为初始基准。
 *
 * 2. **RTT 用 monotonic**。`Date.now()` 会被 NTP 回拨，一次回拨就能让 RTT
 *    变成负数或几十秒。`performance.now()` 只增不减。
 *
 * 3. **只有回显「最近一次 ping 的 seq」才算有效 pong**。
 *    「Desktop 发来任何帧就当它还活着」是错的：一个只发 `status` 却不回
 *    `pong` 的客户端会让 Cloud 永远以为链路双向健康，而实际上行已经断了。
 *    迟到的 pong（上一次的 seq）同理不算——它无法证明「此刻」还通。
 *
 * ## 可注入的时钟与定时器
 *
 * 超时判据是「60 秒无 pong」。测试不可能真等 60 秒，所以 `now` 与
 * `setInterval` 都是注入的——但生产路径用的仍是同一个 `performance.now`，
 * 测试改的只是「时间怎么走」，不是「用哪个时钟」。
 */

/** 连续多少个 ping 未被回应即判死（协议 §5.1：默认 3 → 60s）。 */
export const HEARTBEAT_MISS_LIMIT = 3;

export interface HeartbeatDeps {
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  /** monotonic 毫秒（与 `performance.now()` 同单位）。 */
  now?: () => number;
  send: (frame: PingFrame) => void;
  onTimeout: (closeCode: number, reason: string) => void;
  onRtt?: (rttMs: number) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface HeartbeatController {
  /** 记录一次有效 pong。返回是否被接受（`seq` 必须匹配最近一次 ping）。 */
  onPong(seq: number): boolean;
  /** 连接建立（`hello_ok` 发出）后调用一次。 */
  start(): void;
  /** 幂等。连接关闭必须调用它，否则 timer 泄漏。 */
  stop(): void;
  /** 当前是否在运行（测试与关闭后的断言用）。 */
  running(): boolean;
}

export function createHeartbeat(deps: HeartbeatDeps): HeartbeatController {
  const heartbeatMs = deps.heartbeatMs ?? REMOTE_HEARTBEAT_MS;
  const idleTimeoutMs = deps.idleTimeoutMs ?? REMOTE_IDLE_TIMEOUT_MS;
  const now = deps.now ?? (() => performance.now());
  const setIntervalImpl = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalImpl =
    deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let timer: unknown = null;
  /** 单调递增的 ping 序号。**不随 pong 重置**：Desktop 靠它区分迟到响应。 */
  let seq = 0;
  /** 最近一次 ping 的序号。 */
  let lastPingSeq: number | null = null;
  /** 最近一次 ping 的发送时刻（monotonic），用于 RTT。 */
  let lastPingAtMono: number | null = null;
  /** 最近一次被回应过的 ping 序号。 */
  let lastPongedSeq: number | null = null;
  /** 最近一次**有效** pong 的时刻（monotonic）。 */
  let lastPongAtMono: number | null = null;
  /** 连接建立时刻（monotonic）：空闲判据的初始基准。 */
  let startedAtMono: number | null = null;
  let missed = 0;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    const nowMono = now();

    // 上一个 ping 没被回应 → 记一次 miss。放在「发新 ping」之前，
    // 这样「第 3 个 ping 发出后仍无 pong」会在下一次 tick 立刻判死，
    // 而不是再来一轮。
    if (lastPingSeq !== null && lastPongedSeq !== lastPingSeq) {
      missed += 1;
    }

    const reference = lastPongAtMono ?? startedAtMono ?? nowMono;
    const idleMs = nowMono - reference;
    if (missed >= HEARTBEAT_MISS_LIMIT || idleMs >= idleTimeoutMs) {
      stop();
      deps.onTimeout(REMOTE_CLOSE.HEARTBEAT_TIMEOUT, REMOTE_CLOSE_REASON.HEARTBEAT_TIMEOUT);
      return;
    }

    seq += 1;
    lastPingSeq = seq;
    lastPingAtMono = nowMono;
    deps.send({ v: 1, type: "ping", ts: Date.now(), seq });
  };

  return {
    start() {
      if (timer !== null || stopped) return;
      startedAtMono = now();
      lastPongAtMono = null;
      timer = setIntervalImpl(tick, heartbeatMs);
    },

    onPong(pongSeq) {
      if (stopped) return false;
      if (lastPingSeq === null || pongSeq !== lastPingSeq) return false;
      const nowMono = now();
      if (deps.onRtt && lastPingAtMono !== null) {
        deps.onRtt(Math.max(0, nowMono - lastPingAtMono));
      }
      lastPongedSeq = pongSeq;
      lastPongAtMono = nowMono;
      missed = 0;
      return true;
    },

    stop,

    running() {
      return timer !== null && !stopped;
    },
  };
}
