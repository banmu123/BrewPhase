import { normalizeHost } from "../link/link-server.js";

/**
 * `/mcp` HTTP 入口的安全闸门（Phase 1.3.2，设计 §4.2 步骤 1–3 / §4.5）。
 *
 * 顺序是契约的一部分：**请求体大小 → Host → Origin**，之后才是 Bearer /
 * Session / Grant。Host 判据与 WSS 握手**共用同一个 `normalizeHost`**
 * （从 `link-server.ts` 导出）——两处各写一份归一化，迟早出现
 * 「WSS 能连、/mcp 被拒」（设计 §4.5 明令避免）。
 *
 * Origin 用**完整 origin 精确匹配**（小写比较），与 `link-server` 的
 * `allowedOrigins.has(origin.toLowerCase())` 同语义：SDK 的
 * `originValidationResponse` 只比对 hostname（忽略 scheme / port），把
 * `https://x` 列进白名单会连带放行 `http://x`——那是一次真实的降级放宽，
 * 这里不采用。
 */

/** 请求体上限 256 KiB（设计 §4.2 步骤 1）。 */
export const MCP_HTTP_MAX_BODY_BYTES = 256 * 1024;

/**
 * 步骤 1：请求体大小。
 *
 * `Content-Length` 存在且合法时先判（廉价、发生在任何读取之前）→ `413` 纯文本。
 * 没有 `Content-Length`（chunked / 谎报）的超限体交给 SDK 的
 * `maxRequestBodySize`（同为 256 KiB）兜底，同样在解析任何内容之前 `413`。
 */
export function bodyTooLargeResponse(request: Request): Response | undefined {
  const declared = request.headers.get("content-length");
  if (declared === null) return undefined;
  if (!/^\d+$/.test(declared)) return undefined; // 非法头交由 SDK / HTTP 层处理
  if (Number(declared) > MCP_HTTP_MAX_BODY_BYTES) {
    return new Response("request body too large", { status: 413, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return undefined;
}

/**
 * 与 SDK `originValidationResponse` 同形的 403 拒绝体（`-32000`、`id: null`）。
 * 选这个形状而不是自造错误码：SDK 对 Host/Origin 类拒绝用的就是它，
 * 客户端看到的传输层错误面保持一致。
 */
function forbidden(message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

/** 步骤 2：Host 必须命中 `GATEWAY_ALLOWED_HOSTS`（含 BASE_URL 推导）。 */
export function hostGuard(request: Request, allowedHosts: readonly string[]): Response | undefined {
  const allowed = new Set(allowedHosts.map(normalizeHost).filter((host) => host.length > 0));
  // 白名单为空 = 不校验（仅测试场景；生产由 loadEnv 从 BASE_URL 推导保证非空）。
  if (allowed.size === 0) return undefined;
  const host = normalizeHost(request.headers.get("host") ?? "");
  if (!host || !allowed.has(host)) return forbidden("Host not allowed");
  return undefined;
}

/**
 * 步骤 3：Origin 存在时必须命中 CORS 白名单；无 Origin（服务端到服务端）通过。
 * 精确匹配、大小写不敏感——与 WSS 升级握手一致。
 */
export function originGuard(request: Request, allowedOrigins: readonly string[]): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) return undefined;
  const allowed = new Set(allowedOrigins.map((value) => value.toLowerCase()));
  if (!allowed.has(origin.toLowerCase())) return forbidden("Origin not allowed");
  return undefined;
}
