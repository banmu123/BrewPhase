import { describe, expect, it } from "vitest";
import {
  authPageHeaders,
  renderErrorPage,
  renderLoginPage,
  AUTH_PAGE_HEADERS,
} from "../../src/mcp-oauth/login-page.js";
import { renderConsentPage } from "../../src/mcp-oauth/consent-page.js";
import { resolveAuthLocale } from "../../src/mcp-oauth/auth-locale.js";
import { parseConsentPage } from "../helpers/mcp-consent.js";

/**
 * 登录页 / 同意页 / 错误页的渲染契约（Phase 1.3.3-A-R4）。
 *
 * 这三个页面是用户在一次授权里连续看到的东西，也是**唯一**会把攻击者可控
 * 字符串（客户端名、回调域名）渲染进 HTML 的地方。所以这一组盯两件事：
 *
 * 1. **注入面**：所有动态内容都转义、没有脚本、没有外部资源；
 * 2. **语义面**：rid / CSRF / scope 的表单结构没被改版破坏——那三个字段是
 *    `parseConsentPage` 与服务端 `decideConsent` 的契约，改了它们，
 *    权限语义就悄悄变了。
 *
 * 服务端规则（全部取消=拒绝、提交未请求 scope=400 等）由
 * `consent-submit.test.ts` 覆盖，这里只验证**页面没有把规则表达错**。
 */

const XSS = `<img src=x onerror=alert(1)>`;
const XSS_HOST = `<script>alert(1)</script>`;
const XSS_REDIRECT = `evil.example"><script>alert(2)</script>`;

/** 页面里不许出现的外部资源与脚本痕迹。 */
function expectNoExternalResources(html: string, label: string): void {
  expect(html, `${label}: 不得有 <script`).not.toContain("<script");
  expect(html, `${label}: 不得有 <link rel`).not.toContain("<link");
  expect(html, `${label}: 不得有 @import`).not.toContain("@import");
  expect(html, `${label}: 不得有 CSS url()`).not.toContain("url(");
  expect(html, `${label}: 不得有 http://`).not.toContain("http://");
  expect(html, `${label}: 不得有 https://`).not.toContain("https://");
  expect(html, `${label}: 不得有 <iframe`).not.toContain("<iframe");
  expect(html, `${label}: 不得有 on*= 处理器`).not.toMatch(/\son(error|load|click)\s*=/i);
}

describe("登录页 renderLoginPage", () => {
  const base = {
    rid: "11111111-2222-4333-8444-555555555555",
    clientName: "ChatGPT",
    availableProviders: ["google", "github"] as const,
  };

  it("客户端名被转义：不产生标签，原文以实体形式出现", () => {
    const html = renderLoginPage({ ...base, clientName: XSS });
    // 原始尖括号不出现 → 没有可解析的元素。
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/<h1>[^<]*<img/);
    // 转义后的实体在场，证明「渲染了但被转义」而不是「被吞掉」。
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("rid 进链接前被 URL 编码，且只出现在本路由上", () => {
    const rid = "11111111-2222-4333-8444-555555555555";
    const html = renderLoginPage({ ...base, rid });
    expect(html).toContain(`/mcp/oauth/login?rid=${rid}&amp;provider=google`);
    expect(html).toContain(`/mcp/oauth/login?rid=${rid}&amp;provider=github`);
    // 除本路由外没有任何其它跳转目标。
    for (const href of [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string)) {
      expect(href.startsWith("/mcp/oauth/login?rid="), `意外的跳转目标: ${href}`).toBe(true);
    }
  });

  it("Google 与 GitHub 各自对应正确的 provider 参数", () => {
    const html = renderLoginPage({ ...base });
    expect(html).toContain("provider=google");
    expect(html).toContain("provider=github");
    expect(html).toContain("Google");
    expect(html).toContain("GitHub");
    // 两个按钮是并列入口，不能把 google 的链接写成 github。
    expect(html).not.toContain("provider=google&amp;provider=github");
  });

  it("只列已配置的 Provider：未配置的那个连名字都不出现", () => {
    const html = renderLoginPage({ ...base, availableProviders: ["google"] });
    expect(html).toContain("provider=google");
    expect(html).not.toContain("provider=github");
    // 文案不能替未启用的登录方式背书（这正是「不伪造入口」的另一半）。
    expect(html).not.toContain("GitHub");
  });

  it("一个 Provider 都没有 → 明确提示，不伪造任何入口", () => {
    const html = renderLoginPage({ ...base, availableProviders: [] });
    expect(html).toContain("未配置");
    expect(html).not.toContain("provider=google");
    expect(html).not.toContain("provider=github");
  });

  it("登录与授权是两个动作：本页不含 scope 勾选与同意表单", () => {
    const html = renderLoginPage({ ...base });
    // 登录页不能提前把「能读什么」混进来（任务书：不得把两者合并成一个操作）。
    expect(html).not.toContain('name="scope"');
    expect(html).not.toContain('action="/mcp/oauth/consent"');
    expect(html).not.toContain('name="decision"');
  });

  it("没有外部资源、没有脚本", () => {
    expectNoExternalResources(renderLoginPage({ ...base }), "login");
    // 图标只能是内联 SVG：有 <svg> 但没有任何 src / href 引用。
    const html = renderLoginPage({ ...base });
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<svg[^>]*\ssrc=/);
    expect(html).not.toMatch(/<svg[^>]*\shref=/);
  });
});

