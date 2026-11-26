import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sign as cryptoSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { mcpDevices, mcpGrants } from "../../src/db/schema.js";
import { computeRequestHash } from "../../src/link/request-hash.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { rotateSigningPayload } from "../../src/mcp-devices/rotate.js";
import { createLinkHarness, type LinkHarness } from "../helpers/link-server.js";
import {
  errRes,
  goOnline,
  keyPair,
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
 * Cloud 请求转发端到端（Phase 1.2B.2.2，里程碑 A / B）。
 *
 * 全部走**真** WSS + **真** PostgreSQL：被测的是「Cloud 能不能把一条请求
 * 安全地送到正确的设备上，并把它真实的结果拿回来」。用 Mock 替掉任何一端，
 * 这一组要证明的东西就都不成立了。
 *
 * 这一组覆盖：
 *
 * | 主题 | 断言的核心 |
 * |---|---|
 * | 正常往返 | `req` 的字段集 + `res` 原样回到调用方 |
 * | 跨用户（ST-1） | A 的 grant + B 的身份 → `USER_MISMATCH`，且**一个 req 帧都没发出** |
 * | rotating（ST-3） | 轮换后旧连接收不到新请求 |
 * | 设备状态 | revoked / suspended / token 过期 各自独立的错误码 |
 * | 不可用 | 离线、未知工具、scope 不足、grant 撤销 |
 */

let h: LinkHarness;
let userId: string;
let deviceId: string;
let deviceKeys: DeviceKeys;
let deviceToken: string;
let grantId: string;
let online: OnlineDevice | null = null;

beforeEach(async () => {
  resetRateLimiter();
  h = await createLinkHarness();
  userId = await seedUser(h);
  const device = await seedDevice(h, userId);
  deviceId = device.deviceId;
  deviceKeys = device.keys;
  deviceToken = device.deviceToken;
  grantId = await seedGrant(h, userId, { scopes: ["records:read", "coffee:read"] });
  online = null;
});

afterEach(async () => {
  online?.close();
  online = null;
  await h.close();
});

/** 一次「设备自动回成功 res」的派发，返回调用方看到的结果。 */
async function dispatchAndReply(
  target: OnlineDevice,
  input: { tool?: string; args?: unknown; data?: unknown; clientDeadline?: number; signal?: AbortSignal } = {},
) {
  const promise = h.link.dispatchToolCall({
    userId,
    grantId,
    tool: input.tool ?? "search_records",
    arguments: input.args ?? { search: "埃塞" },
    clientDeadline: input.clientDeadline,
    signal: input.signal,
  });
  const frame = await target.next((f) => f.type === "req");
  target.send(okRes(String(frame.id), input.data ?? { items: [], total: 0 }));
  return { result: await promise, frame };
}

describe("正常往返", () => {
  it("req 的字段集与协议一致（不带任何自报身份）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const { frame } = await dispatchAndReply(online);

    expect(Object.keys(frame).sort()).toEqual([
      "arguments",
      "deadline_ms",
      "grant_ctx",
      "id",
      "request_hash",
      "tool",
      "ts",
      "type",
      "v",
    ]);
    // 三个「绝不出现」的字段：身份必须只有一个来源。
    for (const forbidden of ["user_id", "grant_id", "client_id", "scopes", "connection_id"]) {
      expect(frame[forbidden]).toBeUndefined();
    }
    expect(frame.type).toBe("req");
    expect(frame.v).toBe(1);
    expect(frame.tool).toBe("search_records");
    expect(frame.arguments).toEqual({ search: "埃塞" });
    expect(String(frame.id)).toMatch(/^req_[0-9a-f]{12}$/);
  });

  it("request_hash 与 Desktop 算的同一串（用共享向量核对算法，再看线上值）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const args = { search: "埃塞", limit: 20 };
    const { frame } = await dispatchAndReply(online, { tool: "search_records", args });
    expect(frame.request_hash).toBe(computeRequestHash({ v: 1, tool: "search_records", arguments: args }));
  });

  it("Desktop 的结果原样回到调用方（含 meta）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const data = { items: [{ id: "r1", title: "云南保山" }], has_more: false };
    const { result } = await dispatchAndReply(online, { data });
    expect(result).toEqual({
      ok: true,
      data,
      meta: { duration_ms: 1, cached: false },
    });
  });

  it("请求 id 与响应 id 一致，且每次派发都是新 id", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const first = await dispatchAndReply(online);
    const second = await dispatchAndReply(online);
    expect(first.result.ok).toBe(true);
    expect(second.result.ok).toBe(true);
    const ids = reqFrames(online).map((frame) => frame.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("失败结果也原样透传（错误码不变形）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "get_record",
      arguments: { record_id: "00000000-0000-4000-8000-000000000000" },
    });
    const frame = await online.next((f) => f.type === "req");
    online.send(errRes(String(frame.id), "NOT_FOUND", "record not found"));
    const result = await promise;
    expect(result).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "record not found", retryable: false },
    });
  });

  it("deadline_ms 落在 15 秒预算内（且是 epoch 绝对值）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const before = Date.now();
    const { frame } = await dispatchAndReply(online);
    const deadline = frame.deadline_ms as number;
    expect(deadline).toBeGreaterThan(before + 14_000);
    expect(deadline).toBeLessThan(before + 16_000);
  });

  it("clientDeadline 能收紧预算（不能被延长）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const before = Date.now();
    const { frame } = await dispatchAndReply(online, { clientDeadline: before + 3_000 });
    expect(frame.deadline_ms as number).toBeLessThanOrEqual(before + 3_100);
  });
});

