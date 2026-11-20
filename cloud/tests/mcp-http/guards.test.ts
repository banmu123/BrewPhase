import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
import { MCP_HTTP_MAX_BODY_BYTES } from "../../src/mcp-http/guards.js";
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
