import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  MCP_HOST,
  createMcpHttpHarness,
  jsonBody,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  rpcError,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";
import {
  MCP_HTTP_BODY_READ_TIMEOUT_MS,
  MCP_HTTP_MAX_BODY_BYTES,
  readBoundedMcpBody,
} from "../../src/mcp-http/guards.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";

/**
 * HTTP 入口闸门与限流（Phase 1.3.2，任务书 §四 / §八）。
 *
 * 顺序是契约：**大小 → Host → Origin → Bearer → …**——用「同时违反两项」的
 * 请求断言「先撞哪一项」，防止有人把检查挪后。
 */

const handle = await getTestDb();

let h: McpHttpHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpHttpHarness({ corsOrigins: ["https://allowed.example"] });
});

afterAll(async () => {
  await closeTestDb();
});

function discover(token: string, headers: Record<string, string> = {}): Request {
  return modernRequest(
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernEnvelope() } },
    { token, headers },
  );
}

describe("Host / Origin / 大小闸门", () => {
  it("Host 不在白名单 → 403（-32000），且发生在认证之前（无 token 也是 Host 先拒）", async () => {
    const res = await h.app.request(discover("", { host: "evil.example" }));
    expect(res.status).toBe(403);
    const err = rpcError(await jsonBody(res));
    expect(err?.code).toBe(-32000);
    expect(err?.message).toContain("Host");
    // 无 Bearer 的请求本应 401——先撞 Host 说明顺序是 Host → Bearer。
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("大小 → Host → Origin 的顺序：声明超限的 body + 坏 Host → 413（大小最先）", async () => {
    // Content-Length 是第一步的判据（HTTP/1.1 下声明值不可被正文超出或少报：
    // 解析器按它定帧）。Fetch 的 Request.headers 不自动带 content-length，
    // 这里显式声明一个超限值——正是「先撞大小、还没到 Host」的顺序证明。
    const res = await h.app.request(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: {
          host: "evil.example",
          "content-type": "application/json",
          accept: "application/json",
          "content-length": String(MCP_HTTP_MAX_BODY_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/plain"); // §4.6：纯文本
  });

  it("坏 Host + 坏 Origin → 403 Host（Host 先于 Origin）", async () => {
    const res = await h.app.request(
      discover("", { host: "evil.example", origin: "https://other.example" }),
    );
    expect(res.status).toBe(403);
    const err = rpcError(await jsonBody(res));
    expect(err?.message).toContain("Host");
  });

  it("Origin 不在白名单 → 403（-32000）；Host 正确", async () => {
    const res = await h.app.request(discover("", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    const err = rpcError(await jsonBody(res));
    expect(err?.code).toBe(-32000);
    expect(err?.message).toContain("Origin");
  });

  it("Origin 在白名单 → 通过认证正常响应；无 Origin（服务端调用）→ 也通过", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const withOrigin = await h.app.request(
      discover(bearer.accessToken, { origin: "https://allowed.example" }),
    );
    expect(withOrigin.status).toBe(200);

    const withoutOrigin = await h.app.request(discover(bearer.accessToken));
    expect(withoutOrigin.status).toBe(200);
  });

  it("Origin 大小写不敏感比较，但不接受白名单外的 scheme 降级", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const upper = await h.app.request(
      discover(bearer.accessToken, { origin: "https://Allowed.example" }),
    );
    expect(upper.status).toBe(200);

    // 只列了 https://allowed.example —— http:// 同 host 不算同一个 origin。
    const downgrade = await h.app.request(
      discover(bearer.accessToken, { origin: "http://allowed.example" }),
    );
    expect(downgrade.status).toBe(403);
  });

  it("正确的 Host 通过（端口不影响判定，与 WSS 的 normalizeHost 一致）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const res = await h.app.request(discover(bearer.accessToken, { host: `${MCP_HOST}:443` }));
    expect(res.status).toBe(200);
  });
});

describe("独立限流桶（RATE_LIMIT_MAX_MCP）", () => {
  it("超过 maxMcp → 429 + Retry-After", async () => {
    await resetRateLimiter();
    const limited = await createMcpHttpHarness({ maxMcp: 2 });
    const bearer = await obtainMcpBearer(limited, { scope: "records:read" });

    for (let i = 0; i < 2; i += 1) {
      const ok = await limited.app.request(discover(bearer.accessToken));
      expect(ok.status, `request ${i + 1}`).toBe(200);
    }
    const blocked = await limited.app.request(discover(bearer.accessToken));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("与浏览器授权桶互不干扰：授权桶打满不影响 /mcp，反之亦然", async () => {
    await resetRateLimiter();
    // token 先用默认限流的 harness 拿（授权流程要跨 5 个请求，maxAuthorize=1 会
    // 打断它）；token 与 keyRing / DB 都是共享的，跨 harness 有效。
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });

    const mixed = await createMcpHttpHarness({ maxMcp: 2, rateLimit: { maxAuthorize: 1 } });

    // 授权桶上限 1：打一次 authorize（400 也会计数——限流在 handler 之前）。
    const authorize = await mixed.app.request("/mcp/oauth/authorize?response_type=code");
    expect(authorize.status).toBe(400);
    // 再打一次 authorize → 429（授权桶满）。
    const authorize2 = await mixed.app.request("/mcp/oauth/authorize?response_type=code");
    expect(authorize2.status).toBe(429);

    // 但 /mcp 桶（maxMcp=2）不受影响：两次都 200。
    expect((await mixed.app.request(discover(bearer.accessToken))).status).toBe(200);
    expect((await mixed.app.request(discover(bearer.accessToken))).status).toBe(200);
    // /mcp 自己的桶随后打满 → 429。
    expect((await mixed.app.request(discover(bearer.accessToken))).status).toBe(429);
  });
});

describe("启用边界", () => {
  it("MCP OAuth 未启用时 /mcp 与 /mcp/oauth 同时 404（不允许 OAuth 关、MCP 开）", async () => {
    const disabled = await createMcpHttpHarness({
      env: { mcpBrowserSessionKey: undefined },
    });
    const res = await disabled.app.request("/mcp", {
      method: "POST",
      headers: { host: MCP_HOST, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    });
    expect(res.status).toBe(404);
    const oauth = await disabled.app.request("/mcp/oauth/authorize?response_type=code");
    expect(oauth.status).toBe(404);
  });
});


/* ========================================================================== *
 * P1：请求体实际字节硬上限（R1，任务书 §三 / §四）
 *
 * 修复前只信 Content-Length，且 Scope 预检用 request.clone().text() 无上限
 * 缓冲——chunked（无 CL）请求可在预检阶段被完整读入。现在一切 POST 都先经
 * readBoundedMcpBody()：流式累计字节、超限立即停读 + 取消底层流。
 * ========================================================================== */

/** 造一个**无 Content-Length** 的流式 POST：每块 64 KiB，共 chunks 块。 */
function streamPost(
  chunks: number,
  options: { headers?: Record<string, string> } = {},
): { request: Request; state: { pulled: number; cancelled: boolean } } {
  const CHUNK = 64 * 1024;
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      controller.enqueue(new Uint8Array(CHUNK));
      if (state.pulled >= chunks) controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const request = new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      host: MCP_HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...options.headers,
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, state };
}

/** 造一个**无 Content-Length** 的流式 POST：正文 = 一段 JSON 文本（单块）。 */
function textStreamPost(
  bodyText: string,
  headers: Record<string, string>,
): Request {
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      host: MCP_HOST,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyText));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("P1：无 Content-Length 的请求体硬上限", () => {
  it("测试 A：无 CL 的 1 MiB 超限 + 非法 Host + 无 Bearer → 413（先于一切），流被提前取消", async () => {
    const CHUNK = 64 * 1024;
    // 16 块 = 1 MiB（远超 256 KiB）；Host 故意非法、不带 Bearer。
    const { request, state } = streamPost(16, { headers: { host: "evil.example" } });
    const res = await h.app.request(request);

    // 413，且**不是** Host 的 403、**不是** Bearer 的 401——大小最先。
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("www-authenticate")).toBeNull();
    // 我们自己的纯文本响应 = 未进入 SDK（SDK 的 413/400 都是 JSON-RPC 形态）。
    expect(await res.text()).toBe("request body too large");
    // 没有任何工具/处理器日志（SDK 与业务逻辑都没跑）。
    expect(h.logs.filter((l) => l.message === "mcp_tool_call")).toHaveLength(0);

    // 底层流在超限后被取消，且**读取量有硬上限**：
    // 4 块 = 256 KiB（≤ 上限，缓冲进正文），第 5 块跨过上限 → 立即 cancel。
    // 允许的第 6 次 pull 是流的 HWM 预取（chunk 进入**流内部队列**，从未进入
    // 我们的缓冲，cancel 时被丢弃）——送达块数与预取次数由流实现决定，
    // 因此断言区间而不是精确值；关键是远小于总长且跨限即停。
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeGreaterThanOrEqual(5); // 至少读到跨限那一块
    expect(state.pulled).toBeLessThanOrEqual(6); // 至多 +1 次预取
    expect(state.pulled * CHUNK).toBeLessThan(512 * 1024); // < 512 KiB
    expect(state.pulled * CHUNK).toBeLessThan(16 * CHUNK); // 绝没读完 1 MiB
  });

  it("测试 B：无 CL 的合法请求（modern discover / tools/call 参数原样 / legacy initialize）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });

    // 1) modern discover（流式正文，无 Content-Length）
    const discoverRes = await h.app.request(
      textStreamPost(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "server/discover",
          params: { _meta: modernEnvelope() },
        }),
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
          authorization: `Bearer ${bearer.accessToken}`,
        },
      ),
    );
    expect(discoverRes.status).toBe(200);
    const discoverBody = (await discoverRes.json()) as { result: { supportedVersions: string[] } };
    expect(discoverBody.result.supportedVersions).toContain("2026-07-28");

    // 2) modern tools/call：SDK 收到**完整正文**，参数逐项原样到达派发层
    const callBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "search_records",
        arguments: { search: "ethiopia", limit: 3 },
        _meta: modernEnvelope(),
      },
    });
    // 逐块喂：每块 64 KiB（首块含全部 JSON，其余为空填充）——模拟真实 chunked。
    const callRequest = new Request("https://gateway.example/mcp", {
      method: "POST",
      headers: {
        host: MCP_HOST,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "search_records",
        authorization: `Bearer ${bearer.accessToken}`,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(callBody));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const callRes = await h.app.request(callRequest);
    expect(callRes.status).toBe(200);
    expect(h.link.calls).toHaveLength(1);
    expect(h.link.calls[0]?.tool).toBe("search_records");
    expect(h.link.calls[0]?.arguments).toEqual({ search: "ethiopia", limit: 3 });

    // 3) legacy initialize（流式正文）→ 200 SSE（旧时代同样经有界读取 + 重建）
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      },
    });
    const initRequest = textStreamPost(initBody, {
      authorization: `Bearer ${bearer.accessToken}`,
    });
    const initRes = await h.app.request(initRequest);
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("content-type")).toContain("text/event-stream");
  });

  it("测试 C：带 Content-Length 的超限在 Host / Origin / Auth 之前 413（纯文本、不查库）", async () => {
    const res = await h.app.request(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: {
          host: "evil.example", // 若先判 Host 会是 403
          origin: "https://evil.example", // 若先判 Origin 也会是 403
          "content-type": "application/json",
          accept: "application/json",
          "content-length": String(MCP_HTTP_MAX_BODY_BYTES + 1),
        },
        body: "{}", // 声明值超限：一个字节都不读
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("www-authenticate")).toBeNull(); // 没进 Bearer（= 没进 DB）
    expect(await res.text()).toBe("request body too large");
  });

  it("测试 D：边界恰好 256 KiB 放行、256 KiB + 1 byte 拒绝（禁止 off-by-one）", async () => {
    const LIMIT = MCP_HTTP_MAX_BODY_BYTES; // 262144

    // 1) CL 恰好等于上限 → 通过大小关（走到认证 → 401，因为没带 Bearer）
    const atLimit = await h.app.request(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: { host: MCP_HOST, "content-type": "application/json", "content-length": String(LIMIT) },
        body: "{}",
      }),
    );
    expect(atLimit.status).toBe(401); // 过了 413，停在 Bearer

    // 2) CL = 上限 + 1 → 413
    const overLimit = await h.app.request(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: { host: MCP_HOST, "content-type": "application/json", "content-length": String(LIMIT + 1) },
        body: "{}",
      }),
    );
    expect(overLimit.status).toBe(413);

    // 3) 流式（无 CL）恰好 256 KiB：4 × 64 KiB 后正常关闭 → 放行到 401
    const exactStream = streamPost(4);
    const exactRes = await h.app.request(exactStream.request);
    expect(exactRes.status).toBe(401);
    expect(exactStream.state.pulled).toBe(4); // 正好读满上限即止
    expect(exactStream.state.cancelled).toBe(false); // 没超限就不取消

    // 4) 流式 256 KiB + 1 byte：第 5 块一进来就超 → 413 + 取消（后面还有块没读）
    //    用 8 块（512 KiB）而不是恰好 5 块：后者会在跨界同一次 pull 里 close，
    //    cancel 自然是 no-op——断言「取消」必须让流还有剩余可取消。
    //    同测试 A：允许 HWM 预取的第 6 次 pull，但跨限即停、远小于总长。
    const overStream = streamPost(8);
    const overRes = await h.app.request(overStream.request);
    expect(overRes.status).toBe(413);
    expect(overStream.state.cancelled).toBe(true);
    expect(overStream.state.pulled).toBeGreaterThanOrEqual(5);
    expect(overStream.state.pulled).toBeLessThanOrEqual(6);
    expect(overStream.state.pulled).toBeLessThan(8); // 第 7、8 块从未被拉取
  });
});