describe("不可用与拒绝（都不应该发出 req）", () => {
  it("设备离线 → DEVICE_OFFLINE，且文案点明是哪个账号没有设备", async () => {
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE", retryable: true } });
    // 「账号不匹配」在云端只能表现为「该账号没有在线设备」，所以文案必须带上
    // 账号线索：否则用户会去查网络/开关，而真正要看的是两边登录是否同一账号。
    const error = (result as { ok: false; error: { message: string } }).error;
    expect(error.message).toContain(userId.slice(0, 8));
    expect(error.message).toContain("same account");
  });

  it("未知工具 → TOOL_NOT_ALLOWED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "delete_record",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ALLOWED" } });
    expect(reqFrames(online)).toHaveLength(0);
  });

  it("scope 不覆盖 → SCOPE_DENIED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    // grant 只有 records:read / coffee:read，没有 canvas:read。
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "list_canvases",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "SCOPE_DENIED" } });
    expect(reqFrames(online)).toHaveLength(0);
  });

  it("grant 已撤销 → GRANT_REVOKED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    await h.ctx.db.db.update(mcpGrants).set({ revokedAt: new Date() }).where(eq(mcpGrants.id, grantId));
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_REVOKED" } });
    expect(reqFrames(online)).toHaveLength(0);
  });

  it("grant 的 resource 不是本服务 → GRANT_CONTEXT_INVALID", async () => {
    const otherResource = await seedGrant(h, userId, {
      clientId: "other-client",
      resource: "https://elsewhere.example/mcp",
    });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const result = await h.link.dispatchToolCall({
      userId,
      grantId: otherResource,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
    expect(reqFrames(online)).toHaveLength(0);
  });

  it("grant id 不存在 → GRANT_CONTEXT_INVALID（不暴露「不存在」与「不是你的」的差别）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const result = await h.link.dispatchToolCall({
      userId,
      grantId: "00000000-0000-4000-8000-000000000000",
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_CONTEXT_INVALID" } });
  });

  it("设备被暂停 → DEVICE_SUSPENDED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    await h.ctx.db.db.update(mcpDevices).set({ status: "suspended" }).where(eq(mcpDevices.id, deviceId));
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    // 连接还在（suspend 的清理可能稍后到），但派发必须已经拒绝。
    expect(result).toMatchObject({ ok: false, error: { code: "DEVICE_SUSPENDED" } });
  });

  it("设备被撤销 → DEVICE_REVOKED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    await h.ctx.db.db
      .update(mcpDevices)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(mcpDevices.id, deviceId));
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DEVICE_REVOKED" } });
  });

  it("device_token 已过期 → DEVICE_UNAUTHORIZED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    await h.ctx.db.db
      .update(mcpDevices)
      .set({ tokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mcpDevices.id, deviceId));
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DEVICE_UNAUTHORIZED" } });
    expect(reqFrames(online)).toHaveLength(0);
  });
});

