import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
import { sha256Hex } from "../../src/security/crypto.js";
import { mcpAuthRequests } from "../../src/db/schema.js";
import { createProviders } from "../../src/oauth/providers.js";
import { makeTestEnv } from "../helpers/env.js";

/**
 * `GET /mcp/oauth/login`（Phase 1.3.1-C2a）。
 *
 * 三条主线：
 * 1. **TOFU 绑定** —— 首次进入即绑定，之后必须是同一个浏览器；
 * 2. **Provider 跳转** —— 回调地址必须是 `/mcp/oauth/callback/:provider`，
 *    且只把哈希落库；
 * 3. **登录页** —— 只列真实可用的 Provider，所有动态内容转义。
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

interface AuthorizeResult {
  rid: string;
  cookie: string;
}

/** 走一次 authorize，拿到 rid 与随之签发的浏览器 Cookie。 */
async function startAuthorization(query = authorizeQuery()): Promise<AuthorizeResult> {
  const res = await h.app.request(`/mcp/oauth/authorize?${query}`);
  expect(res.status).toBe(302);
  const rid = new URL(res.headers.get("location")!, "https://x").searchParams.get("rid")!;
  const cookie = cookiePair(res) ?? "";
  return { rid, cookie };
}

async function login(rid: string, cookie: string, query = "") {
  return h.app.request(`/mcp/oauth/login?rid=${encodeURIComponent(rid)}${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function rows() {
  return handle.db.select().from(mcpAuthRequests);
}

describe("前置校验", () => {
  it("rid 不是 uuid → 400", async () => {
    const { cookie } = await startAuthorization();
    for (const rid of ["", "abc", "../../etc/passwd", "0".repeat(36)]) {
      const res = await login(rid, cookie);
      expect(res.status, rid).toBe(400);
    }
  });

  it("rid 不存在 → 400", async () => {
    const { cookie } = await startAuthorization();
    const res = await login("00000000-0000-0000-0000-000000000000", cookie);
    expect(res.status).toBe(400);
  });

  it("已绑定的授权请求缺 Cookie → 400（不允许靠新建 Cookie 接管）", async () => {
    const { rid, cookie } = await startAuthorization();
    await login(rid, cookie); // 浏览器 A 先绑定

    // 浏览器 B 拿着同一个 rid、但没有 Cookie。
    const res = await login(rid, "");
    expect(res.status).toBe(400);
    // 不签发新 Cookie：签发就等于把绑定让给了任何拿到 rid 的人。
    expect(setCookieOf(res)).toBeNull();
    // 行仍然绑定在浏览器 A 上。
    expect((await rows())[0]!.browserBindingHash).not.toBeNull();
  });

  it("已过期的授权请求 → 400 且行被清理", async () => {
    const { rid, cookie } = await startAuthorization();
    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${rid}`;

    const res = await login(rid, cookie);
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("已消费的授权请求 → 400", async () => {
    const { rid, cookie } = await startAuthorization();
    await handle.sql`
      update mcp_auth_requests set provider_consumed_at = now() where id = ${rid}`;

    const res = await login(rid, cookie);
    expect(res.status).toBe(400);
  });
});

