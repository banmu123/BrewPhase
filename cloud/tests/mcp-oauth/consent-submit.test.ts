import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpOAuthHarness,
  parseSetCookie,
  seedAuthorizeClient,
  signBrowserCookie,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import {
  codesOf,
  grantsOf,
  redirectParams,
  startConsentFlow,
  submitConsent,
  submitConsentRaw,
  tableCount,
  type ConsentSession,
} from "../helpers/mcp-consent.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { mcpAuthCodeHash } from "../../src/mcp-oauth/consent-flow.js";

/**
 * `POST /mcp/oauth/consent`（Phase 1.3.1-C2b）。
 *
 * 三条主线：
 * 1. **拒绝**：只回 `access_denied`，绝不建 grant / code，行与 Cookie 都清；
 * 2. **允许**：grant + code + 删行在同一个事务里，302 携带 `code/state/iss`；
 * 3. **CSRF 与表单解析**：错一次就 400，且被篡改的那一行不可再用。
 */

const handle = await getTestDb();

let h: McpOAuthHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
});

afterAll(async () => {
  await closeTestDb();
});

function codeOf(res: Response): string {
  const params = redirectParams(res);
  const code = params.get("code");
  if (!code) throw new Error("redirect carries no code");
  return code;
}

async function flowWith(scope: string): Promise<ConsentSession> {
  return startConsentFlow(h, {
    query: new URLSearchParams({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: "https://client.example/callback",
      scope,
      state: "client-state-1",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://gateway.example/mcp",
    }).toString(),
  });
}

