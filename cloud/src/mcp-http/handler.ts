import { McpServer, createMcpHandler, type AuthInfo, type McpHttpHandler, type McpRequestContext } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import type { LinkControl } from "../context.js";
import { MCP_HTTP_MAX_BODY_BYTES } from "./guards.js";
import { REMOTE_TOOLS, type RemoteToolDefinition } from "./tools.js";

/**
 * `POST /mcp` 的 MCP 处理器（Phase 1.3.2，设计 §3 / §4）。
 *
 * **统一入口**：`createMcpHandler(factory, { legacy: "stateless" })`——SDK 负责
 * 协议解析、双时代识别（modern 2026-07-28 / legacy 2025-06-18·25）、
 * `-32020` / `-32022` / `-32601` / 405 / 202 的传输层响应。Cloud **不**手写
 * Streamable HTTP Transport、**不**手接 `WebStandardStreamableHTTPServerTransport`、
 * **不**生成 `Mcp-Session-Id`（stateless 本身不产生会话）。
 *
 * 同一个 factory 服务两个时代（SDK 要求 ONE factory）：工具定义只有一份，
 * 两个时代的 `tools/list` / `tools/call` 不可能漂移。
 *
 * ## authInfo 是唯一的身份入口
 *
 * 路由层完成 Bearer / Session / Grant 回查后把结果放进 `authInfo`（严格透传，
 * SDK 不做任何 token 校验）。工厂按 `authInfo.scopes`（= effective scopes）
 * 注册工具子集，工具回调从 `authInfo.extra` 取 `userId / grantId / jti`——
 * **全部来自验签后的 JWT `sub` 与已回查的 Session / Grant**，绝不读 Body 或
 * 工具 arguments 里的身份字段。
 */

/** 与 Desktop stdio 入口相同的 serverInfo（`Desktop/src/mcp/stdio.ts`）。 */
const SERVER_INFO = { name: "brewphase", version: "1.0.0" } as const;

/** `authInfo.extra` 里由路由层盖章的身份字段。 */
interface McpAuthExtra {
  userId: string;
  sessionId: string;
  grantId: string;
  jti: string;
}

function authExtra(authInfo: AuthInfo | undefined): McpAuthExtra | null {
  const extra = authInfo?.extra as Partial<McpAuthExtra> | undefined;
  if (
    extra &&
    typeof extra.userId === "string" &&
    typeof extra.sessionId === "string" &&
    typeof extra.grantId === "string" &&
    typeof extra.jti === "string"
  ) {
    return { userId: extra.userId, sessionId: extra.sessionId, grantId: extra.grantId, jti: extra.jti };
  }
  return null;
}

/** 客户端取消：HTTP Request 的 signal（断开）∪ 协议层 cancelled 通知。 */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * 结构化日志的**允许字段**（设计 / 安全文档 §3.2.1）：
 * `tool` / `status` / `durationMs` / `errorCode` / `jti`（前 8 位）/ `grantId`。
 *
 * **绝不记录**：token、JWT 全文、工具 arguments、结果正文、错误 message
 * （Zod 校验错误的 message 会回显参数值——所以 handler 级错误只记 `err.name`）。
 */
interface ToolCallLogFields {
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  jti: string;
  grantId: string;
  errorCode?: string;
}

function logToolCall(ctx: AppContext, fields: ToolCallLogFields): void {
  // 展开成对象字面量：Logger 的入参是 Record<string, unknown>，接口类型没有索引签名。
  ctx.logger.info("mcp_tool_call", { ...fields });
}

/** §6.4 映射：`ok` → text + structuredContent；失败 → `isError: true`（不是 JSON-RPC error）。 */
function okResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const text = JSON.stringify(data);
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return { content: [{ type: "text", text }], structuredContent: data as Record<string, unknown> };
  }
  return { content: [{ type: "text", text }] };
}

function errorResult(error: { code: string; message: string; retryable: boolean }): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
}

interface ToolCallScope {
  ctx: AppContext;
  authInfo: AuthInfo | undefined;
  requestSignal: AbortSignal | undefined;
}

/**
 * 注册一个工具。回调内的判定顺序（**先权限、后派发**，§7.2「不能先执行再检查」）：
 *
 * 1. scope 防御复核（路由已 403 过；这里是结构防线，缺 scope 绝不派发）；
 * 2. `ctx.link` 缺失 → fail-closed `DEVICE_OFFLINE`（HTTP-only / 无在线连接的
 *    测试场景不得 fail-open，也不得抛未处理异常）；
 * 3. `dispatchToolCall`（既有 R1/R2 语义，一字不改）；
 * 4. 结果映射 + 允许字段日志。
 */
