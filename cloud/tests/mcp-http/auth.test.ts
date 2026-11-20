import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { signAccessToken } from "../../src/sessions/jwt.js";
import { signMcpAccessToken } from "../../src/mcp-oauth/tokens.js";
import { randomToken } from "../../src/security/crypto.js";
import {
  createMcpHttpHarness,
  jsonBody,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  rpcError,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";

/**
 * B. 认证面（Phase 1.3.2，任务书 §5 / §8.1）。
 *
 * 每个 `/mcp` 请求重新验签：HS256 / `kid` / `iss` / `aud=MCP_RESOURCE` /
 * `exp` / `sub` / `sid` / `client_id` / `scope` / `jti`。401 的 challenge
 * **只带 `resource_metadata`、绝不带 `scope`**（§5.8.2）。
 *
 * 双向隔离（B6 关闭方式）：Desktop 登录 token 打不了 `/mcp`，
 * MCP token 打不了 Desktop 的 `/auth/*`。
 */

const handle = await getTestDb();

let h: McpHttpHarness;

const EXPECTED_CHALLENGE = 'Bearer resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp"';

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  h = await createMcpHttpHarness();
});

afterAll(async () => {
  await closeTestDb();
});

function discover(token?: string): Request {
  return modernRequest(
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernEnvelope() } },
    { token },
  );
}

async function expect401(token?: string): Promise<string> {
  const res = await h.app.request(discover(token));
  expect(res.status).toBe(401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge).toBe(EXPECTED_CHALLENGE);
  // §5.8.2：401 的 challenge 不得携带 scope（否则等于默认索要全部权限）。
  expect(challenge).not.toContain("scope=");
  expect(challenge).not.toContain("insufficient_scope");
  return challenge;
}

describe("Bearer 校验（每次请求重新验签）", () => {
  it("无 Bearer → 401 + resource_metadata challenge（无 scope）", async () => {
    await expect401(undefined);
  });

  it("非法 JWT → 401（同一 challenge，不区分失败原因）", async () => {
    await expect401("not-a-jwt");
    await expect401("Bearer-ish garbage");
  });

  it("错误 aud（非 MCP_RESOURCE）→ 401", async () => {
    const token = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: "u", sessionId: "s", clientId: "test-client", scope: ["records:read"] },
      { issuer: h.env.baseUrl, resource: "https://other.example/mcp", ttlSeconds: 900 },
    );
    await expect401(token);
  });

  it("错误 iss → 401", async () => {
    const token = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: "u", sessionId: "s", clientId: "test-client", scope: ["records:read"] },
      { issuer: "https://evil.example", resource: "https://gateway.example/mcp", ttlSeconds: 900 },
    );
    await expect401(token);
  });

  it("过期 token → 401", async () => {
    const token = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: "u", sessionId: "s", clientId: "test-client", scope: ["records:read"] },
      {
        issuer: h.env.baseUrl,
        resource: "https://gateway.example/mcp",
        ttlSeconds: 600,
        now: () => new Date(Date.now() - 3600_000),
      },
    );
    await expect401(token);
  });

  it("未知 kid → 401（不回退到 current key 试一试）", async () => {
    const token = await new SignJWT({ sid: "s", client_id: "test-client", scope: "records:read" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "unknown-kid" })
      .setSubject("u")
      .setIssuer(h.env.baseUrl)
      .setAudience("https://gateway.example/mcp")
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .setJti(randomToken(16))
      .sign(h.ctx.keyRing.current.key);
    await expect401(token);
  });

  it("Desktop 登录 token（aud=brewphase-desktop）打 /mcp → 401", async () => {
    const desktopToken = await signAccessToken(
      h.ctx.keyRing,
      { userId: "u", sessionId: "s" },
      { issuer: h.env.baseUrl, ttlSeconds: 900 },
    );
    await expect401(desktopToken);
  });

  it("MCP token 打 Desktop 的 /auth/me → 401（双向隔离）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const res = await h.app.request("/auth/me", {
      headers: { authorization: `Bearer ${bearer.accessToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("有效 token 通过认证并进入 SDK（200）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const res = await h.app.request(discover(bearer.accessToken));
    expect(res.status).toBe(200);
    expect(rpcError(await jsonBody(res))).toBeNull();
  });
});
