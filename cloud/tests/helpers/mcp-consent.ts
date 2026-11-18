import type postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Env } from "../../src/env.js";
import type { AppHono } from "../../src/context.js";
import type { DbHandle } from "../../src/db/client.js";
import { browserBindingHash } from "../../src/mcp-oauth/browser-session.js";
import { hashCsrf } from "../../src/mcp-oauth/authorize-flow.js";
import { signBrowserCookie } from "./mcp-oauth-app.js";
import { MCP_RESOURCE } from "./oauth-db.js";

/**
 * 同意页测试的共用原语（Phase 1.3.1-C2b）。
 *
 * ## 两条路径，用途不同
 *
 * 1. **完整浏览器流程**（`startConsentFlow`）：authorize → login → Provider 跳转
 *    → callback → consent。它验证的是「真实用户会走过的路」，包括 TOFU 绑定、
 *    CSRF 轮换与 Provider 消费。
 * 2. **直接造行**（`seedConsentRow`）：只建一条「已登录、已消费 Provider」的
 *    授权请求 + 一把签名 Cookie。WSS 同步那组用它——那里被测的是「同意之后
 *    怎么同步」，不该再花四步去重复登录流程（那部分已有 98 条 C2a 测试）。
 */

export interface ConsentSession {
  rid: string;
  cookie: string;
  csrf: string;
  html: string;
  redirectUri: string;
  /** Provider 回调写进去的用户（断言 grant / code 归属用）。 */
  userId: string;
}

/** 从同意页 HTML 里取出 CSRF 与（可选的）scope 输入项。 */
export function parseConsentPage(html: string): {
  csrf: string;
  rid: string;
  scopes: Array<{ value: string; checked: boolean; disabled: boolean }>;
} {
  const hidden = (name: string): string => {
    const matched = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html);
    if (!matched) throw new Error(`consent page has no hidden field ${name}`);
    return matched[1] as string;
  };

  const scopes: Array<{ value: string; checked: boolean; disabled: boolean }> = [];
  const inputPattern = /<input type="checkbox" name="scope" value="([^"]*)"([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = inputPattern.exec(html)) !== null) {
    const attrs = match[2] ?? "";
    scopes.push({
      value: match[1] as string,
      checked: /\schecked/.test(attrs),
      disabled: /\sdisabled/.test(attrs),
    });
  }

  return { csrf: hidden("csrf"), rid: hidden("rid"), scopes };
}

export interface FlowOptions {
  provider?: "google" | "github";
  /** 覆盖 authorize 的查询串（例如换 scope / client）。 */
  query?: string;
  /**
   * 模拟「客户端在服务端拉 authorize，Set-Cookie 被丢弃」：
   * 首次访问 login 时不带任何 Cookie。
   */
  dropAuthorizeCookie?: boolean;
}

/**
 * 走完整条浏览器授权流程，返回同意页与它的 CSRF。
 *
 * 任何一步不符合预期都直接抛错——测试不该在「流程已经跑偏」的情况下继续断言
 * 后面的东西，那会让失败信息指向一个无辜的步骤。
 */