describe("跨用户（ST-1）", () => {
  it("B 的身份 + A 的 grant → USER_MISMATCH，一个 req 帧都不发", async () => {
    // A 有一条 grant，但**没有**设备；B 有设备并在线。
    const userA = await seedUser(h, "User A");
    const grantOfA = await seedGrant(h, userA);

    const userB = await seedUser(h, "User B");
    const deviceOfB = await seedDevice(h, userB);
    const onlineB = await goOnline(h, { deviceId: deviceOfB.deviceId, deviceToken: deviceOfB.deviceToken, keys: deviceOfB.keys });
    online = onlineB;

    const result = await h.link.dispatchToolCall({
      userId: userB,
      grantId: grantOfA,
      tool: "search_records",
      arguments: {},
    });

    expect(result).toMatchObject({ ok: false, error: { code: "USER_MISMATCH" } });
    // 关键：不是「先发后拒」——B 的设备上不能出现任何请求帧。
    expect(reqFrames(onlineB)).toHaveLength(0);
  });

  it("A 的身份 + B 的 grant → USER_MISMATCH（两个方向都要挡）", async () => {
    const userA = await seedUser(h, "User A 2");
    const deviceA = await seedDevice(h, userA);
    const onlineA = await goOnline(h, { deviceId: deviceA.deviceId, deviceToken: deviceA.deviceToken, keys: deviceA.keys });
    online = onlineA;

    const userB = await seedUser(h, "User B 2");
    const grantOfB = await seedGrant(h, userB);

    const result = await h.link.dispatchToolCall({
      userId: userA,
      grantId: grantOfB,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "USER_MISMATCH" } });
    expect(reqFrames(onlineA)).toHaveLength(0);
  });

  it("设备表的 user_id 被改成别人 → USER_MISMATCH（不只查 grant 一半）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const stranger = await seedUser(h, "Stranger");
    // 直接改库，模拟「设备归属被篡改」——只查 grant 的实现会漏掉这一条。
    await h.ctx.db.db.update(mcpDevices).set({ userId: stranger }).where(eq(mcpDevices.id, deviceId));
    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "USER_MISMATCH" } });
    expect(reqFrames(online)).toHaveLength(0);
  });
});

