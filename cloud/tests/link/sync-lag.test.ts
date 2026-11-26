import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/logger.js";
import {
  createMemoryConnectionRegistry,
  type ConnectionRegistry,
} from "../../src/link/connection-registry.js";
import { createForwarder, type Forwarder } from "../../src/link/forwarder.js";
import { gatewayResource } from "../../src/link/dispatch-guard.js";
import {
  createRequestRegistry,
  type PendingRequest,
  type RequestRegistry,
} from "../../src/link/request-registry.js";
import { REMOTE_GRANT_ACK_TIMEOUT_MS } from "../../src/link/schemas.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";import { createLinkHarness, type LinkHarness } from "../helpers/link-server.js";
import { okRes, seedDevice, seedUser, waitUntil } from "../helpers/forward.js";

/**
 * `syncLag` 作为**连接级发送闸门**（Phase 1.2B.2.2-R2）。
 *
 * ## 为什么这一组不用真 WebSocket
 *
 * 这里要证明的两件事都无法用真 socket **确定性地**构造：
 *
 * 1. **ack 超时**。生产值 3s、排队预算 2s，任何一次把时间推到 ack deadline 的
 *    `sweep()` 都会顺带把排队项按 `DEVICE_BUSY` 结算掉（2s < 3s）。于是
 *    「syncLag 之后队列怎么收敛」这条断言会被另一个合法行为抢先兑现——
 *    测试仍然是绿的，但它测的不是闸门。
 * 2. **帧写出失败**。真 socket 上「不可写」只发生在 close 前后，而 close 本身
 *    是异步事件；要把「写出失败但连接还在」稳定复现，只能在传输层注入。
 *
 * 所以这一组用**真实 PostgreSQL + 真实 Forwarder + 真实 RequestRegistry**，
 * 只把 `send` 换成可控实现。被替换掉的恰好是「传输」，而闸门在传输之前。
 * 真实 WSS 上的同类断言在 `grant-sync.test.ts` 的 R2 一节。
 */

let h: LinkHarness;
let userId: string;
let deviceId: string;
let resource: string;

/** 进程内单调时钟。测试自己推进它，不等真实时间。 */
let mono = 0;

beforeEach(async () => {
  resetRateLimiter();
  h = await createLinkHarness();
  userId = await seedUser(h);
  const device = await seedDevice(h, userId);
  deviceId = device.deviceId;
  resource = gatewayResource(h.ctx.env.baseUrl);
  mono = 0;
});

afterEach(async () => {
  await h.close();
});

type CapturedEvent = { level: string; msg: string; fields?: Record<string, unknown> };

function captureLogger(): { logger: Logger; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const push =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      events.push({ level, msg, fields });
    };
  return {
    logger: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") },
    events,
  };
}

/**
 * 一座「forwarder + 可控传输」的台子。
 *
 * `send` 的返回值就是协议里的「连接是否可写」：返回 false 等价于
 * `sendFrame` 失败。`failWhen` 决定哪些帧写不出去。
 */