describe("同意页 renderConsentPage", () => {
  const base = {
    rid: "11111111-2222-4333-8444-555555555555",
    csrf: "csrf-token-value",
    clientName: "ChatGPT",
    clientIdentifierHost: "chatgpt.com",
    redirectHost: "chatgpt.com",
    scopes: [
      { scope: "records:read" as const, granted: false },
      { scope: "tags:read" as const, granted: false },
      { scope: "coffee:read" as const, granted: false },
      { scope: "canvas:read" as const, granted: false },
    ],
  };

  it("rid 与 CSRF 隐藏域形态不变（parseConsentPage 契约）", () => {
    const html = renderConsentPage(base);
    const parsed = parseConsentPage(html);
    expect(parsed.rid).toBe(base.rid);
    expect(parsed.csrf).toBe(base.csrf);
    // 逐字形态：服务端 `parseConsentForm` 与测试解析器都按这个形状找字段。
    expect(html).toContain(`<input type="hidden" name="rid" value="${base.rid}">`);
    expect(html).toContain(`<input type="hidden" name="csrf" value="csrf-token-value">`);
    expect(html).toContain('action="/mcp/oauth/consent"');
    expect(html).toContain('method="post"');
  });

  it("客户端名 / 身份域名 / 回调域名三处都转义", () => {
    const html = renderConsentPage({
      ...base,
      clientName: XSS,
      clientIdentifierHost: XSS_HOST,
      redirectHost: XSS_REDIRECT,
    });
    // 没有任何一处产生可解析元素。
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toMatch(/<dd>[^<]*<script/);
    // 转义实体在场（渲染了，但被转义）。
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;");
  });

  it("身份域名与回调域名是两个带标签的独立块，值不串", () => {
    const html = renderConsentPage({
      ...base,
      clientIdentifierHost: "chatgpt.com",
      redirectHost: "connector.example",
    });
    const facts = [
      ...html.matchAll(/<div class="fact">\s*<dt>([^<]*)<\/dt>\s*<dd>([^<]*)<\/dd>\s*<\/div>/g),
    ].map((m) => ({ label: m[1] as string, value: m[2] as string }));
    expect(facts).toHaveLength(2);
    expect(facts[0]!.value).toBe("chatgpt.com");
    expect(facts[1]!.value).toBe("connector.example");
    // 回调域名不能出现在身份标签里（用户会把「回到哪」误认成「授权给谁」）。
    expect(facts[0]!.value).not.toBe("connector.example");
    // 两者都只作纯文本，不渲染成链接。
    expect(html).not.toContain("<a href");
  });

  it("Step-up：已授予项 checked + disabled（不可被本次操作移除）", () => {
    const html = renderConsentPage({
      ...base,
      scopes: [
        { scope: "records:read", granted: true },
        { scope: "tags:read", granted: false },
        { scope: "coffee:read", granted: false },
        { scope: "canvas:read", granted: false },
      ],
    });
    const parsed = parseConsentPage(html);
    const granted = parsed.scopes.find((s) => s.value === "records:read")!;
    const fresh = parsed.scopes.find((s) => s.value === "tags:read")!;

    // 已授予：勾选且禁用 → 浏览器**不提交**它，最终 scope 由服务端并回。
    expect(granted.checked).toBe(true);
    expect(granted.disabled).toBe(true);
    expect(html).toContain("已授予");

    // 新增项：勾选但可取消 → 用户取消后不会被提交。
    expect(fresh.checked).toBe(true);
    expect(fresh.disabled).toBe(false);
  });

  it("只有请求内的 scope 才会出现，且默认全勾选", () => {
    const html = renderConsentPage({
      ...base,
      scopes: [
        { scope: "records:read", granted: false },
        { scope: "coffee:read", granted: false },
      ],
    });
    const parsed = parseConsentPage(html);
    expect(parsed.scopes.map((s) => s.value).sort()).toEqual(["coffee:read", "records:read"]);
    expect(parsed.scopes.every((s) => s.checked)).toBe(true);
    // 未请求的 scope 绝不出现在页面上（否则等于凭空多出一个可提交项）。
    expect(html).not.toContain('value="canvas:read"');
    expect(html).not.toContain('value="tags:read"');
  });

  it("页面把「全部取消 = 拒绝」的规则写清楚", () => {
    // 服务端行为由 consent-submit.test.ts「全部取消勾选 → 按拒绝处理」覆盖。
    const html = renderConsentPage(base);
    expect(html).toContain("取消全部勾选视为拒绝");
    expect(html).toContain("至少保留一项权限");
  });

  it("只读声明与数据流说明都在场，且只讲读取", () => {
    const html = renderConsentPage(base);
    expect(html).toContain("仅查看权限");
    expect(html).toContain("READ-ONLY ACCESS");
    // 四个权限卡片的标题与真实 scope 对应。
    expect(html).toContain("records:read");
    expect(html).toContain("tags:read");
    expect(html).toContain("coffee:read");
    expect(html).toContain("canvas:read");
    // 数据流五步链。
    for (const step of ["ChatGPT", "BrewPhase Cloud", "你的 Desktop"]) {
      expect(html, step).toContain(step);
    }
    // 只读声明用否定句澄清边界，但权限卡片本身不得声称写能力。
    const permSection = html.slice(html.indexOf('<ul class="perm-list">'), html.indexOf('class="flow"'));
    for (const word of ["修改", "删除", "写入", "编辑"]) {
      expect(permSection.includes(word), `权限说明不应出现「${word}」`).toBe(false);
    }
  });

  it("没有外部资源、没有脚本", () => {
    expectNoExternalResources(renderConsentPage(base), "consent");
    const html = renderConsentPage(base);
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<svg[^>]*\ssrc=/);
    expect(html).not.toMatch(/<svg[^>]*\shref=/);
  });
});

