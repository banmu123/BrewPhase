import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpHttpHarness,
  jsonBody,
  legacyRequest,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  parseSse,
  rpcError,
  bareRequest,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";

/**
 * A. 协议面（Phase 1.3.2，设计 §1.3 / §3 / §4.6）。
 *
 * 双时代全部由 SDK `createMcpHandler(..., { legacy: "stateless" })` 产出——
 * 本组是「Cloud 没有重新实现一套 Transport」的直接证据：`-32020` / `-32022` /
 * `-32601` / 405 / 202 的形状与设计 §1.3 的实测表逐行对应。
 */

const handle = await getTestDb();

let h: McpHttpHarness;
let token: string;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  h = await createMcpHttpHarness();
  // 默认给全 4 个 scope（本组断言「8 个工具」）；按 scope 过滤的子集由 D 组覆盖。
  token = (
    await obtainMcpBearer(h, { scope: "records:read tags:read coffee:read canvas:read" })
  ).accessToken;
});

afterAll(async () => {
  await closeTestDb();
});

/** 直接把构造好的 Request 交给 app（保留自定义头）。 */
async function send(request: Request): Promise<Response> {
  return h.app.request(request);
}

describe("双时代协议（modern 2026-07-28 / legacy 2025-06-18）", () => {
  it("modern：server/discover → 200 JSON，supportedVersions 含 2026-07-28", async () => {
    const res = await send(
      modernRequest(
        { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernEnvelope() } },
        { token },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull(); // 不生成协议层会话
    const body = await jsonBody(res);
    expect(rpcError(body)).toBeNull();
    expect((body.result as { supportedVersions: string[] }).supportedVersions).toContain("2026-07-28");
    const serverInfo = (body.result as { _meta?: Record<string, { name?: string }> })["_meta"]?.[
      "io.modelcontextprotocol/serverInfo"
    ];
    expect(serverInfo?.name).toBe("brewphase");
  });

  it("legacy：initialize → 200 SSE，回显 protocolVersion，无 Mcp-Session-Id", async () => {
    const res = await send(
      legacyRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy-client", version: "1.0.0" },
          },
        },
        { token },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const message = parseSse(await res.text());
    expect((message.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    expect((message.result as { serverInfo: { name: string } }).serverInfo.name).toBe("brewphase");
  });

  it("modern：tools/list 返回 8 个工具（无 cursor 分页截断）", async () => {
    const res = await send(
      modernRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernEnvelope() } },
        { token },
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(8);
    expect(new Set(tools.map((t) => t.name)).size).toBe(8);
  });

  it("legacy：tools/list 返回同样的 8 个工具（SSE 形态）", async () => {
    const res = await send(legacyRequest({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const message = parseSse(await res.text());
    const tools = (message.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(8);
  });

  it("modern：tools/call search_records → 200 且经由 dispatchToolCall", async () => {
    const res = await send(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "search_records", arguments: { search: "ethiopia" }, _meta: modernEnvelope() },
        },
        { token, mcpName: "search_records" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(rpcError(body)).toBeNull();
    expect((body.result as { isError?: boolean }).isError).toBeUndefined();
    expect(h.link.calls).toHaveLength(1);
    expect(h.link.calls[0]?.tool).toBe("search_records");
  });

  it("legacy：tools/call → 200 SSE，结果可达", async () => {
    const res = await send(
      legacyRequest(
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_canvases", arguments: {} } },
        { token },
      ),
    );
    expect(res.status).toBe(200);
    const message = parseSse(await res.text());
    expect(message.result).toBeTruthy();
    expect(h.link.calls.map((c) => c.tool)).toContain("list_canvases");
  });
});

describe("协议层错误（-32020 / -32022 / -32601 / 405 / 202）", () => {
  it("Mcp-Method 头与 body 不一致 → 400 + -32020（HeaderMismatch）", async () => {
    const res = await send(
      modernRequest(
        { jsonrpc: "2.0", id: 10, method: "tools/list", params: { _meta: modernEnvelope() } },
        { token, mcpMethodHeader: "tools/call" },
      ),
    );
    expect(res.status).toBe(400);
    const err = rpcError(await jsonBody(res));
    expect(err?.code).toBe(-32020);
  });

  it("MCP-Protocol-Version 头与信封版本不一致 → 400 + -32020", async () => {
    const res = await send(
      modernRequest(
        { jsonrpc: "2.0", id: 11, method: "server/discover", params: { _meta: modernEnvelope() } },
        { token, protocolVersionHeader: "2025-11-25" },
      ),
    );
    expect(res.status).toBe(400);
    const err = rpcError(await jsonBody(res));
    expect(err?.code).toBe(-32020);
  });

  it("不支持的 protocolVersion → 400 + -32022，data.supported 指明 2026-07-28", async () => {
    const res = await send(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "server/discover",
          params: { _meta: modernEnvelope("1900-01-01") },
        },
        { token, protocolVersionHeader: "1900-01-01" },
      ),
    );
    expect(res.status).toBe(400);
    const err = rpcError(await jsonBody(res));
    // 信封命名未知版本：-32022（UnsupportedProtocolVersion）且带 data.supported。
    expect(err?.code).toBe(-32022);
    const data = err?.data as { supported?: string[]; requested?: string };
    expect(data?.supported).toEqual(["2026-07-28"]);
    expect(data?.requested).toBe("1900-01-01");
  });

  it("未知方法 → 404 + -32601", async () => {
    const res = await send(
      modernRequest(
        { jsonrpc: "2.0", id: 13, method: "bogus/method", params: { _meta: modernEnvelope() } },
        { token },
      ),
    );
    expect(res.status).toBe(404);
    const err = rpcError(await jsonBody(res));
    expect(err?.code).toBe(-32601);
  });

  it("GET / DELETE → 恒 405（无 SSE、无会话），且不需要 Bearer", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await send(bareRequest(method)); // 无 token
      expect(res.status, method).toBe(405);
      const err = rpcError(await jsonBody(res));
      expect(err?.code, method).toBe(-32000);
      expect(res.headers.get("mcp-session-id")).toBeNull();
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("legacy notification → 202（空体）", async () => {
    const res = await send(
      legacyRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, { token }),
    );
    expect(res.status).toBe(202);
    expect((await res.text()).length).toBe(0);
  });

  it("整个协议面不出现 Mcp-Session-Id（stateless，不生成协议层会话）", async () => {
    const responses = await Promise.all([
      send(
        modernRequest(
          { jsonrpc: "2.0", id: 20, method: "server/discover", params: { _meta: modernEnvelope() } },
          { token },
        ),
      ),
      send(legacyRequest({ jsonrpc: "2.0", id: 21, method: "tools/list" }, { token })),
      send(
        modernRequest(
          { jsonrpc: "2.0", id: 22, method: "tools/list", params: { _meta: modernEnvelope() } },
          { token },
        ),
      ),
    ]);
    for (const res of responses) {
      expect(res.headers.get("mcp-session-id")).toBeNull();
    }
  });
});
