import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, getTestDb } from "../helpers/db.js";
import { createLinkHarness, type LinkHarness } from "../helpers/link-server.js";
import {
  grantAck,
  goOnline,
  seedDevice,
  seedUser,
  type DeviceKeys,
  type OnlineDevice,
} from "../helpers/forward.js";
import { seedConsentRow } from "../helpers/mcp-consent.js";
import { mcpResourceFor } from "../../src/mcp-oauth/constants.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { REMOTE_GRANT_ACK_TIMEOUT_MS } from "../../src/link/schemas.js";
import { mcpAuthCodeHash } from "../../src/mcp-oauth/consent-flow.js";

/**
 * 同意之后：Grant 同步到在线设备（Phase 1.3.1-C2b / 协议运行时 §6.5.2）。
 *
 * ## 这一组用**真** WSS，不是 mock
 *
 * 被测的是「Cloud 在授权事务提交之后，怎么把增量发给设备、怎么等 ack、
 * 失败时怎么 fail-closed」。把 `installGrant` 换成一个 `Promise.resolve(true)`
 * 就只能测到「代码有调用」，测不到「未 ack 不可路由」「applied=false 会停路由」
 * 这些真正要命的语义。
 *
 * 所以这里起的是生产同款 `startCloudServer`，客户端是真正的 `ws`，
 * HTTP 请求走真实端口（`fetch`），整条链路只有 Provider 被绕过——因为本阶段
 * 的起点就是「用户已经站在同意页上」。
 */

const handle = await getTestDb();

let h: LinkHarness;
let userId: string;
let deviceId: string;
let deviceKeys: DeviceKeys;
let deviceToken: string;
let online: OnlineDevice | null = null;