describe("用户拒绝", () => {
  it("显式 deny → 302 access_denied，带 state 与 iss，无 code", async () => {
    const flow = await flowWith("records:read coffee:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });

    expect(res.status).toBe(302);
    const params = redirectParams(res);
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("state")).toBe("client-state-1");
    expect(params.get("iss")).toBe("https://gateway.example");
    expect(params.get("code")).toBeNull();
    expect(params.get("error_description")).toBeNull();
  });

  it("拒绝会删行、不建 grant、不建 code", async () => {
    const flow = await flowWith("records:read");
    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });

    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
  });

  it("拒绝时清除 Cookie，Path 必须是 /mcp/oauth", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });

    const cookie = parseSetCookie(res.headers.get("set-cookie")!);
    expect(cookie.__name).toBe("bp_mcp_bs");
    expect(cookie["max-age"]).toBe("0");
    expect(cookie.path).toBe("/mcp/oauth");
  });

  it("全部取消勾选 → 按拒绝处理（不建 grant）", async () => {
    const flow = await flowWith("records:read coffee:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: [],
    });

    expect(res.status).toBe(302);
    expect(redirectParams(res).get("error")).toBe("access_denied");
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
  });

  it("拒绝会写审计但绝不写 scope 之外的东西", async () => {
    const flow = await flowWith("records:read");
    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });

    const rows = await handle.sql<{ detail: Record<string, unknown>; user_id: string | null }[]>`
      select detail, user_id from auth_events where event_type = 'mcp_consent_denied'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBeTruthy();
    expect(Object.keys(rows[0]!.detail).sort()).toEqual(["clientId", "rid"]);
  });
});

describe("用户允许", () => {
  it("302 回 redirect_uri，带 code / state / iss", async () => {
    const flow = await flowWith("records:read coffee:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read", "coffee:read"],
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://client.example/callback");
    expect(location.searchParams.get("state")).toBe("client-state-1");
    expect(location.searchParams.get("iss")).toBe("https://gateway.example");
    expect(location.searchParams.get("error")).toBeNull();
    expect(codeOf(res)).toHaveLength(43);
  });

  it("明文 code 只出现在 Location 里，数据库只有哈希", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    const code = codeOf(res);

    const codes = await codesOf(handle.sql, flow.userId);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.code_hash).toBe(mcpAuthCodeHash(code));
    expect(codes[0]!.code_hash).not.toBe(code);

    // 全表搜不到明文。
    const leaked = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_auth_codes where code_hash = ${code}`;
    expect(leaked[0]?.count).toBe("0");

    // 审计里也没有。
    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events
       where detail::text like ${`%${code}%`}`;
    expect(audit[0]?.count).toBe("0");
  });

  it("授权码有效期 60 秒", async () => {
    const flow = await flowWith("records:read");
    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    const rows = await handle.sql<{ seconds: string }[]>`
      select extract(epoch from (expires_at - created_at))::text as seconds from mcp_auth_codes`;
    expect(Number(rows[0]!.seconds)).toBe(60);
  });

  it("code 行继承原授权请求的 resource / redirect_uri / code_challenge", async () => {
    const flow = await flowWith("records:read");
    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    const code = (await codesOf(handle.sql, flow.userId))[0]!;
    expect(code.resource).toBe("https://gateway.example/mcp");
    expect(code.redirect_uri).toBe("https://client.example/callback");
    expect(code.code_challenge).toBe("a".repeat(43));
    expect(code.consumed_at).toBeNull();
  });

  it("成功后授权请求被删除、Cookie 被清除", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
    const cookie = parseSetCookie(res.headers.get("set-cookie")!);
    expect(cookie["max-age"]).toBe("0");
    expect(cookie.path).toBe("/mcp/oauth");
  });

  it("code 在重定向 URL 的 query 里，不在 fragment 里", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    const location = res.headers.get("location")!;
    expect(location.includes("#")).toBe(false);
    expect(location.startsWith("https://client.example/callback?")).toBe(true);
  });

  it("写 mcp_consent_allowed 与 mcp_auth_code_issued 两条审计，且不含 code", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    const code = codeOf(res);

    const rows = await handle.sql<{ event_type: string; detail: Record<string, unknown> }[]>`
      select event_type, detail from auth_events
       where event_type in ('mcp_consent_allowed', 'mcp_auth_code_issued')
       order by event_type`;
    expect(rows.map((row) => row.event_type)).toEqual([
      "mcp_auth_code_issued",
      "mcp_consent_allowed",
    ]);

    const allowed = rows.find((row) => row.event_type === "mcp_consent_allowed")!;
    expect(allowed.detail.scope).toEqual(["records:read"]);
    expect(allowed.detail.grantId).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("重复提交同一张表单 → 第二次 400（行已消费）", async () => {
    const flow = await flowWith("records:read");
    const first = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(first.status).toBe(302);

    const second = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(second.status).toBe(400);
    expect(second.headers.get("location")).toBeNull();
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(1);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(1);
  });
});

describe("CSRF", () => {
  it("CSRF 错误 → 400、删行、写 mcp_consent_csrf_mismatch、不签发任何东西", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: "b".repeat(43),
      decision: "allow",
      scopes: ["records:read"],
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events where event_type = 'mcp_consent_csrf_mismatch'`;
    expect(audit[0]?.count).toBe("1");
  });

  it("用上一次打开的 CSRF 提交 → 400（重开页面会换一把）", async () => {
    const flow = await startConsentFlow(h);
    const oldCsrf = flow.csrf;

    const reopened = await h.app.request(`/mcp/oauth/consent?rid=${flow.rid}`, {
      headers: { cookie: flow.cookie },
    });
    expect(reopened.status).toBe(200);

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: oldCsrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("CSRF 缺失 → 400（parseForm 拒绝），且不删行", async () => {
    const flow = await flowWith("records:read");
    const body = new URLSearchParams({
      rid: flow.rid,
      decision: "allow",
      scope: "records:read",
    }).toString();
    const res = await submitConsentRaw(h, { cookie: flow.cookie, body });

    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(1);
  });

  it("CSRF 重复提交 → 400（不做「取最后一个」的猜测）", async () => {
    const flow = await flowWith("records:read");
    const body =
      `rid=${flow.rid}&csrf=${flow.csrf}&csrf=${flow.csrf}&decision=allow&scope=records:read`;
    const res = await submitConsentRaw(h, { cookie: flow.cookie, body });

    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("rid / decision 重复 → 400", async () => {
    const flow = await flowWith("records:read");

    for (const body of [
      `rid=${flow.rid}&rid=${flow.rid}&csrf=${flow.csrf}&decision=allow&scope=records:read`,
      `rid=${flow.rid}&csrf=${flow.csrf}&decision=allow&decision=deny&scope=records:read`,
    ]) {
      const res = await submitConsentRaw(h, { cookie: flow.cookie, body });
      expect(res.status).toBe(400);
    }
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("非 urlencoded 的 content-type → 400", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
      contentType: "application/json",
    });
    expect(res.status).toBe(400);
  });
});

describe("Scope 校验", () => {
  it("提交未请求的 scope → 400，且不签发 grant/code", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read", "coffee:read"],
    });

    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
  });

  it("提交未知 scope → 400", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read", "records:write"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("重复提交同一个 scope 会被去重（不产生重复元素）", async () => {
    const flow = await flowWith("records:read coffee:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read", "records:read"],
    });

    expect(res.status).toBe(302);
    const grants = await grantsOf(handle.sql, flow.userId);
    expect(grants[0]!.scopes).toEqual(["records:read"]);
  });

  it("收窄到单个 scope：grant 与 code 都只记这个子集", async () => {
    const flow = await flowWith("records:read coffee:read");
    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["coffee:read"],
    });

    const grants = await grantsOf(handle.sql, flow.userId);
    expect(grants[0]!.scopes).toEqual(["coffee:read"]);
    const codes = await codesOf(handle.sql, flow.userId);
    expect(codes[0]!.scope).toEqual(["coffee:read"]);
  });

  it("scope 顺序按 MCP_SCOPES 归一（不是按提交顺序）", async () => {
    const flow = await flowWith("records:read coffee:read tags:read");
    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["coffee:read", "records:read", "tags:read"],
    });

    const grants = await grantsOf(handle.sql, flow.userId);
    expect(grants[0]!.scopes).toEqual(["records:read", "tags:read", "coffee:read"]);
  });

  it("绝不产生任何写入权限", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:write"],
    });
    expect(res.status).toBe(400);
    const all = await handle.sql<{ scopes: string[] }[]>`select scopes from mcp_grants`;
    expect(all.filter((row) => row.scopes.some((scope) => scope.endsWith(":write")))).toHaveLength(0);
  });
});