describe("首次进入时建立浏览器会话（C2b 修复）", () => {
  it("authorize 的 Set-Cookie 被服务端丢弃后，真实浏览器首次访问 login → 200 并完成 TOFU", async () => {
    // 模拟「客户端在服务端拉 authorize，Set-Cookie 被丢弃」：这里刻意不
    // 回填 authorize 拿到的 Cookie。
    const { rid } = await startAuthorization();

    const res = await login(rid, "");
    expect(res.status).toBe(200);

    // 新 Cookie 被签发，属性与 authorize 那次一致。
    const header = setCookieOf(res);
    expect(header).toBeTruthy();
    const parsed = parseSetCookie(header!);
    expect(parsed.__name).toBe("bp_mcp_bs");
    expect(parsed.path).toBe("/mcp/oauth");
    expect(parsed.httponly).toBe("true");
    expect(parsed.samesite?.toLowerCase()).toBe("lax");

    // 行被绑定到这把新 Cookie 的 sid，而不是「未绑定」。
    const cookieValue = decodeURIComponent(parsed.__value ?? "");
    const sid = JSON.parse(cookieValue.slice(0, cookieValue.lastIndexOf("."))).sid as string;
    expect((await rows())[0]!.browserBindingHash).toBe(sha256Hex(`mcp-browser:${sid}`));

    // 这把 Cookie 能继续走到 Provider。
    const cookie = `bp_mcp_bs=${parsed.__value}`;
    const next = await login(rid, cookie, "&provider=google");
    expect(next.status).toBe(302);
  });

  it("被篡改的 Cookie 在未绑定时按缺失处理：新建会话并绑定", async () => {
    const { rid, cookie } = await startAuthorization();
    const tampered = `${cookie.split("=")[0]}=${cookie.split("=")[1]}x`;

    const res = await login(rid, tampered);
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toBeTruthy();
    expect((await rows())[0]!.browserBindingHash).not.toBeNull();
  });

  it("过期的 Cookie 不影响未绑定行的首次绑定（新建一把）", async () => {
    const { rid } = await startAuthorization();
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await signBrowserCookie(h.env, {
      sid: "e".repeat(43),
      iat: nowSec - 3600,
      exp: nowSec - 1800,
    });

    const res = await login(rid, expired);
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toBeTruthy();
  });

  it("已绑定的行遇到被篡改的 Cookie → 400（按缺失处理，不新建）", async () => {
    const { rid, cookie } = await startAuthorization();
    await login(rid, cookie);

    const res = await login(rid, `${cookie.split("=")[0]}=${cookie.split("=")[1]}x`);
    expect(res.status).toBe(400);
    expect(setCookieOf(res)).toBeNull();
  });

  it("Provider 回调不允许匿名创建浏览器会话", async () => {
    const { rid, cookie } = await startAuthorization();
    const jump = await login(rid, cookie, "&provider=google");
    expect(jump.status).toBe(302);
    const state = new URL(jump.headers.get("location")!).searchParams.get("state")!;

    // 回调时没有 Cookie：这里**不能**像 login 那样补一把新的。
    const res = await h.app.request(
      `/mcp/oauth/callback/google?code=c&state=${state}`,
      { headers: {} },
    );
    expect(res.status).toBe(400);
    expect(setCookieOf(res)).toBeNull();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.providerConsumedAt).toBeNull();
  });
});

describe("TOFU 绑定", () => {
  it("首次进入绑定成功（NULL → 当前 sid 的哈希）", async () => {
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie);
    expect(res.status).toBe(200);

    const row = (await rows())[0]!;
    expect(row.browserBindingHash).toMatch(/^[0-9a-f]{64}$/);

    // 绑定哈希必须来自 Cookie 里的 sid（域分隔 `mcp-browser:`）。
    const sid = JSON.parse(
      decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).slice(
        0,
        decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).lastIndexOf("."),
      ),
    ).sid as string;
    expect(row.browserBindingHash).toBe(sha256Hex(`mcp-browser:${sid}`));
  });

  it("同一个 sid 重复进入成功，且哈希不变（不重绑）", async () => {
    const { rid, cookie } = await startAuthorization();
    await login(rid, cookie);
    const first = (await rows())[0]!.browserBindingHash;

    const again = await login(rid, cookie);
    expect(again.status).toBe(200);
    expect((await rows())[0]!.browserBindingHash).toBe(first);
  });

  it("不同 sid 进入 → 400，行被删除，写入绑定不匹配审计", async () => {
    const { rid, cookie } = await startAuthorization();
    await login(rid, cookie); // 浏览器 A 先绑定

    const nowSec = Math.floor(Date.now() / 1000);
    const otherBrowser = await signBrowserCookie(h.env, {
      sid: "b".repeat(43),
      iat: nowSec,
      exp: nowSec + 1800,
    });

    const res = await login(rid, otherBrowser);
    expect(res.status).toBe(400);
    // fail-closed：删行，让「另一个浏览器」也无法继续。
    expect(await rows()).toHaveLength(0);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events
       where event_type = 'mcp_browser_binding_mismatch'`;
    expect(audit[0]?.count).toBe("1");
  });

  it("两个浏览器同时抢一个 rid：恰好一个绑定成功，另一个被拒", async () => {
    const { rid, cookie } = await startAuthorization();
    const nowSec = Math.floor(Date.now() / 1000);
    const otherBrowser = await signBrowserCookie(h.env, {
      sid: "c".repeat(43),
      iat: nowSec,
      exp: nowSec + 1800,
    });

    const [a, b] = await Promise.all([login(rid, cookie), login(rid, otherBrowser)]);
    const statuses = [a.status, b.status].sort();
    // 一个 200（抢到绑定），一个 400（发现已被别人绑上）。
    expect(statuses).toEqual([200, 400]);

    // 绑定不匹配那一刻会删行，所以最终行数为 0 —— 这是设计选择：
    // 宁可打断一次合法流程，也不放行一次可疑流程。
    expect(await rows()).toHaveLength(0);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events
       where event_type = 'mcp_browser_binding_mismatch'`;
    expect(Number(audit[0]?.count)).toBeGreaterThanOrEqual(1);
  });
});