describe("P1：Scope 预检回归（有界正文 + batch）", () => {
  it("batch 中第二个 tools/call 缺权 → 403（不只检查数组第一个），0 次派发", async () => {
    const recordsOnly = await obtainMcpBearer(h, { scope: "records:read" });
    // 第一个有权限、第二个缺 coffee:read——只查第一个就会放行未授权工具。
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_records", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_beans", arguments: {} } },
    ]);
    const res = await h.app.request(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: {
          host: MCP_HOST,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${recordsOnly.accessToken}`,
        },
        body: batch,
      }),
    );
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('scope="coffee:read"');
    expect(h.link.calls).toHaveLength(0); // 未授权工具绝不进入派发
  });

  it("batch 内全部 tools/call 都有权 → 预检放行，SDK 批量执行（两个都派发）", async () => {
    const full = await obtainMcpBearer(h, { scope: "records:read coffee:read" });
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_records", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_beans", arguments: {} } },
    ]);
    const res = await h.app.request(
      new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: {
          host: MCP_HOST,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${full.accessToken}`,
        },
        body: batch,
      }),
    );
    // 预检放行（非 403）；legacy batch 由 SDK 执行 → SSE 帧（形态由 SDK 决定）。
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(h.link.calls.map((c) => c.tool)).toEqual(["search_records", "list_beans"]);
  });

  it("非法 JSON（无 CL 流式）→ 仍是 SDK 的 -32700（预检不改变协议错误分类）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    // 非法 JSON 的流式正文（无 CL）：预检解析失败 → 分类权交给 SDK。
    const broken = textStreamPost("{not json", {
      authorization: `Bearer ${bearer.accessToken}`,
    });
    const res = await h.app.request(broken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32700); // SDK 的 Parse error，不是我们的 413/403
    expect(h.link.calls).toHaveLength(0);
  });

  it("有权限工具照常派发、缺权限 403（单条路径回归）", async () => {
    const recordsOnly = await obtainMcpBearer(h, { scope: "records:read" });
    const okRes = await h.app.request(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_records", arguments: { search: "x" }, _meta: modernEnvelope() },
        },
        { token: recordsOnly.accessToken, mcpName: "search_records" },
      ),
    );
    expect(okRes.status).toBe(200);
    expect(h.link.calls).toHaveLength(1);

    const denied = await h.app.request(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_beans", arguments: {}, _meta: modernEnvelope() },
        },
        { token: recordsOnly.accessToken, mcpName: "list_beans" },
      ),
    );
    expect(denied.status).toBe(403);
    expect(h.link.calls).toHaveLength(1); // 未授权的那次没有派发
  });
});

