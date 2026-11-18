import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { createApp } from "../../src/app.js";
import type { AppContext, AppHono } from "../../src/context.js";
import { createDb, type DbHandle } from "../../src/db/client.js";
import type { Env } from "../../src/env.js";
import { createLogger } from "../../src/logger.js";
import {
  createProviders,
  type ProviderAdapter,
  type ProviderMap,
  type ProviderName,
} from "../../src/oauth/providers.js";
import { serverError } from "../../src/security/errors.js";
import { createKeyRing } from "../../src/sessions/jwt.js";
import { sha256Hex } from "../../src/security/crypto.js";
import { makeTestEnv, TEST_DATABASE_URL, type TestEnvOverrides } from "./env.js";
import { MCP_BROWSER_COOKIE_NAME, MCP_BROWSER_COOKIE_PATH } from "../../src/mcp-oauth/constants.js";
import { seedClient } from "./oauth-db.js";

/**
 * MCP 浏览器授权路由的测试夹具（Phase 1.3.1-C2a）。
 *
 * ## 为什么 Provider 用 Mock Adapter
 *
 * 授权流程里**只有**两处触及外部世界：`buildAuthorizeUrl`（纯函数）与
 * `exchangeAndVerify`（网络）。前者用真实适配器单独测（它只是拼 URL），
 * 后者只能 Mock —— 但这里的 Mock 不是「假装成功」，它**校验契约**：
 *
 * - Google：`expectedNonceHash` 必须等于 `sha256(发给 Google 的 nonce)`。
 *   路由若把 nonce 哈希搞错（比如加了域前缀），Mock 会直接失败。
 * - GitHub：`expectedNonceHash` 必须是空串（GitHub 没有 OIDC nonce）。
 *
 * 于是「nonce 只存哈希且能对上」这条不只是「代码看起来对」，而是**跑出来的**。
 *
 * 数据库一律用真实 PostgreSQL（`getTestDb()`），不 Mock 事务与唯一约束。
 */

export interface MockProviderState {
  identity: {
    subject: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string;
    avatarUrl: string | null;
  };
  /** 下一次 `exchangeAndVerify` 抛这个错误（用后即清）。 */
  failure: Error | null;
  /** 累计调用次数（断言「只交换了一次」用）。 */
  exchangeCount: number;
  /** 最后一次 `buildAuthorizeUrl` 的参数（取 state / nonce 用）。 */
  lastAuthorize: { cloudRedirectUri: string; combinedState: string; nonce?: string | undefined } | null;
  authorizeCount: number;
}

export interface MockProvider extends ProviderAdapter {
  readonly state: MockProviderState;
}

function defaultIdentity(provider: ProviderName) {
  return provider === "google"
    ? {
        subject: "google-sub-1",
        email: "g@example.com",
        emailVerified: true,
        displayName: "Google User",
        avatarUrl: null,
      }
    : {
        subject: "4242",
        email: null,
        emailVerified: false,
        displayName: "GitHub User",
        avatarUrl: null,
      };
}

export function createMockProvider(provider: ProviderName): MockProvider {
  const state: MockProviderState = {
    identity: defaultIdentity(provider),
    failure: null,
    exchangeCount: 0,
    lastAuthorize: null,
    authorizeCount: 0,
  };

  return {
    name: provider,
    state,

    buildAuthorizeUrl(params) {
      state.authorizeCount += 1;
      state.lastAuthorize = params;
      const url = new URL(`https://${provider}.test/authorize`);
      url.searchParams.set("redirect_uri", params.cloudRedirectUri);
      url.searchParams.set("state", params.combinedState);
      if (params.nonce !== undefined) url.searchParams.set("nonce", params.nonce);
      return url.toString();
    },

    async exchangeAndVerify(params) {
      state.exchangeCount += 1;
      if (state.failure) {
        const failure = state.failure;
        state.failure = null;
        throw failure;
      }

      // --- 契约校验（不是「假装成功」）---
      if (provider === "google") {
        const nonce = state.lastAuthorize?.nonce;
        if (!nonce) throw serverError("mock: google authorize URL carried no nonce");
        if (params.expectedNonceHash !== sha256Hex(nonce)) {
          throw serverError("mock: nonce hash does not match the nonce that was sent");
        }
      } else if (params.expectedNonceHash !== "") {
        throw serverError("mock: github must not carry a nonce hash");
      }

      return state.identity;
    },
  };
}