export async function startConsentFlow(
  h: { app: AppHono; env: Env; db: DbHandle },
  options: FlowOptions = {},
): Promise<ConsentSession> {
  const query =
    options.query ??
    new URLSearchParams({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: "https://client.example/callback",
      scope: "records:read coffee:read",
      state: "client-state-1",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://gateway.example/mcp",
    }).toString();

  const authorizeRes = await h.app.request(`/mcp/oauth/authorize?${query}`);
  if (authorizeRes.status !== 302) throw new Error(`authorize failed: ${authorizeRes.status}`);
  const rid = new URL(authorizeRes.headers.get("location")!, "https://x").searchParams.get("rid")!;
  let cookie = (authorizeRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const loginRes = await h.app.request(`/mcp/oauth/login?rid=${rid}`, {
    headers: options.dropAuthorizeCookie || !cookie ? {} : { cookie },
  });
  if (loginRes.status !== 200) throw new Error(`login page failed: ${loginRes.status}`);
  if (options.dropAuthorizeCookie || !cookie) {
    cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const provider = options.provider ?? "google";
  const jumpRes = await h.app.request(`/mcp/oauth/login?rid=${rid}&provider=${provider}`, {
    headers: { cookie },
  });
  if (jumpRes.status !== 302) throw new Error(`provider jump failed: ${jumpRes.status}`);
  const state = new URL(jumpRes.headers.get("location")!).searchParams.get("state")!;

  const callbackRes = await h.app.request(
    `/mcp/oauth/callback/${provider}?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie } },
  );
  if (callbackRes.status !== 302) throw new Error(`callback failed: ${callbackRes.status}`);

  const consentRes = await h.app.request(`/mcp/oauth/consent?rid=${rid}`, {
    headers: { cookie },
  });
  if (consentRes.status !== 200) throw new Error(`consent page failed: ${consentRes.status}`);
  const html = await consentRes.text();
  const parsed = parseConsentPage(html);

  const userRows = await h.db.sql<{ user_id: string | null }[]>`
    select user_id from mcp_auth_requests where id = ${rid}`;
  const userId = userRows[0]?.user_id;
  if (!userId) throw new Error("consent flow finished without user_id");

  return {
    rid,
    cookie,
    csrf: parsed.csrf,
    html,
    redirectUri: "https://client.example/callback",
    userId,
  };
}

/** 提交同意表单（`decision` + 勾选的 scope）。 */
export async function submitConsent(
  h: { app: AppHono },
  input: {
    rid: string;
    cookie: string;
    csrf: string;
    decision: string;
    scopes?: readonly string[];
    /** 覆盖 content-type（测非 urlencoded 的拒绝）。 */
    contentType?: string;
  },
): Promise<Response> {
  const body = new URLSearchParams();
  body.set("rid", input.rid);
  body.set("csrf", input.csrf);
  body.set("decision", input.decision);
  for (const scope of input.scopes ?? []) body.append("scope", scope);

  return h.app.request("/mcp/oauth/consent", {
    method: "POST",
    headers: {
      cookie: input.cookie,
      "content-type": input.contentType ?? "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
}

/** 用原始表单字符串提交（测重复字段、缺字段这类畸形输入）。 */
export async function submitConsentRaw(
  h: { app: AppHono },
  input: { cookie: string; body: string; contentType?: string },
): Promise<Response> {
  return h.app.request("/mcp/oauth/consent", {
    method: "POST",
    headers: {
      cookie: input.cookie,
      "content-type": input.contentType ?? "application/x-www-form-urlencoded",
    },
    body: input.body,
  });
}

export interface SeededConsent {
  rid: string;
  cookie: string;
  csrf: string;
  userId: string;
  clientId: string;
  redirectUri: string;
}

/**
 * 直接造一条「已登录、Provider 已消费」的授权请求，并签一把合法 Cookie。
 *
 * 只用于「同意之后发生什么」的测试（grant upsert / 授权码 / WSS 同步）——
 * 那些用例的起点是「用户已经站在同意页上」。
 */
export async function seedConsentRow(
  sql: postgres.Sql,
  env: Env,
  input: {
    userId: string;
    clientId?: string;
    clientName?: string;
    redirectUri?: string;
    /** 测试 LinkHarness 时必须是该实例的 `BASE_URL + "/mcp"`。 */
    resource?: string;
    scope?: string[];
    state?: string | null;
    codeChallenge?: string;
    /** 显式指定 CSRF 明文，便于测试直接提交。 */
    csrf?: string;
    /** 显式指定浏览器 sid（默认随机）。 */
    sid?: string;
    /** 覆盖有效期（测过期）。 */
    expiresAt?: Date;
    /** 覆盖 provider（测非法值）。 */
    provider?: string | null;
    /** 覆盖 provider_consumed_at（测「尚未登录」）。 */
    providerConsumedAt?: Date | null;
  },
): Promise<SeededConsent> {
  const clientId = input.clientId ?? "test-client";
  const redirectUri = input.redirectUri ?? "https://client.example/callback";
  const csrf = input.csrf ?? randomBytes(32).toString("base64url");
  const sid = input.sid ?? randomBytes(32).toString("base64url");
  const binding = browserBindingHash(sid);
  const nowSec = Math.floor(Date.now() / 1000);

  const rows = await sql<{ id: string }[]>`
    insert into mcp_auth_requests
      (client_id, redirect_uri, scope, resource, state, code_challenge,
       csrf_hash, browser_binding_hash, user_id, provider, provider_state_hash,
       nonce_hash, provider_consumed_at, expires_at)
    values (
      ${clientId},
      ${redirectUri},
      ${input.scope ?? ["records:read", "coffee:read"]},
      ${input.resource ?? MCP_RESOURCE},
      ${input.state === undefined ? "client-state-1" : input.state},
      ${input.codeChallenge ?? "a".repeat(43)},
      ${hashCsrf(csrf)},
      ${binding},
      ${input.userId},
      ${input.provider === undefined ? "google" : input.provider},
      ${`seed-${randomBytes(8).toString("hex")}`},
      '',
      ${(input.providerConsumedAt === undefined ? new Date() : input.providerConsumedAt)?.toISOString() ?? null}::timestamptz,
      ${(input.expiresAt ?? new Date(Date.now() + 10 * 60_000)).toISOString()}::timestamptz
    )
    returning id`;

  const rid = rows[0]?.id;
  if (!rid) throw new Error("auth request insert returned no row");

  const cookie = await signBrowserCookie(env, {
    sid,
    iat: nowSec,
    exp: nowSec + 1800,
  });

  return { rid, cookie, csrf, userId: input.userId, clientId, redirectUri };
}

/** 当前用户的 grant 行（按 client 过滤）。 */
export async function grantsOf(
  sql: postgres.Sql,
  userId: string,
): Promise<
  Array<{
    id: string;
    client_id: string;
    scopes: string[];
    epoch: number;
    revoked_at: string | null;
    resource: string;
  }>
> {
  return sql`
    select id, client_id, scopes, epoch, revoked_at::text, resource
      from mcp_grants where user_id = ${userId} order by created_at`;
}

/** 授权码行（只读得到哈希，读不到明文——这正是要断言的）。 */
export async function codesOf(
  sql: postgres.Sql,
  userId: string,
): Promise<Array<{ code_hash: string; scope: string[]; resource: string; redirect_uri: string; code_challenge: string; expires_at: string; consumed_at: string | null }>> {
  return sql`
    select code_hash, scope, resource, redirect_uri, code_challenge,
           expires_at::text, consumed_at::text
      from mcp_auth_codes where user_id = ${userId} order by created_at`;
}

/** 从 302 的 Location 里取出参数。 */
export function redirectParams(res: Response): URLSearchParams {
  const location = res.headers.get("location");
  if (!location) throw new Error(`expected a redirect, got ${res.status}`);
  return new URL(location).searchParams;
}

/** 直接读一张表的行数（断言「没有产生副作用」）。 */
export async function tableCount(
  sql: postgres.Sql,
  table: "mcp_grants" | "mcp_auth_codes" | "mcp_auth_requests",
): Promise<number> {
  const rows = await sql.unsafe<{ count: string }[]>(`select count(*)::text as count from "${table}"`);
  return Number(rows[0]?.count ?? "0");
}

/** 给测试一个稳定的 `DbHandle` 类型别名（避免每个文件重复写）。 */
export type ConsentDb = DbHandle;
