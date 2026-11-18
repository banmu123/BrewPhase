import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices } from "../db/schema.js";
import type { Logger } from "../logger.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { admitDispatch, type DispatchRejection } from "./dispatch-guard.js";
import { computeRequestHash } from "./request-hash.js";
import {
  createRequestRegistry,
  type DispatchResult,
  type PendingRequest,
  type RequestRegistry,
} from "./request-registry.js";
import {
  filterScopes,
  grantUpdateAckSchema,
  REMOTE_GRANT_ACK_TIMEOUT_MS,
  REMOTE_HARD_DEADLINE_MS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TOOL_BUDGET_MS,
  resSchema,
  type CancelFrame,
  type GrantSnapshot,
  type GrantUpdateFrame,
  type ReqFrame,
  type RemoteErrorCode,
  type RemoteScope,
} from "./schemas.js";

/**
 * Cloud 的请求转发层（协议运行时 §6 / §7 / §8 / §6.5.2）。
 *
 * ## 它由四个互相独立的部分组成
 *
 * | 部分 | 职责 | 状态 |
 * |---|---|---|
 * | 准入 | 三身份 + grant + 设备 + token（`dispatch-guard.ts`） | 无（每次重读数据库） |
 * | 生命周期 | 排队 / 在途 / 超时 / 完成（`request-registry.ts`） | 有（pending 表 + 三层计数） |
 * | 授权同步 | `grant_update` 发送 + ack 等待 + `grant_sync_lag` | 有（每条连接一份） |
 * | 传输 | 帧的构造与写出 | 无（`send` 回调由 link-server 提供） |
 *
 * 拆开是为了让每一部分**能单独失败**。混在一个文件里时，「重连后计数器没清」
 * 与「ack 超时」看起来会是同一种 bug（请求莫名 DEVICE_BUSY），而它们的修法
 * 完全不同。
 *
 * ## 三条贯穿全文件的纪律
 *
 * 1. **每个 settle 只发生一次**（`request-registry` 的 `finish` 是唯一收口）；
 * 2. **每次 settle 之后都要 pump 队列**，否则一个超时的请求会永久占着一个
 *    槽位，直到断线——那是「设备看起来忙了几分钟」的全部成因；
 * 3. **connectionId 必须逐次核对**。旧连接的迟到 `res`、旧连接的 ack、
 *    旧连接的心跳，都不能影响新连接的任何状态。
 */

/** 一次派发的输入。`userId` 只能来自已验证的 JWT `sub`。 */
export interface DispatchToolCallInput {
  userId: string;
  grantId: string;
  tool: string;
  arguments: unknown;
  /** 调用方（未来的 MCP HTTP 层）的截止时间（epoch 毫秒）。**只能收紧**。 */
  clientDeadline?: number;
  /** 调用方取消（HTTP 断开）。排队中则不发；已发出则尽力 cancel。 */
  signal?: AbortSignal;
  trace?: { mcp_request_id?: string; received_at?: number };
}

export type GrantSyncOutcome =
  | { ok: true; grantCtx: string; epoch: number; delivered: boolean }
  | {
      ok: false;
      reason: "offline" | "sync_lag" | "ack_timeout" | "rejected" | "not_installed";
    };

export interface ForwarderInspect {
  connections: Array<{
    connectionId: string;
    userId: string;
    deviceId: string;
    grantEpoch: number;
    syncLag: boolean;
    pendingAckEpoch: number | null;
    grants: Array<{
      grantCtx: string;
      grantId: string;
      scopes: RemoteScope[];
      epoch: number;
      installed: boolean;
    }>;
  }>;
  counts: ReturnType<RequestRegistry["counts"]>;
}

