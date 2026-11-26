import type { AppHono } from "../../src/context.js";
import type { DbHandle } from "../../src/db/client.js";
import type { Env } from "../../src/env.js";
import { pkceChallengeFromVerifier } from "../../src/security/crypto.js";
import { startConsentFlow, submitConsent } from "./mcp-consent.js";

/**
 * Token Endpoint 测试的共用原语（Phase 1.3.1-C3a）。
 *
 * 起点是「用户已经批准，客户端手里有 code」——浏览器那半段已有 100+ 条用例，
 * 这里不再重复。所有 helper 都走真实路由，不直接调业务层，除非某个用例专门
 * 要验证业务层的判据。
 */

/** RFC 7636 允许的字符集，43 字符（下限）。 */
export const TEST_VERIFIER = "v".repeat(43);

export interface AuthCodeFixture {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  /** 授权码签发时用户勾选的 scope（= 最终授予）。 */
  grantedScope: string;
}

export interface ObtainCodeOptions {
  clientId?: string;
  redirectUri?: string;
  /** 走哪个 Provider（决定 mock 身份 → 不同用户）。默认 google。 */
  provider?: "google" | "github";
  /** 请求的 scope（默认 records:read coffee:read）。 */
  scope?: string;
  /** 用户实际勾选的 scope（默认等于请求）。 */
  grantedScope?: string[];
  /** 覆盖 verifier（测 PKCE 时用另一个）。 */
  verifier?: string;
  /** 不进 authorize 的 Cookie（模拟服务端拉取）。 */
  dropAuthorizeCookie?: boolean;
}

/**
 * 走完整条浏览器流程，返回一枚可兑换的授权码。
 *
 * `code_challenge` 由 verifier 现算，所以「PKCE 对得上」这件事由真实流程
 * 保证，而不是测试里手写一个 `"a".repeat(43)` 再假装它对。
 */
export async function obtainAuthCode(
  h: { app: AppHono; env: Env; db: DbHandle },
  options: ObtainCodeOptions = {},
): Promise<AuthCodeFixture> {
  const clientId = options.clientId ?? "test-client";
  const redirectUri = options.redirectUri ?? "https://client.example/callback";
  const scope = options.scope ?? "records:read coffee:read";
  const verifier = options.verifier ?? TEST_VERIFIER;

  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "client-state-1",
    code_challenge: pkceChallengeFromVerifier(verifier),
    code_challenge_method: "S256",
    resource: "https://gateway.example/mcp",
  });

  const flow = await startConsentFlow(h, {
    query: query.toString(),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.dropAuthorizeCookie ? { dropAuthorizeCookie: true } : {}),
  });

  const approved = options.grantedScope ?? scope.split(" ");
  const res = await submitConsent(h, {
    rid: flow.rid,
    cookie: flow.cookie,
    csrf: flow.csrf,
    decision: "allow",
    scopes: approved,
  });
  if (res.status !== 302) {
    throw new Error(`consent submit failed: ${res.status} ${await res.text()}`);
  }
  const code = new URL(res.headers.get("location")!).searchParams.get("code");
  if (!code) throw new Error("consent redirect carried no code");

  return { code, verifier, clientId, redirectUri, userId: flow.userId, grantedScope: approved.join(" ") };
}

/** 发一次 token 请求（标准 urlencoded）。 */
export async function postToken(
  h: { app: AppHono },
  body: Record<string, string | undefined>,
): Promise<Response> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) params.set(key, value);
  }
  return h.app.request("/mcp/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

/** 用原始 body 发一次（测重复字段、畸形表单）。 */
export async function postTokenRaw(
  h: { app: AppHono },
  body: string,
  contentType = "application/x-www-form-urlencoded",
): Promise<Response> {
  return h.app.request("/mcp/oauth/token", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function readTokenResponse(res: Response): Promise<TokenResponse> {
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token || !body.refresh_token) {
    throw new Error(`token response incomplete: ${JSON.stringify(body)}`);
  }
  return body;
}

/** 兑换授权码的便捷入口（默认参数对齐 `obtainAuthCode`）。 */
export async function exchangeCode(
  h: { app: AppHono },
  fixture: AuthCodeFixture,
  overrides: Record<string, string | undefined> = {},
): Promise<Response> {
  return postToken(h, {
    grant_type: "authorization_code",
    code: fixture.code,
    client_id: fixture.clientId,
    redirect_uri: fixture.redirectUri,
    code_verifier: fixture.verifier,
    resource: "https://gateway.example/mcp",
    ...overrides,
  });
}

/** 刷新令牌的便捷入口。 */
export async function refreshToken(
  h: { app: AppHono },
  input: { refreshToken: string; clientId?: string; resource?: string; scope?: string },
): Promise<Response> {
  return postToken(h, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId ?? "test-client",
    resource: input.resource ?? "https://gateway.example/mcp",
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
}

/** 只解码 JWT 的 payload（不验签，用于断言 claim 值）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("malformed jwt");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** 读某个用户在当前库里的会话行数。 */
export async function sessionCount(db: DbHandle, userId: string): Promise<number> {
  const rows = await db.sql<{ count: string }[]>`
    select count(*)::text as count from mcp_sessions where user_id = ${userId}`;
  return Number(rows[0]?.count ?? "0");
}

/** 读某个用户当前的 Refresh Token 行（按 generation 升序）。 */
export async function refreshRows(
  db: DbHandle,
  userId: string,
): Promise<Array<{ generation: number; token_hash: string; consumed_at: string | null; session_id: string }>> {
  return db.sql`
    select t.generation, t.token_hash, t.consumed_at::text, t.session_id
      from mcp_refresh_tokens t
      join mcp_sessions s on s.id = t.session_id
     where s.user_id = ${userId}
     order by t.generation`;
}
