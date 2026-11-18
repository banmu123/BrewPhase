import { describe, expect, it } from "vitest";
import {
  createRequestRegistry,
  type PendingRequest,
  type RequestRegistry,
} from "../../src/link/request-registry.js";

/**
 * 在途请求状态机的纯单元测试（不碰数据库、不碰 socket、不等真实时间）。
 *
 * ## 为什么这一组必须有
 *
 * 「槽位没还」这类 bug 的表现是**延迟**的：请求 A 超时了，但计数器没降，
 * 于是接下来的三条请求全部 `DEVICE_BUSY`，几分钟后偶发恢复。它不会被
 * 端到端测试稳定抓住（取决于时序），但如果计数逻辑本身被测死，它就不可能存在。
 *
 * 这里的时间是一个整数：`registry.sweep(now)`。没有 `sleep`，没有 `setTimeout`。
 */

let counter = 0;

function reserve(
  registry: RequestRegistry,
  overrides: Partial<Parameters<RequestRegistry["reserve"]>[0]> = {},
): ReturnType<RequestRegistry["reserve"]> {
  counter += 1;
  return registry.reserve({
    deliveryId: `req_${counter}`,
    requestHash: "sha256:" + "0".repeat(64),
    userId: "user-1",
    deviceId: "device-1",
    connectionId: "conn-1",
    tool: "search_records",
    arguments: {},
    grantId: "grant-1",
    grantCtx: "gc_1",
    deadlineMs: 100_000,
    deadlineMono: 15_000,
    nowMono: 0,
    ...overrides,
  });
}

describe("三层在途计数", () => {
  it("admitted 之后计数上升，settle 之后归零", () => {
    const registry = createRequestRegistry();
    const reserved = reserve(registry);
    expect(reserved.kind).toBe("admitted");
    expect(registry.counts()).toMatchObject({ user: 1, device: 1, connection: 1, pending: 1, queued: 0 });

    const entry = (reserved as { entry: PendingRequest }).entry;
    expect(registry.settle(entry, { ok: true, data: 1, meta: { duration_ms: 1, cached: false } })).toBe(true);
    expect(registry.counts()).toMatchObject({ user: 0, device: 0, connection: 0, pending: 0 });
  });

  it("第二条占满连接上限后，第三条进入队列（不是立即失败）", () => {
    const registry = createRequestRegistry();
    expect(reserve(registry).kind).toBe("admitted");
    expect(reserve(registry).kind).toBe("admitted");
    const third = reserve(registry);
    expect(third.kind).toBe("queued");
    expect(registry.counts()).toMatchObject({ connection: 2, pending: 2, queued: 1 });
  });

  it("释放一个槽位后 promote 取出排队项", () => {
    const registry = createRequestRegistry();
    const first = reserve(registry) as { entry: PendingRequest };
    reserve(registry);
    const third = reserve(registry) as { entry: PendingRequest };
    expect(third.entry.state).toBe("queued");

    registry.fail(first.entry, "REQUEST_TIMEOUT", "boom");
    const promoted = registry.promote();
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.deliveryId).toBe(third.entry.deliveryId);
    expect(promoted[0]?.state).toBe("sent");
    expect(registry.counts().connection).toBe(2);
  });

  it("promote 遵守设备级上限：连接还有空位也不能超过设备预算", () => {
    // 连接上限 3、设备上限 2：这是唯一能区分「三层」与「只做连接级」的配置。
    const registry = createRequestRegistry({ maxInflightPerConnection: 3, deviceMaxInflight: 2 });
    const first = reserve(registry) as { entry: PendingRequest };
    reserve(registry);
    const queued = reserve(registry) as { entry: PendingRequest };
    expect(queued.entry.state).toBe("queued");

    // 连接还有一个空位（1 < 3），但设备级已满（2 = 2）→ 只能等。
    expect(registry.promote()).toHaveLength(0);

    registry.fail(first.entry, "DEVICE_OFFLINE", "released");
    const promoted = registry.promote();
    expect(promoted.map((entry) => entry.deliveryId)).toEqual([queued.entry.deliveryId]);
    expect(registry.counts()).toMatchObject({ device: 2, connection: 2, queued: 0 });
  });

  it("用户级上限独立于设备级：不同设备各占各的，但共享用户预算", () => {
    const registry = createRequestRegistry({
      maxInflightPerConnection: 4,
      deviceMaxInflight: 4,
      userMaxInflight: 3,
    });
    expect(reserve(registry, { deviceId: "d1", connectionId: "c1" }).kind).toBe("admitted");
    expect(reserve(registry, { deviceId: "d1", connectionId: "c1" }).kind).toBe("admitted");
    expect(reserve(registry, { deviceId: "d2", connectionId: "c2" }).kind).toBe("admitted");
    // 用户预算 3 已满 → 第 4 条排队，即使两台设备各自都还有余量。
    expect(reserve(registry, { deviceId: "d2", connectionId: "c2" }).kind).toBe("queued");
  });

  it("队列满 → 立即 DEVICE_BUSY（不排队、不建等待者）", () => {
    const registry = createRequestRegistry({ queueMax: 2 });
    reserve(registry);
    reserve(registry);
    expect(reserve(registry).kind).toBe("queued");
    expect(reserve(registry).kind).toBe("queued");
    const rejected = reserve(registry);
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") return;
    expect(rejected.result).toMatchObject({ ok: false, error: { code: "DEVICE_BUSY", retryable: true } });
    expect(registry.counts().queued).toBe(2);
  });
});

