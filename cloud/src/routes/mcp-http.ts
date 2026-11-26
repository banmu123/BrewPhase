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
import {
  bodyTooLargeResponse,
  bodyTimeoutResponse,
  hostGuard,
  originGuard,
  readBoundedMcpBody,
  tooLargeResponse,
  withBoundedBody,
} from "../mcp-http/guards.js";
import { createMcpHttpHandler } from "../mcp-http/handler.js";
import { scopeForTool } from "../mcp-http/tools.js";

/**
 * `POST /mcp` —— Remote MCP Streamable HTTP 端点（Phase 1.3.2；R1 修订 P1/P2）。
 *
 * ## 入口顺序（契约，任务书 §四；P1 把大小限制改为实际字节硬上限）
 *
 * ```text
 * 0a. OPTIONS /mcp → 独立路由（不进限流桶、不进认证、不进 SDK）→ 204
 * 0. 限流（独立桶 mcp-http，非浏览器授权桶；只作用于 GET/DELETE/POST）
 * 1. GET / DELETE → 交给 SDK → 405（无 SSE、无会话终止）
 * 2a. Content-Length > 256 KiB → 413（廉价快路径，一个字节都不读）
 * 2b. 有界流式读取（实际字节硬上限 256 KiB + 绝对总时限 15s）
 *     → 超限立即停读 + 取消流 → 413 纯文本（先于 Host / Origin / Bearer / DB / SDK）
 *     → 超时停读 + 取消流 → 408 纯文本（同样先于一切后续阶段）
 *     → 流不可读（对端断开 / 流错误）→ 400 纯文本
 * 3. Host → 403（与 WSS 共用 normalizeHost / 同一份 env 解析）
 * 4. Origin → 403（存在即须精确命中 CORS 白名单；无 Origin = 服务端调用，通过）
 * 5. Bearer 验签（HS256 / kid / iss / aud / exp / sub / sid / client_id / scope / jti）→ 401
 * 6. Session 实时回查 → 401；Grant 实时回查 → 403（每次都查库，无进程缓存）
 * 7. tools/call 的 scope 预检（解析**有界正文**；batch 的每个元素都查）→ 403
 * 8. 用有界正文重建 Request → createMcpHandler().fetch(...)（协议层全部由 SDK 产出）
 * ```
 *
 * ## 错误面（设计 §4.6）
 *
 * - 401：`WWW-Authenticate: Bearer resource_metadata="…"`（**不带 scope**）；
 * - 403 insufficient_scope：`Bearer error="insufficient_scope", scope="<缺的一个>", resource_metadata="…"`；
 * - 403 其它（Origin / Host / grant 回查失败）：JSON-RPC `-32000`（与 SDK 的
 *   传输层拒绝同形）或带 `invalid_token` challenge 的 403；
 * - 405 / 413 / 429 / 协议层 `-32020` `-32022` `-32601` `-32700`：SDK 或既有设施产出。
 *
 * **协议层以下的业务失败不进这里**：`tools/call` 的结果面（含 `isError`）
 * 由 handler 映射（§6.4），不改变 HTTP 状态。
 */

/**
 * 步骤 7 的输入：从**已有界的正文**解析出缺失的 scope。
 *
 * - 单条 JSON-RPC 与 **batch 数组**都处理：SDK 实测支持 legacy batch
 *   （数组里每个 `tools/call` 都会执行），因此 batch 的**每一个**元素都要过
 *   预检——任何一个缺权即拒，绝不让未授权工具进入派发；
 * - 非法 JSON / 空正文 / 形状问题 / 未知工具名 → `null`：**分类权属于 SDK**
 *   （`-32700`、`-32600`、参数错误原样产出），预检不改变既有协议错误面。
 */
function missingScopeFromBoundedBody(
  bytes: Uint8Array,
  effectiveScopes: readonly string[],
): string | null {
  if (bytes.length === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null; // 非法 JSON → SDK 的协议错误（-32700）
  }
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { method?: unknown; params?: { name?: unknown } };
    if (record.method !== "tools/call") continue;
    const name = record.params?.name;
    if (typeof name !== "string") continue; // 形状问题交给 SDK
    const required = scopeForTool(name);
    if (required === undefined) continue; // 未知工具交给 SDK
    if (!effectiveScopes.includes(required)) return required;
  }
  return null;
}

function unauthorized(c: Context, challenge: string): Response {
  return c.body(null, 401, { "WWW-Authenticate": challenge });
}

