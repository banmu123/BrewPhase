import type { Context } from "hono";
import type { AppContext, AppHono } from "../context.js";
import { mcpResourceFor } from "../mcp-oauth/constants.js";
import { rateLimit } from "../security/rate-limit.js";
import { serverError } from "../security/errors.js";
import {
  authorizeMcpRequest,
  challengeInsufficientScope,
  toSdkAuthInfo,
  type McpAuthOutcome,
} from "../mcp-http/authorize.js";
import { bodyTooLargeResponse, hostGuard, originGuard } from "../mcp-http/guards.js";
import { createMcpHttpHandler } from "../mcp-http/handler.js";
import { scopeForTool } from "../mcp-http/tools.js";

/**
 * `POST /mcp` —— Remote MCP Streamable HTTP 端点（Phase 1.3.2，设计 §4）。
 *
 * ## 入口顺序（契约，任务书 §四）
 *
 * ```text
 * 0. 限流（独立桶 mcp-http，非浏览器授权桶）
 * 1. GET / DELETE → 交给 SDK → 405（无 SSE、无会话终止）
 * 2. 请求体大小 → 413（纯文本；Content-Length 先判，chunked 由 SDK 兜底）
 * 3. Host → 403（与 WSS 共用 normalizeHost / 同一份 env 解析）
 * 4. Origin → 403（存在即须精确命中 CORS 白名单；无 Origin = 服务端调用，通过）
 * 5. Bearer 验签（HS256 / kid / iss / aud / exp / sub / sid / client_id / scope / jti）→ 401
 * 6. Session 实时回查 → 401；Grant 实时回查 → 403（每次都查库，无进程缓存）
 * 7. tools/call 的 scope 预检 → 403 insufficient_scope（只报缺的那一个）
 * 8. 交给 createMcpHandler().fetch(request, { authInfo })（协议层全部由 SDK 处理）
 * ```
 *
 * ## 错误面（设计 §4.6）
 *
 * - 401：`WWW-Authenticate: Bearer resource_metadata="…"`（**不带 scope**）；
 * - 403 insufficient_scope：`Bearer error="insufficient_scope", scope="<缺的一个>", resource_metadata="…"`；
 * - 403 其它（Origin / Host / grant 回查失败）：JSON-RPC `-32000`（与 SDK 的
 *   传输层拒绝同形）或带 `invalid_token` challenge 的 403；
 * - 405 / 413 / 429 / 协议层 `-32020` `-32022` `-32601`：SDK 或既有设施产出。
 *
 * **协议层以下的业务失败不进这里**：`tools/call` 的结果面（含 `isError`）
 * 由 handler 映射（§6.4），不改变 HTTP 状态。
 */

/** 从 POST body 里**只读地**窥探 `tools/call` 的工具名（scope 预检用）。 */
async function peekToolCallName(request: Request): Promise<string | null | "unparsable"> {
  let clone: Request;
  try {
    // 读 clone、不读原请求：原请求仍完整交给 SDK（SDK 自己也会 clone 分类）。
    clone = request.clone();
  } catch {
    return "unparsable"; // body 已被消费等异常形态 → 交给 SDK 处理
  }
  let text: string;
  try {
    text = await clone.text();
  } catch {
    return "unparsable";
  }
  if (text.length === 0) return "unparsable";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "unparsable"; // 非法 JSON 的分类权属于 SDK
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "unparsable";
  const record = body as { method?: unknown; params?: { name?: unknown } };
  if (record.method !== "tools/call") return "unparsable";
  if (typeof record.params?.name !== "string") return "unparsable"; // 形状问题交给 SDK
  return record.params.name;
}

/**
 * 步骤 7：`tools/call` 的 scope 预检。
 *
 * 返回 `null` = 通过 / 非 tools/call（交给 SDK）；返回 scope 字符串 = 缺少该
 * scope → 403。**在派发之前**判定（§7.2），且只报**本次缺少的那一个**
 * （§5.8.3）。未知工具名不在此判 404——工具存在性是 SDK 的协议面。
 */
async function checkToolCallScope(
  request: Request,
  effectiveScopes: readonly string[],
): Promise<string | null> {
  const name = await peekToolCallName(request);
  if (name === null || name === "unparsable") return null;
  const required = scopeForTool(name);
  if (required === undefined) return null;
  return effectiveScopes.includes(required) ? null : required;
}

function unauthorized(c: Context, challenge: string): Response {
  return c.body(null, 401, { "WWW-Authenticate": challenge });
}

function forbidden(c: Context, challenge: string): Response {
  return c.body(null, 403, { "WWW-Authenticate": challenge });
}

export function routeMcpHttp(app: AppHono, ctx: AppContext): void {
  /**
   * 独立限流桶（任务书 §四）：`mcp-http` 与浏览器授权（`mcp-oauth`）、
   * token（`mcp-token`）分开——客户端一次会话会连续 discover/list/call，
   * 正常频率高一个量级，共用桶会互相挤掉额度。
   */
  const limiter = rateLimit({
    name: "mcp-http",
    max: ctx.env.rateLimit.maxMcp,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
    maxBuckets: ctx.env.rateLimit.maxBuckets,
  });

  const handler = createMcpHttpHandler(ctx);
  const resource = mcpResourceFor(ctx.env.baseUrl);

  app.on(["GET", "DELETE", "POST"], "/mcp", limiter, async (c) => {
    const request = c.req.raw;

    // ---- 1. 方法：GET / DELETE → 405（SDK 的 canonical 响应；无 SSE、无会话）----
    if (c.req.method !== "POST") {
      return handler.fetch(request);
    }

    // ---- 2. 请求体大小 → 413 纯文本（在任何读取 / Host / 认证之前）----
    const tooLarge = bodyTooLargeResponse(request);
    if (tooLarge) return tooLarge;

    // ---- 3. Host（与 WSS 同一份 normalizeHost / env 解析）----
    const hostRejected = hostGuard(request, ctx.env.gateway.allowedHosts);
    if (hostRejected) return hostRejected;

    // ---- 4. Origin（存在即须命中；无 Origin = 服务端到服务端，通过）----
    const originRejected = originGuard(request, ctx.env.corsOrigins);
    if (originRejected) return originRejected;

    // ---- 5/6. Bearer → Session → Grant（每次请求实时查库）----
    let outcome: McpAuthOutcome;
    try {
      outcome = await authorizeMcpRequest(request.headers.get("authorization"), {
        db: ctx.db.db,
        keyRing: ctx.keyRing,
        issuer: ctx.env.baseUrl,
        resource,
        now: new Date(),
      });
    } catch {
      // 数据库等非判定性异常：固定文案 500（不透出 drizzle 的 SQL / 参数）。
      throw serverError("mcp authorization failed");
    }
    if (!outcome.ok) {
      // 401（token / session）与 403（grant）的 challenge 形状见 authorize.ts。
      if (outcome.status === 401) return unauthorized(c, outcome.challenge);
      return forbidden(c, outcome.challenge);
    }

    // ---- 7. tools/call scope 预检（派发之前；只报缺的那一个）----
    const missingScope = await checkToolCallScope(request, outcome.auth.effectiveScopes);
    if (missingScope !== null) {
      return forbidden(c, challengeInsufficientScope(missingScope, resource));
    }

    // ---- 8. 交给 SDK（协议 / 时代 / 传输层响应全部由它产出）----
    return handler.fetch(request, { authInfo: toSdkAuthInfo(outcome.auth, resource) });
  });
}