describe("完成必须恰好一次", () => {
  it("第二次 settle 返回 false，计数不会二次下降", () => {
    const registry = createRequestRegistry();
    const { entry } = reserve(registry) as { entry: PendingRequest };
    expect(registry.settle(entry, { ok: true, data: 1, meta: { duration_ms: 1, cached: false } })).toBe(true);
    // 这正是「迟到 res / 重复 res」的形状。
    expect(registry.settle(entry, { ok: true, data: 2, meta: { duration_ms: 9, cached: false } })).toBe(false);
    expect(registry.counts().connection).toBe(0);
    expect(entry.result).toMatchObject({ ok: true, data: 1 });
  });

  it("fail 之后再 settle 也无效（先到者赢）", () => {
    const registry = createRequestRegistry();
    const { entry } = reserve(registry) as { entry: PendingRequest };
    expect(registry.fail(entry, "REQUEST_TIMEOUT", "too late")).toBe(true);
    expect(registry.settle(entry, { ok: true, data: "late", meta: { duration_ms: 1, cached: false } })).toBe(false);
    expect(entry.result).toMatchObject({ ok: false, error: { code: "REQUEST_TIMEOUT" } });
  });

  it("已结算的 id 记为 settled，未结算的 id 不是", () => {
    const registry = createRequestRegistry();
    const { entry } = reserve(registry) as { entry: PendingRequest };
    expect(registry.get(entry.deliveryId)).toBeDefined();
    registry.fail(entry, "DEVICE_OFFLINE", "gone");
    expect(registry.get(entry.deliveryId)).toBeUndefined();
    expect(registry.isSettled(entry.deliveryId)).toBe(true);
    expect(registry.isSettled("req_never_seen")).toBe(false);
  });

  it("排队项被结算时也会唤醒等待者（否则调用方永久悬挂）", async () => {
    const registry = createRequestRegistry();
    reserve(registry);
    reserve(registry);
    const queued = reserve(registry) as { entry: PendingRequest; promise: Promise<unknown> };
    expect(queued.entry.state).toBe("queued");
    registry.fail(queued.entry, "DEVICE_OFFLINE", "connection lost while queued");
    await expect(queued.promise).resolves.toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
  });
});

