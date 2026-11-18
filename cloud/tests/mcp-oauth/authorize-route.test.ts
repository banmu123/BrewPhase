import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  authorizeQuery,
  cookiePair,
  createMcpOAuthHarness,
  parseSetCookie,
  seedAuthorizeClient,
  setCookieOf,
  signBrowserCookie,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { mcpAuthRequests } from "../../src/db/schema.js";
import { MCP_BROWSER_COOKIE_PATH } from "../../src/mcp-oauth/constants.js";

/**
 * `GET /mcp/oauth/authorize`（Phase 1.3.1-C2a）。
 *
 * 这一组只测「参数是否被严格校验」与「浏览器 Cookie 是否被正确复用/新建」。
 * 参数校验之所以要逐项测，是因为**任何一项放宽都等于授权码可被投递到
 * 攻击者的回调地址**——那是 OAuth 最经典的失陷方式，而它通常不是一次
 * 大改，而是「顺手支持一下通配」这种小让步。
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

async function get(query: string, headers: Record<string, string> = {}) {
  return h.app.request(`/mcp/oauth/authorize?${query}`, { method: "GET", headers });
}

async function rows() {
  return handle.db.select().from(mcpAuthRequests);
}

describe("参数校验：每一项都必须严格", () => {
  it("合法请求：302 到登录页，且行字段逐项正确", async () => {
    const res = await get(authorizeQuery());
    expect(res.status).toBe(302);

    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/mcp\/oauth\/login\?rid=/);
    const rid = new URL(location, "https://x").searchParams.get("rid") ?? "";
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);

    const created = (await rows())[0];
    expect(created).toBeTruthy();
    expect(created!.id).toBe(rid);
    expect(created!.clientId).toBe("test-client");
    expect(created!.redirectUri).toBe("https://client.example/callback");
    expect(created!.scope).toEqual(["records:read", "coffee:read"]);
    expect(created!.resource).toBe("https://gateway.example/mcp");
    expect(created!.state).toBe("client-state-1");
    expect(created!.codeChallenge).toBe("a".repeat(43));
    expect(created!.codeChallengeMethod).toBe("S256");

    // 三处「尚未发生」必须是 NULL（不是空串、不是占位符）。
    expect(created!.browserBindingHash).toBeNull();
    expect(created!.userId).toBeNull();
    expect(created!.provider).toBeNull();
    expect(created!.providerStateHash).toBeNull();
    expect(created!.providerConsumedAt).toBeNull();

    // csrf_hash 有值但不可用于授权（明文已被丢弃；C2b 会重新生成）。
    expect(created!.csrfHash).toMatch(/^[0-9a-f]{64}$/);

    // 有效期 10 分钟（允许几秒误差：它由 `new Date()` 生成）。
    const ttlMs = created!.expiresAt.getTime() - created!.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(9.9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("response_type 缺失或不是 code → 400", async () => {
    for (const value of [undefined, "token", "", "CODE"]) {
      const res = await get(authorizeQuery({ response_type: value }));
      expect(res.status, `response_type=${String(value)}`).toBe(400);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("client_id 未注册 → 400（不区分「不存在」与「参数错」）", async () => {
    const res = await get(authorizeQuery({ client_id: "no-such-client" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    // 文案里不能出现「这个 client 不存在」这类存在性判断。
    expect(body.error_description).toBe("client is not registered");
    expect(await rows()).toHaveLength(0);
  });

  it("redirect_uri 必须逐字符相等（前缀相同也不行）", async () => {
    await seedAuthorizeClient(handle, {
      clientId: "prefix-client",
      redirectUris: ["https://client.example/cb"],
    });

    const nearMisses = [
      "https://client.example/cb/", // 尾部斜杠
      "https://client.example/cb/extra", // 前缀相同、多了路径
      "https://client.example/cb?x=1", // 加了查询串
      "https://client.example/cb#frag", // 加了片段
      "http://client.example/cb", // 协议不同
      "https://client.example:443/cb", // 显式端口
      "https://CLIENT.example/cb", // 大小写（主机名规范化不该被偷偷应用）
    ];
    for (const redirectUri of nearMisses) {
      const res = await get(authorizeQuery({ client_id: "prefix-client", redirect_uri: redirectUri }));
      expect(res.status, redirectUri).toBe(400);
    }
    expect(await rows()).toHaveLength(0);

    // 精确的那一个必须成功——否则上面的全 400 可能只是因为路由整个坏了。
    const ok = await get(
      authorizeQuery({ client_id: "prefix-client", redirect_uri: "https://client.example/cb" }),
    );
    expect(ok.status).toBe(302);
  });

  it("未注册的 redirect_uri（完全不同的域名）→ 400", async () => {
    const res = await get(authorizeQuery({ redirect_uri: "https://evil.example/callback" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("resource 必须逐字符等于 BASE_URL + /mcp", async () => {
    for (const resource of [
      "https://gateway.example",
      "https://gateway.example/mcp/",
      "https://other.example/mcp",
      "http://gateway.example/mcp",
      undefined,
    ]) {
      const res = await get(authorizeQuery({ resource }));
      expect(res.status, `resource=${String(resource)}`).toBe(400);
    }
  });

  it("code_challenge 必须是 43 字符 base64url", async () => {
    for (const challenge of [
      "short",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}+`, // 非 base64url 字符
      `${"a".repeat(42)}=`, // padding
      undefined,
    ]) {
      const res = await get(authorizeQuery({ code_challenge: challenge }));
      expect(res.status, `challenge=${String(challenge).slice(0, 10)}`).toBe(400);
    }
  });

  it("code_challenge_method 只接受 S256（plain 一律拒绝）", async () => {
    for (const method of ["plain", "s256", "", undefined]) {
      const res = await get(authorizeQuery({ code_challenge_method: method }));
      expect(res.status, `method=${String(method)}`).toBe(400);
    }
  });

  it("scope 必须是非空且全在 MCP_SCOPES 内的子集", async () => {
    for (const scope of [undefined, "", "   ", "records:write", "records:read records:write", "unknown"]) {
      const res = await get(authorizeQuery({ scope }));
      expect(res.status, `scope=${String(scope)}`).toBe(400);
    }

    // 单个合法 scope 必须通过。
    const single = await get(authorizeQuery({ scope: "canvas:read" }));
    expect(single.status).toBe(302);
    const created = (await rows())[0];
    expect(created!.scope).toEqual(["canvas:read"]);
  });

  it("重复 scope 去重后落库（不是照抄原串）", async () => {
    const res = await get(authorizeQuery({ scope: "records:read records:read coffee:read" }));
    expect(res.status).toBe(302);
    expect((await rows())[0]!.scope).toEqual(["records:read", "coffee:read"]);
  });

  it("grant_types 不含 authorization_code → 400", async () => {
    await seedAuthorizeClient(handle, {
      clientId: "refresh-only",
      grantTypes: ["refresh_token"],
    });
    const res = await get(authorizeQuery({ client_id: "refresh-only" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toContain("authorization code");
  });

  it("state 缺省时落 NULL（不是空串），且超长被拒", async () => {
    const ok = await get(authorizeQuery({ state: undefined }));
    expect(ok.status).toBe(302);
    expect((await rows())[0]!.state).toBeNull();

    const tooLong = await get(authorizeQuery({ state: "x".repeat(600) }));
    expect(tooLong.status).toBe(400);
  });
});

describe("浏览器 Cookie：复用而不是每次重签", () => {
  it("没有 Cookie 时新建，属性正确", async () => {
    const res = await get(authorizeQuery());
    const header = setCookieOf(res);
    expect(header).toBeTruthy();
    const cookie = parseSetCookie(header!);

    expect(cookie.__name).toBe("bp_mcp_bs");
    expect(cookie.path).toBe(MCP_BROWSER_COOKIE_PATH);
    expect(cookie.path).toBe("/mcp/oauth");
    expect(cookie.httponly).toBe("true");
    expect(cookie.samesite).toBe("Lax");
    expect(cookie["max-age"]).toBe("1800");
    expect(cookie.domain).toBeUndefined();
    // 测试环境 isProduction=false → 不带 Secure（生产必须带，另有用例）。
    expect(cookie.secure).toBeUndefined();
  });

  it("已有有效 Cookie 时复用：不再下发 Set-Cookie", async () => {
    const first = await get(authorizeQuery());
    const pair = cookiePair(first)!;
    expect(pair).toBeTruthy();

    const second = await get(authorizeQuery(), { cookie: pair });
    expect(second.status).toBe(302);
    // 没有新的 Set-Cookie = 没重新签发、没滑动续期。
    expect(setCookieOf(second)).toBeNull();
  });

  it("两个 authorize 复用同一 sid：两个 rid 都能用同一个 Cookie 绑定", async () => {
    // 多标签页的真实形状：同一浏览器连开两次授权。
    const first = await get(authorizeQuery());
    const pair = cookiePair(first)!;
    const second = await get(authorizeQuery(), { cookie: pair });
    expect(setCookieOf(second)).toBeNull();

    const rid1 = new URL(first.headers.get("location")!, "https://x").searchParams.get("rid")!;
    const rid2 = new URL(second.headers.get("location")!, "https://x").searchParams.get("rid")!;
    expect(rid1).not.toBe(rid2);

    // 用**同一个** Cookie 分别进入两个 rid：都要成功（绑定在行上，不在 Cookie 上）。
    for (const rid of [rid1, rid2]) {
      const login = await h.app.request(`/mcp/oauth/login?rid=${rid}`, {
        headers: { cookie: pair },
      });
      expect(login.status, rid).toBe(200);
    }

    // 两行绑的是同一个哈希。
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0]!.browserBindingHash).toBe(all[1]!.browserBindingHash);
    expect(all[0]!.browserBindingHash).toBeTruthy();
  });

  it("Cookie 被篡改 → 不沿用，重新签发", async () => {
    const first = await get(authorizeQuery());
    const pair = cookiePair(first)!;
    const tampered = `${pair.slice(0, -2)}zz`;

    const res = await get(authorizeQuery(), { cookie: tampered });
    expect(res.status).toBe(302);
    // 篡改值等于「没有可用 Cookie」，因此必须新发一个。
    expect(setCookieOf(res)).toBeTruthy();
  });

  it("Cookie 已过期 → 不沿用，重新签发", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await signBrowserCookie(h.env, {
      sid: "x".repeat(43),
      iat: nowSec - 2000,
      exp: nowSec - 100,
    });

    const res = await get(authorizeQuery(), { cookie: expired });
    expect(res.status).toBe(302);
    expect(setCookieOf(res)).toBeTruthy();
  });

  it("authorize 不写 browser_binding_hash（绑定发生在登录页）", async () => {
    const res = await get(authorizeQuery());
    expect(res.status).toBe(302);
    // 即便这次请求已经拿到了 Cookie，也不在这一步绑定：
    // 客户端可能是「服务端去拉 authorize」，那时 Set-Cookie 会被丢弃。
    expect((await rows())[0]!.browserBindingHash).toBeNull();
  });

  it("Cookie 的 Path 不含 /mcp 本体（只覆盖 /mcp/oauth）", async () => {
    const res = await get(authorizeQuery());
    const cookie = parseSetCookie(setCookieOf(res)!);
    const path = cookie.path ?? "";
    // `/mcp/oauth` 的前缀匹配不会命中 `/mcp`，因此授权 Cookie 永远不会
    // 出现在数据端点的请求里。
    expect("/mcp".startsWith(path)).toBe(false);
    expect("/mcp/oauth/consent".startsWith(path)).toBe(true);
  });
});

describe("与 Desktop 登录的隔离", () => {
  it("MCP authorize 不写 oauth_transactions / oauth_codes", async () => {
    await get(authorizeQuery());
    const txCount = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from oauth_transactions`;
    const codeCount = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from oauth_codes`;
    expect(txCount[0]?.count).toBe("0");
    expect(codeCount[0]?.count).toBe("0");
  });

  it("Desktop 的 /oauth/authorize 仍只接受 127.0.0.1 回环回调", async () => {
    // 非回环 redirect_uri 必须继续 400 —— 提醒：这条白名单属 Desktop 登录，
    // MCP 的放宽**不得**波及它。
    const res = await h.app.request(
      "/oauth/authorize?provider=google&state=s&code_challenge=" +
        "a".repeat(43) +
        "&redirect_uri=" +
        encodeURIComponent("https://evil.example/cb"),
    );
    expect(res.status).toBe(400);
  });
});

describe("行数据的一致性", () => {
  it("每次 authorize 只建一行（不重复、不复用旧行）", async () => {
    await get(authorizeQuery());
    await get(authorizeQuery());
    expect(await rows()).toHaveLength(2);
    const all = await rows();
    expect(all[0]!.id).not.toBe(all[1]!.id);
  });

  it("落库的 redirect_uri 就是客户端注册的那一个（不是请求里的任意值）", async () => {
    await get(authorizeQuery());
    const row = (await rows())[0]!;
    // 它通过了精确匹配，所以两者必然逐字符相等；这条断言在「未来有人把
    // 匹配改成前缀比较」时会变红。
    expect(row.redirectUri).toBe("https://client.example/callback");
  });

  it("可以直接按 provider_state_hash 反查（唯一索引的前提）", async () => {
    await get(authorizeQuery());
    const row = (await rows())[0]!;
    // authorize 阶段没有 Provider State；这条确认列可空且为 NULL。
    expect(row.providerStateHash).toBeNull();
    const found = await handle.db
      .select({ id: mcpAuthRequests.id })
      .from(mcpAuthRequests)
      .where(eq(mcpAuthRequests.state, "client-state-1"));
    expect(found).toHaveLength(1);
  });
});