describe("登录页", () => {
  it("展示两个已配置的 Provider，且链接指向本路由", async () => {
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Google");
    expect(html).toContain("GitHub");
    expect(html).toContain(`/mcp/oauth/login?rid=${rid}&amp;provider=google`);
    expect(html).toContain(`/mcp/oauth/login?rid=${rid}&amp;provider=github`);

    // 安全头：授权页不能被缓存、不能被 iframe、不能带 Referer 出去。
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");

    // 没有脚本、没有外部资源。
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://cdn");
  });

  it("只列出真实可用的 Provider", async () => {
    h.removeProvider("github");
    const { rid, cookie } = await startAuthorization();
    const html = await (await login(rid, cookie)).text();

    expect(html).toContain("Google");
    expect(html).not.toContain("GitHub");
  });

  it("一个 Provider 都没配置时给出明确提示，不伪造入口", async () => {
    h.removeProvider("google");
    h.removeProvider("github");
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain("provider=google");
    expect(html).not.toContain("provider=github");
    expect(html).toContain("未配置");
  });

  it("客户端名里的 HTML 被转义（不产生标签）", async () => {
    await seedAuthorizeClient(handle, {
      clientId: "xss-client",
      clientName: `<img src=x onerror=alert(1)>"破折号"&`,
      redirectUris: ["https://xss.example/cb"],
    });
    const { rid, cookie } = await startAuthorization(
      authorizeQuery({ client_id: "xss-client", redirect_uri: "https://xss.example/cb" }),
    );
    const html = await (await login(rid, cookie)).text();

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;破折号&quot;");
    expect(html).toContain("&amp;");
  });
});

