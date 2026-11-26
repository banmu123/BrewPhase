import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Consent 的三条**静态**不变量（Phase 1.3.1-C2b）。
 *
 * ## 为什么这几条必须用源码扫描，而不是行为测试
 *
 * | 不变量 | 为什么行为测试测不到 |
 * |---|---|
 * | CSRF 比较用常量时间 | 「快多少纳秒」在 CI 里不可观测；把 `timingSafeEqual` 换成 `===` 之后所有行为用例仍然全绿 |
 * | CSRF / 授权码哈希带域分隔 | 哈希值本身不对外暴露，换成不带域前缀的 SHA-256 也能跑通全部流程 |
 * | TTL 是 60 秒 | 这条**有**行为测试（数据库里的差值），这里再加一条是为了让常量被改名/改单位时立刻炸在最近的断言上 |
 *
 * 源码扫描不是「更弱的测试」，而是对**实现性质**的断言——这类性质只能这样钉。
 */

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("CSRF 的实现性质", () => {
  it("提交值必须与行内哈希做 constantTimeEqual 比较", () => {
    const src = read("src/mcp-oauth/consent-flow.ts");
    expect(src).toContain("constantTimeEqual(row.csrfHash, hashCsrf(input.csrf))");
    // 任何直接比较哈希的写法都不允许。
    expect(src).not.toMatch(/csrfHash\s*===/);
    expect(src).not.toMatch(/===\s*row\.csrfHash/);
  });

  it("CSRF 哈希带域分隔（`mcp-csrf:`）", () => {
    const src = read("src/mcp-oauth/authorize-flow.ts");
    expect(src).toContain("`mcp-csrf:${csrf}`");
  });

  it("CSRF 明文只出现在页面的隐藏字段里，不进日志", () => {
    const routes = read("src/routes/mcp-oauth.ts");
    // 不允许任何 logger 调用带上 csrf（明文或哈希）。
    expect(routes).not.toMatch(/logger\.[a-z]+\([^)]*csrf/i);
    // 也不允许把 csrf 放进重定向参数。
    expect(routes).not.toMatch(/buildRedirectUri\([^)]*csrf/s);
  });
});

describe("授权码的实现性质", () => {
  it("哈希带域分隔（`mcp-code:`）", () => {
    // 签发（consent-flow）与兑换（token-flow）共用同一个函数，定义在
    // authorize-flow 里，两边都只经过它。
    const src = read("src/mcp-oauth/authorize-flow.ts");
    expect(src).toContain("sha256Hex(`mcp-code:${code}`)");
  });

  it("TTL 常量是 60 秒", () => {
    const src = read("src/mcp-oauth/constants.ts");
    expect(src).toContain("MCP_AUTH_CODE_TTL_MS = 60_000");
  });

  it("路由只把 code 放进一次重定向，不写日志", () => {
    const routes = read("src/routes/mcp-oauth.ts");
    expect(routes).toContain("code: result.code");
    expect(routes).not.toMatch(/logger\.[a-z]+\([^)]*result\.code/);
    expect(routes).not.toMatch(/logger\.[a-z]+\([^)]*codeHash/);
  });

  it("审计事件里不出现 code 或 code_hash", () => {
    const routes = read("src/routes/mcp-oauth.ts");
    // `mcp_auth_code_issued` 的 detail 只允许 rid / clientId / grantId。
    const index = routes.indexOf('eventType: "mcp_auth_code_issued"');
    expect(index).toBeGreaterThan(-1);
    const block = routes.slice(index, index + 300);
    // 形如 `code: ...` 的字段名即违规（正文里出现 "code" 这个词不算）。
    expect(block).not.toMatch(/(^|[{,\s])code\s*:/m);
    expect(block).not.toContain("codeHash");
  });
});