function createRig(options: { ackTimeoutMs?: number; queueBudgetMs?: number } = {}) {
  const { logger, events } = captureLogger();
  const registry: ConnectionRegistry = createMemoryConnectionRegistry();
  /** 真正写出去了的帧（按序）。 */
  const outbound: Array<Record<string, unknown>> = [];
  let failWhen: ((frame: Record<string, unknown>) => boolean) | null = null;

  const send = (_connectionId: string, text: string): boolean => {
    const frame = JSON.parse(text) as Record<string, unknown>;
    if (failWhen && failWhen(frame)) return false;
    outbound.push(frame);
    return true;
  };

  const requests: RequestRegistry = createRequestRegistry({
    // 队列预算放大：本文件要观察「syncLag 会不会放行排队项」，
    // 不能让排队预算先把它结算成 DEVICE_BUSY。
    queueBudgetMs: options.queueBudgetMs ?? 60_000,
  });

  const forwarder: Forwarder = createForwarder({
    db: h.ctx.db.db,
    logger,
    resource,
    registry,
    send,
    requests,
    nowMono: () => mono,
    now: () => 1_000_000,
    ackTimeoutMs: options.ackTimeoutMs ?? REMOTE_GRANT_ACK_TIMEOUT_MS,
  });

  /** 绑定一条在线连接并安装快照。 */
  const connect = async (input: {
    connectionId: string;
    deviceId?: string;
    userId?: string;
    grants: Array<{ grantId: string; grantCtx: string; scopes?: string[]; epoch?: number }>;
  }) => {
    const connUserId = input.userId ?? userId;
    const connDeviceId = input.deviceId ?? deviceId;
    await registry.bind(
      {
        userId: connUserId,
        deviceId: connDeviceId,
        connectionId: input.connectionId,
        instanceId: "gw_test",
        serviceable: true,
      },
      0,
    );
    forwarder.onConnectionReady({
      connectionId: input.connectionId,
      userId: connUserId,
      deviceId: connDeviceId,
      grantEpoch: 1,
      grants: input.grants.map((grant) => ({
        grant_ctx: grant.grantCtx,
        grant_id: grant.grantId,
        client_id: "claude",
        client_name: "Claude",
        scopes: (grant.scopes ?? ["records:read"]) as never,
        bound_user_id: connUserId,
        epoch: grant.epoch ?? 1,
      })),
    });
  };

  return {
    forwarder,
    registry,
    requests,
    outbound,
    events,
    connect,
    /** 让符合条件的帧写不出去（只影响之后写出的帧）。 */
    failWrites(predicate: ((frame: Record<string, unknown>) => boolean) | null) {
      failWhen = predicate;
    },
    /** 手工登记一条请求（等价于派发路径里 `reserve()` 那一步）。 */
    reserve(input: {
      deliveryId: string;
      connectionId: string;
      grantId: string;
      grantCtx: string;
      deviceId?: string;
      userId?: string;
    }): ReturnType<RequestRegistry["reserve"]> {
      return requests.reserve({
        deliveryId: input.deliveryId,
        requestHash: "sha256:" + "0".repeat(64),
        userId: input.userId ?? userId,
        deviceId: input.deviceId ?? deviceId,
        connectionId: input.connectionId,
        tool: "search_records",
        arguments: {},
        grantId: input.grantId,
        grantCtx: input.grantCtx,
        deadlineMs: 1_000_000,
        deadlineMono: 100_000,
        nowMono: mono,
      });
    },
  };
}

const grantFrames = (outbound: Array<Record<string, unknown>>) =>
  outbound.filter((frame) => frame.type === "grant_update");

/**
 * 等到第 n 条 `grant_update` 真的写出。
 *
 * `installGrant` 内部要经过 `lookupByDevice`、设备串行链、以及一次真实的
 * `bumpGrantEpoch`（数据库 UPDATE），所以「调用之后立刻断言帧已写出」是不成立的。
 * 这里等的是一个**已经发生的事实**（帧进 `outbound`），不是时序运气：
 * 帧要么会写出，要么不会，条件一旦成立就不会再变。
 */
async function awaitGrantFrames(rig: { outbound: Array<Record<string, unknown>> }, count: number) {
  await waitUntil(() => grantFrames(rig.outbound).length >= count, `${count} grant_update frame(s)`);
}

