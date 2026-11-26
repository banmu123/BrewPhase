import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryConnectionRegistry,
  type ConnectionRegistry,
} from "../../src/link/connection-registry.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { createLinkHarness, type LinkHarness } from "../helpers/link-server.js";
import {
  goOnline,
  grantAck,
  okRes,
  reqFrames,
  seedDevice,
  seedGrant,
  seedUser,
  waitUntil,
  type DeviceKeys,
  type OnlineDevice,
} from "../helpers/forward.js";

/**
 * 派发与 **撤销 / 轮换 / 取消** 的竞态（Phase 1.2B.2.2-R1）。
 *
 * ## 为什么不能只测「撤销之后再发请求」
 *
 * 那种测试走的是「第一次 `lookupByUser` 就返回 null / syncLag」的分支，它证明
 * 不了任何窗口内的行为——而真实事故都发生在窗口里：
 *
 * ```
 * Dispatch 通过全部授权校验
 *   ↓   ← 这里是 await（准入查库、最终连接核对）
 * revokeGrant 删掉 byGrantId / byCtx，rejectByGrantCtx 找不到这条请求
 *   ↓
 * Dispatch 恢复，带着**已撤销的 grant_ctx** 把 req 写出去
 * ```
 *
 * ## 这里怎么做到确定性
 *
 * 不 sleep、不靠调度运气：把 `ConnectionRegistry.lookup`（派发的最后一次
 * await）换成一个**可暂停**的包装器。`pauseNextLookup()` 之后，下一次
 * `lookup` 会停在 Deferred 上，测试拿 `entered` 确认它真的停住了，再执行
 * 撤销/轮换/取消，最后 `release()` 放行。
 *
 * 包装器在**测试里**，生产代码不知道它存在：`createLinkServer` 只看到
 * `ConnectionRegistry` 接口。这一点很重要——如果为了测试在 Forwarder 里
 * 埋钩子，那条钩子调用的位置本身就成了被测行为的一部分。
 */

type LookupHold = { entered: Promise<void>; release: () => void };

/**
 * 包一层可暂停的 `lookup`。
 *
 * 只拦 `lookup`（派发第 8 步的最终核对），不拦 `lookupByUser` /
 * `lookupByDevice`——后两者是撤销与轮换自己要用的，拦了就会自锁。
 * `calls` 只用于断言「某个路径有没有走到第 1 步 / 第 8 步」。
 */
function pausableRegistry(inner: ConnectionRegistry) {
  let hold: { entered: () => void; gate: Promise<void> } | null = null;
  const calls = { lookupByUser: 0, lookup: 0 };

  const registry: ConnectionRegistry = {
    ...inner,
    async lookup(userId, deviceId) {
      calls.lookup += 1;
      const current = hold;
      if (current) {
        hold = null;
        current.entered();
        await current.gate;
      }
      return inner.lookup(userId, deviceId);
    },
    async lookupByUser(userId) {
      calls.lookupByUser += 1;
      return inner.lookupByUser(userId);
    },
  };

  return {
    registry,
    calls,
    /** 让**下一次** `lookup` 停在 Deferred 上。 */
    pauseNextLookup(): LookupHold {
      let enteredResolve!: () => void;
      let releaseResolve!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      hold = { entered: enteredResolve, gate };
      return { entered, release: () => releaseResolve() };
    },
  };
}

let h: LinkHarness;
let gate: ReturnType<typeof pausableRegistry>;
let userId: string;
let deviceId: string;
let deviceKeys: DeviceKeys;
let deviceToken: string;
let grantId = "";
let online: OnlineDevice | null = null;

beforeEach(async () => {
  resetRateLimiter();
  gate = pausableRegistry(createMemoryConnectionRegistry());
  h = await createLinkHarness({ registry: gate.registry });
  userId = await seedUser(h);
  const device = await seedDevice(h, userId);
  deviceId = device.deviceId;
  deviceKeys = device.keys;
  deviceToken = device.deviceToken;
  online = null;
});

afterEach(async () => {
  online?.close();
  online = null;
  await h.close();
});

/** 派发一次 → 等 req → 回 res。用来证明「正常路径仍然可用」。 */
async function roundTrip(target: OnlineDevice, targetGrant = grantId): Promise<boolean> {
  const promise = h.link.dispatchToolCall({
    userId,
    grantId: targetGrant,
    tool: "search_records",
    arguments: {},
  });
  const frame = await target.next((f) => f.type === "req");
  target.send(okRes(String(frame.id), { ok: true }));
  return (await promise).ok;
}