describe("rotating 保护进入派发层（ST-3 的另一半）", () => {
  it("轮换后旧连接不再收到 req；新凭据重连后恢复派发", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    // 先证明轮换前可以派发。
    const before = await dispatchAndReply(online);
    expect(before.result.ok).toBe(true);

    // ---- 轮换 ----
    const nextKeys = keyPair();
    const ts = Date.now();
    const sig = cryptoSign(
      null,
      rotateSigningPayload({ deviceId, newPublicKey: nextKeys.publicKey, ts }),
      deviceKeys.privateKey,
    ).toString("base64url");
    const resp = await fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${deviceId}/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ new_public_key: nextKeys.publicKey, ts, sig }),
    });
    expect(resp.status).toBe(200);
    const rotated = (await resp.json()) as { device_token: string };
    await online.closeInfo;

    // ---- 旧连接已经没了，但即使它还没断，也不能收到新请求 ----
    //
    // 这里的关键断言是「旧 socket 上 req 帧计数没有增长」。轮换之后它收到的
    // 只有 bye（已经在 close 之前发出）。
    expect(reqFrames(online)).toHaveLength(1);

    // ---- 新凭据重连 → 恢复 ----
    const fresh = await goOnline(h, {
      deviceId,
      deviceToken: rotated.device_token,
      keys: nextKeys,
    });
    online = fresh;
    const after = await dispatchAndReply(fresh);
    expect(after.result.ok).toBe(true);
  });

  it("轮换**之后**（路由项已删、socket 还在）派发仍是 DEVICE_UNAUTHORIZED 而不是 DEVICE_OFFLINE", async () => {
    // 这条锁的是「错误码不能退化成可重试」。路由项被 unbind 之后
    // `lookupByUser` 返回 null，如果只按 null 判断就会报 DEVICE_OFFLINE
    // （retryable=true），而凭据作废是**不可重试**的——调用方会一直重试。
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    await h.link.rotateConnection(deviceId);

    const result = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DEVICE_UNAUTHORIZED", retryable: false },
    });
  });

  it("轮换时在途请求立刻以 DEVICE_UNAUTHORIZED 结束（不等 socket 关闭）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const inflight = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    await online.next((f) => f.type === "req");

    await h.link.rotateConnection(deviceId);
    expect(await inflight).toMatchObject({ ok: false, error: { code: "DEVICE_UNAUTHORIZED" } });
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, connection: 0 });
  });

  it("rotating 期间（旧连接标记已置、尚未 close）派发被拒为 DEVICE_UNAUTHORIZED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    // 直接调 rotateConnection，模拟「数据库已提交、清理正在进行」的那一刻。
    // 这里**不**经过 HTTP，所以能精确落在标记之后、close 之前的窗口里。
    const rotated = h.link.rotateConnection(deviceId);
    // 标记是同步完成的（`markRotating` 的实现不 await），所以立刻派发即可命中。
    const during = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    await rotated;

    expect(during).toMatchObject({ ok: false, error: { code: "DEVICE_UNAUTHORIZED" } });
    expect(reqFrames(online)).toHaveLength(0);
  });
});

describe("消息层异常", () => {
  it("未知 id 的 res 被忽略，不影响在途请求", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const frame = await online.next((f) => f.type === "req");

    // 先塞三条假 res：未知 id、畸形帧、错误连接的 id。
    online.send(okRes("req_deadbeef0000", { spoofed: true }));
    online.send({ v: 1, type: "res", id: String(frame.id), ok: true });
    online.send({ nonsense: true });

    online.send(okRes(String(frame.id), { real: true }));
    const result = await promise;
    expect(result).toEqual({ ok: true, data: { real: true }, meta: { duration_ms: 1, cached: false } });
  });

  it("重复 res 只完成一次（第二次被忽略）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const frame = await online.next((f) => f.type === "req");
    online.send(okRes(String(frame.id), { first: true }));
    online.send(okRes(String(frame.id), { second: true }));
    const result = await promise;
    expect(result).toMatchObject({ ok: true, data: { first: true } });
    // 计数只降一次：再派发一条必须能拿到槽位（否则说明释放了两次或没释放）。
    const again = await dispatchAndReply(online);
    expect(again.result.ok).toBe(true);
  });

  it("畸形 res 不会被当成执行结果", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const frame = await online.next((f) => f.type === "req");
    // ok:true 但没有 data → 会被 schema 拒绝（否则调用方拿到「成功但空」）。
    online.send({ v: 1, type: "res", id: String(frame.id), ts: Date.now(), ok: true, meta: { duration_ms: 1, cached: false } });
    online.send(okRes(String(frame.id), { after: true }));
    const result = await promise;
    expect(result).toMatchObject({ ok: true, data: { after: true } });
  });

  it("连接断开时在途请求立刻以 DEVICE_OFFLINE 结束", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    await online.next((f) => f.type === "req");

    online.ws.terminate();
    const result = await promise;
    expect(result).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, queued: 0 });
  });

  it("旧连接的迟到 res 不会完成新连接上的请求", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const first = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const firstFrame = await online.next((f) => f.type === "req");

    // 断开 → 请求以 DEVICE_OFFLINE 结束；随后用同一条设备重连。
    online.ws.terminate();
    await first;
    const reconnect = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    online = reconnect;

    // 新连接上派发一条新请求，然后**用旧 frame 的 id** 发一条 res。
    const second = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const secondFrame = await reconnect.next((f) => f.type === "req");
    reconnect.send(okRes(String(firstFrame.id), { fromOldConnection: true }));
    // 新请求必须仍然在等（用正确的 id 才完成）。
    reconnect.send(okRes(String(secondFrame.id), { fresh: true }));
    expect(await second).toMatchObject({ ok: true, data: { fresh: true } });
    expect(firstFrame.id).not.toBe(secondFrame.id);
  });
});

