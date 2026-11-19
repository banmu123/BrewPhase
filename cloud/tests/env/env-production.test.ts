import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";

/**
 * 生产环境「拒绝启动」的边界。
 *
 * 这里只锁配置校验，不涉及任何真实凭据：全部使用明显的测试字面量。
 * 重点之一是 BASE_URL：它有 `http://localhost:3000` 的默认值，如果校验只看
 * 原始输入，生产漏配 BASE_URL 会把 JWT iss 与 Provider 回调静默指向 localhost。
 */

const validProduction = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:pass@db.internal:5432/brewphase_cloud",
  BASE_URL: "https://cloud.example.com",
  GOOGLE_CLIENT_ID: "test-google-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  GITHUB_CLIENT_ID: "test-github-id",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  JWT_SIGNING_KEY: "x".repeat(48),
  SESSION_TOKEN_PEPPER: "y".repeat(32),
};

function expectRefusal(input: Record<string, string | undefined>, needle: string): void {
  let message = "";
  try {
    loadEnv(input);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("[env] refusing to start in production");
  expect(message).toContain(needle);
}

describe("BASE_URL 形态（issuer）校验", () => {
  /** 形态问题在「生产拒绝」之前就抛，文案也独立。 */
  function expectIssuerRefusal(baseUrl: string, needle: string): void {
    let message = "";
    try {
      loadEnv({ ...validProduction, BASE_URL: baseUrl });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[env] BASE_URL must be an origin only");
    expect(message).toContain(needle);
  }

  it("带 path / query / fragment / userinfo 都拒绝启动", () => {
    // 这三处 issuer（JWT iss、授权响应 iss、metadata issuer）必须逐字符相同；
    // 一旦允许路径，就只能在元数据层归一化，从而让三者产生分歧。
    expectIssuerRefusal("https://cloud.example.com/api", 'path "/api"');
    expectIssuerRefusal("https://cloud.example.com/?a=1", "a query string");
    expectIssuerRefusal("https://cloud.example.com/#frag", "a fragment");
    expectIssuerRefusal("https://user:pass@cloud.example.com", "userinfo");
    // 空 userinfo 的 `username` / `password` 都是空串，只有原始串里有 `@`。
    expectIssuerRefusal("https://@cloud.example.com", "userinfo");
  });

  it("纯 origin 接受（尾斜杠会被去掉，不算路径）", () => {
    expect(loadEnv({ ...validProduction, BASE_URL: "https://cloud.example.com/" }).baseUrl).toBe(
      "https://cloud.example.com",
    );
  });

  it("非生产环境同样拒绝（issuer 一致性不是生产专属）", () => {
    let message = "";
    try {
      loadEnv({ ...validProduction, NODE_ENV: "development", BASE_URL: "http://127.0.0.1:3000/api" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[env] BASE_URL must be an origin only");
  });

  /**
   * C3c-1-R1：路径规范化绕过。
   *
   * `new URL()` 会在校验之前完成路径规范化，下面这些输入的 `pathname` 全是
   * `/`：只查 `pathname` 的实现会放行，而 `loadEnv()` 保留的原始字符串会原样
   * 变成 JWT 的 `iss`、授权响应的 `iss` 和 metadata 的 `issuer`。
   */
  it("点段与百分号编码的点段不能把带路径的 BASE_URL 洗成 origin", () => {
    expectIssuerRefusal("https://cloud.example.com/api/..", 'path "/api/.."');
    expectIssuerRefusal("https://cloud.example.com/a/..", 'path "/a/.."');
    expectIssuerRefusal("https://cloud.example.com/..", 'path "/.."');
    expectIssuerRefusal("https://cloud.example.com/.", 'path "/."');
    expectIssuerRefusal("https://cloud.example.com/%2e%2e", 'path "/%2e%2e"');
    expectIssuerRefusal("https://cloud.example.com/a/%2E%2E", 'path "/a/%2E%2E"');
  });

  it("反斜杠路径同样拒绝（WHATWG 把 `\\` 当路径分隔符）", () => {
    // `https://host\api` 在解析后等价于 `https://host/api`，但原始 issuer
    // 里留着的是反斜杠——它不是一个 origin，也不能被归一化。
    expectIssuerRefusal("https://cloud.example.com\\api", "a backslash path");
    expectIssuerRefusal("https://cloud.example.com/a\\..", "a backslash path");
  });

  it("空 authority 拒绝（`https:///api` 会被解析成 host=api）", () => {
    // 这是同一类问题的另一端：原始串里没有 authority，解析结果却有一个
    // host。按 `url.host` 判断会把它当成合法的 `https://api`。
    expectIssuerRefusal("https:///api", "an empty authority");
  });

  it("IPv6 origin 不被手工切分 authority 误伤", () => {
    // authority 里本来就有冒号，所以不能按 `:` 切。
    expect(loadEnv({ ...validProduction, BASE_URL: "https://[::1]:8443" }).baseUrl).toBe(
      "https://[::1]:8443",
    );
  });

  it("开发环境仍可用 localhost HTTP", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/brewphase_cloud",
      BASE_URL: "http://127.0.0.1:3000",
    });
    expect(env.baseUrl).toBe("http://127.0.0.1:3000");
  });
});

describe("loadEnv production 校验", () => {
  it("完整配置可以启动", () => {
    const env = loadEnv(validProduction);
    expect(env.isProduction).toBe(true);
    expect(env.baseUrl).toBe("https://cloud.example.com");
    expect(env.googleClientId).toBe("test-google-id");
  });

  it("缺少 JWT_SIGNING_KEY 或长度不足都拒绝启动", () => {
    expectRefusal({ ...validProduction, JWT_SIGNING_KEY: undefined }, "JWT_SIGNING_KEY is required");
    expectRefusal({ ...validProduction, JWT_SIGNING_KEY: "short" }, "JWT_SIGNING_KEY must be at least 32");
  });

  it("缺少 SESSION_TOKEN_PEPPER 或长度不足都拒绝启动", () => {
    expectRefusal({ ...validProduction, SESSION_TOKEN_PEPPER: undefined }, "SESSION_TOKEN_PEPPER is required");
    expectRefusal({ ...validProduction, SESSION_TOKEN_PEPPER: "short" }, "SESSION_TOKEN_PEPPER must be at least 16");
  });

  it("缺少任一 Provider 凭据都拒绝启动", () => {
    expectRefusal({ ...validProduction, GOOGLE_CLIENT_SECRET: undefined }, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
    expectRefusal({ ...validProduction, GITHUB_CLIENT_ID: undefined }, "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET");
  });

  it("BASE_URL 未显式设置时不会静默用 localhost 启动", () => {
    expectRefusal({ ...validProduction, BASE_URL: undefined }, "BASE_URL must be an explicitly set https URL");
  });

  it("BASE_URL 是 http（含 127.0.0.1）时拒绝启动", () => {
    expectRefusal({ ...validProduction, BASE_URL: "http://127.0.0.1:3000" }, "BASE_URL must be an explicitly set https URL");
  });

  it("开发环境缺少密钥时用临时随机值，不报错", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/brewphase_cloud",
    });
    expect(env.isProduction).toBe(false);
    expect(env.jwtSigningKey.length).toBeGreaterThanOrEqual(32);
    expect(env.sessionTokenPepper.length).toBeGreaterThanOrEqual(16);
    expect(env.jwtSigningKey).not.toBe(env.sessionTokenPepper);
  });

  it("DATABASE_URL 缺失时给出可定位的错误（只列变量名，不回显取值）", () => {
    let message = "";
    try {
      loadEnv({ NODE_ENV: "development" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[env] invalid configuration");
    expect(message).toContain("DATABASE_URL");
  });
});