function registerRemoteTool(
  server: McpServer,
  tool: RemoteToolDefinition,
  scope: ToolCallScope,
): ReturnType<McpServer["registerTool"]> {
  const { ctx, authInfo, requestSignal } = scope;
  const extra = authExtra(authInfo);

  return server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: true },
    },
    async (args, mcpCtx) => {
      const startedAt = performance.now();
      const jtiPrefix = extra ? extra.jti.slice(0, 8) : "";
      const grantId = extra ? extra.grantId : "";
      const finish = (fields: Partial<ToolCallLogFields>): void => {
        logToolCall(ctx, {
          tool: tool.name,
          status: "ok",
          durationMs: Math.round(performance.now() - startedAt),
          jti: jtiPrefix,
          grantId,
          ...fields,
        });
      };

      // 1. scope 防御复核：路由的 403 是第一道，这里是「绝不带缺失 scope 派发」
      //    的结构防线（fail-closed，不发网络、不查库）。
      const effective = new Set(authInfo?.scopes ?? []);
      if (!effective.has(tool.scope)) {
        finish({ status: "error", errorCode: "SCOPE_DENIED" });
        return errorResult({
          code: "SCOPE_DENIED",
          message: `${tool.scope} is required for ${tool.name}`,
          retryable: false,
        });
      }
      // 身份缺失（工厂被绕过 authInfo 调用的理论情形）→ fail-closed。
      if (!extra) {
        finish({ status: "error", errorCode: "DEVICE_OFFLINE" });
        return errorResult({
          code: "DEVICE_OFFLINE",
          message: "device connection is not ready",
          retryable: true,
        });
      }

      const link: LinkControl | undefined = ctx.link;
      // 2. 无 link（HTTP-only 部署 / 纯 HTTP 测试）→ fail-closed，绝不 fail-open。
      if (!link) {
        finish({ status: "error", errorCode: "DEVICE_OFFLINE" });
        return errorResult({
          code: "DEVICE_OFFLINE",
          message: "device connection is not ready",
          retryable: true,
        });
      }

      // 3. 派发：userId 只来自 JWT sub，grantId 只来自已回查的 Session。
      const signal = combineSignals(requestSignal, mcpCtx.mcpReq.signal);
      const result = await link.dispatchToolCall({
        userId: extra.userId,
        grantId: extra.grantId,
        tool: tool.name,
        arguments: args,
        ...(signal ? { signal } : {}),
        // 仅用于日志串联（§6.1）：JSON-RPC id 截断，防止超长 id 撑大帧。
        trace: {
          mcp_request_id: String(mcpCtx.mcpReq.id).slice(0, 128),
          received_at: Date.now(),
        },
      });

      // 4. 映射 + 日志（不记 arguments、不记结果正文）。
      if (result.ok) {
        finish({});
        return okResult(result.data);
      }
      finish({ status: "error", errorCode: result.error.code });
      return errorResult(result.error);
    },
  );
}

/**
 * 构造 `/mcp` 的 SDK handler（每个应用一次）。
 *
 * `legacy: "stateless"`：2025 时代逐请求无状态应答，GET/DELETE 恒 405、
 * 不生成 `Mcp-Session-Id`；`maxRequestBodySize` 与入口的 256 KiB 一致
 * （没有 Content-Length 的 chunked 超限体由 SDK 在解析前 413 兜底）。
 */
export function createMcpHttpHandler(ctx: AppContext): McpHttpHandler {
  return createMcpHandler(
    (factoryCtx: McpRequestContext) => {
      const server = new McpServer(SERVER_INFO);
      const scopes = factoryCtx.authInfo?.scopes ?? [];
      const scope: ToolCallScope = {
        ctx,
        authInfo: factoryCtx.authInfo,
        requestSignal: factoryCtx.requestInfo?.signal,
      };
      /**
       * **注册全部 8 个工具，再按 effective scope 置 `enabled`**（而不是只注册
       * 子集）：
       *
       * - SDK 在「一个工具都没注册」时不声明 tools 能力 → `tools/list` 会变成
       *   `-32601`（实测），而 §5.8.1 要求**无 scope 时返回空数组、不是错误**；
       * - `tools/list` 过滤 `enabled` → 有 scope 返回子集、零 scope 返回 `[]`；
       * - `tools/call` 对 disabled 工具是 SDK 的二次防线（路由的 403 是第一道）。
       */
      for (const tool of REMOTE_TOOLS) {
        const registered = registerRemoteTool(server, tool, scope);
        registered.update({ enabled: scopes.includes(tool.scope) });
      }
      return server;
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MCP_HTTP_MAX_BODY_BYTES,
      // 只记错误名：SDK / Zod 的 message 可能回显参数值（哨兵日志纪律）。
      onerror: (error) => ctx.logger.warn("mcp_handler_error", { error: error.name }),
    },
  );
}
