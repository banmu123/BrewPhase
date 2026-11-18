import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mcpDevices, mcpGrants } from "../../src/db/schema.js";
import { REMOTE_GRANT_ACK_TIMEOUT_MS } from "../../src/link/schemas.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { createLinkHarness, type LinkHarness } from "../helpers/link-server.js";
import {
  grantAck,
  goOnline,
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
 * Grant 在线同步（Phase 1.2B.2.2，里程碑 D / 协议运行时 §6.5.2）。
 *
 * ## 这一组要钉死的是一条 fail-closed 链
 *
 * ```
 * install 发出但没 ack     → 该 grant 不可派发
 * install applied=false    → 整台设备停止路由（syncLag）
 * revoke ack 超时          → 整台设备停止路由（syncLag）
 * syncLag 状态下            → 所有 grant 都不可派发
 * 重连（新 hello_ok）      → 从快照恢复，syncLag 清零
 * ```
 *
 * 每一环的代价都很高（一台设备上的全部 AI 客户端停服），所以每一环都必须
 * **只在真的无法确认时才触发**，也必须**一旦触发就真的停住**。两个方向都要测。
 */

let h: LinkHarness;
let userId: string;
let deviceId: string;
let deviceKeys: DeviceKeys;
let deviceToken: string;
let online: OnlineDevice | null = null;

beforeEach(async () => {
  resetRateLimiter();
  h = await createLinkHarness();
  userId = await seedUser(h);
  const device = await seedDevice(h, userId);
  deviceId = device.deviceId;
  deviceKeys = device.keys;
  deviceToken = device.deviceToken;
  online = null;
});

afterEach(async () => {
  if (online) online.close();
  online = null;
  await h.close();
});

/** 派发一次，期望被拒（不回 res，因为根本不该发出 req）。 */
async function dispatchCode(grantId: string, tool = "search_records"): Promise<string> {
  const result = await h.link.dispatchToolCall({ userId, grantId, tool, arguments: {} });
  if (result.ok) return "OK";
  return result.error.code;
}

/** 在线的设备上装一条新 grant，并按测试的意图回 ack。 */
async function installWithAck(
  grantId: string,
  mode: "applied" | "rejected" | "never",
  scopes: string[] = ["records:read"],
) {
  const pending = h.link.installGrant({
    deviceId,
    grant: { grantId, clientId: "claude", clientName: "Claude", scopes, epoch: 1 },
  });
  const frame = await online!.next((f) => f.type === "grant_update");
  const epoch = frame.grant_epoch as number;
  if (mode === "applied") online!.send(grantAck(epoch, true));
  if (mode === "rejected") online!.send(grantAck(epoch, false, "protocol_violation"));
  return { pending, frame, epoch };
}

describe("install 必须 ack 才可路由", () => {
  it("ack 之前派发被拒（GRANT_CONTEXT_INVALID），ack 之后可以派发", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude" });

    const { pending, frame } = await installWithAck(grantId, "never");
    expect(frame.op).toBe("install");
    expect(frame.grant_epoch).toBeGreaterThan(0);
    expect((frame.grant as { grant_id: string }).grant_id).toBe(grantId);

    // 未 ack：不可派发。**注意这里没有 req 帧**——不是发出去再拒。
    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");
    expect(reqFrames(online)).toHaveLength(0);

    online.send(grantAck(frame.grant_epoch as number, true));
    const installed = await pending;
    expect(installed.ok).toBe(true);

    // ack 之后：可以派发。
    const dispatch = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const req = await online.next((f) => f.type === "req");
    online.send(okRes(String(req.id), { after: "ack" }));
    expect((await dispatch).ok).toBe(true);
  });

  it("applied=false → 记安全事件并停掉整台设备的路由", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const existing = await seedGrant(h, userId, { clientId: "chatgpt" });
    const extra = await seedGrant(h, userId, { clientId: "claude" });

    // chatgpt 那条在 hello_ok 快照里，本来可以派发。
    const { pending } = await installWithAck(extra, "rejected");
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: "rejected" });

    // **整台设备**停路由——包括本来正常的那条 grant。
    expect(await dispatchCode(existing)).toBe("GRANT_CONTEXT_INVALID");
    expect(h.link.inspectForwarder().connections[0]?.syncLag).toBe(true);
    expect(reqFrames(online)).toHaveLength(0);
  });

  it("ack 超时 → syncLag（不 ack 就永远不路由）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude" });

    const { pending } = await installWithAck(grantId, "never");
    // 把时间推到 ack 超时之后。**不**等真实 3 秒。
    h.link.sweep(performance.now() + REMOTE_GRANT_ACK_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: "ack_timeout" });
    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");
  });

  it("ack 的 epoch 不对 → 不算数（仍在等），正确 epoch 才生效", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude" });
    const { pending, frame } = await installWithAck(grantId, "never");
    const epoch = frame.grant_epoch as number;

    // 旧 epoch / 未来 epoch / 完全无关的 epoch：三条都必须被忽略。
    online.send(grantAck(epoch - 1, true));
    online.send(grantAck(epoch + 1, true));
    online.send(grantAck(0, true));
    // 给事件循环一轮，确认它们真的被处理过（而不是还在队列里）。
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");
    expect(h.link.inspectForwarder().connections[0]?.pendingAckEpoch).toBe(epoch);

    online.send(grantAck(epoch, true));
    expect((await pending).ok).toBe(true);
  });

  it("重复 ack 不会把已完成的安装状态改坏", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude" });
    const { pending, frame } = await installWithAck(grantId, "applied");
    await pending;

    // 再来三条重复 ack（含 applied=false）：没有 pendingAck 时应全部忽略。
    online.send(grantAck(frame.grant_epoch as number, false, "late"));
    online.send(grantAck(frame.grant_epoch as number, true));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const dispatch = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const req = await online.next((f) => f.type === "req");
    online.send(okRes(String(req.id), { stillWorks: true }));
    expect((await dispatch).ok).toBe(true);
    expect(h.link.inspectForwarder().connections[0]?.syncLag).toBe(false);
  });
});

