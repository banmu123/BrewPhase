import {
  isRetryableRemoteError,
  REMOTE_DEVICE_MAX_INFLIGHT,
  REMOTE_MAX_INFLIGHT,
  REMOTE_QUEUE_BUDGET_MS,
  REMOTE_QUEUE_MAX,
  REMOTE_USER_MAX_INFLIGHT,
  type RemoteErrorCode,
} from "./schemas.js";

/**
 * 在途请求的生命周期（协议运行时 §7 / §8）。
 *
 * ## 这个文件只做一件事
 *
 * 它回答三个问题，别的一个都不碰：
 *
 * 1. **现在能不能发**（三层计数 + 队列）；
 * 2. **这条请求结束了吗**（幂等完成，第一次调用者赢）；
 * 3. **超时该怎么收敛**（扫描 + 返回需要发 `cancel` 的那些）。
 *
 * 它**不碰 socket、不碰数据库、不看时钟**——`nowMono` 由调用方每次传进来。
 * 这样并发测试可以用一个整数控制「现在几点」，而不必等真实时间流逝；
 * 也让「检查超时」与「发送帧」这两件事在代码里彻底分开——它们混在一起时，
 * 迟到 `res` 与「连接已断」会互相覆盖状态。
 *
 * ## 为什么计数要三层而不是一层
 *
 * | 层 | 上限 | 谁在用 |
 * |---|---|---|
 * | 连接 | `max_inflight`（协商值，2） | Desktop 的执行能力 |
 * | 设备 | 2 | 同一台机器上的所有连接 |
 * | 用户 | 4 | 跨设备的总预算（Phase 1.4 多设备时才有区别） |
 *
 * 只做连接级会在 Phase 1.4 直接失效（一个用户多台设备时连接级限流各自为政）；
 * 只做用户级则完全挡不住「一台设备被打满」。三层都记，代价是三个 `Map`。
 *
 * **释放必须恰好一次。** 每条 entry 有一个 `released` 标志，`settle` 与
 * `onConnectionLost` 都走同一个收口函数，所以「迟到 res 导致二次释放」
 * 在结构上不可能发生（而不是靠调用方记得别多调一次）。
 */

export type DispatchResult =
  | { ok: true; data: unknown; meta: { duration_ms: number; cached: boolean } }
  | {
      ok: false;
      error: { code: RemoteErrorCode; message: string; retryable: boolean };
    };

/** 一条在途请求的状态。`queued` 与 `sent` 都算「占着这次调用的预算」。 */
export type RequestState = "queued" | "sent" | "settled";

export interface PendingRequest {
  deliveryId: string;
  requestHash: string;
  userId: string;
  deviceId: string;
  connectionId: string;
  tool: string;
  /** 工具参数（原样透传，进 `req.arguments` 与 `request_hash`）。 */
  arguments: unknown;
  grantId: string;
  grantCtx: string;
  /** 协议字段（epoch），写进 `req.deadline_ms`。 */
  deadlineMs: number;
  /** 进程内判据（monotonic）。**派生一次**，之后只读它。 */
  deadlineMono: number;
  /** 进入队列的时刻（monotonic）；未入队为 `null`。 */
  queuedAtMono: number | null;
  state: RequestState;
  /**
   * `req` 帧**真的写出过**。
   *
   * 必须与 `state === 'sent'` 分开：`sent` 只表示「已占着三层计数里的一个槽位」，
   * 而 `reserve()` 一旦返回 `admitted` 就已经是 `sent`——那时帧还没构造。
   * 两者混用会让「reserve 之后、写出之前被取消/撤销」的请求收到一条
   * `cancel`，而 Desktop 从没见过它的 id（协议 §7.5：cancel 只能针对已投递的
   * 请求）。这个区分也是「已取消请求不得发出」的可观测判据。
   */
  frameSent: boolean;
  /** 结果（`state === 'settled'` 时有效，用于诊断与测试断言）。 */
  result: DispatchResult | null;
  /** 三层计数是否已归还。**恰好一次**。 */
  released: boolean;
}