/* ========================================================================== *
 * P2：OPTIONS /mcp（R1，设计 §4.1）
 * ========================================================================== */

describe("P2：OPTIONS /mcp → 204（CORS 预检）", () => {
  it("CORS 默认关闭：OPTIONS → 204，无任何 ACAO（无 *、不放大跨源），且不进 Bearer", async () => {
    const off = await createMcpHttpHarness(); // 未配置 corsOrigins
    const res = await off.app.request("/mcp", {
      method: "OPTIONS",
      headers: { host: MCP_HOST, origin: "https://anywhere.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(JSON.stringify(Object.fromEntries(res.headers.entries()))).not.toContain("*");
    // 预检头仍给出方法/允许头（与全局 CORS 中间件同形），供浏览器读取。
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(res.headers.get("vary")).toContain("Origin");
    // 不进认证：没带 Bearer 也照样 204；也没进任何工具逻辑。
    expect((await off.app.request("/mcp", { method: "GET", headers: { host: MCP_HOST } })).status).toBe(405);
  });

  it("CORS 白名单开启：命中 Origin 得到 204 + 回显 ACAO（非 *）；未命中没有 ACAO", async () => {
    const on = await createMcpHttpHarness({ corsOrigins: ["https://allowed.example"] });

    const allowed = await on.app.request("/mcp", {
      method: "OPTIONS",
      headers: { host: MCP_HOST, origin: "https://allowed.example" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull(); // 不允许 credentials
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");

    const denied = await on.app.request("/mcp", {
      method: "OPTIONS",
      headers: { host: MCP_HOST, origin: "https://evil.example" },
    });
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull(); // 不扩大来源

    // POST 的 Origin Guard 不受 OPTIONS 影响：非白名单 Origin 的 POST 仍 403。
    const post = await on.app.request("/mcp", {
      method: "POST",
      headers: {
        host: MCP_HOST,
        origin: "https://evil.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    });
    expect(post.status).toBe(403);
  });

  it("OPTIONS 不进入业务逻辑：无工具日志、无派发，后续 POST 正常（不消耗状态）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    for (let i = 0; i < 3; i += 1) {
      const res = await h.app.request("/mcp", {
        method: "OPTIONS",
        headers: { host: MCP_HOST },
      });
      expect(res.status).toBe(204);
    }
    expect(h.logs.filter((l) => l.message === "mcp_tool_call")).toHaveLength(0);
    expect(h.link.calls).toHaveLength(0);

    // 预检之后同一条链路照常工作（没有被 OPTIONS 消耗掉任何东西）。
    const post = await h.app.request(discover(bearer.accessToken));
    expect(post.status).toBe(200);
  });
});

/* ========================================================================== *
 * R2-P1：流式读取的绝对总时限（15s）
 * ========================================================================== */

/**
 * 造一个「先发少量数据、然后永远停住」的无 CL 流（慢速挂起客户端）。
 * 第 2 次 pull 返回一个永不 settle 的 Promise —— read() 因此永远挂起。
 */
function stallStreamRequest(
  headers: Record<string, string> = {},
): { request: Request; state: { pulled: number; cancelled: boolean } } {
  const state = { pulled: 0, cancelled: false };
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      state.pulled += 1;
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode("{")); // 少量数据后停住
        return;
      }
      return new Promise<void>(() => undefined); // 永不结束
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const request = new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      host: MCP_HOST,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, state };
}

describe("R2-P1：请求体流式读取的绝对总时限", () => {
  it("无 CL、发少量数据后停住 → 总时限内 408；不进 Host/Bearer/SDK；流被取消；定时器清理", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    vi.useFakeTimers();
    try {
      // 非法 Host + 无 Bearer：若超时路径没生效，这里会是 403/401——
      // 断言 408 证明「停读+取消」发生在 Host / Origin / Bearer / DB / SDK 之前。
      const { request, state } = stallStreamRequest({ host: "evil.example" });
      const pending = Promise.resolve(h.app.request(request));
      let settled = false;
      const guarded = pending.then((res) => {
        settled = true;
        return res;
      });
      // 推进假时钟（先让微任务流转到定时器创建，再跨过 15s）；最多 60s 假时间，
      // **不真实等待**。
      for (let i = 0; i < 60 && !settled; i += 1) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      const res = await guarded;

      expect(res.status).toBe(408);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("request body read timed out"); // 固定文案，无内部细节
      expect(res.headers.get("www-authenticate")).toBeNull(); // 未进 Bearer（= 未进 DB）
      expect(state.cancelled).toBe(true); // 底层流被取消
      expect(vi.getTimerCount()).toBe(0); // 超时定时器已清理
      expect(h.logs.filter((l) => l.message === "mcp_tool_call")).toHaveLength(0); // 未进 SDK/业务
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", onRejection);
    }
    // 让可能的迟到 settle 暴露为 unhandled rejection（若实现有泄漏，这里会非空；
    // vitest 本身也会因 unhandled rejection 让整轮变红）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toHaveLength(0);
  });

  it("注入短超时：函数在注入的时限内返回 timeout 并取消流（不必等 15 秒）", async () => {
    // 默认总时限钉死为 15s（任务书 §二「建议 15 秒」）。
    expect(MCP_HTTP_BODY_READ_TIMEOUT_MS).toBe(15_000);
    const { request, state } = stallStreamRequest();
    const startedAt = Date.now();
    const result = await readBoundedMcpBody(request, MCP_HTTP_MAX_BODY_BYTES, 150);
    const elapsed = Date.now() - startedAt;

    expect(result.outcome).toBe("timeout");
    expect(state.cancelled).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(140); // 注入的 150ms 生效
    expect(elapsed).toBeLessThan(3000); // 远小于默认 15s
  });

  it("时限内正常结束的流 → ok，正文完整无损", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: modernEnvelope() },
    });
    const result = await readBoundedMcpBody(textStreamPost(payload, {}));
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(new TextDecoder().decode(result.bytes)).toBe(payload); // 完整正文
      expect(result.bytes.byteLength).toBe(new TextEncoder().encode(payload).byteLength);
    }
  });

  it("客户端中断（流在读取中报错）→ 400 固定文案；无 unhandled rejection；后续请求正常", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const state = { pulls: 0 };
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          state.pulls = pulls;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode("{"));
            return;
          }
          controller.error(new Error("client disconnected")); // 模拟对端断开
        },
      });
      const request = new Request("https://gateway.example/mcp", {
        method: "POST",
        headers: { host: MCP_HOST, "content-type": "application/json", accept: "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const res = await h.app.request(request);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("request body could not be read"); // 固定文案
      expect(res.headers.get("www-authenticate")).toBeNull();

      // 分类与超时互斥且明确：读取异常 = unreadable(400)，不是 408。
      // 后续正常请求不受任何影响（无泄漏状态）。
      const bearer = await obtainMcpBearer(h, { scope: "records:read" });
      const ok = await h.app.request(discover(bearer.accessToken));
      expect(ok.status).toBe(200);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toHaveLength(0);
  });
});