/**
 * 给「本该立刻收敛」的派发加一个上限。
 *
 * 竞态没修好时，被拦下的请求会**卡在等 res** 上（它已经把 req 发出去了，
 * 而测试不会回 res）。没有这个上限，失败表现为 5 秒超时加一段与被测行为
 * 无关的堆栈；有了它，失败直接说明「这条请求不该还在等」。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 一次**可识别**的往返，用作投递屏障。
 *
 * 为什么不直接断言「req 帧计数没变」：`ws.send` 只是把帧交给内核，客户端的
 * `message` 事件要等到下一轮 I/O。在被测请求刚 settle 的那一行读帧计数，
 * 读到的是「还没到达」而不是「不会被发送」——错误实现照样绿。
 *
 * 屏障的做法：紧接着再发一条**参数带标记**的请求，等它的 `req` 到达再断言。
 * 同一条 socket 上先写出的帧一定先到，所以那条被拦下的请求（若真的写了）
 * 此刻一定已经在 `frames` 里。用标记而不是「下一条 req」，是因为错误实现
 * 写出的那条 req 可能恰好排在前面，按顺序取会取错。
 */
async function barrierRoundTrip(target: OnlineDevice, targetGrant: string): Promise<void> {
  const promise = h.link.dispatchToolCall({
    userId,
    grantId: targetGrant,
    tool: "search_records",
    arguments: { __barrier: true },
  });
  const frame = await target.next(
    (f) => f.type === "req" && (f.arguments as { __barrier?: boolean } | undefined)?.__barrier === true,
  );
  target.send(okRes(String(frame.id), { barrier: true }));
  expect((await promise).ok).toBe(true);
}

describe("P0：撤销发生在「最终核对」期间（请求已登记、尚未写出）", () => {
  it("撤销先手 → 不写 req、返回 GRANT_REVOKED、计数归零", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    // 第二条 grant 不是陪衬：它是**投递屏障**（见用例末尾）。
    const otherGrant = await seedGrant(h, userId, { clientId: "claude" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    // 先证明这条连接与这条 grant 本来能派发（否则下面的断言可能因为
    // 「它压根没被装上」而假绿）。
    expect(await roundTrip(online, grantId)).toBe(true);

    const hold = gate.pauseNextLookup();
    const dispatching = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: { search: "埃塞" },
    });
    // 停在这里 = 授权校验已通过、请求已 reserve、req 还没构造。
    await hold.entered;

    const revoking = h.link.revokeGrant({ deviceId, grantId, reason: "user_revoked" });
    const frame = await online.next((f) => f.type === "grant_update");
    expect(frame.op).toBe("revoke");
    // 撤销自己的 ack 正常回，让撤销「成功」——这正是最危险的形状：
    // 撤销完全成功，而那条被拦下的请求还悬在 await 里。
    online.send(grantAck(frame.grant_epoch as number, true));
    expect((await revoking).ok).toBe(true);

    hold.release();
    const result = await withTimeout(
      dispatching,
      2_000,
      "the dispatch should have been settled by the revoke; it is still waiting for a res",
    );

    // 撤销路径给出的结论必须原样交给调用方（不可重试）。
    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_REVOKED", retryable: false } });
    // 槽位、队列、三层计数都必须归零（撤销那条 `finish` 已经还过一次）。
    expect(h.link.inspectForwarder().counts).toMatchObject({
      user: 0,
      device: 0,
      connection: 0,
      pending: 0,
      queued: 0,
    });

    // **投递屏障**：同一条 socket 上先写出的帧一定先到达，所以这条正常往返
    // 的 req 到达时，被拦下的那条（如果它真的被写出去过）也一定已经到了。
    // 直接断言「计数没变」会在写出之前就通过——那是假绿。
    await barrierRoundTrip(online, otherGrant);
    expect(reqFrames(online)).toHaveLength(2);
  });

  it("撤销之后再派发：仍被拒（窗口关闭后状态是自洽的）", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const hold = gate.pauseNextLookup();
    const dispatching = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    await hold.entered;
    const revoking = h.link.revokeGrant({ deviceId, grantId, reason: "user_revoked" });
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, true));
    await revoking;
    hold.release();
    await withTimeout(dispatching, 2_000, "the dispatch should have been settled by the revoke");

    const after = await h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    expect(after).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
    expect(reqFrames(online)).toHaveLength(0);
  });
});