describe("超时与排队预算", () => {
  it("deadline 到期 → REQUEST_TIMEOUT，并在 timedOut 里返回（供发 cancel）", () => {
    const registry = createRequestRegistry();
    const { entry } = reserve(registry, { deadlineMono: 1_000 }) as { entry: PendingRequest };
    const outcome = registry.sweep(1_000);
    expect(outcome.timedOut.map((item) => item.deliveryId)).toEqual([entry.deliveryId]);
    expect(outcome.queueExpired).toHaveLength(0);
    expect(entry.result).toMatchObject({ ok: false, error: { code: "REQUEST_TIMEOUT" } });
    expect(registry.counts().connection).toBe(0);
  });

  it("未到期不动", () => {
    const registry = createRequestRegistry();
    reserve(registry, { deadlineMono: 5_000 });
    const outcome = registry.sweep(4_999);
    expect(outcome.timedOut).toHaveLength(0);
    expect(registry.counts().connection).toBe(1);
  });

  it("排队超过 2 秒 → DEVICE_BUSY（不是 REQUEST_TIMEOUT）", () => {
    const registry = createRequestRegistry();
    reserve(registry, { deadlineMono: 100_000 });
    reserve(registry, { deadlineMono: 100_000 });
    const queued = reserve(registry, { deadlineMono: 100_000, nowMono: 0 }) as { entry: PendingRequest };
    const outcome = registry.sweep(2_000);
    expect(outcome.queueExpired.map((item) => item.deliveryId)).toEqual([queued.entry.deliveryId]);
    // 排队项**没有**发出去过，所以不能进 timedOut（那样会发一个凭空取消）。
    expect(outcome.timedOut).toHaveLength(0);
    expect(queued.entry.result).toMatchObject({ ok: false, error: { code: "DEVICE_BUSY" } });
  });

  it("排队期间 deadline 先到 → REQUEST_TIMEOUT（两者取先到）", () => {
    const registry = createRequestRegistry();
    reserve(registry);
    reserve(registry);
    const queued = reserve(registry, { deadlineMono: 500, nowMono: 0 }) as { entry: PendingRequest };
    const outcome = registry.sweep(600);
    expect(outcome.timedOut.map((item) => item.deliveryId)).toEqual([queued.entry.deliveryId]);
    expect(queued.entry.result).toMatchObject({ ok: false, error: { code: "REQUEST_TIMEOUT" } });
  });

  it("sweep 之后计数归零（不留垃圾）", () => {
    const registry = createRequestRegistry();
    reserve(registry, { deadlineMono: 100 });
    reserve(registry, { deadlineMono: 100 });
    reserve(registry, { deadlineMono: 100, nowMono: 0 });
    registry.sweep(10_000);
    expect(registry.counts()).toMatchObject({ user: 0, device: 0, connection: 0, pending: 0, queued: 0 });
  });
});

describe("断线与 grant 撤销", () => {
  it("连接断开时该连接的全部在途请求以 DEVICE_OFFLINE 结束", () => {
    const registry = createRequestRegistry({ maxInflightPerConnection: 3 });
    const a = reserve(registry) as { entry: PendingRequest };
    const b = reserve(registry) as { entry: PendingRequest };
    const other = reserve(registry, { connectionId: "conn-2", deviceId: "device-2" }) as {
      entry: PendingRequest;
    };
    const affected = registry.onConnectionLost("conn-1");
    expect(affected.map((entry) => entry.deliveryId).sort()).toEqual(
      [a.entry.deliveryId, b.entry.deliveryId].sort(),
    );
    expect(a.entry.result).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
    // 另一条连接不受影响——这是「旧连接断开不能误伤新连接」的最小形态。
    expect(registry.get(other.entry.deliveryId)).toBeDefined();
    expect(registry.counts().connection).toBe(1);
  });

  it("断开时排队项也一起结束（不会在新连接上被误发）", () => {
    const registry = createRequestRegistry();
    reserve(registry);
    reserve(registry);
    const queued = reserve(registry) as { entry: PendingRequest };
    const affected = registry.onConnectionLost("conn-1");
    expect(affected).toHaveLength(3);
    expect(queued.entry.result).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
    expect(registry.counts().queued).toBe(0);
  });

  it("撤销某个 grant 时只结束它的请求，同设备其它 grant 不受影响", () => {
    const registry = createRequestRegistry({ maxInflightPerConnection: 4 });
    const mine = reserve(registry, { grantCtx: "gc_1" }) as { entry: PendingRequest };
    const other = reserve(registry, { grantCtx: "gc_2", grantId: "grant-2" }) as { entry: PendingRequest };
    const affected = registry.rejectByGrantCtx("gc_1", "GRANT_REVOKED", "revoked");
    expect(affected.map((entry) => entry.deliveryId)).toEqual([mine.entry.deliveryId]);
    expect(mine.entry.result).toMatchObject({ ok: false, error: { code: "GRANT_REVOKED" } });
    expect(registry.get(other.entry.deliveryId)).toBeDefined();
  });

  it("同一连接重复 onConnectionLost 是幂等的", () => {
    const registry = createRequestRegistry();
    reserve(registry);
    expect(registry.onConnectionLost("conn-1")).toHaveLength(1);
    expect(registry.onConnectionLost("conn-1")).toHaveLength(0);
    expect(registry.counts().connection).toBe(0);
  });
});