beforeEach(async () => {
  resetRateLimiter();
  h = await createLinkHarness();
  userId = await seedUser(h, "consent-sync");
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

// 连接池全程共用：`createLinkHarness()` 内部用的就是同一个 `getTestDb()`。
afterAll(async () => {
  await closeTestDb();
});

/** 真实 HTTP：`POST /mcp/oauth/consent`。 */
async function postConsent(input: {
  rid: string;
  cookie: string;
  csrf: string;
  decision: string;
  scopes?: readonly string[];
}): Promise<Response> {
  const body = new URLSearchParams();
  body.set("rid", input.rid);
  body.set("csrf", input.csrf);
  body.set("decision", input.decision);
  for (const scope of input.scopes ?? []) body.append("scope", scope);

  return fetch(`http://127.0.0.1:${h.server.port}/mcp/oauth/consent`, {
    method: "POST",
    headers: { cookie: input.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
}

function grantFrames(): Array<Record<string, unknown>> {
  return (online?.frames ?? []).filter((frame) => frame.type === "grant_update");
}

async function grantIdOf(): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`
    select id from mcp_grants where user_id = ${userId}`;
  const id = rows[0]?.id;
  if (!id) throw new Error("no grant for user");
  return id;
}

async function codeOfRedirect(res: Response): Promise<string> {
  const location = res.headers.get("location");
  if (!location) throw new Error(`expected redirect, got ${res.status}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("redirect has no code");
  return code;
}

async function codeRowCount(code: string): Promise<number> {
  const rows = await handle.sql<{ count: string }[]>`
    select count(*)::text as count from mcp_auth_codes where code_hash = ${mcpAuthCodeHash(code)}`;
  return Number(rows[0]?.count ?? "0");
}

describe("在线设备：新建 Grant", () => {
  it("allow → 发 install 帧，ack 之后才返回 302", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const session = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });

    const posting = postConsent({
      rid: session.rid,
      cookie: session.cookie,
      csrf: session.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    // 请求被 ack 挡住：没有 ack 就不会有 302。
    const frame = await online.next((f) => f.type === "grant_update");
    expect(frame.op).toBe("install");
    const snapshot = frame.grant as { grant_id: string; scopes: string[]; bound_user_id: string };
    expect(snapshot.grant_id).toBe(await grantIdOf());
    expect(snapshot.scopes).toEqual(["records:read"]);
    expect(snapshot.bound_user_id).toBe(userId);

    online.send(grantAck(frame.grant_epoch as number, true));
    const res = await posting;
    expect(res.status).toBe(302);
    expect(await codeOfRedirect(res)).toHaveLength(43);
  });

  it("scope 未变时第二次授权不再发帧（不白涨 grant_epoch）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const first = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });
    const posting = postConsent({
      rid: first.rid,
      cookie: first.cookie,
      csrf: first.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, true));
    await posting;

    const second = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });
    const res = await postConsent({
      rid: second.rid,
      cookie: second.cookie,
      csrf: second.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    expect(res.status).toBe(302);
    // 只发出过第一条 install 帧。
    expect(grantFrames()).toHaveLength(1);
    const epochRows = await handle.sql<{ epoch: number }[]>`
      select epoch from mcp_grants where user_id = ${userId}`;
    expect(epochRows[0]!.epoch).toBe(1);
  });

  it("scope 变化 → 先 revoke 旧 ctx，再 install 新 ctx", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });

    const first = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });
    const firstPost = postConsent({
      rid: first.rid,
      cookie: first.cookie,
      csrf: first.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    const install = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(install.grant_epoch as number, true));
    await firstPost;

    const second = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });
    const secondPost = postConsent({
      rid: second.rid,
      cookie: second.cookie,
      csrf: second.csrf,
      decision: "allow",
      scopes: ["records:read", "coffee:read"],
    });

    const revoke = await online.next((f) => f.type === "grant_update" && f.op === "revoke");
    expect(revoke.reason).toBe("scope_changed");
    online.send(grantAck(revoke.grant_epoch as number, true));

    const reinstall = await online.next((f) => f.type === "grant_update" && f.op === "install");
    expect((reinstall.grant as { scopes: string[] }).scopes).toEqual([
      "records:read",
      "coffee:read",
    ]);
    online.send(grantAck(reinstall.grant_epoch as number, true));

    const res = await secondPost;
    expect(res.status).toBe(302);

    const epochs = await handle.sql<{ epoch: number }[]>`
      select epoch from mcp_grants where user_id = ${userId}`;
    expect(epochs[0]!.epoch).toBe(2);
  });
});

describe("同步失败：授权仍然成立", () => {
  it("applied=false → 仍 302 且带 code，但设备进入 syncLag", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const session = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });

    const posting = postConsent({
      rid: session.rid,
      cookie: session.cookie,
      csrf: session.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    const frame = await online.next((f) => f.type === "grant_update");
    online.send(grantAck(frame.grant_epoch as number, false, "protocol_violation"));

    const res = await posting;
    expect(res.status).toBe(302);
    const code = await codeOfRedirect(res);
    // 授权码没有因为同步失败而丢失。
    expect(await codeRowCount(code)).toBe(1);

    const connections = h.link.inspectForwarder().connections;
    expect(connections[0]?.syncLag).toBe(true);
    expect(connections[0]?.syncLagCause).toBe("apply_rejected");
    // 明确拒绝的帧同样不能被记成「已安装」。
    const grantId = await grantIdOf();
    const rejected = connections[0]?.grants.find((entry) => entry.grantId === grantId);
    expect(rejected).toBeTruthy();
    expect(rejected!.installed).toBe(false);

    // 审计记了「同步失败」，但**不是**「授权失败」。
    const audit = await handle.sql<{ event_type: string }[]>`
      select event_type from auth_events
       where event_type in ('mcp_consent_allowed', 'mcp_grant_sync_failed')
       order by event_type`;
    expect(audit.map((row) => row.event_type)).toEqual([
      "mcp_consent_allowed",
      "mcp_grant_sync_failed",
    ]);
  });

  it("ack 超时 → 仍 302，且该 grant 不可派发（绝不当成已安装）", async () => {
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const session = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });

    const posting = postConsent({
      rid: session.rid,
      cookie: session.cookie,
      csrf: session.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    // 收到帧但永不回 ack。
    const frame = await online.next((f) => f.type === "grant_update");
    expect(frame.op).toBe("install");

    // 精确推到 ack deadline（不是真实等待）。
    h.link.sweep(performance.now() + REMOTE_GRANT_ACK_TIMEOUT_MS + 1);

    const res = await posting;
    expect(res.status).toBe(302);
    expect(await codeRowCount(await codeOfRedirect(res))).toBe(1);

    const grantId = await grantIdOf();
    // ★ 直接读转发层的事实：slot 存在但 **installed 必须仍是 false**。
    //
    // 只看派发结果是**不够的**——`syncLag` 也会让派发失败，于是「ack 失败却
    // 被当成已安装」这个 bug 会被 syncLag 掩盖（这正是本用例第一版存活的原因）。
    const slot = h
      .link
      .inspectForwarder()
      .connections[0]?.grants.find((entry) => entry.grantId === grantId);
    expect(slot).toBeTruthy();
    expect(slot!.installed).toBe(false);

    const dispatch = await h.link.dispatchToolCall({
      userId,
      grantId,
      tool: "search_records",
      arguments: {},
    });
    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) expect(dispatch.error.code).toBe("GRANT_CONTEXT_INVALID");
  });
});

describe("离线设备", () => {
  it("没有在线设备 → 不同步、不报错；重新握手时 hello_ok 带着这条 grant", async () => {
    const session = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });

    const res = await postConsent({
      rid: session.rid,
      cookie: session.cookie,
      csrf: session.csrf,
      decision: "allow",
      scopes: ["records:read", "coffee:read"],
    });
    expect(res.status).toBe(302);
    const code = await codeOfRedirect(res);
    expect(await codeRowCount(code)).toBe(1);

    const grantId = await grantIdOf();
    const grants = await handle.sql<{ scopes: string[]; epoch: number }[]>`
      select scopes, epoch from mcp_grants where id = ${grantId}`;
    expect(grants[0]!.scopes).toEqual(["records:read", "coffee:read"]);

    // 设备上线：快照来自数据库，不依赖那次失败的在线同步。
    online = await goOnline(h, { deviceId, deviceToken, keys: deviceKeys });
    const helloOk = online.frames.find((frame) => frame.type === "hello_ok");
    expect(helloOk).toBeTruthy();
    const snapshot = helloOk!.grants as Array<{ grant_id: string; scopes: string[] }>;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.grant_id).toBe(grantId);
    expect(snapshot[0]!.scopes).toEqual(["records:read", "coffee:read"]);

    // 快照装进来的 ctx 立刻可派发（这是 hello_ok 作为同步屏障的语义）。
    const dispatch = h.link.dispatchToolCall({ userId, grantId, tool: "search_records", arguments: {} });
    const started = await Promise.race([
      online.next((frame) => frame.type === "req").then((frame) => ({ kind: "req" as const, frame })),
      dispatch.then((result) => ({ kind: "result" as const, result })),
    ]);
    if (started.kind === "result") {
      throw new Error(`dispatch finished without a req frame: ${JSON.stringify(started.result)}`);
    }
    const req = started.frame;
    online.send({
      v: 1,
      type: "res",
      id: req.id,
      ts: Date.now(),
      ok: true,
      data: { from: "snapshot" },
      meta: { duration_ms: 1, cached: false },
    });
    expect((await dispatch).ok).toBe(true);
  });

  it("拒绝不会碰到任何 grant（离线也不写库）", async () => {
    const session = await seedConsentRow(handle.sql, h.ctx.env, {
      userId,
      resource: mcpResourceFor(h.ctx.env.baseUrl),
    });
    const res = await postConsent({
      rid: session.rid,
      cookie: session.cookie,
      csrf: session.csrf,
      decision: "deny",
    });

    expect(res.status).toBe(302);
    const grants = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_grants where user_id = ${userId}`;
    expect(grants[0]?.count).toBe("0");
  });
});
