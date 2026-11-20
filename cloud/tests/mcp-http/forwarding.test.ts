import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { mcpSessions } from "../../src/db/schema.js";
import { signMcpAccessToken } from "../../src/mcp-oauth/tokens.js";
import { mcpResourceFor } from "../../src/mcp-oauth/constants.js";
import { createLinkHarness, type LinkHarness } from "../helpers/link-server.js";
import { goOnline, seedDevice, seedGrant, seedUser, type OnlineDevice } from "../helpers/forward.js";
import {
  createMcpHttpHarness,
  jsonBody,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  rpcError,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";
import { REMOTE_TOOLS } from "../../src/mcp-http/tools.js";

/**
 * E. 转发面（Phase 1.3.2，任务书 §6）。
 *
 * - 所有工具**只**经 `ctx.link.dispatchToolCall`（userId 来自 JWT sub，
 *   grantId 来自已回查的 Session，arguments 是过完 schema 的原值）；
 * - 不在线 / 超时 / 无 link → `isError: true` 的**工具结果**（§6.4：不用
 *   JSON-RPC 协议错误表达业务失败，AI 客户端能读到原因并重试）；
 * - 请求取消把 AbortSignal 透传给派发（§4.4）；
 * - 最后一条用**真实 WSS + 真实 PostgreSQL** 走通
 *   `/mcp → 真实 forwarder → 在线设备 → res` 的完整链路（R1/R2 语义一字未改）。
 */

const handle = await getTestDb();

let h: McpHttpHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  h = await createMcpHttpHarness();
});

afterAll(async () => {
  await closeTestDb();
});

function call(
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Request {
  return modernRequest(
    {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: tool, arguments: args, _meta: modernEnvelope() },
    },
    { token, mcpName: tool },
  );
}

const FULL_SCOPES = "records:read tags:read coffee:read canvas:read";

/** 每个工具的**合法最小参数**（uuid 形态，供 schema 校验通过）。 */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  search_records: { search: "ethiopia" },
  get_record: { record_id: "3f1a5b2c-9d8e-4f7a-b6c5-4e3d2a1b0c9d" },
  list_record_tags: {},
  list_beans: {},
  list_brews: {},
  list_tastings: {},
  list_canvases: {},
  get_canvas: { canvas_id: "3f1a5b2c-9d8e-4f7a-b6c5-4e3d2a1b0c9d" },
};

describe("dispatchToolCall 是唯一出口", () => {
  it("8 个工具全部经由 dispatchToolCall，入参逐项正确", async () => {
    const bearer = await obtainMcpBearer(h, { scope: FULL_SCOPES });

    for (const tool of REMOTE_TOOLS) {
      const res = await h.app.request(call(bearer.accessToken, tool.name, VALID_ARGS[tool.name] ?? {}));
      expect(res.status, tool.name).toBe(200);
      const body = await jsonBody(res);
      expect(rpcError(body), tool.name).toBeNull();
      expect((body.result as { isError?: boolean }).isError, tool.name).toBeUndefined();
    }

    expect(h.link.calls).toHaveLength(REMOTE_TOOLS.length);
    for (const [index, tool] of REMOTE_TOOLS.entries()) {
      const input = h.link.calls[index]!;
      expect(input.tool).toBe(tool.name);
      // userId 只来自 JWT sub；grantId 只来自已回查的 Session。
      expect(input.userId).toBe(bearer.userId);
      expect(input.grantId).toBeTruthy();
      expect(input.arguments).toEqual(VALID_ARGS[tool.name] ?? {});
      expect(input.signal === undefined || input.signal instanceof AbortSignal).toBe(true);
    }
    // 8 个工具名无重复、无写工具混入。
    const names = h.link.calls.map((c) => c.tool);
    expect(new Set(names).size).toBe(8);
    expect(names).not.toContain("create_record");
  });

  it("设备不在线（派发失败 DEVICE_OFFLINE）→ 200 + isError 工具结果（不是 JSON-RPC 错误）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    h.link.setDispatch(() => ({
      ok: false,
      error: { code: "DEVICE_OFFLINE", message: "no active device connection for this user", retryable: true },
    }));

    const res = await h.app.request(call(bearer.accessToken, "search_records", {}));
    expect(res.status).toBe(200); // §6.4：业务失败不走协议错误
    const body = await jsonBody(res);
    expect(rpcError(body)).toBeNull();
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DEVICE_OFFLINE");
    expect(result.content[0]?.text).toContain('"retryable":true');
  });

  it("转发超时（REQUEST_TIMEOUT）→ 200 + isError，可重试标志原样带出", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    h.link.setDispatch(() => ({
      ok: false,
      error: { code: "REQUEST_TIMEOUT", message: "deadline exceeded", retryable: true },
    }));

    const res = await h.app.request(call(bearer.accessToken, "search_records", {}));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("REQUEST_TIMEOUT");
  });

  it("ctx.link 缺失（HTTP-only 场景）→ fail-closed DEVICE_OFFLINE，不抛异常", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const real = h.ctx.link;
    h.ctx.link = undefined;
    try {
      const res = await h.app.request(call(bearer.accessToken, "search_records", {}));
      expect(res.status).toBe(200); // 不是 500：结构性离线也是工具级结果
      const body = await jsonBody(res);
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("DEVICE_OFFLINE");
    } finally {
      h.ctx.link = real; // 恢复，避免影响后续用例
    }
  });

  it("请求取消把 AbortSignal 透传给 dispatchToolCall", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const controller = new AbortController();
    let captured: AbortSignal | undefined;

    h.link.setDispatch((input) => {
      captured = input.signal;
      // 模拟「派发在途时客户端断开」：先拿到 signal，再触发取消。
      controller.abort();
      return { ok: true, data: { cancelled: true }, meta: { duration_ms: 1, cached: false } };
    });

    const request = modernRequest(
      {
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: { name: "search_records", arguments: {}, _meta: modernEnvelope() },
      },
      { token: bearer.accessToken, mcpName: "search_records", signal: controller.signal },
    );
    // 取消发生在交换中途：响应形态由 SDK 决定（可能中断），这里只断言 signal 已透传。
    await Promise.resolve(h.app.request(request)).catch(() => undefined);

    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
    expect(h.link.calls).toHaveLength(1);
    expect(h.link.calls[0]?.signal).toBe(captured);
  });

  it("Grant 撤销后新调用在 Cloud 侧被 403 拦下（不进入派发）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const before = h.link.calls.length;

    await handle.sql`
      update mcp_grants set revoked_at = now() where user_id = ${bearer.userId}`;
    const res = await h.app.request(call(bearer.accessToken, "search_records", {}));
    expect(res.status).toBe(403);
    expect(h.link.calls.length).toBe(before);
  });
});