export interface McpOAuthHarness {
  app: AppHono;
  ctx: AppContext;
  db: DbHandle;
  env: Env;
  providers: { google: MockProvider; github: MockProvider };
  /** 直接把某个 Provider 从 `ctx.providers` 里摘掉（测「未配置」）。 */
  removeProvider(provider: ProviderName): void;
}

export interface CreateHarnessOptions {
  env?: TestEnvOverrides;
  /** 用真实适配器替代 Mock（只用于 URL 拼装测试）。 */
  useRealProviders?: boolean;
}

export async function createMcpOAuthHarness(
  options: CreateHarnessOptions = {},
): Promise<McpOAuthHarness> {
  const env = makeTestEnv({
    baseUrl: "https://gateway.example",
    // 测试环境不加 Secure：`app.request()` 并不真的走 TLS，而 Secure 属性的
    // 断言在 browser-session.test 里单独覆盖。
    isProduction: false,
    ...options.env,
  });

  const db = createDb(TEST_DATABASE_URL);
  const google = createMockProvider("google");
  const github = createMockProvider("github");
  // `useRealProviders` 只用于「URL 拼装」这一组纯函数测试；真实适配器
  // 需要 client_id/secret，而 `makeTestEnv` 提供了它们。类型上收窄回
  // `ProviderMap`（真实适配器可能缺某个 provider）。
  const providers: ProviderMap = options.useRealProviders
    ? createProviders(env)
    : { google, github };

  const ctx: AppContext = {
    env,
    db,
    providers,
    logger: createLogger(env.logLevel),
    keyRing: createKeyRing(env.jwtSigningKey, env.jwtSigningKeyPrevious),
  };

  return {
    app: createApp(ctx),
    ctx,
    db,
    env,
    providers: { google, github },
    removeProvider(provider) {
      delete (ctx.providers as Record<string, ProviderAdapter | undefined>)[provider];
    },
  };
}

/** 从响应里取第一个 `Set-Cookie`（没有则 null）。 */
export function setCookieOf(res: Response): string | null {
  return res.headers.get("set-cookie");
}

/** 取 `name=value` 那一段（用于后续请求回填 Cookie 头）。 */
export function cookiePair(res: Response): string | null {
  const header = setCookieOf(res);
  if (!header) return null;
  return header.split(";")[0] ?? null;
}

export function parseSetCookie(header: string): Record<string, string> {
  const [nameValue, ...attrs] = header.split(";").map((part) => part.trim());
  const out: Record<string, string> = {};
  const [name, ...rest] = (nameValue ?? "").split("=");
  out.__name = name ?? "";
  out.__value = rest.join("=");
  for (const attr of attrs) {
    const [k, ...v] = attr.split("=");
    out[(k ?? "").toLowerCase()] = v.length > 0 ? v.join("=") : "true";
  }
  return out;
}

/**
 * 用给定 sid/iat/exp 签一个「合法的」浏览器 Cookie（绕过路由，直接签名）。
 *
 * 用于构造过期 Cookie 与「另一个浏览器」的 Cookie——这两类输入不可能通过
 * 正常路由产生，但它们是安全边界必须处理的情况。
 */
export async function signBrowserCookie(
  env: Env,
  payload: { sid: string; iat: number; exp: number },
): Promise<string> {
  const app = new Hono();
  app.get("/sign", async (c) => {
    await setSignedCookie(
      c,
      MCP_BROWSER_COOKIE_NAME,
      JSON.stringify(payload),
      env.mcpBrowserSessionKey ?? "",
      {
        path: MCP_BROWSER_COOKIE_PATH,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        maxAge: 1800,
      },
    );
    return c.text("ok");
  });
  const res = await app.request("/sign");
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

/** 造一个已注册的客户端（授权码流程），返回 client_id。 */
export async function seedAuthorizeClient(
  db: DbHandle,
  overrides: {
    clientId?: string;
    clientName?: string;
    redirectUris?: string[];
    grantTypes?: string[];
  } = {},
): Promise<string> {
  return seedClient(db.sql, {
    clientId: overrides.clientId ?? "test-client",
    clientName: overrides.clientName ?? "Test Client",
    redirectUris: overrides.redirectUris ?? ["https://client.example/callback"],
    ...(overrides.grantTypes ? { grantTypes: overrides.grantTypes } : {}),
  });
}

/** 拼一个完整的合法 authorize 查询串（测试里只需覆盖某一项）。 */
export function authorizeQuery(overrides: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "test-client",
    redirect_uri: "https://client.example/callback",
    scope: "records:read coffee:read",
    state: "client-state-1",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    resource: "https://gateway.example/mcp",
    ...Object.fromEntries(
      Object.entries(overrides).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key);
  }
  return params.toString();
}
