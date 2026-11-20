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

/** 413 纯文本响应（设计 §4.6）——声明头快路径与实际字节超限共用同一响应。 */
export function tooLargeResponse(): Response {
  return new Response("request body too large", {
    status: 413,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * 步骤 1a：`Content-Length` **廉价快路径**——声明值超限则在任何读取、Host、
 * Origin、Bearer 与数据库操作之前直接 `413`。
 *
 * 它**不是**大小限制本身：没有 `Content-Length` 的 chunked 请求、以及声明值
 * 小于实际正文的请求，都由 `readBoundedMcpBody()` 按**实际读取字节数**硬限。
 */
export function bodyTooLargeResponse(request: Request): Response | undefined {
  const declared = request.headers.get("content-length");
  if (declared === null) return undefined;
  if (!/^\d+$/.test(declared)) return undefined; // 非法头交由有界读取器按实际字节判
  if (Number(declared) > MCP_HTTP_MAX_BODY_BYTES) {
    return tooLargeResponse();
  }
  return undefined;
}

/** `readBoundedMcpBody` 的结果：成功（有界）/ 超限（已取消流）/ 不可读。 */
export type BoundedBodyRead =
  | { outcome: "ok"; bytes: Uint8Array }
  | { outcome: "too_large"; bytesRead: number }
  | { outcome: "unreadable" };

/**
 * 步骤 1b：**按实际字节的硬上限**流式读取请求体（Phase 1.3.2-R1 P1）。
 *
 * 修复前的顺序是「只信 `Content-Length` → Scope 预检时 `request.clone().text()`
 * 无上限缓冲」——没有 `Content-Length` 的 chunked 请求可以在 Scope 预检阶段
 * 被完整读入内存（SDK 的 `maxRequestBodySize` 在那之后才生效）。现在：
 *
 * - **流式读取**，累计 `Uint8Array.byteLength`；一旦 `> limit`：
 *   **立即停止读取、`reader.cancel()` 取消底层流**，返回 `too_large`——
 *   正文最多保留 `limit` 字节（跨越上限的那个 chunk 只计数、不入缓冲）。
 * - 因此**任何超过 256 KiB 的请求都不可能被完整缓冲**：读取量上界是
 *   `limit + 单个 chunk`，而不是请求的真实总长。
 * - 读取异常 / 对端中断 → `unreadable`（入口回 400，不进入后续任何阶段）。
 * - 成功路径返回**恰好有界**的完整正文，Host/Origin/Bearer/Scope 预检与 SDK
 *   共用这一份数据（SDK 不再各自读原始流，`maxRequestBodySize` 保留为第二道）。
 */
export async function readBoundedMcpBody(
  request: Request,
  limit: number = MCP_HTTP_MAX_BODY_BYTES,
): Promise<BoundedBodyRead> {
  const body = request.body;
  if (body === null) return { outcome: "ok", bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // 超限：立刻停读并取消底层流（不等对端发完，不缓冲跨越上限的 chunk）。
        await reader.cancel().catch(() => undefined);
        return { outcome: "too_large", bytesRead: total };
      }
      chunks.push(value);
    }
  } catch {
    // 对端中断 / 流错误：不做部分解析，交由入口回 400（不进入 SDK、不查库）。
    return { outcome: "unreadable" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已 cancel / 已出错的 reader 释放会抛——这里只需要不泄漏锁。
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { outcome: "ok", bytes: merged };
}

/**
 * 用**已有界的正文**重建交给 SDK 的 Request（Phase 1.3.2-R1 P1）。
 *
 * 保留原始 URL / method / headers（`Authorization`、`MCP-Protocol-Version`、
 * `Mcp-Method`、`Mcp-Name`、`Host`、`Origin`、`Content-Type` …一个不丢）与
 * `AbortSignal`（取消语义 §4.4）；正文换成已读出的字节——原始请求的流已被
 * 读尽/取消，SDK 拿到的是同一份**完整但已经有界**的数据。
 */
export function withBoundedBody(request: Request, bytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(bytes.length > 0 ? { body: bytes } : {}),
    signal: request.signal,
  });
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