describe("revoke 的顺序与后果", () => {
  it("先停路由再发帧：revoke 帧到达前，派发已经被拒", async () => {
    // **必须先建 grant 再握手**：`hello_ok.grants` 是连接建立那一刻的快照，
    // 握手之后才插库的 grant 不会在快照里（这正是「新增授权要走 grant_update」
    // 的原因）。第一版写反了顺序，于是这条测试在「grant 根本没装」上假绿。
    const grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    // 先证明可以派发。
    const before = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const first = await online.next((f) => f.type === "req");
    online.send(okRes(String(first.id), {}));
    expect((await before).ok).toBe(true);

    const revoking = h.link.revokeGrant({ deviceId, grantId, reason: "user_revoked" });
    const frame = await online.next((f) => f.type === "grant_update");
    expect(frame.op).toBe("revoke");
    expect(frame.grant_ctx).toBeTypeOf("string");

    // **帧已到达、ack 还没回** 的这一刻：本地路由必须已经停了。
    // 这正是「先停路由再发帧」的可观测形态——反过来写的话，这里仍会派发成功。
    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");

    online.send(grantAck(frame.grant_epoch as number, true));
    expect((await revoking).ok).toBe(true);

    // 撤销后即便数据库里的 grant 仍然有效（模拟「OAuth 侧还没落库」），
    // Cloud 也不会派发：它已经没有这台设备上的 ctx 了。
    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");
  });

  it("撤销一条 grant 结束它在途的请求（不返回撤销前的数据）", async () => {
    const grantId = await seedGrant(h, userId, { clientId: "chatgpt" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const inflight = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const req = await online.next((f) => f.type === "req");

    const revoking = h.link.revokeGrant({ deviceId, grantId, reason: "user_revoked" });

    // 在途请求立刻以 GRANT_REVOKED 结束——**不等** Desktop 回那条 res。
    expect(await inflight).toMatchObject({ ok: false, error: { code: "GRANT_REVOKED" } });

    // 之后 Desktop 再回 res 也必须被忽略（请求已结算）。
    online.send(okRes(String(req.id), { leak: true }));
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, true));
    await revoking;
    expect(h.link.inspectForwarder().counts).toMatchObject({ pending: 0 });
  });

  it("撤销 ack 超时 → syncLag（设备上其它 grant 也停路由）", async () => {
    // `keep` 必须在握手前就存在，否则它压根不在快照里——那样「它也停路由」
    // 的断言会因为「它从来没被装上」而不是「syncLag」而通过。
    const keep = await seedGrant(h, userId, { clientId: "chatgpt" });
    const drop = await seedGrant(h, userId, { clientId: "claude" });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    // 两条都已在 `hello_ok` 快照里，**不需要**再 install。
    // （再 install 会走「先卸旧 ctx 再装新」的路径，发出两条帧，与本用例无关。）

    const revoking = h.link.revokeGrant({ deviceId, grantId: drop, reason: "user_revoked" });
    await online.next((f) => f.type === "grant_update");
    // 不回 ack，直接把时间推到超时。
    h.link.sweep(performance.now() + REMOTE_GRANT_ACK_TIMEOUT_MS + 1);
    expect((await revoking).ok).toBe(false);
    if (!(await revoking).ok) {
      expect((await h.link.revokeGrant({ deviceId, grantId: drop, reason: "again" })).ok).toBe(false);
    }

    // 关键：**另一条** grant 也不能派发了。
    expect(await dispatchCode(keep)).toBe("GRANT_CONTEXT_INVALID");
    expect(h.link.inspectForwarder().connections[0]?.syncLag).toBe(true);
  });

  it("撤销一条 grant 不影响同设备的另一条", async () => {
    const a = await seedGrant(h, userId, { clientId: "chatgpt", scopes: ["records:read"] });
    const b = await seedGrant(h, userId, { clientId: "claude", scopes: ["coffee:read"] });
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const revoking = h.link.revokeGrant({ deviceId, grantId: a, reason: "user_revoked" });
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, true));
    await revoking;

    // a 已经不可派发，b 仍然可以。
    const dispatch = h.link.dispatchToolCall({ userId, grantId: b, tool: "list_beans", arguments: {} });
    const req = await online.next((f) => f.type === "req");
    online.send(okRes(String(req.id), { beans: [] }));
    expect((await dispatch).ok).toBe(true);
    expect(await dispatchCode(a)).toBe("GRANT_CONTEXT_INVALID");
  });

  it("从没装过的 grant 撤销返回 not_installed（不是错误，也不改状态）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const never = await seedGrant(h, userId, { clientId: "gemini" });
    const result = await h.link.revokeGrant({ deviceId, grantId: never, reason: "user_revoked" });
    expect(result).toEqual({ ok: false, reason: "not_installed" });
    // 没有发出任何帧（除了前面可能的 ping）。
    expect(online.frames.filter((frame) => frame.type === "grant_update")).toHaveLength(0);
  });
});