describe("Provider 跳转", () => {
  it("Google：302 到 Provider，回调地址指向本文件的路由，state/nonce 非空", async () => {
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie, "&provider=google");

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.hostname).toBe("google.test");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example/mcp/oauth/callback/google",
    );
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();

    // 明文绝不等于库里的哈希。
    const row = (await rows())[0]!;
    expect(row.provider).toBe("google");
    expect(row.providerStateHash).toBeTruthy();
    expect(row.providerStateHash).not.toBe(location.searchParams.get("state"));
    expect(row.nonceHash).toBeTruthy();
    expect(row.nonceHash).not.toBe(location.searchParams.get("nonce"));
  });

  it("Provider State 与 Nonce 都只存 SHA-256 哈希", async () => {
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie, "&provider=google");
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const nonce = location.searchParams.get("nonce")!;

    const row = (await rows())[0]!;
    expect(row.providerStateHash).toBe(sha256Hex(state));
    // nonce 的哈希**不加域前缀**：Google 适配器验证 ID Token 时算的是
    // `sha256Hex(idToken.nonce)`，加前缀会让所有 Google 登录失败。
    expect(row.nonceHash).toBe(sha256Hex(nonce));

    // 库里的任何列都不含明文。
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(state);
    expect(dump).not.toContain(nonce);
  });

  it("GitHub：回调地址正确，且不传 nonce、nonce_hash 为空串", async () => {
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie, "&provider=github");

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.hostname).toBe("github.test");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example/mcp/oauth/callback/github",
    );
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeNull();

    const row = (await rows())[0]!;
    expect(row.provider).toBe("github");
    expect(row.nonceHash).toBe("");
  });

  it("绝不使用 Desktop 的回调地址", async () => {
    const { rid, cookie } = await startAuthorization();
    const redirectUris: string[] = [];
    for (const provider of ["google", "github"]) {
      const fresh = await startAuthorization();
      const res = await login(fresh.rid, fresh.cookie, `&provider=${provider}`);
      const location = new URL(res.headers.get("location")!);
      redirectUris.push(location.searchParams.get("redirect_uri") ?? "");
    }
    expect(redirectUris).toEqual([
      "https://gateway.example/mcp/oauth/callback/google",
      "https://gateway.example/mcp/oauth/callback/github",
    ]);
    for (const uri of redirectUris) {
      // 注意正则不能写 `/\/oauth\/callback\//` —— `/mcp/oauth/callback/`
      // 里也含这段子串，那样断言会把正确实现判成错的。要比的是**根路径**。
      expect(uri.startsWith("https://gateway.example/oauth/")).toBe(false);
      expect(uri.startsWith("https://gateway.example/mcp/oauth/callback/")).toBe(true);
    }
    void rid;
    void cookie;
  });

  it("不支持的 provider → 400", async () => {
    const { rid, cookie } = await startAuthorization();
    for (const provider of ["okta", "GOOGLE", "", "github2"]) {
      const res = await login(rid, cookie, `&provider=${provider}`);
      // 空串等价于「没传」，会走登录页而不是报错。
      expect(res.status, provider).toBe(provider === "" ? 200 : 400);
    }
  });

  it("Provider 未配置 → 400 provider_not_configured", async () => {
    h.removeProvider("google");
    const { rid, cookie } = await startAuthorization();
    const res = await login(rid, cookie, "&provider=google");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provider_not_configured");
  });

  it("已被另一个 Provider 占用 → 400 provider_conflict（不静默切换）", async () => {
    const { rid, cookie } = await startAuthorization();
    const first = await login(rid, cookie, "&provider=google");
    expect(first.status).toBe(302);

    const second = await login(rid, cookie, "&provider=github");
    expect(second.status).toBe(400);
    // 行仍指向 google：冲突不会改动既有状态。
    expect((await rows())[0]!.provider).toBe("google");
  });

  it("同一 Provider 重复发起 → 允许，且换一把新的 PR（旧的立刻失效）", async () => {
    const { rid, cookie } = await startAuthorization();
    const first = await login(rid, cookie, "&provider=google");
    const firstState = new URL(first.headers.get("location")!).searchParams.get("state")!;
    const firstHash = (await rows())[0]!.providerStateHash;

    const second = await login(rid, cookie, "&provider=google");
    expect(second.status).toBe(302);
    const secondState = new URL(second.headers.get("location")!).searchParams.get("state")!;
    const secondHash = (await rows())[0]!.providerStateHash;

    expect(secondState).not.toBe(firstState);
    expect(secondHash).not.toBe(firstHash);
    expect(secondHash).toBe(sha256Hex(secondState));
  });

  it("登录页 200 不写 provider_state_hash（只有点了 Provider 才写）", async () => {
    const { rid, cookie } = await startAuthorization();
    await login(rid, cookie);
    const row = (await rows())[0]!;
    expect(row.provider).toBeNull();
    expect(row.providerStateHash).toBeNull();
  });
});

describe("真实 Provider 适配器的 URL 拼装", () => {
  // 上面的用例用 Mock Adapter 是为了能控制身份交换；但「把 MCP 的回调地址
  // 交给真实适配器」这件事必须用**真的** Google/GitHub 实现验一次，
  // 否则 Mock 只是在验证我自己写的 URL 拼接。
  const adapters = createProviders(makeTestEnv());
  const cloudRedirect = "https://gateway.example/mcp/oauth/callback";

  it("Google：redirect_uri 指向 MCP 回调，state/nonce 原样传递", () => {
    const url = new URL(
      adapters.google!.buildAuthorizeUrl({
        cloudRedirectUri: `${cloudRedirect}/google`,
        combinedState: "PR-value",
        nonce: "nonce-value",
      }),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(`${cloudRedirect}/google`);
    expect(url.searchParams.get("state")).toBe("PR-value");
    expect(url.searchParams.get("nonce")).toBe("nonce-value");
    // Google 适配器自己的固定参数保持不变（不是我们该改的东西）。
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("online");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("GitHub：redirect_uri 指向 MCP 回调，且不带 nonce、不带 scope", () => {
    const url = new URL(
      adapters.github!.buildAuthorizeUrl({
        cloudRedirectUri: `${cloudRedirect}/github`,
        combinedState: "PR-value",
      }),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(`${cloudRedirect}/github`);
    expect(url.searchParams.get("state")).toBe("PR-value");
    expect(url.searchParams.get("nonce")).toBeNull();
    // GitHub 不申请仓库权限（scope 留空）。
    expect(url.searchParams.get("scope")).toBeNull();
  });
});