describe("前置校验（POST 侧重做一遍）", () => {
  it("没有 Cookie → 400", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: "",
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("绑定不匹配 → 400 + 删行 + 审计", async () => {
    const flow = await flowWith("records:read");
    const nowSec = Math.floor(Date.now() / 1000);
    const other = await signBrowserCookie(h.env, {
      sid: "q".repeat(43),
      iat: nowSec,
      exp: nowSec + 1800,
    });

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: other,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("授权请求已过期 → 400 + 删行", async () => {
    const flow = await flowWith("records:read");
    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${flow.rid}`;

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("provider 回调尚未完成 → 400", async () => {
    const flow = await flowWith("records:read");
    await handle.sql`update mcp_auth_requests set provider_consumed_at = null where id = ${flow.rid}`;

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });

  it("user_id 为空 → 400", async () => {
    const flow = await flowWith("records:read");
    await handle.sql`update mcp_auth_requests set user_id = null where id = ${flow.rid}`;

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
  });

  it("rid 不存在 → 400", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: "00000000-0000-0000-0000-000000000000",
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
  });

  it("decision 不是 allow/deny → 400", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "maybe",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
  });
});

describe("Desktop OAuth 与 MCP 的隔离（C2b 复核）", () => {
  it("一次完整的同意流程不写 Desktop 的三张表", async () => {
    const flow = await flowWith("records:read");
    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(302);

    for (const table of ["oauth_codes", "oauth_transactions", "auth_sessions"]) {
      const rows = await handle.sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from "${table}"`,
      );
      expect(Number(rows[0]?.count ?? "-1"), table).toBe(0);
    }
  });

  it("MCP 的同意不会修改已存在的 Desktop 会话行", async () => {
    // 先造一条 Desktop 登录会话（直接写库，不经过服务层——这里只需要一行
    // 存在的记录来证明它没被碰）。
    const flow = await flowWith("records:read");
    await handle.sql`
      insert into auth_sessions (user_id, refresh_token_hash, token_family, expires_at)
      values (${flow.userId}, 'desktop-hash-1', gen_random_uuid(), now() + interval '30 days')`;
    const before = await handle.sql<{ count: string; hash: string }[]>`
      select count(*)::text as count, min(refresh_token_hash) as hash from auth_sessions where revoked_at is null`;

    await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    const after = await handle.sql<{ count: string; hash: string }[]>`
      select count(*)::text as count, min(refresh_token_hash) as hash from auth_sessions where revoked_at is null`;
    expect(after[0]).toEqual(before[0]);
  });

  it("MCP 的授权 Cookie 发给 /oauth/authorize：仍然按 Desktop 规则拒绝", async () => {
    const flow = await flowWith("records:read");
    const res = await h.app.request(
      `/oauth/authorize?redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`,
      { headers: { cookie: flow.cookie } },
    );
    // Desktop 的入口仍然按它自己的规则先拒绝（缺 provider → unsupported_provider），
    // 关键是：**不是** 302、**不是** 404，也**没有**因为带着 MCP Cookie 而放行。
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("invalid_token");
  });
});
