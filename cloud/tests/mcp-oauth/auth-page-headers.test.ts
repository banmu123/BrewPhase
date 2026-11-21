import { describe, expect, it } from "vitest";
import { AUTH_PAGE_HEADERS, authPageHeaders } from "../../src/mcp-oauth/login-page.js";

/**
 * 授权页响应头里的 CSP `form-action`（Phase 1.3.3-A）。
 *
 * 这一组钉的是**同意页为什么必须放行回调 Origin**，以及放行的边界在哪：
 * Chromium 把 `form-action` 也套用到「表单提交后的 302」上，只写 `'self'`
 * 会把跨 Origin 的回调导航中止成 `net::ERR_ABORTED`——授权码已签发却永远
 * 到不了客户端，Allow 与 Deny 一起卡死。
 *
 * 反过来说，这个口子只能开到「本次已验证的回调 Origin」为止：它要是能被
 * 拼进 path、query 或非 http(s) 的 scheme，安全头就成了注入面。
 */

const CSP_KEY = "Content-Security-Policy";

function cspOf(headers: Record<string, string>): string {
  return headers[CSP_KEY] ?? "";
}

describe("默认响应头（登录页 / 错误页）", () => {
  it("form-action 只允许同源，且其余指令齐全", () => {
    const csp = cspOf(AUTH_PAGE_HEADERS);
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 登录页是链接导航，没有任何跨 Origin 表单提交——不该被放宽。
    expect(csp).not.toContain("form-action 'self' http");
  });

  it("不传参数时与常量逐字相同（登录页行为不能因为重构而变）", () => {
    expect(authPageHeaders()).toEqual(AUTH_PAGE_HEADERS);
  });

  it("非 CSP 的安全头原样保留", () => {
    expect(AUTH_PAGE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(AUTH_PAGE_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(AUTH_PAGE_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(AUTH_PAGE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });
});

describe("同意页放行回调 Origin", () => {
  it("http 与 https 的纯 Origin 都被追加进 form-action", () => {
    expect(cspOf(authPageHeaders({ formActionOrigin: "http://127.0.0.1:6276" }))).toContain(
      "form-action 'self' http://127.0.0.1:6276",
    );
    expect(cspOf(authPageHeaders({ formActionOrigin: "https://client.example" }))).toContain(
      "form-action 'self' https://client.example",
    );
  });

  it("带默认端口的 https 归一化后仍与 origin 相等，可用", () => {
    // `new URL("https://client.example:443/").origin` === "https://client.example"
    expect(cspOf(authPageHeaders({ formActionOrigin: "https://client.example" }))).toContain(
      "form-action 'self' https://client.example",
    );
  });

  it("空串 / undefined 退回只允许同源", () => {
    expect(cspOf(authPageHeaders({ formActionOrigin: "" }))).toContain("form-action 'self'");
    expect(cspOf(authPageHeaders({ formActionOrigin: "" }))).not.toContain("http");
    expect(cspOf(authPageHeaders({}))).toContain("form-action 'self'");
    expect(cspOf(authPageHeaders())).not.toContain("http");
  });

  it("拒绝带 path / query / fragment 的串——CSP source 只收 Origin", () => {
    for (const bad of [
      "https://client.example/callback",
      "https://client.example/callback?x=1",
      "https://client.example/cb#frag",
      "http://127.0.0.1:6276/oauth/callback",
    ]) {
      const csp = cspOf(authPageHeaders({ formActionOrigin: bad }));
      expect(csp, bad).toContain("form-action 'self'");
      expect(csp, bad).not.toContain(bad);
      expect(csp, bad).not.toContain("/callback");
    }
  });

  it("拒绝非 http(s) 的自定义 scheme（origin 是字符串 \"null\"，不是合法 source）", () => {
    for (const bad of ["myapp://callback", "null", "file:///tmp/x", "urn:foo"]) {
      const csp = cspOf(authPageHeaders({ formActionOrigin: bad }));
      expect(csp, bad).toContain("form-action 'self'");
      expect(csp, bad).not.toContain(bad);
      // 不把字面量 `null` 写进安全头。
      expect(csp, bad).not.toContain(" null");
    }
  });

  it("拒绝含空白、引号等会污染 header 或打断 CSP 引号的串", () => {
    for (const bad of [
      "https://evil.example 'unsafe-inline'",
      'https://evil.example"',
      "https://evil.example\nx: y",
      " https://evil.example",
      "https://evil.example ",
      "https://evil.example;script-src *",
      "https://evil.example'",
    ]) {
      const csp = cspOf(authPageHeaders({ formActionOrigin: bad }));
      expect(csp, JSON.stringify(bad)).toContain("form-action 'self'");
      expect(csp, JSON.stringify(bad)).not.toContain("evil.example");
      // 双引号会打断 CSP 的 source 解析，绝不能进安全头。
      expect(csp, JSON.stringify(bad)).not.toContain('"');
    }
  });

  it("放行合法的 IPv6 loopback Origin", () => {
    expect(cspOf(authPageHeaders({ formActionOrigin: "http://[::1]:6276" }))).toContain(
      "form-action 'self' http://[::1]:6276",
    );
  });

  it("拒绝 reg-name 里的子定界符（`'` `;` `=` 会改变 CSP 语义）", () => {
    for (const bad of ["https://a!b.example", "https://a;b.example", "https://a=b.example"]) {
      const csp = cspOf(authPageHeaders({ formActionOrigin: bad }));
      expect(csp, bad).toContain("form-action 'self'");
      expect(csp, bad).not.toContain("a!");
      expect(csp, bad).not.toContain("a;");
      expect(csp, bad).not.toContain("a=");
    }
  });

  it("拒绝无法解析的串", () => {
    for (const bad of ["not a url", "http://", "://x", "https://"]) {
      const csp = cspOf(authPageHeaders({ formActionOrigin: bad }));
      expect(csp, JSON.stringify(bad)).toContain("form-action 'self'");
      expect(csp, JSON.stringify(bad)).not.toContain("form-action 'self' ");
    }
  });

  it("放行一个 Origin 不影响其余指令", () => {
    const csp = cspOf(authPageHeaders({ formActionOrigin: "http://127.0.0.1:6276" }));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 没有悄悄多出 script-src 之类的口子。
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("unsafe-eval");
  });
});
