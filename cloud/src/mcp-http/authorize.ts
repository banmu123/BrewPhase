import { eq } from "drizzle-orm";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import type { Database } from "../db/client.js";
import { mcpGrants, mcpSessions } from "../db/schema.js";
import type { JwtKeyRing } from "../sessions/jwt.js";
import { isMcpScope, orderMcpScopes, type McpScope } from "../mcp-oauth/constants.js";
import { verifyMcpAccessToken, type McpAccessClaims } from "../mcp-oauth/tokens.js";

/**
 * `/mcp` 每次请求的认证与授权回查（Phase 1.3.2，设计 §8.1–§8.3 / 任务书 §五）。
 *
 * 链路（顺序不可调换，全部每次请求执行、无任何进程缓存）：
 *
 * ```text
 * Authorization: Bearer <jwt>
 *   1. verifyMcpAccessToken —— HS256 / kid 轮换 / iss / aud=MCP_RESOURCE /
 *      exp / sub / sid / client_id / scope / jti（签名层，内存计算）
 *   2. mcp_sessions（sid）—— 存在、未撤销、未过 absolute_expires_at、
 *      user_id == sub、client_id == claim、resource == 本资源
 *   3. mcp_grants（session.grant_id）—— 存在、属于 sub、未撤销、
 *      client_id == session、resource == session、scopes 全部合法
 *   4. effective = token.scope ∩ session.issued_scope ∩ grant.scopes
 * ```
 *
 * JWT **没有** `grant_id` claim（C1 的签发面如此）：授权链是
 * `sub(JWT) → sid(JWT) → mcp_sessions → grant_id → mcp_grants`，每跳都做
 * 归属核对，因此不需要 token 自报 grant。
 *
 * **用户身份只来自验签后的 JWT `sub`**（安全 §2.4）：Body、MCP 参数、
 * 工具 arguments 里的 userId 一律不读。
 *
 * 失败分类（设计 §4.6 / §9.5）：
 * - **401**：token 层问题（缺失 / 签名 / 过期 / aud / iss / kid）与
 *   **Session 层问题**（sid 查不到 = 撤销或删除、已过期、归属不符）——
 *   设计 §9.5：「下一次 `/mcp` 的 `sid` 查询失败 → 401」。
 *   challenge **只带 `resource_metadata`**，不带 `scope`（§5.8.2）。
 * - **403**：Grant 回查失败（不存在 / 已撤销 / 归属或 resource 不符）——
 *   设计 §8.5「之后任何 /mcp 请求：grant 回查失败 → 403」。
 */

export interface McpHttpAuth {
  /** 原始 Bearer 值（仅用于组装 SDK `authInfo.token`；不进日志）。 */
  token: string;
  claims: McpAccessClaims;
  sessionId: string;
  grantId: string;
  /** `token.scope ∩ session.issued_scope ∩ grant.scopes`（任务书 §5.3）。 */
  effectiveScopes: McpScope[];
}

export type McpAuthFailureReason =
  | "missing_token"
  | "invalid_token"
  | "session_invalid"
  | "grant_invalid";

export type McpAuthOutcome =
  | { ok: true; auth: McpHttpAuth }
  | { ok: false; reason: McpAuthFailureReason; status: 401 | 403; challenge: string };

/** RFC 9728 PRM 地址：`<resource>` 路径前插入 `/.well-known/oauth-protected-resource`。 */
export function protectedResourceMetadataUrl(resource: string): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(resource));
}

/** 401 challenge：**只带 `resource_metadata`**，绝不带 `scope`（§5.8.2 / §6.4）。 */
export function challenge401(resource: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}

/** 403 + `insufficient_scope`：只带**本次缺少的那一个** scope（§5.8.3）。 */
export function challengeInsufficientScope(scope: string, resource: string): string {
  return (
    `Bearer error="insufficient_scope", scope="${scope}", ` +
    `resource_metadata="${protectedResourceMetadataUrl(resource)}"`
  );
}

