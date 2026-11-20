import type { Logger } from "../../src/logger.js";
import type { AppHono, LinkControl } from "../../src/context.js";
import type { Env } from "../../src/env.js";
import type { DbHandle } from "../../src/db/client.js";
import type { DispatchToolCallInput } from "../../src/link/forwarder.js";
import type { DispatchResult } from "../../src/link/request-registry.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  createMcpOAuthHarness,
  type CreateHarnessOptions,
  type McpOAuthHarness,
} from "./mcp-oauth-app.js";
import { exchangeCode, obtainAuthCode, readTokenResponse } from "./mcp-token.js";

/**
 * `POST /mcp`（Phase 1.3.2）的测试夹具。
 *
 * - **真实 PostgreSQL**：Bearer 走完整 OAuth 流程（consent → code → token），
 *   Session / Grant 回查打真表——不 mock 数据库来「证明」授权有效。
 * - **可控 link**：`ctx.link` 注入 fake LinkControl（断言 dispatchToolCall 入参、
 *   模拟 DEVICE_OFFLINE / 超时 / 撤销）；真实 WSS 转发语义由既有 link 测试
 *   与本组的一条真实链路用例覆盖。
 * - **可捕获日志**：替换 `ctx.logger`，记录所有 (level, message, fields) 供
 *   哨兵 grep。
 */

export const MCP_HOST = "gateway.example";
export const MCP_BASE_URL = `https://${MCP_HOST}`;
export const MCP_RESOURCE = `${MCP_BASE_URL}/mcp`;

// ---------------------------------------------------------------------------
// 日志捕获
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
}

export function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields: fields ?? {} });
    };
  return {
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    entries,
  };
}

// ---------------------------------------------------------------------------
// 可控 LinkControl
// ---------------------------------------------------------------------------

export interface FakeLinkControl extends LinkControl {
  /** 每次 dispatch 的入参（断言 userId / grantId / tool / signal）。 */
  calls: DispatchToolCallInput[];
  /** 覆盖默认派发行为。 */
  setDispatch(handler: (input: DispatchToolCallInput) => Promise<DispatchResult> | DispatchResult): void;
}

const DEFAULT_COUNTS = { user: 0, device: 0, connection: 0, queued: 0, pending: 0 };

