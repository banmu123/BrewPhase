import { expect } from "vitest";
import { createApp } from "../../src/app.js";
import type { AppContext, AppHono } from "../../src/context.js";
import type { DbHandle } from "../../src/db/client.js";
import type { Env } from "../../src/env.js";
import { createProviders } from "../../src/oauth/providers.js";
import { createLogger } from "../../src/logger.js";
import { createKeyRing } from "../../src/sessions/jwt.js";
import { pkceChallengeFromVerifier, randomToken } from "../../src/security/crypto.js";
import { ensureDatabaseOrThrow, getTestDb, resetDb } from "./db.js";
import { makeTestEnv, type TestEnvOverrides } from "./env.js";
import {
  startMockGithub,
  startMockGoogle,
  type MockGithubIdentity,
  type MockGoogleIdentity,
} from "./mock-providers.js";

export type { MockGithubIdentity, MockGoogleIdentity };

/** Desktop 本机回调的标准形态（与 validateLocalCallbackUri 规则一致）。 */
export const DESKTOP_REDIRECT = "http://127.0.0.1:51743/callback";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface Harness {
  env: Env;
  app: AppHono;
  db: DbHandle;
  ctx: AppContext;
  mockGoogle: { url: string; close(): Promise<void> };
  mockGithub: { url: string; close(): Promise<void> };
  close(): Promise<void>;
}

export async function createHarness(overrides: TestEnvOverrides = {}): Promise<Harness> {
  await ensureDatabaseOrThrow();
  const mockGoogle = await startMockGoogle();
  const mockGithub = await startMockGithub();

  const env = makeTestEnv({
    googleAuthUrl: `${mockGoogle.url}/auth`,
    googleTokenUrl: `${mockGoogle.url}/token`,
    googleJwksUrl: `${mockGoogle.url}/.well-known/jwks`,
    githubAuthUrl: `${mockGithub.url}/login/oauth/authorize`,
    githubTokenUrl: `${mockGithub.url}/login/oauth/access_token`,
    githubApiBase: mockGithub.url,
    ...overrides,
  });

  const db: DbHandle = await getTestDb();
  const providers = createProviders(env);
  const ctx: AppContext = {
    env,
    db,
    providers,
    // 跟随 env.logLevel（默认 "error"）：需要断言「日志里没有哨兵」的用例
    // 必须能把 info 级输出打开，否则那条断言会因为「根本没输出」而平凡成立。
    logger: createLogger(env.logLevel),
    keyRing: createKeyRing(env.jwtSigningKey, env.jwtSigningKeyPrevious),
  };
  const app = createApp(ctx);
  await resetDb(db);

  return {
    env,
    app,
    db,
    ctx,
    mockGoogle,
    mockGithub,
    close: async () => {
      await mockGoogle.close();
      await mockGithub.close();
    },
  };
}

// ---------- Desktop 模拟原语 ----------

export function desktopState(): string {
  return randomToken(32);
}

export function desktopPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48); // 64 字符，符合 43–128 规则
  return { verifier, challenge: pkceChallengeFromVerifier(verifier) };
}

export interface AuthorizeStart {
  resp: Response;
  authorizeUrl: URL | null;
  combinedState: string;
  nonce: string | undefined;
  /** 与 authorize 阶段 challenge 配对的 verifier（兑换时必须使用） */
  verifier: string;
  /** 发起时使用的 client state（回传比对用） */
  state: string;
}

