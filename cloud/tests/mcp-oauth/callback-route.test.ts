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
import { serverError } from "../../src/security/errors.js";
import { mcpAuthRequests } from "../../src/db/schema.js";

/**
 * `GET /mcp/oauth/callback/:provider`（Phase 1.3.1-C2a）。
 *
 * 三条不可让步的语义：
 * 1. **State 只能被消费一次** —— 重放/并发都只有一个成功；
 * 2. **Provider 错误不得伪装** —— 用户拒绝是 `access_denied`，交换失败是
 *    `server_error`，两者混淆会让客户端做出相反的决定；
 * 3. **不碰 Desktop 的表** —— 这条流程结束后 `oauth_codes` 与
 *    `oauth_transactions` 必须仍是 0 行。
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

interface Started {
  rid: string;
  cookie: string;
  state: string;
  nonce?: string;
  redirectUri: string;
}

/** 走到「Provider 已跳转」这一步，拿到 state / nonce。 */
async function startProvider(
  provider: "google" | "github" = "google",
  query = authorizeQuery(),
): Promise<Started> {
  const authorizeRes = await h.app.request(`/mcp/oauth/authorize?${query}`);
  expect(authorizeRes.status).toBe(302);
  const rid = new URL(authorizeRes.headers.get("location")!, "https://x").searchParams.get("rid")!;
  const cookie = cookiePair(authorizeRes) ?? "";

  const loginRes = await h.app.request(`/mcp/oauth/login?rid=${rid}&provider=${provider}`, {
    headers: { cookie },
  });
  expect(loginRes.status).toBe(302);
  const location = new URL(loginRes.headers.get("location")!);
  return {
    rid,
    cookie,
    state: location.searchParams.get("state")!,
    nonce: location.searchParams.get("nonce") ?? undefined,
    redirectUri: location.searchParams.get("redirect_uri")!,
  };
}

async function callback(
  provider: "google" | "github",
  params: Record<string, string | undefined>,
  cookie: string,
) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, v);
  return h.app.request(`/mcp/oauth/callback/${provider}?${search.toString()}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function rows() {
  return handle.db.select().from(mcpAuthRequests);
}

async function userCount(): Promise<number> {
  const r = await handle.sql<{ count: string }[]>`select count(*)::text as count from users`;
  return Number(r[0]?.count ?? "0");
}

describe("成功路径", () => {
  it("302 到同意页，user_id 写入，行被保留", async () => {
    const started = await startProvider("google");
    const res = await callback("google", { code: "code-1", state: started.state }, started.cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/mcp/oauth/consent?rid=${started.rid}`);

    // 行**必须保留**：C2b 的同意页还要读 scope / client / redirect_uri。
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(started.rid);
    expect(all[0]!.userId).toBeTruthy();
    expect(all[0]!.provider).toBe("google");
    expect(all[0]!.providerConsumedAt).not.toBeNull();
  });

  it("首次登录会创建 BrewPhase 用户与身份", async () => {
    const started = await startProvider("google");
    expect(await userCount()).toBe(0);

    await callback("google", { code: "c", state: started.state }, started.cookie);

    expect(await userCount()).toBe(1);
    const identities = await handle.sql<{ provider: string; provider_subject: string }[]>`
      select provider, provider_subject from user_identities`;
    expect(identities).toEqual([{ provider: "google", provider_subject: "google-sub-1" }]);
  });

  it("已存在的身份复用同一个用户（不重复建号）", async () => {
    const first = await startProvider("google");
    await callback("google", { code: "c1", state: first.state }, first.cookie);
    const afterFirst = await userCount();

    // 同一浏览器重新走一遍授权（新 rid），Provider 返回同一个 sub。
    const second = await startProvider("google");
    await callback("google", { code: "c2", state: second.state }, second.cookie);

    expect(await userCount()).toBe(afterFirst);
    // 两次授权的行指向同一个用户。
    const all = await rows();
    expect(new Set(all.map((row) => row.userId)).size).toBe(1);
  });

  it("GitHub 路径同样可用（nonce_hash 为空串）", async () => {
    const started = await startProvider("github");
    const res = await callback("github", { code: "c", state: started.state }, started.cookie);

    expect(res.status).toBe(302);
    const row = (await rows())[0]!;
    expect(row.provider).toBe("github");
    expect(row.nonceHash).toBe("");
    expect(row.userId).toBeTruthy();
  });

  it("审计记录成功，且不含 state / code", async () => {
    const started = await startProvider("google");
    await callback("google", { code: "secret-code", state: started.state }, started.cookie);

    const events = await handle.sql<{ event_type: string; detail: unknown }[]>`
      select event_type, detail from auth_events where event_type like 'mcp_%'`;
    const types = events.map((e) => e.event_type);
    expect(types).toContain("mcp_provider_callback_succeeded");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(started.state);
    expect(serialized).not.toContain("secret-code");
  });
});

