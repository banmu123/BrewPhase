import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  decodeJwtPayload,
  exchangeCode,
  obtainAuthCode,
  readTokenResponse,
  refreshRows,
  sessionCount,
  type AuthCodeFixture,
} from "../helpers/mcp-token.js";
import { mcpRefreshTokenHash } from "../../src/mcp-oauth/sessions.js";
import { verifyMcpAccessToken } from "../../src/mcp-oauth/tokens.js";

/**
 * `POST /mcp/oauth/token` 的 `authorization_code` 分支（Phase 1.3.1-C3a）。
 *
 * 这一组盯的是「一枚授权码只能换出一组凭据」：code 被消费、Session 建立、
 * 第一代 Refresh Token 落库，三者要么同时发生，要么都不发生。失败路径统一
 * 收敛到 `invalid_grant`——区分「不存在 / 过期 / 已用 / PKCE 不符 / client
 * 不符」等于给攻击者五条探针。
 */

const handle = await getTestDb();
let h: McpOAuthHarness;
let fixture: AuthCodeFixture;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
  fixture = await obtainAuthCode(h);
});

afterAll(async () => {
  await closeTestDb();
});

async function codeRow() {
  const rows = await handle.sql<{ consumed_at: string | null; expires_at: string; scope: string[] }[]>`
    select consumed_at::text, expires_at::text, scope from mcp_auth_codes`;
  return rows[0];
}