describe("P0：请求先进入在途，撤销必须找到它（与「尚未发出」区分）", () => {
  it("已写出 req → 以 GRANT_REVOKED 结算，迟到的 res 被忽略", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const dispatching = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const req = await online.next((f) => f.type === "req");
    // 与上一条用例的分界点：这一次 req **已经**在 Desktop 手上了。
    expect(reqFrames(online)).toHaveLength(1);

    const revoking = h.link.revokeGrant({ deviceId, grantId, reason: "user_revoked" });
    expect(await dispatching).toMatchObject({ ok: false, error: { code: "GRANT_REVOKED" } });

    // Desktop 仍然把那次读取做完了 → 迟到的成功必须被丢弃，
    // 调用方不能拿到撤销之前读到的数据。
    online.send(okRes(String(req.id), { leak: true }));
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, true));
    await revoking;

    await waitUntil(() => h.link.inspectForwarder().counts.pending === 0, "inflight drained");
    expect(h.link.inspectForwarder().counts).toMatchObject({ connection: 0, queued: 0 });
    // 撤销后同一条 grant 不可再派发。
    const after = await h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    expect(after).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
  });
});

describe("P1：轮换发生在「最终核对」期间必须答 DEVICE_UNAUTHORIZED", () => {
  it("不回退成可重试的 DEVICE_OFFLINE，且旧连接收不到 req", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    expect(await roundTrip(online)).toBe(true);
    const reqsBefore = reqFrames(online).length;

    const hold = gate.pauseNextLookup();
    const dispatching = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    await hold.entered;

    // 轮换：先 onConnectionRotating（结算在途 + 置 rotating），再 markRotating
    // 与 unbind。也就是说恢复执行时 `lookup` 只会返回 null——这正是旧实现
    // 把它误判成 DEVICE_OFFLINE 的那条路径。
    const rotated = await h.link.rotateConnection(deviceId);
    expect(rotated).toBe(true);

    hold.release();
    const result = await withTimeout(
      dispatching,
      2_000,
      "the dispatch should have been settled by the rotation; it is still waiting for a res",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "DEVICE_UNAUTHORIZED", retryable: false },
    });
    expect(reqFrames(online)).toHaveLength(reqsBefore);
    expect(h.link.inspectForwarder().counts).toMatchObject({
      pending: 0,
      queued: 0,
      connection: 0,
    });
  });
});

describe("P1：AbortSignal 在 reserve / send 两个阶段", () => {
  it("进入之前就已取消 → REQUEST_CANCELLED，且不查库、不占计数、不发帧", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const lookupsBefore = { ...gate.calls };

    const controller = new AbortController();
    controller.abort();
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CANCELLED", retryable: false },
    });
    expect(reqFrames(online)).toHaveLength(0);
    expect(h.link.inspectForwarder().counts).toMatchObject({
      user: 0,
      device: 0,
      connection: 0,
      pending: 0,
      queued: 0,
    });
    // 第 1 步（lookupByUser）在第 3 步查库之前，第 8 步在其之后。
    // 两个都没走 ⇒ 中间那两次数据库授权查询也没走。
    expect(gate.calls).toEqual(lookupsBefore);
  });

  it("已登记、尚未写出时取消 → 不写 req，也不发 cancel（Desktop 没见过这个 id）", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    const otherGrant = await seedGrant(h, userId, { clientId: "claude" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    expect(await roundTrip(online, grantId)).toBe(true);

    const hold = gate.pauseNextLookup();
    const controller = new AbortController();
    const dispatching = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      signal: controller.signal,
    });
    await hold.entered;

    controller.abort();
    hold.release();

    expect(await dispatching).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CANCELLED" },
    });
    expect(h.link.inspectForwarder().counts).toMatchObject({
      pending: 0,
      queued: 0,
      connection: 0,
    });

    // 同样用一条可识别往返当投递屏障：先写出的帧一定先到达。第一版没有这道
    // 屏障，于是「req 还在内核缓冲区里」时断言就通过了——旧实现（无条件
    // `sendEntry`）在这条用例上是**假绿**的。
    await barrierRoundTrip(online, otherGrant);
    expect(reqFrames(online)).toHaveLength(2);
    // `cancel` 只针对**真的投递过**的请求：这条从没离开 Cloud，
    // 发 cancel 等于让 Desktop 去取消一个它不认识的 id。
    expect(online.frames.filter((f) => f.type === "cancel")).toHaveLength(0);
  });

  it("已写出 req 之后取消 → 发 cancel(client_cancelled)（best-effort，不中止同步 handler）", async () => {
    grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const controller = new AbortController();
    const dispatching = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      signal: controller.signal,
    });
    const req = await online.next((f) => f.type === "req");
    controller.abort();

    expect(await dispatching).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } });
    const cancel = await online.next((f) => f.type === "cancel");
    expect(cancel.id).toBe(String(req.id));
    expect(cancel.reason).toBe("client_cancelled");
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, connection: 0 });
  });
});