describe("syncLag 之后：队列是连接级的", () => {
  it("ack 超时 → 排队项立刻以 GRANT_CONTEXT_INVALID 结算，且不再被 promote", async () => {
    const rig = createRig();
    await rig.connect({
      connectionId: "conn-1",
      grants: [{ grantId: "grant-b", grantCtx: "gc_b" }],
    });

    // 占满 2 个槽位，再排一条（用的是**另一条** grant 的 ctx 也无所谓——
    // 闸门是连接级的，这正是本阶段要证明的）。
    const first = rig.reserve({ deliveryId: "req_1", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    const second = rig.reserve({ deliveryId: "req_2", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    const third = rig.reserve({ deliveryId: "req_3", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    expect(first.kind).toBe("admitted");
    expect(second.kind).toBe("admitted");
    expect(third.kind).toBe("queued");

    // 新 grant 的 install：帧写出去了，但永远不回 ack。
    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-c", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);

    // 精确推到 ack deadline（不是真实等待）。queueBudget 60s > 3s，
    // 所以排队项不会被「排队预算」这条合法路径抢先结算——本用例要观察的
    // 正是「syncLag 会不会自己清掉队列」。
    mono = REMOTE_GRANT_ACK_TIMEOUT_MS + 1;
    rig.forwarder.sweep(mono);

    expect(await installing).toEqual({ ok: false, reason: "ack_timeout" });
    expect(rig.forwarder.inspect().connections[0]?.syncLag).toBe(true);
    expect(rig.forwarder.inspect().connections[0]?.syncLagCause).toBe("ack_timeout");

    // ★ 排队项在 syncLag 那一刻就结算了，没有等任何在途请求完成。
    const queuedEntry = (third as { entry: PendingRequest }).entry;
    expect(queuedEntry.state).toBe("settled");
    expect(queuedEntry.result).toMatchObject({
      ok: false,
      error: { code: "GRANT_CONTEXT_INVALID", retryable: false },
    });
    expect(queuedEntry.frameSent).toBe(false);
    // 排队项从未占计数，所以结算后三层计数仍然是 2（那两条在途）。
    expect(rig.requests.counts()).toMatchObject({ queued: 0, connection: 2, pending: 2 });

    // 后续 promote 不可能再放行它。
    expect(rig.requests.promote()).toHaveLength(0);
    expect(rig.requests.counts().queued).toBe(0);
  });

  it("applied=false → 闸门同样立刻结算排队项；已写出的请求保留既有生命周期", async () => {
    const rig = createRig();
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-b", grantCtx: "gc_b" }] });

    rig.reserve({ deliveryId: "req_1", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    rig.reserve({ deliveryId: "req_2", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    const third = rig.reserve({ deliveryId: "req_3", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });

    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-c", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);
    const frame = grantFrames(rig.outbound)[0] as Record<string, unknown>;

    // Desktop 明确拒绝。
    rig.forwarder.handleGrantAck("conn-1", {
      v: 1,
      type: "grant_update_ack",
      ts: 1,
      grant_epoch: frame.grant_epoch,
      applied: false,
      reason: "protocol_violation",
    });

    expect(await installing).toEqual({ ok: false, reason: "rejected" });
    expect(rig.forwarder.inspect().connections[0]?.syncLagCause).toBe("apply_rejected");
    expect((third as { entry: PendingRequest }).entry.result).toMatchObject({
      ok: false,
      error: { code: "GRANT_CONTEXT_INVALID" },
    });

    // 已写出的两条：`res` 仍然能完成它们（不因为队列修复而改写生命周期）。
    for (const id of ["req_1", "req_2"]) {
      rig.forwarder.handleRes("conn-1", okRes(id, { ok: true }));
    }
    expect(rig.requests.counts()).toMatchObject({ user: 0, device: 0, connection: 0, pending: 0, queued: 0 });
    // 两条 res 各触发一次 pump，但队列已空、连接已停路由：没有任何 req 写出。
    expect(rig.outbound.filter((item) => item.type === "req")).toHaveLength(0);
  });
});

describe("syncLag 之后的传输失败：不与 ack 超时混淆", () => {
  it("grant_update 写不出去 → offline、独立日志、排队项立即收敛、不被误发", async () => {
    const rig = createRig();
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-b", grantCtx: "gc_b" }] });

    rig.reserve({ deliveryId: "req_1", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    rig.reserve({ deliveryId: "req_2", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });
    const third = rig.reserve({ deliveryId: "req_3", connectionId: "conn-1", grantId: "grant-b", grantCtx: "gc_b" });

    // 只让 grant_update 写不出去：req 仍然可写，这样「排队项是否被误发」
    // 才有观测意义（否则所有帧都写不出去，断言会变成同义反复）。
    rig.failWrites((frame) => frame.type === "grant_update");

    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-c", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });

    expect(await installing).toEqual({ ok: false, reason: "offline" });
    const connection = rig.forwarder.inspect().connections[0];
    expect(connection?.syncLag).toBe(true);
    expect(connection?.syncLagCause).toBe("offline");
    expect(connection?.pendingAckEpoch).toBeNull();

    // 三类失败必须各自留下自己的事件：这里只允许 sync_offline。
    const names = rig.events.map((event) => event.msg);
    expect(names).toContain("link_grant_sync_offline");
    expect(names).not.toContain("link_grant_ack_timeout");
    expect(names).not.toContain("link_grant_apply_rejected");
    const lagEvent = rig.events.find((event) => event.msg === "link_grant_sync_lag_set");
    expect(lagEvent?.fields).toMatchObject({ cause: "offline", droppedQueued: 1 });

    // 排队项被立即结算，而不是留在一个不可写的连接上等槽位。
    const queuedEntry = (third as { entry: PendingRequest }).entry;
    expect(queuedEntry.state).toBe("settled");
    expect(queuedEntry.result).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });

    // 放行 req 写入，再完成两条在途：泵不得再写任何 req，计数也不重复释放。
    rig.failWrites(null);
    for (const id of ["req_1", "req_2"]) {
      rig.forwarder.handleRes("conn-1", okRes(id, { ok: true }));
    }
    expect(rig.outbound.filter((item) => item.type === "req")).toHaveLength(0);
    expect(rig.requests.counts()).toMatchObject({ user: 0, device: 0, connection: 0, pending: 0, queued: 0 });
  });

  it("连接收敛之后的迟到失败不会动新连接的状态", async () => {
    const rig = createRig({ ackTimeoutMs: 5_000 });
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-b", grantCtx: "gc_b" }] });

    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-c", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);

    // 连接在等 ack 期间收敛，随后同一个 device 用新 connectionId 重连。
    rig.forwarder.onConnectionClosed("conn-1");
    expect(await installing).toEqual({ ok: false, reason: "offline" });

    await rig.connect({ connectionId: "conn-2", grants: [{ grantId: "grant-b", grantCtx: "gc_b2" }] });
    const fresh = rig.forwarder.inspect().connections.find((item) => item.connectionId === "conn-2");
    expect(fresh?.syncLag).toBe(false);
    expect(fresh?.syncLagCause).toBeNull();
    // 旧连接已经不在表里：那条失败属于一段结束的历史。
    expect(rig.forwarder.inspect().connections).toHaveLength(1);
  });
});

describe("syncLag 的作用范围：只有那一条连接", () => {
  it("连接 A 进入 syncLag 不影响连接 B 的队列与派发", async () => {
    const rig = createRig();
    const otherUser = await seedUser(h, "Other");
    const otherDevice = await seedDevice(h, otherUser);

    await rig.connect({ connectionId: "conn-a", grants: [{ grantId: "grant-a", grantCtx: "gc_a" }] });
    await rig.connect({
      connectionId: "conn-b",
      deviceId: otherDevice.deviceId,
      userId: otherUser,
      grants: [{ grantId: "grant-b", grantCtx: "gc_b" }],
    });

    // A 上排一条；B 上也排一条（两条连接各自的上限 2，先各占 2 条才能排）。
    for (const id of ["a1", "a2"]) {
      rig.reserve({ deliveryId: id, connectionId: "conn-a", grantId: "grant-a", grantCtx: "gc_a" });
    }
    const aQueued = rig.reserve({ deliveryId: "a3", connectionId: "conn-a", grantId: "grant-a", grantCtx: "gc_a" });
    for (const id of ["b1", "b2"]) {
      rig.reserve({
        deliveryId: id,
        connectionId: "conn-b",
        grantId: "grant-b",
        grantCtx: "gc_b",
        deviceId: otherDevice.deviceId,
        userId: otherUser,
      });
    }
    const bQueued = rig.reserve({
      deliveryId: "b3",
      connectionId: "conn-b",
      grantId: "grant-b",
      grantCtx: "gc_b",
      deviceId: otherDevice.deviceId,
      userId: otherUser,
    });
    expect(aQueued.kind).toBe("queued");
    expect(bQueued.kind).toBe("queued");

    // 让 A 的连接进入 syncLag（applied=false）。
    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-x", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);
    const frame = grantFrames(rig.outbound)[0] as Record<string, unknown>;
    rig.forwarder.handleGrantAck("conn-a", {
      v: 1,
      type: "grant_update_ack",
      ts: 1,
      grant_epoch: frame.grant_epoch,
      applied: false,
      reason: "protocol_violation",
    });
    await installing;

    // A 的排队项被结算；B 的**没有**。
    expect((aQueued as { entry: PendingRequest }).entry.state).toBe("settled");
    expect((bQueued as { entry: PendingRequest }).entry.state).toBe("queued");
    expect(rig.requests.counts()).toMatchObject({ queued: 1, connection: 4 });

    // B 的槽位释放后，B 的排队项正常被 promote 并写出（闸门只拦 A）。
    rig.forwarder.handleRes("conn-b", okRes("b1", { ok: true }));
    const reqFramesOut = rig.outbound.filter((item) => item.type === "req");
    // `handleRes` 是同步的：`b3` 的 req 已经写出。
    expect(reqFramesOut.map((item) => item.id)).toEqual(["b3"]);
    expect((bQueued as { entry: PendingRequest }).entry.state).toBe("sent");
  });

  it("闸门兜底：syncLag 期间才入队的请求不会被 pump 写出去", async () => {
    // 这条路径真实存在：`dispatchToolCall` 的入口检查在前、`reserve()` 在后，
    // 两者之间要 await 两次查库。若 syncLag 恰好在那个窗口里被置起，请求仍然
    // 会登记进队列（而 eager 清理那一刻它还不存在）。派发自己的最终核对会拦下
    // 它，但闸门必须是独立成立的最后一道——否则任何一次「检查之后又多了一个
    // await」的改动都会重新打开这条缝。
    const rig = createRig();
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-a", grantCtx: "gc_a" }] });

    rig.reserve({ deliveryId: "req_1", connectionId: "conn-1", grantId: "grant-a", grantCtx: "gc_a" });
    rig.reserve({ deliveryId: "req_2", connectionId: "conn-1", grantId: "grant-a", grantCtx: "gc_a" });

    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-x", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);
    const frame = grantFrames(rig.outbound)[0] as Record<string, unknown>;
    rig.forwarder.handleGrantAck("conn-1", {
      v: 1,
      type: "grant_update_ack",
      ts: 1,
      grant_epoch: frame.grant_epoch,
      applied: false,
      reason: "protocol_violation",
    });
    await installing;
    expect(rig.forwarder.inspect().connections[0]?.syncLag).toBe(true);

    // 窗口内入队：此刻连接已经 syncLag，eager 清理早就跑过了。
    const late = rig.reserve({ deliveryId: "req_late", connectionId: "conn-1", grantId: "grant-a", grantCtx: "gc_a" });
    expect(late.kind).toBe("queued");

    // 在途请求完成 → 触发 pump。闸门必须拦下这条新入队的请求。
    rig.forwarder.handleRes("conn-1", okRes("req_1", { ok: true }));

    const lateEntry = (late as { entry: PendingRequest }).entry;
    expect(lateEntry.state).toBe("settled");
    expect(lateEntry.result).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
    expect(lateEntry.frameSent).toBe(false);
    expect(rig.outbound.filter((item) => item.type === "req")).toHaveLength(0);
    expect(rig.requests.counts()).toMatchObject({ queued: 0 });
  });

  it("同一个队列项不会二次结算、不会二次释放计数", async () => {
    const rig = createRig();
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-a", grantCtx: "gc_a" }] });

    rig.reserve({ deliveryId: "req_1", connectionId: "conn-1", grantId: "grant-a", grantCtx: "gc_a" });
    rig.reserve({ deliveryId: "req_2", connectionId: "conn-1", grantId: "grant-a", grantCtx: "gc_a" });
    const queued = rig.reserve({ deliveryId: "req_3", connectionId: "conn-1", grantId: "grant-a", grantCtx: "gc_a" });
    const entry = (queued as { entry: PendingRequest }).entry;

    // 第一次结算：syncLag 的队列拒绝。
    expect(rig.requests.fail(entry, "GRANT_CONTEXT_INVALID", "sync lag")).toBe(true);
    // 第二次（任何路径）：必须无效，且不得再动计数。
    expect(rig.requests.fail(entry, "DEVICE_OFFLINE", "again")).toBe(false);
    expect(rig.requests.settle(entry, { ok: true, data: 1, meta: { duration_ms: 1, cached: false } })).toBe(false);
    expect(entry.result).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
    // 排队项从未占计数：三层仍是那两条在途。
    expect(rig.requests.counts()).toMatchObject({ connection: 2, user: 2, device: 2, queued: 0, pending: 2 });

    // 被拒绝的队列项不会再次出现在 promote 里。
    expect(rig.requests.promote()).toHaveLength(0);
  });

  it("第二次失败不覆盖第一次的原因（先发生的那件事才是答案）", async () => {
    const rig = createRig();
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-a", grantCtx: "gc_a" }] });

    // 第一次：ack 超时（`sweep` 判定）。
    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-x", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);
    mono = REMOTE_GRANT_ACK_TIMEOUT_MS + 1;
    rig.forwarder.sweep(mono);
    expect(await installing).toEqual({ ok: false, reason: "ack_timeout" });
    expect(rig.forwarder.inspect().connections[0]?.syncLagCause).toBe("ack_timeout");

    // 第二次：撤销帧写不出去。结论是 `offline`，但**原因不该被改写**——
    // 那条 `offline` 是「一条已经不可信连接上的又一件坏事」，先发生的
    // ack 超时才是这条连接状态的定义。
    rig.failWrites((frame) => frame.type === "grant_update");
    const revoking = await rig.forwarder.revokeGrant({ deviceId, grantId: "grant-a", reason: "user_revoked" });
    expect(revoking).toEqual({ ok: false, reason: "offline" });
    expect(rig.forwarder.inspect().connections[0]?.syncLagCause).toBe("ack_timeout");
  });
});

describe("恢复：只有新的 hello_ok 快照", () => {
  it("旧连接上任何 ack / install / res 都不能清除 syncLag", async () => {
    const rig = createRig();
    await rig.connect({ connectionId: "conn-1", grants: [{ grantId: "grant-a", grantCtx: "gc_a" }] });

    const installing = rig.forwarder.installGrant({
      deviceId,
      grant: { grantId: "grant-c", clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    await awaitGrantFrames(rig, 1);
    const frame = grantFrames(rig.outbound)[0] as Record<string, unknown>;
    mono = REMOTE_GRANT_ACK_TIMEOUT_MS + 1;
    rig.forwarder.sweep(mono);
    expect(await installing).toEqual({ ok: false, reason: "ack_timeout" });

    // 迟到的 ack（epoch 更大、applied=true）不改变任何东西。
    rig.forwarder.handleGrantAck("conn-1", {
      v: 1,
      type: "grant_update_ack",
      ts: 1,
      grant_epoch: (frame.grant_epoch as number) + 5,
      applied: true,
      reason: "",
    });
    expect(rig.forwarder.inspect().connections[0]?.syncLag).toBe(true);

    // install 直接拒（不碰传输）。
    const before = rig.outbound.length;
    expect(
      await rig.forwarder.installGrant({
        deviceId,
        grant: { grantId: "grant-a", clientId: "claude", clientName: "Claude", scopes: ["records:read"], epoch: 1 },
      }),
    ).toEqual({ ok: false, reason: "sync_lag" });
    expect(rig.outbound).toHaveLength(before);

    // 派发在入口就被拒。
    const dispatched = await rig.forwarder.dispatchToolCall({
      userId,
      grantId: "grant-a",
      tool: "search_records",
      arguments: {},
    });
    expect(dispatched).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
    expect(rig.outbound.filter((item) => item.type === "req")).toHaveLength(0);
    expect(rig.requests.counts()).toMatchObject({ connection: 0, queued: 0 });

    // 新连接（新 connectionId）从快照恢复。
    rig.forwarder.onConnectionClosed("conn-1");
    await rig.connect({ connectionId: "conn-2", grants: [{ grantId: "grant-a", grantCtx: "gc_a2" }] });
    const fresh = rig.forwarder.inspect().connections.find((item) => item.connectionId === "conn-2");
    expect(fresh?.syncLag).toBe(false);
    expect(fresh?.syncLagCause).toBeNull();
  });
});