describe("scope 变更必须换 ctx（旧缓存不可回放）", () => {
  it("replaceGrant：revoke 旧 ctx → ack → install 新 ctx → ack，ctx 变了", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude", scopes: ["records:read"] });
    const original = await installWithAck(grantId, "applied", ["records:read"]);
    await original.pending;
    const oldCtx = h.link.inspectForwarder().connections[0]?.grants.find((g) => g.grantId === grantId)?.grantCtx;
    expect(oldCtx).toBeTruthy();

    // 数据库里把 scope 收紧到 coffee:read，epoch +1。
    await h.ctx.db.db
      .update(mcpGrants)
      .set({ scopes: ["coffee:read"], epoch: 2 })
      .where(eq(mcpGrants.id, grantId));

    const replacing = h.link.replaceGrant({
      deviceId,
      grant: { grantId, clientId: "claude", clientName: "Claude", scopes: ["coffee:read"], epoch: 2 },
      reason: "scope_changed",
    });

    // 第一步：revoke 旧 ctx。
    const revokeFrame = await online.next((f) => f.type === "grant_update");
    expect(revokeFrame.op).toBe("revoke");
    expect(revokeFrame.grant_ctx).toBe(oldCtx);
    online.send(grantAck(revokeFrame.grant_epoch as number, true));

    // 第二步：install 新 ctx。
    const installFrame = await online.next((f) => f.type === "grant_update");
    expect(installFrame.op).toBe("install");
    const newCtx = (installFrame.grant as { grant_ctx: string }).grant_ctx;
    expect(newCtx).not.toBe(oldCtx);
    expect((installFrame.grant as { scopes: string[] }).scopes).toEqual(["coffee:read"]);
    online.send(grantAck(installFrame.grant_epoch as number, true));

    const result = await replacing;
    expect(result.ok).toBe(true);

    // 新 scope 下：list_beans 可以，search_records 不行（scope 已撤回）。
    const allowed = h.link.dispatchToolCall({ userId, grantId, tool: "list_beans", arguments: {} });
    const req = await online.next((f) => f.type === "req");
    online.send(okRes(String(req.id), { beans: [] }));
    expect((await allowed).ok).toBe(true);
    expect(await dispatchCode(grantId, "search_records")).toBe("SCOPE_DENIED");
  });

  it("单 grant 的 epoch 与数据库不一致时拒发（防「旧 ctx 继续用」）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude", scopes: ["records:read"] });
    // 装的时候用 epoch 1（与数据库一致）。
    const installed = await installWithAck(grantId, "applied");
    await installed.pending;

    // 数据库把 epoch 推到 2，但**没有**重新下发 install。
    await h.ctx.db.db.update(mcpGrants).set({ epoch: 2 }).where(eq(mcpGrants.id, grantId));

    // 连接上还是 epoch 1 → 拒发。这正是「scope 已变、ctx 未更新」的防线。
    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");
    expect(reqFrames(online)).toHaveLength(0);
  });
});