export function createFakeLink(): FakeLinkControl {
  let handler: ((input: DispatchToolCallInput) => DispatchResult | Promise<DispatchResult>) | null = null;
  const calls: DispatchToolCallInput[] = [];
  return {
    calls,
    instanceId: "test-instance",
    connectionCount: () => 0,
    disconnectDevice: async () => undefined,
    rotateConnection: async () => false,
    setDispatch(fn) {
      handler = fn;
    },
    async dispatchToolCall(input) {
      calls.push(input);
      if (handler) return handler(input);
      // 默认：成功但**不回显 arguments**（日志哨兵测试不依赖默认值）。
      return { ok: true, data: { tool: input.tool, ok: true }, meta: { duration_ms: 1, cached: false } };
    },
    installGrant: async () => ({ ok: true, grantCtx: "gc_test", epoch: 1, delivered: false }),
    revokeGrant: async () => ({ ok: true, grantCtx: "gc_test", epoch: 2, delivered: false }),
    replaceGrant: async () => ({ ok: true, grantCtx: "gc_test", epoch: 3, delivered: false }),
    inspectForwarder: () => ({ connections: [], counts: DEFAULT_COUNTS }),
  } as FakeLinkControl;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface McpHttpHarness extends McpOAuthHarness {
  /** 本次 harness 捕获的全部日志（替换默认 stdout logger）。 */
  logs: LogEntry[];
  link: FakeLinkControl;
}

export interface McpHttpHarnessOptions extends CreateHarnessOptions {
  /** 覆盖 CORS 白名单（Origin 用例）。 */
  corsOrigins?: string[];
  /** 覆盖 Host 白名单（默认 = baseUrl 的 hostname）。 */
  allowedHosts?: string[];
  /** 覆盖 `RATE_LIMIT_MAX_MCP`（限流用例）。 */
  maxMcp?: number;
  /** 部分覆盖其它限流字段（如 `maxAuthorize`，测桶间独立性）。 */
  rateLimit?: Partial<Env["rateLimit"]>;
}

/**
 * 造一个带 `/mcp` 路由的完整 harness：
 * 可用 `env`（CORS / Host / 限流）、可控 link、可捕获日志。
 */
export async function createMcpHttpHarness(
  options: McpHttpHarnessOptions = {},
): Promise<McpHttpHarness> {
  resetRateLimiter();
  const { corsOrigins, allowedHosts, maxMcp, rateLimit, ...harnessOptions } = options;
  const h = await createMcpOAuthHarness({
    ...harnessOptions,
    env: {
      ...(corsOrigins ? { corsOrigins } : {}),
      // 默认与 baseUrl 的 hostname 一致（makeTestEnv 的默认是 127.0.0.1，
      // 那是 WSS 集成测试的取值，/mcp 测试要按 gateway.example 校验 Host）。
      gateway: { expectedReplicas: 1, allowedHosts: allowedHosts ?? [MCP_HOST] },
      ...(rateLimit || maxMcp !== undefined
        ? { rateLimit: { ...(rateLimit ?? {}), ...(maxMcp !== undefined ? { maxMcp } : {}) } }
        : {}),
      ...harnessOptions.env,
    },
  });

  const { logger, entries } = captureLogger();
  const link = createFakeLink();
  h.ctx.logger = logger;
  h.ctx.link = link;

  // 默认 OAuth 客户端（`startConsentFlow` / `obtainAuthCode` 的缺省 client_id）。
  // `ON CONFLICT DO NOTHING`：同一用例可能再建第二个 harness（限流 / 启用边界），
  // 那时 beforeEach 的 resetDb 已经跑过，重复播种不能炸。
  await h.db.sql`
    insert into mcp_oauth_clients
      (client_id, client_name, redirect_uris, registration_source)
    values ('test-client', 'Test Client', array['https://client.example/callback'], 'pre_registered')
    on conflict (client_id) do nothing`;

  return Object.assign(h, { logs: entries, link });
}

// ---------------------------------------------------------------------------
// HTTP 请求构造
// ---------------------------------------------------------------------------

/**
 * modern（2026-07-28）信封：`params._meta` 的两个保留键 + 三个标准头。
 * （SDK 实测：只写非命名空间的 `protocolVersion` 不算信封。）
 */
export function modernEnvelope(protocolVersion = "2026-07-28"): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

export interface McpRequestInit {
  token?: string | undefined;
  /** 覆盖 `MCP-Protocol-Version`（默认与信封一致）。 */
  protocolVersionHeader?: string;
  /** 覆盖 `Mcp-Method`（默认 = body.method）。 */
  mcpMethodHeader?: string;
  /** 显式 `Mcp-Name`（tools/call 必需）。 */
  mcpName?: string;
  /** 额外头（Origin / Host / Content-Length 等）。 */
  headers?: Record<string, string>;
  /** 请求取消信号（AbortSignal 透传用例）。 */
  signal?: AbortSignal;
}

function baseHeaders(token: string | undefined, extra: Record<string, string>): Record<string, string> {
  return {
    host: MCP_HOST,
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** modern POST：带 `_meta` 信封与三个标准头。 */
export function modernRequest(
  body: Record<string, unknown>,
  init: McpRequestInit = {},
): Request {
  const method = String(body.method ?? "");
  return new Request(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: baseHeaders(init.token, {
      "content-type": "application/json",
      "mcp-protocol-version": init.protocolVersionHeader ?? "2026-07-28",
      "mcp-method": init.mcpMethodHeader ?? method,
      ...(init.mcpName ? { "mcp-name": init.mcpName } : {}),
      ...init.headers,
    }),
    body: JSON.stringify(body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

/** legacy POST：无信封、无协议头（2025-06-18 / 2025-06-25 形态）。 */
export function legacyRequest(
  body: Record<string, unknown>,
  init: McpRequestInit = {},
): Request {
  return new Request(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: baseHeaders(init.token, {
      "content-type": "application/json",
      ...init.headers,
    }),
    body: JSON.stringify(body),
  });
}

/** 只带头、不带体（GET / DELETE / Origin 探测）。 */
export function bareRequest(method: string, init: McpRequestInit = {}): Request {
  return new Request(`${MCP_BASE_URL}/mcp`, {
    method,
    headers: baseHeaders(init.token, init.headers ?? {}),
  });
}

/** 解析 JSON 响应体。 */
export async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 取 JSON-RPC 响应里的 `error`（没有则 null）。 */
export function rpcError(
  body: Record<string, unknown>,
): { code: number; message: string; data?: unknown } | null {
  const error = body.error as { code?: number; message?: string; data?: unknown } | undefined;
  if (!error || typeof error.code !== "number") return null;
  return { code: error.code, message: error.message ?? "", data: error.data };
}

/** 从 SSE 帧里取出第一条 JSON-RPC 消息（legacy 响应形态）。 */
export function parseSse(text: string): Record<string, unknown> {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`no data frame in SSE response: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bearer 获取（完整真实 OAuth 流程）
// ---------------------------------------------------------------------------

export interface BearerFixture {
  accessToken: string;
  refreshToken: string;
  userId: string;
  clientId: string;
}

/**
 * 走完整流程拿一枚真实 MCP Access Token：
 * authorize → login → callback → consent（按 `grantedScope` 收窄）→ code → token。
 */
export async function obtainMcpBearer(
  h: { app: AppHono; env: Env; db: DbHandle },
  options: {
    clientId?: string;
    /** 请求的 scope（空格分隔，默认全部 4 个）。 */
    scope?: string;
    /** 用户实际勾选（默认 = 请求值；可传子集模拟取消勾选）。 */
    grantedScope?: string[];
    /** 走哪个 Provider（不同 mock 身份 → 不同用户）。默认 google。 */
    provider?: "google" | "github";
  } = {},
): Promise<BearerFixture> {
  const fixture = await obtainAuthCode(h, {
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.grantedScope ? { grantedScope: options.grantedScope } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
  });
  const res = await exchangeCode(h, fixture);
  if (res.status !== 200) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  const tokens = await readTokenResponse(res);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    userId: fixture.userId,
    clientId: fixture.clientId,
  };
}
