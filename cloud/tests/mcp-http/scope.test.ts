import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpHttpHarness,
  jsonBody,
  legacyRequest,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  rpcError,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";
import { REMOTE_TOOLS, toolsForScopes } from "../../src/mcp-http/tools.js";
import { MCP_SCOPES } from "../../src/mcp-oauth/constants.js";

/**
 * D. Scope 与最小权限（Phase 1.3.2，设计 §5.8 / §9.7，任务书 §七）。
 *
 * - `tools/list` **不要求**业务 scope，但要求有效 Session + Grant：返回按
 *   effective scope 过滤的子集；无 scope → 空数组（**不是 403**）。
 * - `tools/call` 按工具映射检查；缺 → 403 + `insufficient_scope` + **只报缺的
 *   那一个** scope；**先检查后派发**（缺权限时 dispatch 一次都不发生）。
 * - effective = `token.scope ∩ session.issued_scope ∩ grant.scopes`——grant
 *   被收窄立刻反映，不等 token 过期。
 */

const handle = await getTestDb();

let h: McpHttpHarness;
let fullToken: string;

const ALL_SCOPES = "records:read tags:read coffee:read canvas:read";
const RESOURCE_METADATA = 'resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp"';

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  h = await createMcpHttpHarness();
  fullToken = (await obtainMcpBearer(h, { scope: ALL_SCOPES })).accessToken;
});

afterAll(async () => {
  await closeTestDb();
});

function modern(method: string, params: Record<string, unknown>, token: string, name?: string): Request {
  return modernRequest(
    { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params: { ...params, _meta: modernEnvelope() } },
    { token, ...(name ? { mcpName: name } : {}) },
  );
}

