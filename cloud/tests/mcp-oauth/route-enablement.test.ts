import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, authorizeQuery } from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { resolveMcpOAuthEnablement } from "../../src/mcp-oauth/enablement.js";
import { MCP_BROWSER_SESSION_KEY_MIN_BYTES } from "../../src/mcp-oauth/constants.js";
import { createApp } from "../../src/app.js";
import { createDb } from "../../src/db/client.js";
import { makeTestEnv, TEST_DATABASE_URL } from "../helpers/env.js";
import { createKeyRing } from "../../src/sessions/jwt.js";
import { createProviders } from "../../src/oauth/providers.js";
import type { AppContext } from "../../src/context.js";
import type { Logger } from "../../src/logger.js";

/**
 * MCP OAuth 路由的**启用边界**（Phase 1.3.1-C2a）。
 *
 * 这一组的核心命题是一条「两个方向都不能错」的约束：
 *
 * - 密钥不合格 → `/mcp/oauth/*` 必须**根本不存在**（404），不能是
 *   「存在但 500」、更不能是「用临时密钥凑合」；
 * - 密钥不合格 → `/oauth/*`、`/auth/*`、`/mcp-devices/*` 必须**照常工作**，
 *   不能因为一个未启用的新能力把旧能力拖死。
 *
 * 后者才是这条设计真正的价值：把 fail-closed 放在**能力边界**上，
 * 而不是整个进程上。
 */

const handle = await getTestDb();

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
});

afterAll(async () => {
  await closeTestDb();
});

interface CapturingLogger extends Logger {
  lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
}

function capturingLogger(): CapturingLogger {
  const lines: CapturingLogger["lines"] = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** 用指定 env 装配一个 app（绕过 harness 的固定 env）。 */
async function appWithEnv(overrides: Record<string, unknown>) {
  const env = makeTestEnv({ baseUrl: "https://gateway.example", ...overrides });
  const db = createDb(TEST_DATABASE_URL);
  const logger = capturingLogger();
  const ctx: AppContext = {
    env,
    db,
    providers: createProviders(env),
    logger,
    keyRing: createKeyRing(env.jwtSigningKey, env.jwtSigningKeyPrevious),
  };
  return { app: createApp(ctx), ctx, logger, env, close: () => db.close() };
}

describe("启用判定（纯函数）", () => {
  it("缺失 → missing_browser_session_key", () => {
    const env = makeTestEnv({ mcpBrowserSessionKey: undefined });
    expect(resolveMcpOAuthEnablement(env)).toEqual({
      enabled: false,
      reason: "missing_browser_session_key",
    });
  });

  it("空串视为「未配置」，短于 32 字节 → too_short", () => {
    // 空串单独归类：`.env.example` 里就是这个形态，报「长度不足」会让运维
    // 去数长度，而真正的问题是根本没填。
    expect(
      resolveMcpOAuthEnablement(makeTestEnv({ mcpBrowserSessionKey: "" })),
    ).toEqual({ enabled: false, reason: "missing_browser_session_key" });

    for (const key of ["x".repeat(31), "密".repeat(10), "abc"]) {
      const env = makeTestEnv({ mcpBrowserSessionKey: key });
      expect(resolveMcpOAuthEnablement(env), `len=${key.length}`).toEqual({
        enabled: false,
        reason: "browser_session_key_too_short",
      });
    }
  });

  it("多字节按字节数算：20 个汉字（60 字节）合格", () => {
    const env = makeTestEnv({ mcpBrowserSessionKey: "密".repeat(20) });
    expect(Buffer.byteLength("密".repeat(20), "utf8")).toBeGreaterThanOrEqual(
      MCP_BROWSER_SESSION_KEY_MIN_BYTES,
    );
    expect(resolveMcpOAuthEnablement(env)).toEqual({ enabled: true });
  });

  it("与 JWT 签名密钥相同 → browser_session_key_reused_from_jwt", () => {
    const env = makeTestEnv();
    const withSame = { ...env, mcpBrowserSessionKey: env.jwtSigningKey };
    expect(resolveMcpOAuthEnablement(withSame)).toEqual({
      enabled: false,
      reason: "browser_session_key_reused_from_jwt",
    });
  });

  it("合格密钥 → enabled", () => {
    const env = makeTestEnv({ mcpBrowserSessionKey: "k".repeat(32) });
    expect(resolveMcpOAuthEnablement(env)).toEqual({ enabled: true });
  });
});

describe("路由注册：不合格就不存在", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["缺失", { mcpBrowserSessionKey: undefined }, "missing_browser_session_key"],
    ["过短", { mcpBrowserSessionKey: "short" }, "browser_session_key_too_short"],
    [
      "与 JWT 相同",
      { mcpBrowserSessionKey: makeTestEnv().jwtSigningKey },
      "browser_session_key_reused_from_jwt",
    ],
  ];

  for (const [label, overrides, expectedReason] of cases) {
    it(`${label}：/mcp/oauth/* 返回 404，且日志给出原因`, async () => {
      await seedAuthorizeClient(handle);
      const rig = await appWithEnv(overrides);
      try {
        for (const path of [
          `/mcp/oauth/authorize?${authorizeQuery()}`,
          "/mcp/oauth/login?rid=00000000-0000-0000-0000-000000000000",
          "/mcp/oauth/callback/google?code=c&state=s",
        ]) {
          const res = await rig.app.request(path);
          // 404 = 路由根本没注册。这是「能力不存在」的语义，
          // 而不是「能力存在但坏了」（那会是 500）。
          expect(res.status, `${label} ${path.split("?")[0]}`).toBe(404);
        }

        const disabled = rig.logger.lines.filter((line) => line.message === "mcp_oauth_disabled");
        expect(disabled).toHaveLength(1);
        expect(disabled[0]!.level).toBe("warn");
        expect(disabled[0]!.fields).toEqual({ reason: expectedReason });
      } finally {
        await rig.close();
      }
    });
  }

  it("日志里不含密钥（任何片段都不行）", async () => {
    const secret = "SENTINEL-browser-key-0123456789abcdef";
    const rig = await appWithEnv({ mcpBrowserSessionKey: `${secret}-but-too-short`.slice(0, 20) });
    try {
      await rig.app.request(`/mcp/oauth/authorize?${authorizeQuery()}`);
      const dumped = JSON.stringify(rig.logger.lines);
      expect(dumped).not.toContain("SENTINEL");
      // 连长度都不该出现（那是一个可用的旁路信号）。
      expect(dumped).not.toMatch(/\[\d+ bytes\]/);
    } finally {
      await rig.close();
      void secret;
    }
  });

  it("密钥不合格不影响 /oauth/*、/auth/*、/mcp-devices/*", async () => {
    const rig = await appWithEnv({ mcpBrowserSessionKey: undefined });
    try {
      // Desktop 授权入口仍然存在（400 是参数错，不是 404）。
      const oauthAuthorize = await rig.app.request(
        "/oauth/authorize?provider=google&state=s&code_challenge=" + "a".repeat(43) + "&redirect_uri=" + encodeURIComponent("http://127.0.0.1:1234/callback"),
      );
      expect(oauthAuthorize.status).not.toBe(404);

      // Desktop token 端点仍然存在（无参 → 400）。
      const oauthToken = await rig.app.request("/oauth/token", { method: "POST" });
      expect(oauthToken.status).not.toBe(404);

      // /auth/me 未认证 → 401（不是 404）。
      const me = await rig.app.request("/auth/me");
      expect(me.status).toBe(401);

      // 设备注册端点仍然存在（未认证 → 401）。
      const devices = await rig.app.request("/mcp-devices");
      expect(devices.status).toBe(401);

      // 健康检查不受影响。
      expect((await rig.app.request("/health")).status).toBe(200);
    } finally {
      await rig.close();
    }
  });
});