function forbidden(c: Context, challenge: string): Response {
  return c.body(null, 403, { "WWW-Authenticate": challenge });
}

/**
 * `OPTIONS /mcp` → **204**（设计 §4.1，P2）。
 *
 * 头部与 `app.ts` 全局 CORS 中间件**逐字段一致**（`Vary: Origin`、
 * `GET, POST, OPTIONS`、`Authorization, Content-Type`）：
 *
 * - **默认（`CORS_ORIGINS` 为空）**：204，但**不下发任何
 *   `Access-Control-Allow-Origin`**——没有 `*`、没有隐式放开跨源；
 *   预检只回答「不许」，不扩大权限；
 * - **配置白名单时**：命中 `CORS_ORIGINS` 的 Origin 才回显 ACAO（不使用通配符、
 *   不带 credentials）；未命中的 Origin 拿到 204 但没有 ACAO（浏览器自行拦截）。
 *   （配置了 CORS 时 `app.use("*")` 的全局中间件会先拦截 OPTIONS——两处
 *   语义逐字段一致，行为不因走哪条分支而不同。）
 *
 * OPTIONS **不进入** Bearer / Session / Grant / 工具的任何业务处理。
 *
 * **独立注册（R2 P2）**：`OPTIONS /mcp` 单独成路由、**不挂 `limiter`**——
 * 预检请求不得消耗 `mcp-http` 业务限流额度（默认关闭 CORS 时全局中间件不
 * 拦截 OPTIONS，它会落到本路由；挂了桶就会被恶意刷预检打满业务配额）。
 * 路径**精确匹配 `/mcp`**，不扩大到其它路径。
 */
function optionsPreflight(c: Context, allowedOrigins: readonly string[]): Response {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
  const origin = c.req.header("origin");
  if (origin !== undefined && origin.length > 0) {
    const allowed = allowedOrigins.some((value) => value.toLowerCase() === origin.toLowerCase());
    // 回显白名单里的具体 origin，绝不用 `*`。
    if (allowed) headers["Access-Control-Allow-Origin"] = origin;
  }
  return c.body(null, 204, headers);
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

  /**
   * OPTIONS：**独立路由、不经过 `limiter`**（R2 P2）。
   *
   * 精确匹配 `/mcp`；不认证、不查库、不进 SDK、**不消耗 `mcp-http` 额度**。
   * 配置了 CORS 时全局中间件会先拦截 OPTIONS（既有语义不变）——本路由主要
   * 服务「CORS 默认关闭」的场景，两条路径的响应逐字段一致。
   */
  app.on("OPTIONS", "/mcp", (c) => optionsPreflight(c, ctx.env.corsOrigins));

  app.on(["GET", "DELETE", "POST"], "/mcp", limiter, async (c) => {
    const request = c.req.raw;

    // ---- 1b. GET / DELETE → 405（SDK 的 canonical 响应；无 SSE、无会话）----
    if (c.req.method !== "POST") {
      return handler.fetch(request);
    }

    // ---- 2a. Content-Length 声明超限 → 413（不读任何字节）----
    const declaredTooLarge = bodyTooLargeResponse(request);
    if (declaredTooLarge) return declaredTooLarge;

    // ---- 2b. 实际字节硬上限 + 绝对总时限：有界流式读取 ----
    const read = await readBoundedMcpBody(request);
    if (read.outcome === "too_large") {
      // 与 2a 完全相同的 413 纯文本（声明头缺失或谎报，响应一致）。
      return tooLargeResponse();
    }
    if (read.outcome === "timeout") {
      // 慢速挂起（无 CL、发几个字节就停）：总时限内停读 + 取消流 → 408。
      // 固定纯文本，不进 Host / Origin / Bearer / 数据库 / SDK。
      return bodyTimeoutResponse();
    }
    if (read.outcome === "unreadable") {
      // 对端中断 / 流错误：不进入任何后续阶段（不查库、不进 SDK）。
      return new Response("request body could not be read", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

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

    // ---- 7. tools/call scope 预检（派发之前；只报缺的那一个；含 batch 每个元素）----
    const missingScope = missingScopeFromBoundedBody(read.bytes, outcome.auth.effectiveScopes);
    if (missingScope !== null) {
      return forbidden(c, challengeInsufficientScope(missingScope, resource));
    }

    // ---- 8. 有界正文重建 Request → SDK（协议 / 时代 / 传输层响应全部由它产出）----
    return handler.fetch(withBoundedBody(request, read.bytes), {
      authInfo: toSdkAuthInfo(outcome.auth, resource),
    });
  });
}