describe("正常兑换", () => {
  it("返回 access_token / token_type / expires_in / refresh_token / scope", async () => {
    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");

    const body = await readTokenResponse(res);
    expect(body.token_type).toBe("Bearer");
    // 真实配置值（makeTestEnv 是 900），不是硬编码。
    expect(body.expires_in).toBe(h.env.accessTokenTtlSeconds);
    expect(body.scope).toBe("records:read coffee:read");
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("JWT 的 iss / aud / sub 与配置和会话一致", async () => {
    const body = await readTokenResponse(await exchangeCode(h, fixture));
    const payload = decodeJwtPayload(body.access_token);

    expect(payload.iss).toBe("https://gateway.example");
    expect(payload.aud).toBe("https://gateway.example/mcp");
    expect(payload.sub).toBe(fixture.userId);
    expect(typeof payload.jti).toBe("string");
    expect(Number(payload.exp) - Number(payload.iat)).toBe(h.env.accessTokenTtlSeconds);
  });

  it("JWT 的 sid 等于数据库里的 Session ID，scope 等于实际授予", async () => {
    const body = await readTokenResponse(await exchangeCode(h, fixture));

    const sessions = await handle.sql<{ id: string; issued_scope: string[]; client_id: string }[]>`
      select id, issued_scope, client_id from mcp_sessions`;
    expect(sessions).toHaveLength(1);
    expect(decodeJwtPayload(body.access_token).sid).toBe(sessions[0]!.id);
    expect(sessions[0]!.issued_scope).toEqual(["records:read", "coffee:read"]);
    expect(sessions[0]!.client_id).toBe("test-client");

    // 用真实的校验函数再过一遍：iss/aud 不对会在这里直接失败。
    const claims = await verifyMcpAccessToken(h.ctx.keyRing, body.access_token, {
      issuer: h.env.baseUrl,
      resource: "https://gateway.example/mcp",
    });
    expect(claims.userId).toBe(fixture.userId);
    expect(claims.scope).toEqual(["records:read", "coffee:read"]);
  });

  it("第一代 Refresh Token 只存哈希，且哈希域仍是 mcp-refresh", async () => {
    const body = await readTokenResponse(await exchangeCode(h, fixture));
    const rows = await refreshRows(handle, fixture.userId);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.generation).toBe(1);
    expect(rows[0]!.consumed_at).toBeNull();
    expect(rows[0]!.token_hash).not.toBe(body.refresh_token);
    expect(rows[0]!.token_hash).toBe(mcpRefreshTokenHash(h.env.sessionTokenPepper!, body.refresh_token));

    // 全表搜不到明文。
    const leaked = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens where token_hash = ${body.refresh_token}`;
    expect(leaked[0]?.count).toBe("0");
  });

  it("授权码被标记消费", async () => {
    await exchangeCode(h, fixture);
    const row = await codeRow();
    expect(row!.consumed_at).not.toBeNull();
  });

  it("Session 的绝对期限是 90 天，第一代 Refresh 不超过它", async () => {
    await exchangeCode(h, fixture);
    const rows = await handle.sql<{ days: string; refresh_days: string }[]>`
      select extract(epoch from (s.absolute_expires_at - s.created_at)) / 86400 as days,
             extract(epoch from (t.expires_at - s.created_at)) / 86400 as refresh_days
        from mcp_sessions s join mcp_refresh_tokens t on t.session_id = s.id`;
    expect(Math.round(Number(rows[0]!.days))).toBe(90);
    expect(Math.round(Number(rows[0]!.refresh_days))).toBe(30);
  });

  it("收窄授予的 scope 会被原样带进 token", async () => {
    // 换一个**没有历史 grant** 的客户端：否则 `test-client` 已有的
    // records+coffee 会让这次授权变成 step-up，最终 scope 是并集。
    await seedAuthorizeClient(handle, {
      clientId: "narrowed-client",
      redirectUris: ["https://client.example/callback"],
    });
    const narrowed = await obtainAuthCode(h, {
      clientId: "narrowed-client",
      scope: "records:read coffee:read tags:read",
      grantedScope: ["records:read"],
    });
    const body = await readTokenResponse(await exchangeCode(h, narrowed));
    expect(body.scope).toBe("records:read");
    expect(decodeJwtPayload(body.access_token).scope).toBe("records:read");
  });
});

describe("失败路径统一 invalid_grant", () => {
  async function expectInvalidGrant(res: Response): Promise<void> {
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description?: string };
    expect(body.error).toBe("invalid_grant");
    // 不回显原因，也不回显任何凭据。
    expect(JSON.stringify(body)).not.toContain(fixture.code);
  }

  it("同一个授权码兑换两次 → 第二次 invalid_grant", async () => {
    expect((await exchangeCode(h, fixture)).status).toBe(200);
    await expectInvalidGrant(await exchangeCode(h, fixture));
    expect(await sessionCount(handle, fixture.userId)).toBe(1);
  });

  it("授权码过期 → invalid_grant，且不建 Session", async () => {
    await handle.sql`update mcp_auth_codes set expires_at = now() - interval '1 second'`;
    await expectInvalidGrant(await exchangeCode(h, fixture));
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("PKCE verifier 不匹配 → invalid_grant", async () => {
    await expectInvalidGrant(await exchangeCode(h, fixture, { code_verifier: "w".repeat(43) }));
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    // 码没有被消费：客户端可以拿正确的 verifier 重试。
    expect((await codeRow())!.consumed_at).toBeNull();
  });

  it("PKCE verifier 形态非法 → invalid_grant", async () => {
    // 形态非法（长度 / 字符集）由 `verifyPkce` 判成「PKCE 不通过」，
    // 对外与「值不对」完全一样。
    for (const bad of ["short", "x".repeat(129), "v".repeat(42) + "!"]) {
      const res = await exchangeCode(h, fixture, { code_verifier: bad });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    }
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("缺少 code_verifier → invalid_request（缺参数，不是 PKCE 失败）", async () => {
    const res = await exchangeCode(h, fixture, { code_verifier: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("client_id 不匹配 → invalid_grant", async () => {
    await expectInvalidGrant(await exchangeCode(h, fixture, { client_id: "someone-else" }));
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("redirect_uri 不匹配 → invalid_grant", async () => {
    await expectInvalidGrant(
      await exchangeCode(h, fixture, { redirect_uri: "https://client.example/callback/" }),
    );
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("resource 不是本服务 → invalid_request（路由层先挡）", async () => {
    const res = await exchangeCode(h, fixture, { resource: "https://other.example/mcp" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("Grant 已撤销 → invalid_grant", async () => {
    await handle.sql`update mcp_grants set revoked_at = now() where user_id = ${fixture.userId}`;
    await expectInvalidGrant(await exchangeCode(h, fixture));
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("用户不活跃 → invalid_grant", async () => {
    await handle.sql`update users set status = 'suspended' where id = ${fixture.userId}`;
    await expectInvalidGrant(await exchangeCode(h, fixture));
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("授权码不存在 → invalid_grant（与已用过无法区分）", async () => {
    const res = await exchangeCode(h, { ...fixture, code: "z".repeat(43) });
    await expectInvalidGrant(res);
  });

  it("所有失败都不创建 Session / Refresh Token", async () => {
    await exchangeCode(h, fixture, { code_verifier: "w".repeat(43) });
    await exchangeCode(h, fixture, { client_id: "someone-else" });
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);
  });
});