export interface Forwarder {
  /** 握手完成、`hello_ok` 已发出：安装授权快照（它是同步屏障）。 */
  onConnectionReady(input: {
    connectionId: string;
    userId: string;
    deviceId: string;
    grantEpoch: number;
    grants: readonly GrantSnapshot[];
  }): void;
  /**
   * 凭据已轮换：这条连接从此不可派发，在途请求立刻以 `DEVICE_UNAUTHORIZED` 结束。
   *
   * 与 `onConnectionClosed` 分开：轮换后**还会**短暂地存在一条 socket（正在
   * 收 bye / close），那段窗口里必须给出「凭据作废」而不是「设备离线」。
   */
  onConnectionRotating(connectionId: string): void;
  /** 连接收敛：结算该连接上全部在途请求，清授权状态。 */
  onConnectionClosed(connectionId: string): void;
  /** 收到 `res`。畸形 / 未知 / 重复 / 旧连接一律忽略，绝不抛给调用方。 */
  handleRes(connectionId: string, raw: unknown): void;
  /** 收到 `grant_update_ack`。 */
  handleGrantAck(connectionId: string, raw: unknown): void;
  dispatchToolCall(input: DispatchToolCallInput): Promise<DispatchResult>;
  /** 把一条 grant 增量下发给在线设备，等 ack。 */
  installGrant(input: {
    deviceId: string;
    grant: { grantId: string; clientId: string; clientName: string; scopes: readonly string[]; epoch: number };
  }): Promise<GrantSyncOutcome>;
  /** 撤销一条 grant：**先停路由**，再发帧，再等 ack。 */
  revokeGrant(input: {
    deviceId: string;
    grantId: string;
    reason: string;
  }): Promise<GrantSyncOutcome>;
  /**
   * scope 变更：`revoke 旧 ctx → ack → install 新 ctx → ack`。
   *
   * 不能只改数据库就继续用旧 ctx 派发——Desktop 的缓存键是
   * `(grant_ctx, delivery_id)`，旧 ctx 下的结果会在新 scope 生效后被回放。
   */
  replaceGrant(input: {
    deviceId: string;
    grant: { grantId: string; clientId: string; clientName: string; scopes: readonly string[]; epoch: number };
    reason: string;
  }): Promise<GrantSyncOutcome>;
  /** 扫描：超时、排队预算、ack 超时。生产由定时器驱动，测试直接调。 */
  sweep(nowMono?: number): void;
  inspect(): ForwarderInspect;
  shutdown(): void;
}

export interface ForwarderDeps {
  db: Database;
  logger: Logger;
  /** `gatewayResource(env.baseUrl)`，用于 grant 的 resource 绑定校验。 */
  resource: string;
  registry: ConnectionRegistry;
  /** 写出一帧。返回 false 表示连接已不可写（已关闭 / 正在关闭）。 */
  send(connectionId: string, text: string): boolean;
  nowMono?: () => number;
  now?: () => number;
  requests?: RequestRegistry;
  ackTimeoutMs?: number;
  toolBudgetMs?: number;
  hardDeadlineMs?: number;
}

/** 一条连接的授权同步状态（**只在内存**，断线即丢）。 */
type GrantSlot = {
  grantCtx: string;
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: RemoteScope[];
  epoch: number;
  /**
   * 是否已被 Desktop 确认安装。
   *
   * `hello_ok` 装进来的是 `true`——`hello_ok` 本身是同步屏障（协议 §6.5.1：
   * Desktop 必须在处理下一条帧之前原子替换整张表）。而 `grant_update` 的
   * install 在收到 `applied:true` 之前必须是 `false`，否则「发了但没生效」
   * 会被当成「已经能用」。
   */
  installed: boolean;
};

/**
 * 一次 `grant_update` 等到的结论。
 *
 * **必须区分「对端说不行」与「对端没说话」**：前者是明确拒绝（Desktop 的
 * 上下文不合法），后者是超时/断线（我们不知道它有没有生效）。两种都要
 * 停路由，但只有前者说明「Cloud 与 Desktop 对协议的理解不一致」——那是
 * 需要告警的 bug，而超时多半是网络或设备卡住。
 */
type AckOutcome = "applied" | "rejected" | "timeout" | "offline";

type ConnSync = {
  connectionId: string;
  userId: string;
  deviceId: string;
  grantEpoch: number;
  byCtx: Map<string, GrantSlot>;
  byGrantId: Map<string, string>;
  syncLag: boolean;
  /**
   * 凭据已轮换、这条连接正在退场。
   *
   * 必须与 `closing` 分开记：`closing` 只说明「socket 要关了」，而这里要回答
   * 「为什么不能派发」——轮换后的答案是 `DEVICE_UNAUTHORIZED`（不可重试），
   * 而普通关闭是 `DEVICE_OFFLINE`。给错码会让调用方等一个永远不会来的重连。
   */
  rotating: boolean;
  pendingAck: { epoch: number; deadlineMono: number; resolve: (outcome: AckOutcome) => void } | null;
};

const fail = (code: RemoteErrorCode, message: string): DispatchResult => ({
  ok: false,
  error: { code, message, retryable: code === "DEVICE_OFFLINE" || code === "DEVICE_BUSY" || code === "REQUEST_TIMEOUT" || code === "INTERNAL_ERROR" },
});

const fromRejection = (rejection: DispatchRejection): DispatchResult => ({
  ok: false,
  error: { code: rejection.code, message: rejection.message, retryable: rejection.retryable },
});

function makeDeliveryId(): string {
  return `req_${randomBytes(6).toString("hex")}`;
}