describe("重连后以 hello_ok 快照恢复", () => {
  it("syncLag 之后重连：新快照让设备重新可派发", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "chatgpt" });

    // 制造 syncLag：install 一条新 grant 但不 ack。
    const stuck = await installWithAck(await seedGrant(h, userId, { clientId: "claude" }), "never");
    h.link.sweep(performance.now() + REMOTE_GRANT_ACK_TIMEOUT_MS + 1);
    await stuck.pending;
    expect(await dispatchCode(grantId)).toBe("GRANT_CONTEXT_INVALID");

    // 重连：新连接的状态完全来自 hello_ok 快照（旧连接的状态被丢弃）。
    online.close();
    await h.link.awaitHandshakes();
    await waitUntil(() => h.link.connectionCount() === 0, "old connection closed");
    const fresh = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    online = fresh;

    expect(h.link.inspectForwarder().connections).toHaveLength(1);
    expect(h.link.inspectForwarder().connections[0]?.syncLag).toBe(false);

    const dispatch = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const req = await fresh.next((f) => f.type === "req");
    fresh.send(okRes(String(req.id), { recovered: true }));
    expect(await dispatch).toMatchObject({ ok: true, data: { recovered: true } });
  });

  it("设备级 epoch 持久化递增（跨连接不回退）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude" });
    const first = await installWithAck(grantId, "applied");
    await first.pending;
    const epochAfterFirst = first.frame.grant_epoch as number;

    // 重连后再装一条，epoch 必须比上一条大（不是从 0 重来）。
    online.close();
    await h.link.awaitHandshakes();
    await waitUntil(() => h.link.connectionCount() === 0, "closed");
    const fresh = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    online = fresh;

    // hello_ok 里的 grant_epoch 就是数据库里的值。
    const helloOk = online.pending.find((f) => f.type === "hello_ok") ?? online.frames.find((f) => f.type === "hello_ok");
    void helloOk;
    const secondGrant = await seedGrant(h, userId, { clientId: "gemini" });
    const second = h.link.installGrant({
      deviceId,
      grant: { grantId: secondGrant, clientId: "gemini", clientName: "Gemini", scopes: ["records:read"], epoch: 1 },
    });
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, true));
    await second;
    expect(frame.grant_epoch as number).toBeGreaterThan(epochAfterFirst);
  });
});

describe("设备离线时的同步", () => {
  it("离线设备 install / revoke 返回 offline，不发帧也不报错", async () => {
    const grantId = await seedGrant(h, userId, { clientId: "claude" });
    const install = await h.link.installGrant({
      deviceId,
      grant: { grantId, clientId: "claude", clientName: "Claude", scopes: ["records:read"], epoch: 1 },
    });
    expect(install).toEqual({ ok: false, reason: "offline" });
    const revoke = await h.link.revokeGrant({ deviceId, grantId, reason: "user_revoked" });
    expect(revoke).toEqual({ ok: false, reason: "offline" });
  });

  it("rotating 的连接不做授权同步（它马上要被关掉）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const grantId = await seedGrant(h, userId, { clientId: "claude" });
    void h.link.rotateConnection(deviceId);
    const install = await h.link.installGrant({
      deviceId,
      grant: { grantId, clientId: "claude", clientName: "Claude", scopes: ["records:read"], epoch: 1 },
    });
    expect(install).toEqual({ ok: false, reason: "offline" });
  });
});

describe("grant_epoch 与 grant.epoch 不混用", () => {
  it("连接级 epoch 每次上下文变更都 +1，单 grant 的 epoch 只在自身变化时 +1", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const a = await seedGrant(h, userId, { clientId: "chatgpt", epoch: 1 });
    const b = await seedGrant(h, userId, { clientId: "claude", epoch: 1 });

    const first = await installWithAck(a, "applied");
    await first.pending;
    const second = await installWithAck(b, "applied");
    await second.pending;

    // 设备级：严格递增。
    expect(second.epoch).toBeGreaterThan(first.epoch);
    // 单 grant：两条都是 epoch 1，与设备级无关。
    const grants = h.link.inspectForwarder().connections[0]?.grants ?? [];
    expect(grants.find((g) => g.grantId === a)?.epoch).toBe(1);
    expect(grants.find((g) => g.grantId === b)?.epoch).toBe(1);

    // 数据库里的设备级 epoch 也真的被推进了。
    const rows = await h.ctx.db.db
      .select({ grantEpoch: mcpDevices.grantEpoch })
      .from(mcpDevices)
      .where(eq(mcpDevices.id, deviceId));
    expect(rows[0]?.grantEpoch).toBe(second.epoch);
  });
});