describe("真实 WSS 链路（真实 PostgreSQL + 真实 forwarder）", () => {
  let lh: LinkHarness;
  let online: OnlineDevice | null = null;

  beforeEach(async () => {
    lh = await createLinkHarness();
  });

  afterEach(async () => {
    online?.close();
    online = null;
    await lh.close();
  });

  it("/mcp tools/call → 真实派发 → 设备 res → 结果回到客户端", async () => {
    const userId = await seedUser(lh, "mcp-e2e");
    const device = await seedDevice(lh, userId);
    const grantId = await seedGrant(lh, userId, {
      clientId: "chatgpt",
      scopes: ["records:read"],
    });
    // 快照装载即 installed（协议 §6.5.1：hello_ok 是同步屏障，不需要 ack）。
    online = await goOnline(lh, device);

    const resource = mcpResourceFor(lh.ctx.env.baseUrl);
    const sessionRows = await lh.ctx.db.db
      .insert(mcpSessions)
      .values({
        userId,
        grantId,
        clientId: "chatgpt",
        issuedScope: ["records:read"],
        resource,
        absoluteExpiresAt: new Date(Date.now() + 90 * 24 * 3600_000),
      })
      .returning({ id: mcpSessions.id });
    const sessionId = sessionRows[0]!.id;

    const token = await signMcpAccessToken(
      lh.ctx.keyRing,
      { userId, sessionId, clientId: "chatgpt", scope: ["records:read"] },
      { issuer: lh.ctx.env.baseUrl, resource, ttlSeconds: 900 },
    );

    // 真实 HTTP（Host = 127.0.0.1:<port> → normalizeHost → 白名单内）。
    const pending = fetch(`http://127.0.0.1:${lh.server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "search_records",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_records",
          arguments: { search: "ethiopia", limit: 5 },
          _meta: modernEnvelope(),
        },
      }),
    });

    // 设备收到真实 req 帧（R1 线格式不变）。
    const req = await online.next((f) => f.type === "req");
    expect(req.tool).toBe("search_records");
    expect(req.id).toMatch(/^req_/);
    expect(req.grant_ctx).toBeTruthy();
    expect(req.deadline_ms).toBeGreaterThan(Date.now());
    expect((req.arguments as { search: string }).search).toBe("ethiopia");

    online.send({
      v: 1,
      type: "res",
      id: req.id,
      ts: Date.now(),
      ok: true,
      data: { items: [{ id: "r1", title: "Ethiopia" }], limit: 5, offset: 0, has_more: false },
      meta: { duration_ms: 7, cached: false },
    });

    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain("Ethiopia");
  });

  it("设备离线（未连接）→ DEVICE_OFFLINE 工具结果（真实 forwarder 的判定）", async () => {
    const userId = await seedUser(lh, "mcp-offline");
    const device = await seedDevice(lh, userId);
    const grantId = await seedGrant(lh, userId, { clientId: "chatgpt", scopes: ["records:read"] });
    // 不 goOnline：grant 在库里，但没有任何连接。
    const resource = mcpResourceFor(lh.ctx.env.baseUrl);
    const sessionRows = await lh.ctx.db.db
      .insert(mcpSessions)
      .values({
        userId,
        grantId,
        clientId: "chatgpt",
        issuedScope: ["records:read"],
        resource,
        absoluteExpiresAt: new Date(Date.now() + 90 * 24 * 3600_000),
      })
      .returning({ id: mcpSessions.id });
    const token = await signMcpAccessToken(
      lh.ctx.keyRing,
      { userId, sessionId: sessionRows[0]!.id, clientId: "chatgpt", scope: ["records:read"] },
      { issuer: lh.ctx.env.baseUrl, resource, ttlSeconds: 900 },
    );

    const res = await fetch(`http://127.0.0.1:${lh.server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "search_records",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_records", arguments: {}, _meta: modernEnvelope() },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("DEVICE_OFFLINE");
    void device;
  });
});