export function createForwarder(deps: ForwarderDeps): Forwarder {
  const nowMono = deps.nowMono ?? (() => performance.now());
  const now = deps.now ?? (() => Date.now());
  const ackTimeoutMs = deps.ackTimeoutMs ?? REMOTE_GRANT_ACK_TIMEOUT_MS;
  const toolBudgetMs = deps.toolBudgetMs ?? REMOTE_TOOL_BUDGET_MS;
  const hardDeadlineMs = deps.hardDeadlineMs ?? REMOTE_HARD_DEADLINE_MS;
  const requests = deps.requests ?? createRequestRegistry();
  const logger = deps.logger;

  const conns = new Map<string, ConnSync>();
  /** 每台设备的授权变更串行链（保证「epoch 顺序」与「帧顺序」一致）。 */
  const chains = new Map<string, Promise<unknown>>();
  let shuttingDown = false;

  // MARK: - 帧构造与写出

  const sendFrame = (connectionId: string, frame: unknown): boolean => {
    if (shuttingDown) return false;
    try {
      return deps.send(connectionId, JSON.stringify(frame));
    } catch {
      // `send` 抛错只说明这条连接已经不可用；它不该把一次派发变成 500。
      return false;
    }
  };

  const buildReqFrame = (entry: PendingRequest): ReqFrame => {
    const frame: ReqFrame = {
      v: REMOTE_PROTOCOL_VERSION,
      type: "req",
      id: entry.deliveryId,
      ts: now(),
      tool: entry.tool,
      arguments: entry.arguments,
      request_hash: entry.requestHash,
      deadline_ms: entry.deadlineMs,
      grant_ctx: entry.grantCtx,
    };
    return frame;
  };

  // MARK: - 队列泵

  /**
   * 把能发的排队项发出去。
   *
   * **每次 settle 之后都要调用**。漏掉一处，那条请求释放出来的槽位就只能等
   * 下一次「别的请求完成」才会被用到——而如果刚好没有别的请求，队列会一直
   * 停在那里直到排队预算超时。
   */
  const pump = (): void => {
    for (const entry of requests.promote()) sendEntry(entry);
  };

  const sendEntry = (entry: PendingRequest): void => {
    if (!sendFrame(entry.connectionId, buildReqFrame(entry))) {
      requests.fail(entry, "DEVICE_OFFLINE", "device connection is gone");
      // 这条失败也会释放槽位，继续泵。
      pump();
    }
  };

  // MARK: - 连接生命周期

  const onConnectionReady: Forwarder["onConnectionReady"] = (input) => {
    const byCtx = new Map<string, GrantSlot>();
    const byGrantId = new Map<string, string>();
    for (const grant of input.grants) {
      byCtx.set(grant.grant_ctx, {
        grantCtx: grant.grant_ctx,
        grantId: grant.grant_id,
        clientId: grant.client_id,
        clientName: grant.client_name,
        scopes: grant.scopes,
        epoch: grant.epoch,
        installed: true,
      });
      byGrantId.set(grant.grant_id, grant.grant_ctx);
    }
    conns.set(input.connectionId, {
      connectionId: input.connectionId,
      userId: input.userId,
      deviceId: input.deviceId,
      grantEpoch: input.grantEpoch,
      byCtx,
      byGrantId,
      syncLag: false,
      rotating: false,
      pendingAck: null,
    });
  };

  const onConnectionRotating: Forwarder["onConnectionRotating"] = (connectionId) => {
    const conn = conns.get(connectionId);
    if (conn) conn.rotating = true;
    const affected = requests.rejectByConnection(
      connectionId,
      "DEVICE_UNAUTHORIZED",
      "device credentials were rotated",
    );
    if (affected.length > 0) {
      logger.info("link_requests_dropped_on_rotate", { connectionId, count: affected.length });
    }
    pump();
  };

  const onConnectionClosed: Forwarder["onConnectionClosed"] = (connectionId) => {
    const conn = conns.get(connectionId);
    if (conn) {
      // 挂着 ack 的连接断了：等下去没有意义，直接以「未确认」结束，
      // 让调用方（grant 管理层）看到 ack_timeout 而不是永远悬挂。
      conn.pendingAck?.resolve("offline");
      conn.pendingAck = null;
      conns.delete(connectionId);
    }
    const affected = requests.onConnectionLost(connectionId);
    if (affected.length > 0) {
      logger.info("link_requests_dropped_on_disconnect", { connectionId, count: affected.length });
    }
    pump();
  };

  // MARK: - 入站帧

  const handleRes: Forwarder["handleRes"] = (connectionId, raw) => {
    const parsed = resSchema.safeParse(raw);
    if (!parsed.success) {
      // 畸形 res **不能**透传给调用方（协议 §6.3 的最后一条）：那会把
      // 一段来路不明的 JSON 当成工具执行结果。丢弃 + 记安全事件。
      logger.warn("link_malformed_res", {
        connectionId,
        detail: parsed.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const frame = parsed.data;

    const entry = requests.get(frame.id);
    if (!entry) {
      // 「已结算」与「未知 id」都忽略，但日志级别不同——把两者混在一起，
      // 「Cloud 在等一个永远不会来的 res」这类故障就永远看不到。
      if (requests.isSettled(frame.id)) {
        logger.debug("link_duplicate_res", { deliveryId: frame.id });
      } else {
        logger.warn("link_unknown_res", { connectionId, deliveryId: frame.id });
      }
      return;
    }
    // **迟到 res 不得污染新连接**。连接被顶替/重连后，同一个 delivery_id
    // 可能被新连接上的一次新请求复用，而旧连接的 res 此刻才到。
    if (entry.connectionId !== connectionId) {
      logger.warn("link_res_from_other_connection", {
        deliveryId: frame.id,
        expected: entry.connectionId,
        actual: connectionId,
      });
      return;
    }

    const result: DispatchResult = frame.ok
      ? { ok: true, data: frame.data, meta: frame.meta }
      : { ok: false, error: frame.error ?? { code: "INTERNAL_ERROR", message: "unknown", retryable: false } };

    if (!requests.settle(entry, result)) return;
    logger.info("link_request_completed", {
      deliveryId: entry.deliveryId,
      tool: entry.tool,
      ok: result.ok,
      durationMs: result.ok ? result.meta.duration_ms : undefined,
      errorCode: result.ok ? undefined : result.error.code,
    });
    pump();
  };

  const handleGrantAck: Forwarder["handleGrantAck"] = (connectionId, raw) => {
    const parsed = grantUpdateAckSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("link_malformed_grant_ack", {
        connectionId,
        detail: parsed.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const conn = conns.get(connectionId);
    if (!conn) return;
    const pending = conn.pendingAck;
    if (!pending) {
      // 未知 / 重复 ack：不改任何状态。改了就相当于让一条迟到帧改写当前授权。
      logger.debug("link_stale_grant_ack", { connectionId, epoch: parsed.data.grant_epoch });
      return;
    }
    if (parsed.data.grant_epoch !== pending.epoch) {
      logger.debug("link_mismatched_grant_ack", {
        connectionId,
        expected: pending.epoch,
        actual: parsed.data.grant_epoch,
      });
      return;
    }
    conn.pendingAck = null;
    pending.resolve(parsed.data.applied ? "applied" : "rejected");
  };

  // MARK: - 授权同步

  /**
   * 设备级 epoch 的持久化递增。
   *
   * 用 `UPDATE ... RETURNING` 而不是「读出来 + 1 再写」：后者在并发下会让两个
   * 更新拿到同一个 epoch，而 Desktop 对 `<= 当前` 的帧一律丢弃——于是第二条
   * 更新静默消失，Cloud 却以为它生效了。
   *
   * 进程重启后从数据库继续递增（它不是一个内存计数器），所以「重启回到 0」
   * 这类问题结构上不存在。
   */
  async function bumpGrantEpoch(deviceId: string): Promise<number> {
    const rows = await deps.db
      .update(mcpDevices)
      .set({ grantEpoch: sql`${mcpDevices.grantEpoch} + 1` })
      .where(eq(mcpDevices.id, deviceId))
      .returning({ epoch: mcpDevices.grantEpoch });
    const epoch = rows[0]?.epoch;
    if (epoch === undefined) throw new Error("device not found while bumping grant_epoch");
    return epoch;
  }

  /**
   * 每台设备的串行链。
   *
   * 为什么必须有：`bumpGrantEpoch` 保证 epoch 唯一，但**不保证帧顺序**。
   * 两个并发更新可能拿到 8 和 9，却以 9→8 的顺序写出，于是 Desktop 丢弃 8
   * （`<= 当前` 即丢），Cloud 却收到了 8 的 ack 之外什么都没发生。
   * 串行化让「取 epoch」与「写帧」在同一个临界段里。
   */
  function serialize<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(deviceId) ?? Promise.resolve();
    // 链上只关心「什么时候轮到我」，不关心上一步成功与否——一步失败不该
    // 让后续更新永久排队。所以用 `then(task, task)` 而不是 `then(task)`。
    const run = previous.then(task, task);
    // 存进表里的必须是**与 run 同生命周期、且永不拒绝**的那个 promise：
    // 存 `run` 本身会让一次失败在链上留下一个 rejected promise，
    // 而下一次 `previous.then(task, task)` 仍能跑（两个回调都给），所以
    // 它不会阻塞——但 `void run.finally()` 会产生未处理的拒绝。
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(deviceId, guard);
    // 清理只在「我仍是链尾」时做：否则会把后来者的任务抹掉，
    // 而那正是「两次更新互相覆盖」的入口。
    void guard.then(() => {
      if (chains.get(deviceId) === guard) chains.delete(deviceId);
    });
    return run;
  }

  /** 发一帧 `grant_update` 并等 ack。返回结论（不是一个布尔）。 */
  async function sendGrantUpdateAndAwait(
    conn: ConnSync,
    frame: GrantUpdateFrame,
  ): Promise<AckOutcome> {
    // 同一时刻只允许一个未完成 ack：第二条更新必须等第一条落定，
    // 否则「applied=false 标记 syncLag」与「新 install」会互相覆盖。
    if (conn.pendingAck) {
      conn.pendingAck.resolve("offline");
      conn.pendingAck = null;
    }
    const epoch = frame.grant_epoch;
    const outcome = await new Promise<AckOutcome>((resolve) => {
      conn.pendingAck = {
        epoch,
        deadlineMono: nowMono() + ackTimeoutMs,
        resolve: (result) => {
          if (result === "rejected") {
            // `applied=false` 是**明确失败**（协议 §6.5.2 规则 4）：记安全事件
            // 并停止路由该设备的全部 grant。它不是「稍后重试」。
            logger.warn("link_grant_apply_rejected", {
              connectionId: conn.connectionId,
              epoch,
              op: frame.op,
            });
            conn.syncLag = true;
          }
          resolve(result);
        },
      };
      if (!sendFrame(conn.connectionId, frame)) {
        conn.pendingAck = null;
        resolve("offline");
      }
    });
    conn.grantEpoch = Math.max(conn.grantEpoch, epoch);
    return outcome;
  }

  /**
   * 把一条已安装的 grant 从当前连接上卸下（**停路由 → 结束在途 → 发 revoke → 等 ack**）。
   *
   * 顺序不可交换：先发帧的话，从「帧已写出」到「本地标记为不可路由」之间
   * 有一个窗口，期间新的派发仍会带着这条已经被撤销的 ctx 出去。
   */
  async function revokeInstalled(
    conn: ConnSync,
    grantId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_installed" | "ack_timeout" | "rejected" }> {
    const grantCtx = conn.byGrantId.get(grantId);
    if (!grantCtx) return { ok: false, reason: "not_installed" };

    conn.byGrantId.delete(grantId);
    conn.byCtx.delete(grantCtx);
    // 该 ctx 上正在等结果的请求也必须结束——否则撤销之后调用方仍会
    // 拿到撤销之前读到的数据。
    const rejected = requests.rejectByGrantCtx(grantCtx, "GRANT_REVOKED", "this grant has been revoked");
    if (rejected.length > 0) {
      logger.info("link_requests_dropped_on_revoke", {
        deviceId: conn.deviceId.slice(0, 8),
        count: rejected.length,
      });
    }

    const epoch = await bumpGrantEpoch(conn.deviceId);
    const outcome = await sendGrantUpdateAndAwait(conn, {
      v: REMOTE_PROTOCOL_VERSION,
      type: "grant_update",
      ts: now(),
      grant_epoch: epoch,
      op: "revoke",
      grant_ctx: grantCtx,
      reason,
    });
    pump();
    if (outcome !== "applied") {
      // 三种失败都收敛到 syncLag：超时/断线时我们**不知道**撤销有没有生效，
      // 而「不知道」在授权语义里等于「可能没生效」，所以必须停路由。
      // （`rejected` 已经在 sendGrantUpdateAndAwait 里置过了。）
      conn.syncLag = true;
      return { ok: false, reason: outcome === "rejected" ? "rejected" : "ack_timeout" };
    }
    return { ok: true };
  }

  const installGrant: Forwarder["installGrant"] = async (input) => {
    const conn = await lookupConnByDevice(input.deviceId);
    if (!conn) return { ok: false, reason: "offline" };
    if (conn.syncLag) return { ok: false, reason: "sync_lag" };

    return await serialize(input.deviceId, async () => {
      // 串行段内重新检查：上一步可能刚好把 syncLag 置起。
      if (conn.syncLag || !conns.has(conn.connectionId)) {
        return { ok: false as const, reason: conn.syncLag ? ("sync_lag" as const) : ("offline" as const) };
      }
      // 同一条 grant 再装一次 → 必须先卸掉旧 ctx。
      //
      // 不卸的话，Desktop 的上下文表里会**同时**存在两个 ctx 指向同一
      // grant_id，而旧 ctx 的缓存与 scope 都不再反映当前授权。这个分支在
      // 正常流程里不会走到（Phase 1.3 的 scope 变更走 `replaceGrant`），
      // 但它是「重复 install」这条路径上唯一正确的行为。
      if (conn.byGrantId.has(input.grant.grantId)) {
        logger.warn("link_grant_reinstalled", {
          deviceId: input.deviceId.slice(0, 8),
          grantId: input.grant.grantId,
        });
        const removed = await revokeInstalled(conn, input.grant.grantId, "scope_changed");
        if (!removed.ok && removed.reason === "ack_timeout") {
          return { ok: false as const, reason: "ack_timeout" as const };
        }
      }

      const epoch = await bumpGrantEpoch(input.deviceId);
      const grantCtx = `gc_${randomBytes(12).toString("hex")}`;
      const scopes = filterScopes(input.grant.scopes);
      const snapshot: GrantSnapshot = {
        grant_ctx: grantCtx,
        grant_id: input.grant.grantId,
        client_id: input.grant.clientId,
        client_name: input.grant.clientName,
        scopes,
        bound_user_id: conn.userId,
        epoch: input.grant.epoch,
      };
      const slot: GrantSlot = {
        grantCtx,
        grantId: input.grant.grantId,
        clientId: input.grant.clientId,
        clientName: input.grant.clientName,
        scopes,
        epoch: input.grant.epoch,
        installed: false,
      };
      // 先登记（installed=false）再发帧：登记之后它才可以被 `revoke` 找到，
      // 而 `installed=false` 保证「未 ack 不可路由」。
      conn.byCtx.set(grantCtx, slot);
      conn.byGrantId.set(input.grant.grantId, grantCtx);

      const outcome = await sendGrantUpdateAndAwait(conn, {
        v: REMOTE_PROTOCOL_VERSION,
        type: "grant_update",
        ts: now(),
        grant_epoch: epoch,
        op: "install",
        grant: snapshot,
      });
      if (outcome !== "applied") {
        // 未确认 → 不可路由。保留 slot 但 installed 仍是 false，`dispatch` 会拒。
        if (outcome === "offline") return { ok: false as const, reason: "offline" as const };
        return { ok: false as const, reason: outcome === "rejected" ? ("rejected" as const) : ("ack_timeout" as const) };
      }
      slot.installed = true;
      return { ok: true as const, grantCtx, epoch, delivered: true };
    });
  };

  const revokeGrant: Forwarder["revokeGrant"] = async (input) => {
    const conn = await lookupConnByDevice(input.deviceId);
    if (!conn) {
      // 设备离线：没有上下文要撤。**不伪造一条在线状态**，也不抛错。
      return { ok: false, reason: "offline" };
    }

    return await serialize(input.deviceId, async () => {
      const grantCtx = conn.byGrantId.get(input.grantId);
      if (!grantCtx) {
        // 这条 grant 从没装到这台设备上（例如它是在别的设备上授权的）。
        return { ok: false as const, reason: "not_installed" as const };
      }
      const removed = await revokeInstalled(conn, input.grantId, input.reason);
      if (!removed.ok) return { ok: false as const, reason: removed.reason };
      // 返回撤销用的那个 ctx（调用方可能要用它来对账）。
      return { ok: true as const, grantCtx, epoch: conn.grantEpoch, delivered: true };
    });
  };

  const replaceGrant: Forwarder["replaceGrant"] = async (input) => {
    // revoke 与 install 各自已经在设备串行链上，这里不能再串一次（会自锁）。
    const revoked = await revokeGrant({
      deviceId: input.deviceId,
      grantId: input.grant.grantId,
      reason: input.reason,
    });
    // 离线设备：没有旧 ctx 要撤，但也不需要安装（等它重连时走 hello_ok 快照）。
    if (!revoked.ok && revoked.reason !== "not_installed" && revoked.reason !== "offline") {
      return revoked;
    }
    const installed = await installGrant({ deviceId: input.deviceId, grant: input.grant });
    return installed;
  };

  async function lookupConnByDevice(deviceId: string): Promise<ConnSync | null> {
    const info = await deps.registry.lookupByDevice(deviceId);
    if (!info) return null;
    // rotating 的连接不能做任何授权同步——它马上要被关掉，帧发出去也没有意义。
    if (info.rotating) return null;
    const conn = conns.get(info.connectionId);
    if (!conn) return null;
    return conn;
  }

  // MARK: - 派发

  const dispatchToolCall: Forwarder["dispatchToolCall"] = async (input) => {
    if (shuttingDown) return fail("DEVICE_OFFLINE", "gateway is shutting down");

    // ---- 1. 目标连接：这个用户当前有没有活跃连接 ----
    const connection = await deps.registry.lookupByUser(input.userId);
    if (!connection) {
      // 轮换之后路由项被删掉了（`rotateConnection` 里 unbind），所以
      // `lookupByUser` 也会返回 null。这里必须把它与「设备真的离线」分开：
      // 前者的正确答复是 `DEVICE_UNAUTHORIZED`（凭据作废，不要重试），
      // 后者是 `DEVICE_OFFLINE`（可重试）。
      const rotating = [...conns.values()].some(
        (candidate) => candidate.userId === input.userId && candidate.rotating,
      );
      if (rotating) return fail("DEVICE_UNAUTHORIZED", "device credentials were rotated");
      return fail("DEVICE_OFFLINE", "no active device connection for this user");
    }

    const conn = conns.get(connection.connectionId);
    if (!conn) {
      // 连接在 registry 里但状态还没装好：只可能发生在 hello_ok 写出与
      // `onConnectionReady` 之间的极短窗口。宁可让调用方重试，也不猜。
      return fail("DEVICE_OFFLINE", "device connection is not ready");
    }

    // ---- 2. 授权同步异常：整台设备停止路由（fail-closed）----
    if (conn.syncLag) {
      return fail("GRANT_CONTEXT_INVALID", "grant state is not synchronized with the device");
    }

    // ---- 3. 数据库准入：三身份、grant、设备、token ----
    const admission = await admitDispatch(deps.db, {
      userId: input.userId,
      grantId: input.grantId,
      tool: input.tool,
      expectedResource: deps.resource,
      connection,
      now: new Date(now()),
    });
    if (!admission.ok) {
      logger.info("link_dispatch_rejected", {
        userId: input.userId.slice(0, 8),
        grantId: input.grantId,
        tool: input.tool,
        code: admission.rejection.code,
        security: admission.rejection.security,
      });
      return fromRejection(admission.rejection);
    }

    // ---- 4. grant ctx 必须由 Cloud 自己映射，不接受调用方给 ----
    const grantCtx = conn.byGrantId.get(input.grantId);
    const slot = grantCtx ? conn.byCtx.get(grantCtx) : undefined;
    if (!grantCtx || !slot) {
      return fail("GRANT_CONTEXT_INVALID", "grant is not installed on this connection");
    }
    if (!slot.installed) {
      // install 已发出但 Desktop 还没确认。**不能**先发请求赌它已经生效。
      return fail("GRANT_CONTEXT_INVALID", "grant installation is not confirmed yet");
    }
    // 单 grant 的 epoch 也要对得上：scope 变更时它会 +1，
    // 而旧 ctx 在那之后就不该再被派发（即使它还没被 revoke 掉）。
    if (slot.epoch !== admission.grant.epoch) {
      return fail("GRANT_CONTEXT_INVALID", "grant context is stale");
    }

    // ---- 5. 最后一次连接核对（把 check→send 的窗口压到一行）----
    const stillCurrent = await deps.registry.lookup(input.userId, connection.deviceId);
    if (!stillCurrent || stillCurrent.connectionId !== connection.connectionId) {
      // 顶替 / 断线 / rotating：三种都收敛到「这条连接已经不是路由目标」。
      return fail(
        stillCurrent === null ? "DEVICE_OFFLINE" : "DEVICE_UNAUTHORIZED",
        "device connection changed",
      );
    }

    // ---- 6. 预算 ----
    const nowMs = now();
    const deadlineMs = computeDeadline({
      nowMs,
      clientDeadline: input.clientDeadline,
      toolBudgetMs,
      hardDeadlineMs,
    });
    const deadlineMono = nowMono() + (deadlineMs - nowMs);

    const requestHash = computeRequestHash({
      v: REMOTE_PROTOCOL_VERSION,
      tool: input.tool,
      arguments: input.arguments,
    });

    const reserved = requests.reserve({
      deliveryId: makeDeliveryId(),
      requestHash,
      userId: input.userId,
      deviceId: connection.deviceId,
      connectionId: connection.connectionId,
      tool: input.tool,
      grantId: input.grantId,
      grantCtx,
      deadlineMs,
      deadlineMono,
      nowMono: nowMono(),
      arguments: input.arguments,
    });

    if (reserved.kind === "rejected") return reserved.result;

    const entry = reserved.entry;
    const promise = reserved.promise;

    // ---- 7. 调用方取消 ----
    const onAbort = (): void => {
      if (entry.state === "settled") return;
      const wasSent = entry.state === "sent";
      if (requests.fail(entry, "REQUEST_CANCELLED", "client cancelled the request")) {
        if (wasSent) {
          // 执行中的同步 handler 无法被中断（协议 §7.3），但我们仍要尽力告知：
          // Desktop 会丢掉 late res，Cloud 这边已经按取消返回给调用方。
          const cancel: CancelFrame = {
            v: REMOTE_PROTOCOL_VERSION,
            type: "cancel",
            id: entry.deliveryId,
            ts: now(),
            reason: "client_cancelled",
          };
          sendFrame(entry.connectionId, cancel);
        }
        pump();
      }
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (reserved.kind === "admitted") sendEntry(entry);

    const result = await promise;
    input.signal?.removeEventListener("abort", onAbort);
    return result;
  };

  // MARK: - 扫描

  const sweep: Forwarder["sweep"] = (at) => {
    const mono = at ?? nowMono();
    const outcome = requests.sweep(mono);
    for (const entry of outcome.timedOut) {
      // Cloud 已超时返回；`cancel` 只是尽力让 Desktop 别白做一次查询。
      // 注意：**只对已经发出 `req` 的发 cancel**——排队项从没离开过 Cloud。
      const cancel: CancelFrame = {
        v: REMOTE_PROTOCOL_VERSION,
        type: "cancel",
        id: entry.deliveryId,
        ts: now(),
        reason: "gateway_timeout",
      };
      sendFrame(entry.connectionId, cancel);
      logger.info("link_request_timeout", { deliveryId: entry.deliveryId, tool: entry.tool });
    }
    for (const entry of outcome.queueExpired) {
      // 排队项没发出去，不发 cancel（Desktop 从未见过这个 id）。
      logger.info("link_request_queue_expired", { deliveryId: entry.deliveryId, tool: entry.tool });
    }

    // ack 超时：这是本文件里**后果最重**的一条收敛路径。
    for (const conn of [...conns.values()]) {
      const pending = conn.pendingAck;
      if (!pending) continue;
      if (mono < pending.deadlineMono) continue;
      conn.pendingAck = null;
      conn.syncLag = true;
      logger.warn("link_grant_ack_timeout", {
        connectionId: conn.connectionId,
        epoch: pending.epoch,
      });
      pending.resolve("timeout");
    }

    if (outcome.timedOut.length > 0 || outcome.queueExpired.length > 0) pump();
  };

  // MARK: - 诊断

  const inspect: Forwarder["inspect"] = () => ({
    connections: [...conns.values()].map((conn) => ({
      connectionId: conn.connectionId,
      userId: conn.userId,
      deviceId: conn.deviceId,
      grantEpoch: conn.grantEpoch,
      syncLag: conn.syncLag,
      pendingAckEpoch: conn.pendingAck?.epoch ?? null,
      grants: [...conn.byCtx.values()].map((slot) => ({
        grantCtx: slot.grantCtx,
        grantId: slot.grantId,
        scopes: slot.scopes,
        // 单 grant 的 epoch（与连接级 `grantEpoch` 是两个字段）。
        epoch: slot.epoch,
        installed: slot.installed,
      })),
    })),
    counts: requests.counts(),
  });

  return {
    onConnectionReady,
    onConnectionRotating,
    onConnectionClosed,
    handleRes,
    handleGrantAck,
    dispatchToolCall,
    installGrant,
    revokeGrant,
    replaceGrant,
    sweep,
    inspect,
    shutdown() {
      shuttingDown = true;
      // 停机：所有在途请求以 DEVICE_OFFLINE 结束，别让调用方等到超时。
      for (const conn of [...conns.values()]) {
        requests.onConnectionLost(conn.connectionId);
      }
      conns.clear();
    },
  };
}

/**
 * 预算计算（协议运行时 §7.2）。
 *
 * ```
 * deadline_ms = min(now + toolBudget, now + 30_000, clientDeadline)
 * ```
 *
 * `clientDeadline` 只能**收紧**：调用方（未来的 MCP HTTP 层）给一个更早的
 * 截止时间是合理的（它的客户端在等），但给一个更晚的绝不意味着 Cloud 应该
 * 多等——那会让 Desktop 在一个早已没人等的请求上继续查库。
 */
export function computeDeadline(input: {
  nowMs: number;
  clientDeadline?: number;
  toolBudgetMs?: number;
  hardDeadlineMs?: number;
}): number {
  const toolBudget = input.toolBudgetMs ?? REMOTE_TOOL_BUDGET_MS;
  const hardCap = input.hardDeadlineMs ?? REMOTE_HARD_DEADLINE_MS;
  const budgeted = Math.min(input.nowMs + toolBudget, input.nowMs + hardCap);
  if (input.clientDeadline === undefined) return budgeted;
  return Math.min(budgeted, input.clientDeadline);
}
