import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  exchangeCode,
  obtainAuthCode,
  postToken,
  postTokenRaw,
  readTokenResponse,
  refreshToken,
  type AuthCodeFixture,
} from "../helpers/mcp-token.js";

/**
 * Token Endpoint 的**协议面**（Phase 1.3.1-C3a）：表单解析、错误码、限流与隔离。
 *
 * 这一组不重复业务判据（那些在 token-code / token-refresh / token-atomicity），
 * 只钉三件事：畸形请求怎么拒、错误码对不对、以及「它绝不碰 Desktop 的任何表」。
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

function baseFields(): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code: fixture.code,
    client_id: fixture.clientId,
    redirect_uri: fixture.redirectUri,
    code_verifier: fixture.verifier,
    resource: "https://gateway.example/mcp",
  };
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error: string };
  return body.error;
}

describe("表单格式", () => {
  it("JSON body → invalid_request", async () => {
    const res = await postTokenRaw(h, JSON.stringify(baseFields()), "application/json");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("multipart 同样拒绝", async () => {
    const res = await postTokenRaw(h, "grant_type=authorization_code", "multipart/form-data; boundary=x");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("缺少任何一个必填字段 → invalid_request", async () => {
    for (const field of ["grant_type", "client_id", "resource", "code", "redirect_uri", "code_verifier"]) {
      const fields = baseFields();
      delete (fields as Record<string, string | undefined>)[field];
      const res = await postToken(h, fields);
      expect(res.status, field).toBe(400);
      expect(await errorOf(res), field).toBe("invalid_request");
    }
  });

  it("重复字段 → invalid_request（不做「取第一个/最后一个」的猜测）", async () => {
    const body =
      `grant_type=authorization_code&grant_type=refresh_token` +
      `&code=${fixture.code}&client_id=${fixture.clientId}` +
      `&redirect_uri=${encodeURIComponent(fixture.redirectUri)}` +
      `&code_verifier=${fixture.verifier}&resource=${encodeURIComponent("https://gateway.example/mcp")}`;
    const res = await postTokenRaw(h, body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("请求体超限 → invalid_request", async () => {
    const res = await postTokenRaw(h, `grant_type=${"x".repeat(9000)}`);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("未知 grant_type → unsupported_grant_type", async () => {
    const res = await postToken(h, { ...baseFields(), grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("unsupported_grant_type");
  });

  it("GET 不提供服务（不是 200）", async () => {
    const res = await h.app.request("/mcp/oauth/token");
    expect(res.status).not.toBe(200);
  });
});

describe("Cookie 与认证", () => {
  it("不依赖任何 Cookie：带一个伪造的 bp_mcp_bs 也能正常兑换", async () => {
    const res = await h.app.request("/mcp/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "bp_mcp_bs=forged.value",
      },
      body: new URLSearchParams(baseFields()).toString(),
    });
    expect(res.status).toBe(200);
  });

  it("不需要 Authorization 头", async () => {
    const res = await postToken(h, baseFields());
    expect(res.status).toBe(200);
  });

  it("成功响应不带 Location（token 绝不出现在 URL 里）", async () => {
    const res = await exchangeCode(h, fixture);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("响应头：凭据不许被缓存", () => {
  it("成功响应带 no-store + no-cache", async () => {
    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("错误响应同样带（错误体里也可能有可用信息）", async () => {
    const res = await postToken(h, { ...baseFields(), grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    // `respondError` 走 `c.json(..., headers)`，必须与 `c.header()` 合并而不是覆盖。
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });
});

describe("限流", () => {
  it("token 桶独立且按 maxToken 计数", async () => {
    // 第 21 次（maxToken = 20）应当被限流，而不是继续返回 400。
    const statuses: number[] = [];
    for (let i = 0; i < h.env.rateLimit.maxToken + 1; i += 1) {
      const res = await postToken(h, {
        ...baseFields(),
        grant_type: "unsupported_value",
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, h.env.rateLimit.maxToken).every((s) => s === 400)).toBe(true);
    expect(statuses[h.env.rateLimit.maxToken]).toBe(429);
  });
});

describe("隔离：不碰 Desktop 的任何东西", () => {
  it("兑换 + 刷新都不写 oauth_codes / oauth_transactions / auth_sessions", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));
    await refreshToken(h, { refreshToken: tokens.refresh_token });

    for (const table of ["oauth_codes", "oauth_transactions", "auth_sessions"]) {
      const rows = await handle.sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from "${table}"`,
      );
      expect(Number(rows[0]?.count ?? "-1"), table).toBe(0);
    }
  });

  it("Desktop 的 /oauth/token 行为不变（仍是 JSON invalid_request）", async () => {
    const res = await h.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("MCP 的 token 不能通过 Desktop 的校验（aud 隔离）", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));
    const res = await h.app.request("/auth/me", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("日志与存储不含凭据", () => {
  it("审计事件里没有 access / refresh token 明文", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));
    const next = await readTokenResponse(await refreshToken(h, { refreshToken: tokens.refresh_token }));

    for (const secret of [tokens.access_token, tokens.refresh_token, next.access_token, next.refresh_token]) {
      const rows = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from auth_events where strpos(detail::text, ${secret}) > 0`;
      expect(rows[0]?.count).toBe("0");
    }
  });

  it("库里没有明文 refresh token，也没有明文授权码", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));

    const refresh = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens where strpos(token_hash, ${tokens.refresh_token}) > 0`;
    expect(refresh[0]?.count).toBe("0");

    const code = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_auth_codes where strpos(code_hash, ${fixture.code}) > 0`;
    expect(code[0]?.count).toBe("0");
  });
});