describe("并发上限（Cloud 侧真正执行）", () => {
  it("两条在途后第三条排队；第二条完成时它被自动发出", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const a = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 1 } });
    const b = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 2 } });
    const c = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 3 } });

    await online.waitForReqCount(2);
    // 先让事件循环跑一轮，确认第三条**没有**被发出去。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reqFrames(online)).toHaveLength(2);
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 2, queued: 1 });

    const first = reqFrames(online)[0] as Record<string, unknown>;
    online.send(okRes(String(first.id), { n: 1 }));
    await a;

    // 释放一个槽位 → 队列项被泵出去。
    await online.waitForReqCount(3);
    const third = reqFrames(online)[2] as Record<string, unknown>;
    online.send(okRes(String(third.id), { n: 3 }));
    const secondFrame = reqFrames(online)[1] as Record<string, unknown>;
    online.send(okRes(String(secondFrame.id), { n: 2 }));

    expect((await b).ok).toBe(true);
    expect((await c).ok).toBe(true);
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, queued: 0 });
  });

  it("队列满了立刻 DEVICE_BUSY，且不占任何槽位", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    // 队列上限 32（生产值）。先塞满在途 2 条，再把队列灌满。
    const inflight = [
      h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 0 } }),
      h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 1 } }),
    ];
    await online.waitForReqCount(2);
    const queued: Array<Promise<unknown>> = [];
    for (let index = 0; index < 32; index += 1) {
      queued.push(h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 100 + index } }));
    }
    // **必须等队列真的满**再发第 33 条。
    //
    // 32 条 dispatch 各自要先走两次数据库查询（grant + device），它们的完成
    // 顺序没有保证。不等的话，`overflow` 可能在队列只有 20 条时到达 → 它自己
    // 被排队 → 然后永远不会返回（队列项要等槽位释放或 sweep，而这条测试
    // 故意不让槽位释放）。第一版就是这么写成 30 秒超时的。
    await waitUntil(
      () => h.link.inspectForwarder().counts.queued === 32,
      "queue to fill up",
    );
    const overflow = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: { n: 999 },
    });
    expect(overflow).toMatchObject({ ok: false, error: { code: "DEVICE_BUSY" } });
    expect(h.link.inspectForwarder().counts.queued).toBe(32);

    // 收尾：把时间推到远超排队预算处。排队项应以 **DEVICE_BUSY** 结束
    // （不是 REQUEST_TIMEOUT）——两者的区别是「设备忙」与「查询太慢」，
    // 面向用户的提示完全不同。
    h.link.sweep(Number.MAX_SAFE_INTEGER);
    const results = await Promise.allSettled([...inflight, ...queued]);
    const codes = results.map((item) =>
      item.status === "fulfilled" ? (item.value as { error?: { code?: string } }).error?.code : "rejected",
    );
    expect(codes.filter((code) => code === "DEVICE_BUSY")).toHaveLength(32);
    expect(codes.filter((code) => code === "REQUEST_TIMEOUT")).toHaveLength(2);
    // 全部释放：一个槽位都不许漏。
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, queued: 0, connection: 0 });
  });
});