describe("路由注册：合格就存在", () => {
  let rig: Awaited<ReturnType<typeof appWithEnv>>;

  beforeEach(async () => {
    await seedAuthorizeClient(handle);
    rig = await appWithEnv({ mcpBrowserSessionKey: "k".repeat(40) });
  });

  afterEach(async () => {
    await rig.close();
  });

  it("三个路由都注册（不是 404）", async () => {
    const authorize = await rig.app.request(`/mcp/oauth/authorize?${authorizeQuery()}`);
    expect(authorize.status).toBe(302);

    const login = await rig.app.request(
      "/mcp/oauth/login?rid=00000000-0000-0000-0000-000000000000",
    );
    // 没有 Cookie → 400（而不是 404）。
    expect(login.status).toBe(400);

    const callback = await rig.app.request("/mcp/oauth/callback/google?code=c&state=s");
    expect(callback.status).toBe(400);
  });

  it("启用时不打 disabled 日志", async () => {
    const disabled = rig.logger.lines.filter((line) => line.message === "mcp_oauth_disabled");
    expect(disabled).toHaveLength(0);
  });

  it("生产环境：Cookie 带 Secure；开发环境：不带", async () => {
    // 生产 rig：isProduction=true
    const prod = await appWithEnv({
      mcpBrowserSessionKey: "k".repeat(40),
      isProduction: true,
      nodeEnv: "production",
    });
    try {
      await seedAuthorizeClient(handle, { clientId: "prod-client" });
      const res = await prod.app.request(
        `/mcp/oauth/authorize?${authorizeQuery({ client_id: "prod-client" })}`,
      );
      expect(res.headers.get("set-cookie")).toContain("Secure");
    } finally {
      await prod.close();
    }

    // 开发 rig（beforeEach 那个）
    const dev = await rig.app.request(`/mcp/oauth/authorize?${authorizeQuery()}`);
    const devCookie = dev.headers.get("set-cookie") ?? "";
    expect(devCookie).not.toContain("Secure");
    // 其余安全属性在开发环境**不能**跟着放松。
    expect(devCookie).toContain("HttpOnly");
    expect(devCookie).toContain("SameSite=Lax");
    expect(devCookie).toContain("Path=/mcp/oauth");
  });
});

describe("与 harness 的一致性", () => {
  it("默认 harness 的密钥合格，路由可用", async () => {
    const h = await createMcpOAuthHarness();
    await seedAuthorizeClient(handle);
    const res = await h.app.request(`/mcp/oauth/authorize?${authorizeQuery()}`);
    expect(res.status).toBe(302);
    expect(resolveMcpOAuthEnablement(h.env)).toEqual({ enabled: true });
  });
});