describe("错误页 renderErrorPage", () => {
  it("没有任何回跳链接（出错时没有可信的 redirect_uri）", () => {
    for (const key of ["link_invalid", "link_expired", "browser_expired", "session_mismatch"]) {
      const html = renderErrorPage(key, "zh");
      expect(html, key).not.toContain("<a ");
      expect(html, key).not.toContain("href=");
      expect(html, key).not.toContain("http://");
      expect(html, key).not.toContain("https://");
    }
  });

  it("不展示内部标识：没有 rid / code / session id / SQL 痕迹", () => {
    const html = renderErrorPage("link_invalid", "zh");
    expect(html).not.toMatch(/\brid\b/i);
    expect(sqlNoise(html)).toBe(false);
    // 页脚给出「怎么重新开始」，而不是把用户丢在原地。
    expect(html).toContain("回到发起授权的应用");
  });

  it("带 client 参数的错误只展示安全裁剪后的标签", () => {
    // 完整 client_id URL 含路径，绝不回显（clientIdentifierDisplay 已裁剪到 hostname）。
    const html = renderErrorPage("client_unverified", "zh", { client: "partner.example.com" });
    expect(html).toContain("partner.example.com");
    expect(html).toContain("无法验证该客户端");
    // 没有把 client_id 的路径带出来。
    expect(html).not.toContain("/oauth/client");
  });

  it("未知错误键回落到「服务暂时不可用」，绝不渲染 undefined", () => {
    const html = renderErrorPage("no_such_key_defined", "zh");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("no_such_key_defined");
    expect(html).toContain("服务暂时不可用");
  });

  it("中英文都能渲染，语种由参数决定", () => {
    const zh = renderErrorPage("link_expired", "zh");
    const en = renderErrorPage("link_expired", "en");
    expect(zh).toContain("授权已过期");
    expect(zh).toContain('lang="zh-CN"');
    expect(en).toContain("Authorization expired");
    expect(en).toContain('lang="en"');
    expect(en).not.toContain("授权已过期");
  });

  it("没有外部资源、没有脚本", () => {
    expectNoExternalResources(renderErrorPage("service_unavailable", "zh"), "error");
  });
});