/* ========================================================================== *
 * R2-P2：OPTIONS 与 mcp-http 限流桶隔离
 * ========================================================================== */

describe("R2-P2：OPTIONS 不消耗 mcp-http 限流额度", () => {
  it("maxMcp=3：连续 6 次 OPTIONS 全 204（无 ACAO、无 challenge）；POST 额度完整且仍受限", async () => {
    const limited = await createMcpHttpHarness({ maxMcp: 3 });
    const bearer = await obtainMcpBearer(limited, { scope: "records:read" });

    // OPTIONS×6：若计入 mcp-http 桶，第 4 次就该 429——全 204 证明零消耗。
    for (let i = 0; i < 6; i += 1) {
      const res = await limited.app.request("/mcp", {
        method: "OPTIONS",
        headers: { host: MCP_HOST },
      });
      expect(res.status, `options #${i + 1}`).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull(); // CORS 关闭：无 ACAO
      expect(res.headers.get("www-authenticate")).toBeNull(); // 不需要 Bearer
    }

    // 额度完整留给 POST：3 次 discover 全 200。
    for (let i = 0; i < 3; i += 1) {
      const res = await limited.app.request(discover(bearer.accessToken));
      expect(res.status, `post #${i + 1}`).toBe(200);
    }
    // 第 4 次 POST → 429：正常 POST 仍受原有 mcp-http 限流保护。
    const blocked = await limited.app.request(discover(bearer.accessToken));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("maxMcp=1 的极小配额：OPTIONS×3 全 204，随后 1 次 POST 成功、第 2 次 429", async () => {
    const tiny = await createMcpHttpHarness({ maxMcp: 1 });
    const bearer = await obtainMcpBearer(tiny, { scope: "records:read" });

    for (let i = 0; i < 3; i += 1) {
      const res = await tiny.app.request("/mcp", {
        method: "OPTIONS",
        headers: { host: MCP_HOST },
      });
      expect(res.status, `options #${i + 1}`).toBe(204);
    }
    expect((await tiny.app.request(discover(bearer.accessToken))).status).toBe(200);
    expect((await tiny.app.request(discover(bearer.accessToken))).status).toBe(429);
  });

  it("OPTIONS 路由精确匹配 /mcp：其它路径的 OPTIONS 不被本路由接管（404）", async () => {
    const off = await createMcpHttpHarness(); // CORS 关闭：无全局中间件拦截
    const res = await off.app.request("/mcp/oauth/authorize", {
      method: "OPTIONS",
      headers: { host: MCP_HOST },
    });
    expect(res.status).toBe(404); // 没有扩大到其它路径

    const mcp = await off.app.request("/mcp", { method: "OPTIONS", headers: { host: MCP_HOST } });
    expect(mcp.status).toBe(204);
  });
});