export type ReserveInput = {
  deliveryId: string;
  requestHash: string;
  userId: string;
  deviceId: string;
  connectionId: string;
  tool: string;
  arguments: unknown;
  grantId: string;
  grantCtx: string;
  deadlineMs: number;
  deadlineMono: number;
  /** 入队时刻的 monotonic。**必须由调用方给**：本模块不持有时钟。 */
  nowMono: number;
};

export type ReserveOutcome =
  /** 槽位已占，可以立即发送。 */
  | { kind: "admitted"; entry: PendingRequest; promise: Promise<DispatchResult> }
  /** 已入队；等某个槽位释放后由 `promote()` 取出。 */
  | { kind: "queued"; entry: PendingRequest; promise: Promise<DispatchResult> }
  /** 立即拒绝（队列满）。 */
  | { kind: "rejected"; result: DispatchResult };

export interface SweepOutcome {
  /** 已按 `REQUEST_TIMEOUT` 结束；调用方**应当**给它们发 `cancel`（尽力）。 */
  timedOut: PendingRequest[];
  /** 排队超过预算，已按 `DEVICE_BUSY` 结束；**没有**发过 `req`，不该发 cancel。 */
  queueExpired: PendingRequest[];
}

export interface RegistryCounts {
  user: number;
  device: number;
  connection: number;
  queued: number;
  pending: number;
}

export interface RequestRegistryOptions {
  /** 连接级上限，取 `hello_ok.max_inflight` 的协商值。 */
  maxInflightPerConnection?: number;
  userMaxInflight?: number;
  deviceMaxInflight?: number;
  queueBudgetMs?: number;
  queueMax?: number;
}

export interface RequestRegistry {
  /** 占槽位或入队。**不发送任何东西**——发送由调用方在拿到 `entry` 后做。 */
  reserve(input: ReserveInput): ReserveOutcome;
  /** 标记已发送（`queued → sent`）。幂等。 */
  markSent(entry: PendingRequest): void;
  /** 以 `res` 的内容完成。**第一次调用者赢**，后续返回 false。 */
  settle(entry: PendingRequest, result: DispatchResult): boolean;
  /** 以错误码完成（超时 / 离线 / 取消等）。 */
  fail(entry: PendingRequest, code: RemoteErrorCode, message: string): boolean;
  /** 按 `delivery_id` 查（`res` 到达时用）。已 settle 的返回 `undefined`。 */
  get(deliveryId: string): PendingRequest | undefined;
  /** 该 `delivery_id` 是否已结算（区分「未知 id」与「已完成」）。 */
  isSettled(deliveryId: string): boolean;
  /** 扫描超时。返回需要发 `cancel` 的请求。 */
  sweep(nowMono: number): SweepOutcome;
  /** 取出一批可以发送的排队项（FIFO，逐条检查三层上限）。 */
  promote(): PendingRequest[];
  /**
   * 连接断开：该连接上全部未结算请求以 `DEVICE_OFFLINE` 结束。
   *
   * 队列里属于该连接的也一起结束——它们连 `req` 都没发出去，等下去
   * 只会在下一次连接上被误发（新连接是新的 connectionId，语义不同）。
   */
  onConnectionLost(connectionId: string): PendingRequest[];
  /** 拒绝某个 grant 上下文上全部未结算请求（grant 被撤销）。 */
  rejectByGrantCtx(grantCtx: string, code: RemoteErrorCode, message: string): PendingRequest[];
  /**
   * 拒绝某条连接上**尚未写出**的请求（仍在队列里）。
   *
   * 与 `rejectByConnection` 的差别是**范围**，不是错误码：这一条只动 `queued`，
   * 一条已经在 Desktop 手里执行的请求不受影响。
   *
   * 为什么需要它：连接进入 `syncLag` 时，队列里可能有**别的 grant** 的请求。
   * 按 ctx 拒绝（`rejectByGrantCtx`）找不到它们；按连接全拒
   * （`rejectByConnection`）会把已经写出的那些也一并改写生命周期——那是协议
   * 之外的行为扩张。而放着不管，下一次 `pump()` 就会把它们写出去，等于在
   * 「授权状态不可信」的连接上继续路由。
   *
   * 排队项从未占用三层计数，所以这里的结算**不归还任何计数**（`finish`
   * 里 `wasQueued` 分支）：调用方不应期待计数变化。
   */
  rejectQueuedByConnection(
    connectionId: string,
    code: RemoteErrorCode,
    message: string,
  ): PendingRequest[];
  /**
   * 拒绝某条连接上全部未结算请求（凭据轮换 / 连接被驱逐）。
   *
   * 与 `onConnectionLost` 的区别只在错误码：那条路径是「socket 没了」
   * （`DEVICE_OFFLINE`，可重试），这条是「这条连接的身份已经作废」
   * （`DEVICE_UNAUTHORIZED`，不可重试）。混用会让调用方对轮换做出
   * 「等一下再试」的判断，而它永远不会好。
   */
  rejectByConnection(connectionId: string, code: RemoteErrorCode, message: string): PendingRequest[];
  counts(): RegistryCounts;
}