export async function startAuthorize(
  h: Harness,
  opts: {
    provider?: string;
    state?: string;
    challenge?: string;
    redirectUri?: string;
  } = {},
): Promise<AuthorizeStart> {
  const provider = opts.provider ?? "google";
  const state = opts.state ?? desktopState();
  const { verifier, challenge } = desktopPkce();
  const redirectUri = opts.redirectUri ?? DESKTOP_REDIRECT;
  const resp = await h.app.request(
    `/oauth/authorize?provider=${provider}&state=${state}` +
      `&code_challenge=${opts.challenge ?? challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  );
  const location = resp.headers.get("location");
  const authorizeUrl = location ? new URL(location) : null;
  return {
    resp,
    authorizeUrl,
    combinedState: authorizeUrl?.searchParams.get("state") ?? "",
    nonce: authorizeUrl?.searchParams.get("nonce") ?? undefined,
    verifier,
    state,
  };
}

export interface ProviderCallbackArgs {
  combinedState: string;
  identity: MockGoogleIdentity | MockGithubIdentity;
  nonce?: string;
  useWrongKey?: boolean;
  failToken?: boolean;
  /** I-6 故障注入：provider token 端点返回 2xx 非 JSON */
  badJson?: boolean;
  /** I-6 故障注入：Google token 响应合法 JSON 但缺 id_token */
  omitIdToken?: boolean;
  /** 覆盖发给 Cloud 回调的 code（默认用构造好的 provider code） */
  rawCode?: string;
  omitCode?: boolean;
}

export interface ProviderCallbackResult {
  resp: Response;
  location: string;
  /** Desktop 本机回调上拿到的 BrewPhase 一次性授权码 */
  code: string | null;
  /** Desktop 本机回调上拿到的 client state（应与发起时一致） */
  clientState: string | null;
  error: string | null;
  errorDescription: string | null;
}

export async function providerCallback(
  h: Harness,
  provider: "google" | "github",
  args: ProviderCallbackArgs,
): Promise<ProviderCallbackResult> {
  const cloudRedirectUri = `${h.env.baseUrl}/oauth/callback/${provider}`;
  const payload =
    provider === "google"
      ? {
          identity: args.identity as MockGoogleIdentity,
          nonce: args.nonce ?? "",
          redirectUri: cloudRedirectUri,
          useWrongKey: args.useWrongKey,
          failToken: args.failToken,
          badJson: args.badJson,
          omitIdToken: args.omitIdToken,
        }
      : {
          identity: args.identity as MockGithubIdentity,
          redirectUri: cloudRedirectUri,
          failToken: args.failToken,
          badJson: args.badJson,
        };
  const providerCode =
    provider === "google"
      ? Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
      : Buffer.from(
          JSON.stringify({
            identity: args.identity as MockGithubIdentity,
            redirectUri: cloudRedirectUri,
            failToken: args.failToken,
            badJson: args.badJson,
          }),
          "utf8",
        ).toString("base64url");

  const code = args.rawCode ?? providerCode;
  const query = new URLSearchParams({ state: args.combinedState });
  if (!args.omitCode) query.set("code", code);
  const resp = await h.app.request(`/oauth/callback/${provider}?${query.toString()}`);
  const location = resp.headers.get("location") ?? "";
  let parsed: URL | null = null;
  try {
    parsed = location ? new URL(location) : null;
  } catch {
    parsed = null;
  }
  return {
    resp,
    location,
    code: parsed?.searchParams.get("code") ?? null,
    clientState: parsed?.searchParams.get("state") ?? null,
    error: parsed?.searchParams.get("error") ?? null,
    errorDescription: parsed?.searchParams.get("error_description") ?? null,
  };
}

export async function exchangeCode(
  h: Harness,
  args: {
    code: string;
    verifier: string;
    redirectUri?: string;
    formEncoded?: boolean;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const redirectUri = args.redirectUri ?? DESKTOP_REDIRECT;
  if (args.formEncoded) {
    return await h.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...args.headers },
      body: new URLSearchParams({
        code: args.code,
        code_verifier: args.verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
  }
  return await h.app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...args.headers },
    body: JSON.stringify({
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: redirectUri,
    }),
  });
}

export function assertIsTokenPayload(body: unknown): Tokens {
  const t = body as Record<string, unknown>;
  expect(typeof t.access_token).toBe("string");
  expect(typeof t.refresh_token).toBe("string");
  expect(t.token_type).toBe("Bearer");
  expect(typeof t.expires_in).toBe("number");
  return {
    accessToken: t.access_token as string,
    refreshToken: t.refresh_token as string,
    tokenType: t.token_type as string,
    expiresIn: t.expires_in as number,
  };
}

export async function refresh(
  h: Harness,
  refreshToken: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return await h.app.request("/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export async function logout(
  h: Harness,
  refreshToken: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return await h.app.request("/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

/** 完整 Google 登录（Desktop 模拟：authorize → provider → callback → token）。 */
export async function fullGoogleLogin(
  h: Harness,
  identity: MockGoogleIdentity,
): Promise<{ tokens: Tokens; state: string; verifier: string }> {
  const state = desktopState();
  const { verifier, challenge } = desktopPkce();
  const start = await startAuthorize(h, { provider: "google", state, challenge });
  expect(start.resp.status).toBe(302);
  expect(start.combinedState).toContain(".");
  expect(start.nonce).toBeTruthy();

  const cb = await providerCallback(h, "google", {
    combinedState: start.combinedState,
    identity,
    nonce: start.nonce,
  });
  expect(cb.resp.status).toBe(302);
  expect(cb.error).toBeNull();
  expect(cb.code).toBeTruthy();
  expect(cb.clientState).toBe(state);

  const tokenResp = await exchangeCode(h, { code: cb.code as string, verifier });
  expect(tokenResp.status).toBe(200);
  return { tokens: assertIsTokenPayload(await tokenResp.json()), state, verifier };
}

/** 完整 GitHub 登录。 */
export async function fullGithubLogin(
  h: Harness,
  identity: MockGithubIdentity,
): Promise<Tokens> {
  const state = desktopState();
  const { verifier, challenge } = desktopPkce();
  const start = await startAuthorize(h, { provider: "github", state, challenge });
  expect(start.resp.status).toBe(302);
  expect(start.nonce).toBeUndefined(); // GitHub 不使用 nonce

  const cb = await providerCallback(h, "github", {
    combinedState: start.combinedState,
    identity,
  });
  expect(cb.resp.status).toBe(302);
  expect(cb.error).toBeNull();
  expect(cb.code).toBeTruthy();
  expect(cb.clientState).toBe(state);

  const tokenResp = await exchangeCode(h, { code: cb.code as string, verifier });
  expect(tokenResp.status).toBe(200);
  return assertIsTokenPayload(await tokenResp.json());
}

export async function authedGet(h: Harness, path: string, accessToken: string): Promise<Response> {
  return await h.app.request(path, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

/** 直接改库：把「已撤销」会话的撤销时间回拨，模拟「宽限期外重放」。只影响已撤销行。 */
export async function backdateAllRevocations(
  h: Harness,
  secondsAgo: number,
): Promise<void> {
  await h.db.sql`update auth_sessions set revoked_at = now() - make_interval(secs => ${secondsAgo}) where revoked_at is not null`;
}

export async function backdateAllOauthCodes(h: Harness, secondsAgo: number): Promise<void> {
  await h.db.sql`update oauth_codes set expires_at = now() - make_interval(secs => ${secondsAgo})`;
}