/** 粗略检查错误页里有没有数据库 / 栈痕迹。 */
function sqlNoise(html: string): boolean {
  return /select\s+|insert\s+|undefined column|at Object\.|\.ts:\d+/i.test(html);
}

describe("语种选择 resolveAuthLocale", () => {
  it("没有 header → 默认中文（不改变既有用户看到的语言）", () => {
    expect(resolveAuthLocale(undefined)).toBe("zh");
    expect(resolveAuthLocale("")).toBe("zh");
  });

  it("按 q 值排序后取第一个命中的 zh / en", () => {
    expect(resolveAuthLocale("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en");
    expect(resolveAuthLocale("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(resolveAuthLocale("en;q=0.9,zh;q=0.8")).toBe("en");
    expect(resolveAuthLocale("zh;q=0.9,en;q=0.8")).toBe("zh");
  });

  it("q=0 是明确不接受，跳过它", () => {
    expect(resolveAuthLocale("en;q=0,zh-CN")).toBe("zh");
    expect(resolveAuthLocale("zh;q=0,en;q=0.5")).toBe("en");
  });

  it("只有 zh / en 之外的语种 → 回落默认", () => {
    expect(resolveAuthLocale("ja-JP,fr;q=0.9")).toBe("zh");
    expect(resolveAuthLocale("fr")).toBe("zh");
  });

  it("畸形 header 不抛错", () => {
    expect(resolveAuthLocale(",,,")).toBe("zh");
    expect(resolveAuthLocale("q=abc;")).toBe("zh");
    expect(resolveAuthLocale("zh-CN;q=notanumber")).toBe("zh");
  });
});

describe("安全响应头没有放宽", () => {
  it("登录页 / 错误页用默认头：form-action 只允许同源", () => {
    const headers = authPageHeaders();
    expect(headers["Content-Security-Policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    // 常量与按需构造结果逐字相同（登录页/错误页没有跨 Origin 表单提交）。
    expect(AUTH_PAGE_HEADERS).toEqual(headers);
    // 绝不出现 `*` 或 unsafe-inline 之外的放宽项。
    expect(headers["Content-Security-Policy"]).not.toContain("*");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(headers["Content-Security-Policy"]).not.toContain("data:");
  });

  it("页面 HTML 本身不携带任何 meta 刷新或 CSP 覆盖", () => {
    const html = renderLoginPage({
      rid: "11111111-2222-4333-8444-555555555555",
      clientName: "ChatGPT",
      availableProviders: ["google"],
    });
    // 不能用 <meta http-equiv="refresh"> 做回跳，也不能用 meta 改 CSP。
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("Content-Security-Policy");
    // noindex 保留（授权页不该被索引）。
    expect(html).toContain('name="robots"');
    expect(html).toContain("noindex");
  });
});