const EMPTY: DispatchResult = {
  ok: false,
  error: { code: "INTERNAL_ERROR", message: "request ended without a result", retryable: false },
};

export function createRequestRegistry(options: RequestRegistryOptions = {}): RequestRegistry {
  const connMax = options.maxInflightPerConnection ?? REMOTE_MAX_INFLIGHT;
  const userMax = options.userMaxInflight ?? REMOTE_USER_MAX_INFLIGHT;
  const deviceMax = options.deviceMaxInflight ?? REMOTE_DEVICE_MAX_INFLIGHT;
  const queueBudgetMs = options.queueBudgetMs ?? REMOTE_QUEUE_BUDGET_MS;
  const queueMax = options.queueMax ?? REMOTE_QUEUE_MAX;

  /** 未结算的请求，两种状态都在这张表里。 */
  const entries = new Map<string, PendingRequest>();
  /**
   * 已结算的 `delivery_id`（保留最近 512 条）。
   *
   * 它的唯一用途是把「重复 `res`」与「未知 `res`」分开：前者是协议规定的
   * 幂等场景（忽略即可），后者可能是 Cloud 自己在发一条它已经没有记录的请求。
   * 两者都忽略，但日志与告警级别不同——混在一起就永远看不到「未知 id」。
   */
  const settledIds = new Set<string>();
  /** 队列：只放 `state === 'queued'` 的 delivery_id，FIFO。 */
  const queue: string[] = [];
  /** 等待队列项完成的 promise 解析器（队列项没有 emit 路径，只能在这里 resolve）。 */
  const waiters = new Map<string, (result: DispatchResult) => void>();

  const userCount = new Map<string, number>();
  const deviceCount = new Map<string, number>();
  const connCount = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string, delta: number): void => {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  const hasCapacity = (input: Pick<ReserveInput, "userId" | "deviceId" | "connectionId">): boolean =>
    (userCount.get(input.userId) ?? 0) < userMax &&
    (deviceCount.get(input.deviceId) ?? 0) < deviceMax &&
    (connCount.get(input.connectionId) ?? 0) < connMax;

  const acquire = (entry: PendingRequest): void => {
    bump(userCount, entry.userId, +1);
    bump(deviceCount, entry.deviceId, +1);
    bump(connCount, entry.connectionId, +1);
  };

  /**
   * 归还三层计数。**调用方必须先检查 `released`**（本文件内所有路径都通过
   * `finish` 进入，所以这条不变量由结构保证）。
   */
  const release = (entry: PendingRequest): void => {
    if (entry.released) return;
    entry.released = true;
    bump(userCount, entry.userId, -1);
    bump(deviceCount, entry.deviceId, -1);
    bump(connCount, entry.connectionId, -1);
  };

  /**
   * 唯一收口：置结果、摘表、归还计数、唤醒队列 waiter。
   *
   * 五件事必须在**同一次同步执行**里完成。中间有任何 `await`，「已 settle
   * 但仍占着计数」就会成为一个真实状态，而它最恶劣的形态是：请求早已超时返回
   * 给调用方，槽位却一直不还，直到断线才恢复——设备看起来「忙」了几分钟。
   */
  const finish = (entry: PendingRequest, result: DispatchResult): boolean => {
    if (entry.state === "settled") return false;
    const wasQueued = entry.state === "queued";
    entry.state = "settled";
    entry.result = result;
    entries.delete(entry.deliveryId);
    if (wasQueued) {
      const index = queue.indexOf(entry.deliveryId);
      if (index !== -1) queue.splice(index, 1);
    } else {
      // 排队项从未占用计数，所以只需要归还已发送的那些。
      release(entry);
    }
    // 每个未结算的请求都有一个等待者（admitted / queued 都在 reserve 里建）。
    waiters.get(entry.deliveryId)?.(result);
    waiters.delete(entry.deliveryId);
    settledIds.add(entry.deliveryId);
    // 不设上限会无限增长（一次长连接可以跑几十万次调用）。512 条足够覆盖
    // 「重复 res」与「断线后迟到 res」的窗口，也足够小。
    if (settledIds.size > 512) {
      const oldest = settledIds.values().next().value;
      if (oldest !== undefined) settledIds.delete(oldest);
    }
    return true;
  };

  const failure = (code: RemoteErrorCode, message: string): DispatchResult => ({
    ok: false,
    error: { code, message, retryable: isRetryableRemoteError(code) },
  });

  return {
    reserve(input) {
      const base: PendingRequest = {
        ...input,
        queuedAtMono: null,
        state: "sent",
        frameSent: false,
        result: null,
        released: false,
      };

      if (!hasCapacity(input) && queue.length >= queueMax) {
        // 队列满不是「稍后再试」——它说明设备已经严重积压，再排只会更糟。
        return { kind: "rejected", result: failure("DEVICE_BUSY", "gateway queue is full") };
      }

      // 无论 admitted 还是 queued 都建一个等待者：调用方只需要 `await promise`，
      // 不必区分自己走的是哪条路（区分了就会有人只处理其中一条）。
      const promise = new Promise<DispatchResult>((resolve) => {
        waiters.set(base.deliveryId, resolve);
      });

      if (hasCapacity(input)) {
        acquire(base);
        entries.set(base.deliveryId, base);
        return { kind: "admitted", entry: base, promise };
      }

      base.state = "queued";
      // 入队时刻必须来自调用方传入的 monotonic。用 `deadlineMono` 倒推是错的：
      // 那等于假设「入队恰好发生在 deadline 那一刻」，而排队预算（2s）与
      // 执行预算（15s）是两个完全不同的量。
      base.queuedAtMono = input.nowMono;
      entries.set(base.deliveryId, base);
      queue.push(base.deliveryId);
      return { kind: "queued", entry: base, promise };
    },

    markSent(entry) {
      if (entry.state !== "queued") return;
      entry.state = "sent";
      entry.queuedAtMono = null;
      acquire(entry);
    },

    settle(entry, result) {
      return finish(entry, result);
    },

    fail(entry, code, message) {
      return finish(entry, failure(code, message));
    },

    get(deliveryId) {
      const entry = entries.get(deliveryId);
      return entry && entry.state !== "settled" ? entry : undefined;
    },

    isSettled(deliveryId) {
      return settledIds.has(deliveryId);
    },

    sweep(nowMono) {
      const timedOut: PendingRequest[] = [];
      const queueExpired: PendingRequest[] = [];
      for (const entry of [...entries.values()]) {
        if (entry.state === "queued") {
          // 排队预算与 deadline 取先到者：排队超过 2s 就 DEVICE_BUSY，
          // 而不是让调用方一直等到 deadline（那时错误信息会指向「超时」，
          // 而真实原因是「设备忙」）。
          const waited = entry.queuedAtMono === null ? 0 : nowMono - entry.queuedAtMono;
          if (waited >= queueBudgetMs) {
            if (finish(entry, failure("DEVICE_BUSY", "gateway queue budget exceeded"))) {
              queueExpired.push(entry);
            }
            continue;
          }
          if (nowMono >= entry.deadlineMono) {
            if (finish(entry, failure("REQUEST_TIMEOUT", "request deadline has passed"))) {
              timedOut.push(entry);
            }
          }
          continue;
        }
        if (nowMono >= entry.deadlineMono) {
          if (finish(entry, failure("REQUEST_TIMEOUT", "request deadline has passed"))) {
            timedOut.push(entry);
          }
        }
      }
      return { timedOut, queueExpired };
    },

    promote() {
      const promoted: PendingRequest[] = [];
      // 逐条尝试：一个槽位释放可能只够放行一条（三层上限各自独立）。
      for (let index = 0; index < queue.length; ) {
        const deliveryId = queue[index];
        if (deliveryId === undefined) break;
        const entry = entries.get(deliveryId);
        if (!entry || entry.state !== "queued") {
          queue.splice(index, 1);
          continue;
        }
        // 队列项也可能在等待期间被 settle（断线 / grant 撤销），
        // `finish` 已经把它摘掉了；这里只是兜底跳过。
        if (!hasCapacity(entry)) {
          index += 1;
          continue;
        }
        queue.splice(index, 1);
        entry.state = "sent";
        entry.queuedAtMono = null;
        acquire(entry);
        promoted.push(entry);
      }
      return promoted;
    },

    onConnectionLost(connectionId) {
      const affected: PendingRequest[] = [];
      for (const entry of [...entries.values()]) {
        if (entry.connectionId !== connectionId) continue;
        if (finish(entry, failure("DEVICE_OFFLINE", "device connection was lost"))) {
          affected.push(entry);
        }
      }
      return affected;
    },

    rejectByGrantCtx(grantCtx, code, message) {
      const affected: PendingRequest[] = [];
      for (const entry of [...entries.values()]) {
        if (entry.grantCtx !== grantCtx) continue;
        if (finish(entry, failure(code, message))) affected.push(entry);
      }
      return affected;
    },

    rejectQueuedByConnection(connectionId, code, message) {
      const affected: PendingRequest[] = [];
      for (const entry of [...entries.values()]) {
        if (entry.connectionId !== connectionId) continue;
        // `queued` 是唯一判据：它等价于「req 还没有写出」。用 `frameSent`
        // 也行，但那是转发层的事实；这一层的语言是请求状态机。
        if (entry.state !== "queued") continue;
        if (finish(entry, failure(code, message))) affected.push(entry);
      }
      return affected;
    },

    rejectByConnection(connectionId, code, message) {
      const affected: PendingRequest[] = [];
      for (const entry of [...entries.values()]) {
        if (entry.connectionId !== connectionId) continue;
        if (finish(entry, failure(code, message))) affected.push(entry);
      }
      return affected;
    },

    counts() {
      let pending = 0;
      let queued = 0;
      for (const entry of entries.values()) {
        if (entry.state === "sent") pending += 1;
        else if (entry.state === "queued") queued += 1;
      }
      // 三个维度各自求和（不同条目可能共享 user / device / connection）。
      const sum = (map: Map<string, number>): number => {
        let total = 0;
        for (const value of map.values()) total += value;
        return total;
      };
      return {
        user: sum(userCount),
        device: sum(deviceCount),
        connection: sum(connCount),
        queued,
        pending,
      };
    },
  };
}

/** 供诊断/测试读取某个尚未完成的请求的最终结果。 */
export function resultOf(entry: PendingRequest): DispatchResult {
  return entry.result ?? EMPTY;
}