async function listToolNames(token: string): Promise<string[]> {
  const res = await h.app.request(modern("tools/list", {}, token));
  expect(res.status).toBe(200);
  const body = await jsonBody(res);
  expect(rpcError(body)).toBeNull();
  return ((body.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort();
}

async function callTool(
  tool: string,
  token: string,
  args: Record<string, unknown> = {},
): Promise<Response> {
  return h.app.request(modern("tools/call", { name: tool, arguments: args }, token, tool));
}

describe("tools/list 按 effective scope 过滤", () => {
  it("records:read 的 token 只看到 search_records + get_record（不是 403）", async () => {
    const token = (await obtainMcpBearer(h, { scope: "records:read" })).accessToken;
    expect(await listToolNames(token)).toEqual(["get_record", "search_records"]);
  });

  it("tags:read 的 token 只看到 list_record_tags", async () => {
    const token = (await obtainMcpBearer(h, { scope: "tags:read" })).accessToken;
    expect(await listToolNames(token)).toEqual(["list_record_tags"]);
  });

  it("全 scope → 8 个；canvas:read 的 token 只看到 2 个 canvas 工具", async () => {
    expect(await listToolNames(fullToken)).toHaveLength(8);
    const canvas = (await obtainMcpBearer(h, { scope: "canvas:read" })).accessToken;
    expect(await listToolNames(canvas)).toEqual(["get_canvas", "list_canvases"]);
  });

  it("grant.scopes 被置空 → tools/list 200 且返回空数组（不是 -32601、不是 403）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: ALL_SCOPES });
    await handle.sql`
      update mcp_grants set scopes = array[]::text[] where user_id = ${bearer.userId}`;

    const res = await h.app.request(modern("tools/list", {}, bearer.accessToken));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(rpcError(body)).toBeNull();
    expect((body.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it("无业务 scope 也能 discover / initialize（§5.8.1）", async () => {
    const token = (await obtainMcpBearer(h, { scope: "records:read" })).accessToken;
    const discover = await h.app.request(modern("server/discover", {}, token));
    expect(discover.status).toBe(200);

    const init = await h.app.request(
      legacyRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "c", version: "1" },
          },
        },
        { token },
      ),
    );
    expect(init.status).toBe(200);
  });
});

describe("tools/call 的 scope 检查（先检查、后派发）", () => {
  it("records:read 调 list_beans → 403，challenge 只含 coffee:read", async () => {
    const token = (await obtainMcpBearer(h, { scope: "records:read" })).accessToken;
    const res = await callTool("list_beans", token);

    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toBe(
      `Bearer error="insufficient_scope", scope="coffee:read", ${RESOURCE_METADATA}`,
    );
    // 只报**缺的那一个**：不得把全部 scope 或已持有的 scope 塞进来。
    expect(challenge).not.toContain("records:read");
    expect(challenge).not.toContain("tags:read");
    expect(challenge).not.toContain("canvas:read");
    // 403 不是 JSON-RPC 协议错误：无 JSON-RPC 体。
    expect((await res.text()).length).toBe(0);
    // 未授权工具**绝不执行**（一次 dispatch 都没有）。
    expect(h.link.calls).toHaveLength(0);
  });

  it("records:read 调 list_canvases → 403 只报 canvas:read", async () => {
    const token = (await obtainMcpBearer(h, { scope: "records:read" })).accessToken;
    const res = await callTool("list_canvases", token);
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('scope="canvas:read"');
    expect(challenge).not.toContain("coffee:read");
    expect(h.link.calls).toHaveLength(0);
  });

  it("grant 收窄后旧 token 立即缺 scope：list_beans 从可用变 403", async () => {
    const bearer = await obtainMcpBearer(h, { scope: ALL_SCOPES });
    const ok = await callTool("list_beans", bearer.accessToken);
    expect(ok.status).toBe(200);
    expect(h.link.calls).toHaveLength(1);

    await handle.sql`
      update mcp_grants set scopes = array['records:read'] where user_id = ${bearer.userId}`;

    const denied = await callTool("list_beans", bearer.accessToken);
    expect(denied.status).toBe(403);
    expect((denied.headers.get("www-authenticate") ?? "")).toContain('scope="coffee:read"');
    expect(h.link.calls).toHaveLength(1); // 收窄后没有新增派发
  });

  it("未知/写工具（create_record）不会被注册，也绝不派发", async () => {
    const names = await listToolNames(fullToken);
    expect(names).not.toContain("create_record");
    expect(names).not.toContain("update_record");
    expect(names).not.toContain("create_canvas");

    const res = await callTool("create_record", fullToken, { carrier: "text" });
    // SDK 对未注册工具给出协议内错误（不进入 Cloud 派发）。
    expect(h.link.calls).toHaveLength(0);
    const body = await jsonBody(res);
    const failed = rpcError(body) !== null || (body.result as { isError?: boolean } | undefined)?.isError === true;
    expect(failed || res.status >= 400).toBe(true);
  });
});

describe("step-up（§5.8.4 服务端语义）", () => {
  it("403 → 重新授权拿到 union scope 的新 token → 同一工具成功；不重授已授予项", async () => {
    // 第一次：只授 records:read。
    const first = await obtainMcpBearer(h, { scope: "records:read" });
    const denied = await callTool("list_beans", first.accessToken);
    expect(denied.status).toBe(403);
    expect(h.link.calls).toHaveLength(0);

    // 第二步（客户端行为）：union = 已持有 ∪ {coffee:read} → 重新 authorize + consent。
    const second = await obtainMcpBearer(h, { scope: "records:read coffee:read" });
    expect(second.userId).toBe(first.userId); // 同一用户、同一 client

    // 已有 scope 保留 + 新 scope 生效。
    expect(await listToolNames(second.accessToken)).toEqual([
      "get_record",
      "list_beans",
      "list_brews",
      "list_tastings",
      "search_records",
    ]);
    const allowed = await callTool("list_beans", second.accessToken);
    expect(allowed.status).toBe(200);
    expect(h.link.calls).toHaveLength(1);

    // Grant 是并集且 epoch 递增（consent step-up 的既有语义，不重授也在这里可见）。
    const grants = await handle.sql<{ scopes: string[]; epoch: number }[]>`
      select scopes, epoch from mcp_grants where user_id = ${first.userId}`;
    expect(grants[0]?.scopes.sort()).toEqual(["coffee:read", "records:read"]);
    expect(grants[0]?.epoch).toBeGreaterThanOrEqual(2);

    // scope 只能来自已定义集合：两次授权的 scope 都在 MCP_SCOPES 内。
    for (const value of grants[0]?.scopes ?? []) {
      expect(MCP_SCOPES).toContain(value);
    }
  });
});

describe("工具面过滤的纯函数", () => {
  it("toolsForScopes 精确过滤；全集 = REMOTE_TOOLS；无交集 = []", () => {
    expect(toolsForScopes(["records:read"]).map((t) => t.name)).toEqual([
      "search_records",
      "get_record",
    ]);
    expect(toolsForScopes(ALL_SCOPES.split(" "))).toHaveLength(REMOTE_TOOLS.length);
    expect(toolsForScopes([])).toEqual([]);
  });
});
