import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, signBrowserCookie, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import { parseConsentPage, startConsentFlow, tableCount } from "../helpers/mcp-consent.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { hashCsrf } from "../../src/mcp-oauth/authorize-flow.js";
import { browserBindingHash } from "../../src/mcp-oauth/browser-session.js";

/**
 * `GET /mcp/oauth/consent`（Phase 1.3.1-C2b）。
 *
 * 这一组钉的是**「谁能看见同意页」**。它不是「页面渲染得好不好看」——
 * 同意页本身就是授权闸门：能打开它的人，离「拿到该用户的数据访问权」只差
 * 一次点击。所以十条前置条件每一条都要有独立用例，而且失败时的副作用
 * （删行 / 审计）也要断言。
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

async function consent(rid: string, cookie: string) {
  return h.app.request(`/mcp/oauth/consent?rid=${encodeURIComponent(rid)}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function rowOf(rid: string) {
  const rows = await handle.sql<{ csrf_hash: string; browser_binding_hash: string | null }[]>`
    select csrf_hash, browser_binding_hash from mcp_auth_requests where id = ${rid}`;
  return rows[0];
}

describe("正常展示", () => {
  it("200 text/html，包含客户端名、回调域名、四个 scope 与 rid/csrf", async () => {
    const flow = await startConsentFlow(h);

    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Test Client");
    expect(html).toContain("client.example");
    expect(html).toContain(flow.rid);
    expect(html).toContain('name="csrf"');

    const parsed = parseConsentPage(html);
    // 请求的是 records:read + coffee:read：只出现这两项。
    expect(parsed.scopes.map((scope) => scope.value).sort()).toEqual([
      "coffee:read",
      "records:read",
    ]);
    // 默认全选。
    expect(parsed.scopes.every((scope) => scope.checked)).toBe(true);
    // 非 step-up：没有灰置项。
    expect(parsed.scopes.some((scope) => scope.disabled)).toBe(false);
  });

  it("CSP 的 form-action 放行本次已验证的回调 Origin（否则 302 被浏览器中止）", async () => {
    // 回调 `https://client.example/callback` 与 Cloud 不同源：Chromium 把
    // `form-action 'self'` 也套用到表单提交后的那次 302 上，只写 'self' 会让
    // 页面钉在同意页（`net::ERR_ABORTED`），授权码签发了却到不了客户端。
    const flow = await startConsentFlow(h);
    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(200);

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://client.example");
    // 其余指令一字不动：放宽的只有 form-action 这一项。
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 放行的是 Origin，不带 path——回调地址的路径不进安全头。
    expect(csp).not.toContain("/callback");
  });

  it("每个 scope 都有可理解的说明，并且只描述读取", async () => {
    const flow = await startConsentFlow(h);
    const html = await (await consent(flow.rid, flow.cookie)).text();

    expect(html).toContain("读取你的记录、正文、笔记和标签");
    expect(html).toContain("读取你的咖啡豆、冲煮与品鉴记录");
    // 不得出现写入语义。
    for (const word of ["修改", "删除", "写入", "编辑"]) {
      expect(html.includes(word), `页面不应出现「${word}」`).toBe(false);
    }
  });

  it("只展示 redirect_uri 的 host，不展开完整地址与内部参数", async () => {
    const flow = await startConsentFlow(h);
    const html = await (await consent(flow.rid, flow.cookie)).text();

    expect(html).toContain("client.example");
    expect(html).not.toContain("/callback");
    expect(html).not.toContain("https://client.example");
  });

  it("不显示用户 id / grant id / 任何 token 形态的东西", async () => {
    const flow = await startConsentFlow(h);
    const html = await (await consent(flow.rid, flow.cookie)).text();

    const userRows = await handle.sql<{ id: string }[]>`select id from users limit 1`;
    expect(html).not.toContain(userRows[0]!.id);
    expect(html.toLowerCase()).not.toContain("bearer");
    expect(html.toLowerCase()).not.toContain("refresh_token");
    expect(html.toLowerCase()).not.toContain("access_token");
  });

  it("没有脚本、没有外部资源、没有 iframe", async () => {
    const flow = await startConsentFlow(h);
    const html = await (await consent(flow.rid, flow.cookie)).text();

    expect(html).not.toContain("<script");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    // 表单指向本服务自己的路径。
    expect(html).toContain('action="/mcp/oauth/consent"');
  });

  it("动态内容全部转义（客户端名 / 回调 host）", async () => {
    // 客户端名带标签与引号：必须被转义成实体。
    const clientId = await seedAuthorizeClient(handle, {
      clientId: "evil-client",
      clientName: `<script>alert("x")</script>`,
      redirectUris: ["https://evil.example/cb?a=<b>"],
    });
    expect(clientId).toBe("evil-client");

    const flow = await startConsentFlow(h, {
      query: new URLSearchParams({
        response_type: "code",
        client_id: "evil-client",
        redirect_uri: "https://evil.example/cb?a=<b>",
        scope: "records:read",
        state: "s",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        resource: "https://gateway.example/mcp",
      }).toString(),
    });
    const html = await (await consent(flow.rid, flow.cookie)).text();

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("a=<b>");
  });

  it("未知 scope 不会出现在页面上", async () => {
    // 直接把行里的 scope 改坏：`orderMcpScopes` 只保留已知值。
    const flow = await startConsentFlow(h);
    await handle.sql`
      update mcp_auth_requests set scope = array['records:read', 'records:write'] where id = ${flow.rid}`;

    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(200);
    const parsed = parseConsentPage(await res.text());
    expect(parsed.scopes.map((scope) => scope.value)).toEqual(["records:read"]);
  });

  it("请求里全是未知 scope → 不渲染同意页（fail-closed）", async () => {
    const flow = await startConsentFlow(h);
    await handle.sql`
      update mcp_auth_requests set scope = array['records:write'] where id = ${flow.rid}`;

    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(400);
  });
});

describe("前置校验", () => {
  it("rid 不是 uuid → 400", async () => {
    const flow = await startConsentFlow(h);
    for (const rid of ["", "abc", "../../etc/passwd", "0".repeat(36)]) {
      const res = await consent(rid, flow.cookie);
      expect(res.status, rid).toBe(400);
    }
  });

  it("rid 不存在 → 400，且不写任何审计", async () => {
    const flow = await startConsentFlow(h);
    const res = await consent("00000000-0000-0000-0000-000000000000", flow.cookie);
    expect(res.status).toBe(400);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events where event_type = 'mcp_browser_binding_mismatch'`;
    expect(audit[0]?.count).toBe("0");
  });

  it("rid 重复出现在查询串里 → 400（不做「取第一个」的猜测）", async () => {
    const flow = await startConsentFlow(h);
    const res = await h.app.request(
      `/mcp/oauth/consent?rid=${flow.rid}&rid=${"0".repeat(8)}-0000-0000-0000-000000000000`,
      { headers: { cookie: flow.cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("缺少浏览器 Cookie → 400（同意页不允许新建会话）", async () => {
    const flow = await startConsentFlow(h);
    const res = await consent(flow.rid, "");
    expect(res.status).toBe(400);
    // 不签发新的 Cookie。
    expect(res.headers.get("set-cookie")).toBeNull();
    // 行完好（缺 Cookie 不是劫持证据，不应删行）。
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(1);
  });

  it("Cookie 被篡改 → 400", async () => {
    const flow = await startConsentFlow(h);
    const tampered = `${flow.cookie.split("=")[0]}=${flow.cookie.split("=")[1]}x`;
    const res = await consent(flow.rid, tampered);
    expect(res.status).toBe(400);
  });

  it("Cookie 已过期 → 400", async () => {
    const flow = await startConsentFlow(h);
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await signBrowserCookie(h.env, {
      sid: "x".repeat(43),
      iat: nowSec - 3600,
      exp: nowSec - 1800,
    });
    const res = await consent(flow.rid, expired);
    expect(res.status).toBe(400);
  });

  it("浏览器绑定不匹配 → 400 + 删行 + 审计", async () => {
    const flow = await startConsentFlow(h);
    const nowSec = Math.floor(Date.now() / 1000);
    const other = await signBrowserCookie(h.env, {
      sid: "o".repeat(43),
      iat: nowSec,
      exp: nowSec + 1800,
    });

    const res = await consent(flow.rid, other);
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events
       where event_type = 'mcp_browser_binding_mismatch' and detail->>'stage' = 'consent'`;
    expect(audit[0]?.count).toBe("1");
  });

  it("授权请求过期 → 400 + 删行", async () => {
    const flow = await startConsentFlow(h);
    await handle.sql`
      update mcp_auth_requests set expires_at = now() - interval '1 second' where id = ${flow.rid}`;

    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(400);
    expect((await res.text()).includes("过期")).toBe(true);
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(0);
  });

  it("user_id 为空（未登录）→ 400", async () => {
    const flow = await startConsentFlow(h);
    await handle.sql`update mcp_auth_requests set user_id = null where id = ${flow.rid}`;

    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(400);
    expect((await res.text()).includes("登录")).toBe(true);
  });

  it("provider_consumed_at 为空（Provider 回调未完成）→ 400", async () => {
    const flow = await startConsentFlow(h);
    await handle.sql`update mcp_auth_requests set provider_consumed_at = null where id = ${flow.rid}`;

    const res = await consent(flow.rid, flow.cookie);
    expect(res.status).toBe(400);
  });

  it("provider 只能是 google / github（数据库层就写不进第三个值）", async () => {
    const flow = await startConsentFlow(h);

    // 这一条比「路由返回 400」更强：`mcp_auth_requests_provider_check` 让
    // 「未支持的 provider」根本无法存在于这张表里。路由层的判断只是纵深防御。
    await expect(
      handle.sql`update mcp_auth_requests set provider = 'twitter' where id = ${flow.rid}`,
    ).rejects.toThrow(/mcp_auth_requests_provider_check/);

    // 合法值仍然可以写入，进而正常渲染。
    await handle.sql`update mcp_auth_requests set provider = 'github' where id = ${flow.rid}`;
    expect((await consent(flow.rid, flow.cookie)).status).toBe(200);
  });

  it("所有失败都带完整的安全响应头", async () => {
    const flow = await startConsentFlow(h);
    const res = await consent("00000000-0000-0000-0000-000000000000", flow.cookie);

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("CSRF 的生成与轮换", () => {
  it("数据库只存哈希，明文只出现在 HTML 里", async () => {
    const flow = await startConsentFlow(h);
    const parsed = parseConsentPage(flow.html);
    const row = await rowOf(flow.rid);

    expect(parsed.csrf).toHaveLength(43);
    expect(row!.csrf_hash).toBe(hashCsrf(parsed.csrf));
    // 哈希值不等于明文（否则「只存哈希」没有意义）。
    expect(row!.csrf_hash).not.toBe(parsed.csrf);

    // 整张表里找不到明文。
    const leaked = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_auth_requests where csrf_hash = ${parsed.csrf}`;
    expect(leaked[0]?.count).toBe("0");
  });

  it("重开页面会换一把新的（旧表单立刻失效）", async () => {
    const flow = await startConsentFlow(h);
    const first = parseConsentPage(flow.html).csrf;

    const again = await consent(flow.rid, flow.cookie);
    expect(again.status).toBe(200);
    const second = parseConsentPage(await again.text()).csrf;

    expect(second).not.toBe(first);
    const row = await rowOf(flow.rid);
    expect(row!.csrf_hash).toBe(hashCsrf(second));
    expect(row!.csrf_hash).not.toBe(hashCsrf(first));
  });

  it("每次的 CSRF 都不同（随机性，32 字节）", async () => {
    const flow = await startConsentFlow(h);
    const values = new Set<string>([parseConsentPage(flow.html).csrf]);
    for (let i = 0; i < 3; i += 1) {
      const res = await consent(flow.rid, flow.cookie);
      values.add(parseConsentPage(await res.text()).csrf);
    }
    expect(values.size).toBe(4);
    for (const value of values) expect(value).toHaveLength(43);
  });

  it("浏览器绑定的哈希等于 Cookie 里 sid 的域分隔哈希", async () => {
    const flow = await startConsentFlow(h);
    const raw = decodeURIComponent(flow.cookie.slice(flow.cookie.indexOf("=") + 1));
    const sid = JSON.parse(raw.slice(0, raw.lastIndexOf("."))).sid as string;

    const row = await rowOf(flow.rid);
    expect(row!.browser_binding_hash).toBe(browserBindingHash(sid));
  });
});