describe("一次性消费", () => {
  it("重复 callback → 第二次 400，且不重复建用户", async () => {
    const started = await startProvider("google");
    const first = await callback("google", { code: "c", state: started.state }, started.cookie);
    expect(first.status).toBe(302);
    const usersAfterFirst = await userCount();

    const second = await callback("google", { code: "c", state: started.state }, started.cookie);
    expect(second.status).toBe(400);
    // 不允许造成任何第二次结果。
    expect(second.headers.get("location")).toBeNull();
    expect(await userCount()).toBe(usersAfterFirst);
    expect(h.providers.google.state.exchangeCount).toBe(1);
  });

  it("并发 callback → 恰好一个成功，只交换一次身份", async () => {
    const started = await startProvider("google");

    const [a, b] = await Promise.all([
      callback("google", { code: "c", state: started.state }, started.cookie),
      callback("google", { code: "c", state: started.state }, started.cookie),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([302, 400]);

    // **关键**：Provider 只被调用一次。若两次都进了网络交换，
    // 就说明「原子消费」没生效。
    expect(h.providers.google.state.exchangeCount).toBe(1);
    expect(await userCount()).toBe(1);
  });

  it("未知 state → 400，且不产生任何 Location（防开放重定向）", async () => {
    const started = await startProvider("google");
    const res = await callback(
      "google",
      { code: "c", state: "never-issued-state" },
      started.cookie,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("缺少 state / code → 400", async () => {
    const started = await startProvider("google");
    const noState = await callback("google", { code: "c" }, started.cookie);
    expect(noState.status).toBe(400);

    const noCode = await callback("google", { state: started.state }, started.cookie);
    expect(noCode.status).toBe(400);

    // 两次都没消费掉 state。
    expect((await rows())[0]!.providerConsumedAt).toBeNull();
  });

  it("用 Google 的 state 打 GitHub 的回调地址 → 400（不交叉）", async () => {
    const started = await startProvider("google");
    const res = await callback("github", { code: "c", state: started.state }, started.cookie);

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    // 没有被消费：跨 provider 的尝试不该破坏合法流程的状态。
    expect((await rows())[0]!.providerConsumedAt).toBeNull();
  });

  it("不支持的 provider 路径 → 400", async () => {
    const started = await startProvider("google");
    for (const provider of ["okta", "GOOGLE"]) {
      const res = await h.app.request(
        `/mcp/oauth/callback/${provider}?code=c&state=${started.state}`,
        { headers: { cookie: started.cookie } },
      );
      expect(res.status, provider).toBe(400);
    }
  });

  it("过期的授权请求 → 400 且行被清理", async () => {
    const started = await startProvider("google");
    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${started.rid}`;

    const res = await callback("google", { code: "c", state: started.state }, started.cookie);
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });
});

describe("浏览器绑定", () => {
  it("另一个浏览器的 Cookie 回调 → 400，行被删除", async () => {
    const started = await startProvider("google");
    const nowSec = Math.floor(Date.now() / 1000);
    const otherBrowser = await signBrowserCookie(h.env, {
      sid: "d".repeat(43),
      iat: nowSec,
      exp: nowSec + 1800,
    });

    const res = await callback("google", { code: "c", state: started.state }, otherBrowser);
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events
       where event_type = 'mcp_browser_binding_mismatch' and detail->>'stage' = 'callback'`;
    expect(audit[0]?.count).toBe("1");
  });

  it("没有 Cookie 回调 → 400（不消费 state）", async () => {
    const started = await startProvider("google");
    const res = await callback("google", { code: "c", state: started.state }, "");
    expect(res.status).toBe(400);
    expect((await rows())[0]!.providerConsumedAt).toBeNull();
  });
});

describe("Provider 侧失败", () => {
  it("用户拒绝：302 回客户端，带 access_denied + state + iss，并删行清 Cookie", async () => {
    const started = await startProvider("google");
    const res = await callback(
      "google",
      { error: "access_denied", state: started.state },
      started.cookie,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://client.example/callback");
    expect(location.searchParams.get("error")).toBe("access_denied");
    // 客户端 state 必须原样回传（不是 Provider State）。
    expect(location.searchParams.get("state")).toBe("client-state-1");
    expect(location.searchParams.get("iss")).toBe("https://gateway.example");
    // Provider State 绝不能出现在回跳 URL 里。
    expect(res.headers.get("location")).not.toContain(started.state);

    expect(await rows()).toHaveLength(0);

    // 同时清掉浏览器 Cookie（Max-Age=0，且 Path 一致）。
    const cookie = parseSetCookie(setCookieOf(res)!);
    expect(cookie.__name).toBe("bp_mcp_bs");
    expect(cookie["max-age"]).toBe("0");
    expect(cookie.path).toBe("/mcp/oauth");

    // Provider 从未被调用。
    expect(h.providers.google.state.exchangeCount).toBe(0);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events where event_type = 'mcp_provider_denied'`;
    expect(audit[0]?.count).toBe("1");
  });

  it("用户拒绝但 state 未知 → 400，不重定向", async () => {
    const started = await startProvider("google");
    const res = await callback("google", { error: "access_denied", state: "bogus" }, started.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("用户拒绝但缺少 state → 400，不重定向", async () => {
    const started = await startProvider("google");
    const res = await callback("google", { error: "access_denied" }, started.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("交换失败：302 回 redirect_uri 带 error=server_error（不是 access_denied），且行被清理", async () => {
    const started = await startProvider("google");
    h.providers.google.state.failure = serverError("google is down");

    const res = await callback("google", { code: "c", state: started.state }, started.cookie);

    // 不能返回 Cloud 的 500 页面：`redirect_uri` 已经过 authorize 的精确校验，
    // 客户端在那边等着 code/error，把用户丢在 Cloud 错误页等于断链。
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://client.example/callback");
    expect(location.searchParams.get("error")).toBe("server_error");
    // 关键：不能伪装成用户拒绝。
    expect(location.searchParams.get("error")).not.toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state-1");
    expect(location.searchParams.get("iss")).toBe("https://gateway.example");
    // 明文 code 不能出现在任何地方。
    expect(location.searchParams.get("code")).toBeNull();

    expect(await rows()).toHaveLength(0);

    // Cookie 被清（Path 必须是 /mcp/oauth，否则清不掉原来那个）。
    const cookie = parseSetCookie(setCookieOf(res)!);
    expect(cookie.__name).toBe("bp_mcp_bs");
    expect(cookie["max-age"]).toBe("0");
    expect(cookie.path).toBe("/mcp/oauth");

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events
       where event_type = 'mcp_provider_callback_failed' and detail->>'reason' = 'exchange_failed'`;
    expect(audit[0]?.count).toBe("1");
  });

  it("Provider 返回 server_error → error=server_error（不是用户拒绝）", async () => {
    const started = await startProvider("google");
    const res = await callback("google", { error: "server_error", state: started.state }, started.cookie);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("server_error");
    expect(await rows()).toHaveLength(0);
  });

  it("Provider 返回未知 error → error=server_error（不冒充 access_denied）", async () => {
    const started = await startProvider("google");
    const res = await callback("google", { error: "temporarily_unavailable", state: started.state }, started.cookie);

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("server_error");
  });

  it("旧 State 的拒绝回调不能删掉同一 rid 上新发起的授权", async () => {
    // 用同一个 rid 启动两次 Provider 流程：第二次会换掉 provider_state_hash。
    const started = await startProvider("google");
    const relogin = await h.app.request(
      `/mcp/oauth/login?rid=${started.rid}&provider=google`,
      { headers: { cookie: started.cookie } },
    );
    expect(relogin.status).toBe(302);
    const secondState = new URL(relogin.headers.get("location")!).searchParams.get("state")!;
    expect(secondState).not.toBe(started.state);

    // 旧 State 的拒绝回调抵达。
    const res = await callback("google", { error: "access_denied", state: started.state }, started.cookie);

    // 不重定向：这一行已经不是「当初被拒绝的那次授权」。
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();

    // 新流程完好无损。
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(started.rid);
    expect(all[0]!.providerConsumedAt).toBeNull();
  });

  it("旧 State 无法消费重新发起后的授权", async () => {
    const started = await startProvider("google");
    const relogin = await h.app.request(
      `/mcp/oauth/login?rid=${started.rid}&provider=google`,
      { headers: { cookie: started.cookie } },
    );
    expect(relogin.status).toBe(302);

    // 用旧 State 走「正常回调」：SELECT 已经查不到那把哈希。
    const res = await callback("google", { code: "c", state: started.state }, started.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.providerConsumedAt).toBeNull();
    // Provider 一次都没被调用。
    expect(h.providers.google.state.exchangeCount).toBe(0);
  });

  it("同一状态被拒绝后重放 → 第二次 400（一次性）", async () => {
    const started = await startProvider("google");
    const first = await callback("google", { error: "access_denied", state: started.state }, started.cookie);
    expect(first.status).toBe(302);

    const second = await callback("google", { error: "access_denied", state: started.state }, started.cookie);
    expect(second.status).toBe(400);
    expect(second.headers.get("location")).toBeNull();
  });

  it("被暂停的用户 → 403，且行被删除（不进同意页）", async () => {
    const started = await startProvider("google");
    // 先让身份存在且被暂停：跑一次成功流程，然后把用户置为 suspended，
    // 再走一次新授权。
    await callback("google", { code: "c1", state: started.state }, started.cookie);
    await handle.sql`update users set status = 'suspended'`;

    const second = await startProvider("google");
    const res = await callback("google", { code: "c2", state: second.state }, second.cookie);

    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    // 第一次成功的那一行仍然保留（它等着 C2b 的同意页）。
    // 被拒的是**第二次**那一行——它必须消失，不能留任何可用状态。
    const remaining = await rows();
    expect(remaining.map((row) => row.id)).not.toContain(second.rid);
  });
});

describe("Desktop OAuth 完全不受影响", () => {
  it("整个 MCP 流程不写 oauth_codes / oauth_transactions / auth_sessions", async () => {
    const started = await startProvider("google");
    await callback("google", { code: "c", state: started.state }, started.cookie);

    for (const table of ["oauth_codes", "oauth_transactions", "auth_sessions"]) {
      const r = await handle.sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from "${table}"`,
      );
      expect(Number(r[0]?.count ?? "-1"), table).toBe(0);
    }
  });

  it("Desktop 的 /oauth/callback/:provider 仍然存在（未被 MCP 路由遮蔽）", async () => {
    // 传一个不存在的 provider 与 state：应走 Desktop 的逻辑得到 400，
    // 而不是 404。这条断言证明两条路由组是并存的，没有互相覆盖。
    const res = await h.app.request("/oauth/callback/google?code=x&state=y");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Desktop 自己的错误码是 `invalid_grant`（state 无效），且响应是 JSON；
    // 而 MCP 的回调在同类情况下返回 HTML 400。两者形态不同，正好证明
    // 「MCP 路由没有捕获 Desktop 的路径」。
    expect(body.error).toBe("invalid_grant");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("Cookie 不会跨界", () => {
  it("把 MCP 的浏览器 Cookie 发给 /auth/me：仍然 401（不当作登录态）", async () => {
    const started = await startProvider("google");
    const res = await h.app.request("/auth/me", { headers: { cookie: started.cookie } });
    // 关键：授权 Cookie **绝不能**被当成用户登录凭据。它是浏览器流程状态，
    // 不是身份。401 就是这条边界仍然存在的证据。
    expect(res.status).toBe(401);
  });

  it("把 MCP 的浏览器 Cookie 发给 /oauth/token：仍然 400（不是 401/404）", async () => {
    const started = await startProvider("google");
    const res = await h.app.request("/oauth/token", {
      method: "POST",
      headers: { cookie: started.cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});