describe("返回体不含凭据", () => {
  it("派发结果里没有 token / grant_ctx / 内部 id", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const { result } = await dispatchAndReply(online, { data: { items: [] } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(deviceToken);
    expect(serialized).not.toContain("gc_");
    expect(serialized).not.toContain(deviceId);
  });
});

describe("deadline 与 cancel", () => {
  it("超过 deadline → REQUEST_TIMEOUT，并向 Desktop 发 cancel(gateway_timeout)", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      // 1 秒预算，便于用 sweep 把它推到过期。
      clientDeadline: Date.now() + 1_000,
    });
    await online.next((f) => f.type === "req");

    // 推到预算之后。**不**等真实 1 秒。
    h.link.sweep(performance.now() + 2_000);
    expect(await promise).toMatchObject({ ok: false, error: { code: "REQUEST_TIMEOUT", retryable: true } });

    const cancel = await online.next((f) => f.type === "cancel");
    expect(cancel.reason).toBe("gateway_timeout");
    // 槽位必须被归还——否则下一条请求会莫名 DEVICE_BUSY。
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, queued: 0, connection: 0 });
  });

  it("超时之后迟到的 res 不改变任何东西（调用方已拿到超时）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      clientDeadline: Date.now() + 500,
    });
    const req = await online.next((f) => f.type === "req");
    h.link.sweep(performance.now() + 1_000);
    expect((await promise).ok).toBe(false);

    // 迟到的成功：必须被当成「已结算的重复 res」丢弃。
    online.send(okRes(String(req.id), { lateButSuccessful: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, connection: 0 });
  });

  it("排队中的请求被取消 → 不发 req，返回 REQUEST_CANCELLED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const controller = new AbortController();
    // 先占满两条在途。
    const a = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 1 } });
    const b = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: { n: 2 } });
    await online.waitForReqCount(2);

    const queued = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: { n: 3 },
      signal: controller.signal,
    });
    await waitUntil(() => h.link.inspectForwarder().counts.queued === 1, "queued");
    controller.abort();

    expect(await queued).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } });
    // 排队项被取消后**不能**再被泵出去。
    expect(reqFrames(online)).toHaveLength(2);
    expect(h.link.inspectForwarder().counts.queued).toBe(0);

    // 收尾：让在途两条结束，避免影响 afterEach 的收敛。
    for (const frame of reqFrames(online)) online.send(okRes(String(frame.id), {}));
    await Promise.all([a, b]);
  });

  it("已发出的请求被取消 → 发 cancel(client_cancelled)，返回 REQUEST_CANCELLED", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const controller = new AbortController();
    const promise = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      signal: controller.signal,
    });
    const req = await online.next((f) => f.type === "req");
    controller.abort();

    expect(await promise).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED" } });
    const cancel = await online.next((f) => f.type === "cancel");
    expect(cancel.id).toBe(String(req.id));
    expect(cancel.reason).toBe("client_cancelled");
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, connection: 0 });
  });

  it("超时与断线同时发生也只结算一次（不二次释放）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const promise = h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
      clientDeadline: Date.now() + 300,
    });
    await online.next((f) => f.type === "req");

    // 同一轮里：先超时，再断线。
    h.link.sweep(performance.now() + 1_000);
    online.ws.terminate();

    const result = await promise;
    expect(result.ok).toBe(false);
    // 第二次结算必须是无效的：计数不能变成负数（Map 里 <=0 会删键，
    // 所以「二次释放」的表现是另一个键被误减——用总数看更直接）。
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0, queued: 0, connection: 0 });
    // 再派发一次：如果计数被多减，这里会拿到一个不该有的成功/失败。
    const offline = await h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    expect(offline).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
  });
});