/** 403 + grant 回查失败：token 本身有效，但它指向的授权已不成立。 */
export function challengeGrantInvalid(resource: string): string {
  return `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}

export interface AuthorizeMcpDeps {
  db: Database;
  keyRing: JwtKeyRing;
  /** `BASE_URL`（JWT `iss`）。 */
  issuer: string;
  /** `MCP_RESOURCE`（JWT `aud` 与 grant/session resource）。 */
  resource: string;
  now: Date;
}

function allMcpScopes(values: readonly string[]): values is McpScope[] {
  return values.every((value) => isMcpScope(value));
}

function intersect(a: readonly string[], b: readonly string[], c: readonly string[]): McpScope[] {
  const inB = new Set(b);
  const inC = new Set(c);
  return orderMcpScopes(a.filter((value) => inB.has(value) && inC.has(value)));
}

/**
 * 执行整条认证 / 回查链。数据库异常向外抛（路由层收口成固定 500），
 * 判定性失败一律返回**结构化原因**，绝不返回部分通过的 auth。
 */
export async function authorizeMcpRequest(
  authorizationHeader: string | null,
  deps: AuthorizeMcpDeps,
): Promise<McpAuthOutcome> {
  // ---- 4. Bearer ----
  const match = authorizationHeader === null ? null : /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1]?.trim();
  if (!token || token.length === 0) {
    return { ok: false, reason: "missing_token", status: 401, challenge: challenge401(deps.resource) };
  }

  let claims: McpAccessClaims;
  try {
    claims = await verifyMcpAccessToken(deps.keyRing, token, {
      issuer: deps.issuer,
      resource: deps.resource,
    });
  } catch {
    // 验签层的任何失败（签名 / kid / iss / aud / exp / claim 形态）对调用方都是
    // 同一句话「这个 token 不能用」→ 401。jose 的错误类型不外泄，也不区分。
    return { ok: false, reason: "invalid_token", status: 401, challenge: challenge401(deps.resource) };
  }

  // ---- 5. Session 实时回查（sid）----
  const sessionRows = await deps.db
    .select({
      id: mcpSessions.id,
      userId: mcpSessions.userId,
      grantId: mcpSessions.grantId,
      clientId: mcpSessions.clientId,
      resource: mcpSessions.resource,
      issuedScope: mcpSessions.issuedScope,
      revokedAt: mcpSessions.revokedAt,
      absoluteExpiresAt: mcpSessions.absoluteExpiresAt,
    })
    .from(mcpSessions)
    .where(eq(mcpSessions.id, claims.sessionId))
    .limit(1);
  const session = sessionRows[0];
  const sessionValid =
    session !== undefined &&
    session.revokedAt === null &&
    session.absoluteExpiresAt.getTime() > deps.now.getTime() &&
    session.userId === claims.userId &&
    session.clientId === claims.clientId &&
    session.resource === deps.resource &&
    allMcpScopes(session.issuedScope);
  if (!sessionValid) {
    return { ok: false, reason: "session_invalid", status: 401, challenge: challenge401(deps.resource) };
  }

  // ---- 6. Grant 实时回查（grant_id 取自已核对归属的 Session）----
  const grantRows = await deps.db
    .select({
      id: mcpGrants.id,
      userId: mcpGrants.userId,
      clientId: mcpGrants.clientId,
      resource: mcpGrants.resource,
      scopes: mcpGrants.scopes,
      revokedAt: mcpGrants.revokedAt,
    })
    .from(mcpGrants)
    .where(eq(mcpGrants.id, session.grantId))
    .limit(1);
  const grant = grantRows[0];
  const grantValid =
    grant !== undefined &&
    grant.userId === claims.userId &&
    grant.revokedAt === null &&
    grant.clientId === session.clientId &&
    grant.resource === session.resource &&
    allMcpScopes(grant.scopes);
  if (!grantValid) {
    return { ok: false, reason: "grant_invalid", status: 403, challenge: challengeGrantInvalid(deps.resource) };
  }

  // ---- 7. effective scopes（三交集；不能只信 JWT 快照）----
  const effectiveScopes = intersect(claims.scope, session.issuedScope, grant.scopes);

  return {
    ok: true,
    auth: {
      token,
      claims,
      sessionId: session.id,
      grantId: grant.id,
      effectiveScopes,
    },
  };
}

/** 组装传给 SDK 的 `authInfo`（严格透传；SDK 不做任何 token 校验）。 */
export function toSdkAuthInfo(auth: McpHttpAuth, resource: string): {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource: URL;
  resourceMetadataUrl: string;
  extra: Record<string, unknown>;
} {
  return {
    token: auth.token,
    clientId: auth.claims.clientId,
    scopes: [...auth.effectiveScopes],
    expiresAt: auth.claims.expiresAt,
    resource: new URL(resource),
    resourceMetadataUrl: protectedResourceMetadataUrl(resource),
    extra: {
      // 工厂与工具回调只能从这里取身份：userId 永远来自验签后的 JWT sub。
      userId: auth.claims.userId,
      sessionId: auth.sessionId,
      grantId: auth.grantId,
      jti: auth.claims.jti,
    },
  };
}
