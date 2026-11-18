import { z } from 'zod'
import type { McpScope } from './mcp'

/**
 * Remote MCP 的共享契约：scope / 工具 / 错误码 / 帧 / 状态。
 *
 * 这一份同时被四处引用：主进程的 Remote Service、Mock Gateway（测试）、
 * preload 的类型、Renderer 的设置页。**常量只在这里定义一次**。
 *
 * 与 Local MCP 的关系：**凭据域分离、工具面更窄**。这里只有 4 个只读 scope
 * 与 8 个只读工具；`REMOTE_TOOLS` 是写死的常量，不是从 `TOOL_DEFINITIONS`
 * 过滤出来的——Cloud 给什么都不会扩张它（架构设计 §6.8）。
 */

// MARK: - 常量

/** 远程可授出的 scope：4 个，全部只读。 */
export const REMOTE_SCOPES = [
  'records:read',
  'tags:read',
  'coffee:read',
  'canvas:read'
] as const
export type RemoteScope = (typeof REMOTE_SCOPES)[number]

/**
 * 远程第一版工具面：8 个，全部只读。
 *
 * **写死**，不从 `TOOL_DEFINITIONS` 派生：派生会让「Local 新增工具」自动扩张
 * 远程面，等于 Cloud 可以间接扩大自己在设备上的权限。
 */
export const REMOTE_TOOLS = [
  'search_records',
  'get_record',
  'list_record_tags',
  'list_beans',
  'list_brews',
  'list_tastings',
  'list_canvases',
  'get_canvas'
] as const
export type RemoteToolName = (typeof REMOTE_TOOLS)[number]

/** 工具 → 所需远程 scope。与 `TOOL_DEFINITIONS[t].scope` 必须一致（测试断言）。 */
export const REMOTE_TOOL_SCOPES: Record<RemoteToolName, RemoteScope> = {
  search_records: 'records:read',
  get_record: 'records:read',
  list_record_tags: 'tags:read',
  list_beans: 'coffee:read',
  list_brews: 'coffee:read',
  list_tastings: 'coffee:read',
  list_canvases: 'canvas:read',
  get_canvas: 'canvas:read'
}

/** 协议错误码：19 个，唯一权威表见协议 §9.1。 */
export const REMOTE_ERROR_CODES = [
  'DEVICE_OFFLINE',
  'DEVICE_UNAUTHORIZED',
  'DEVICE_REVOKED',
  'DEVICE_SUSPENDED',
  'REMOTE_DISABLED',
  'DEVICE_BUSY',
  'USER_MISMATCH',
  'GRANT_CONTEXT_INVALID',
  'GRANT_REVOKED',
  'SCOPE_DENIED',
  'TOOL_NOT_ALLOWED',
  'INVALID_ARGUMENTS',
  'NOT_FOUND',
  'REQUEST_TIMEOUT',
  'REQUEST_CANCELLED',
  'REQUEST_TOO_LARGE',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'PROTOCOL_VIOLATION',
  'INTERNAL_ERROR'
] as const
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number]

/** 可重试的错误码（AI 侧据此决定要不要重试；只读工具重试是安全的）。 */
export const RETRYABLE_REMOTE_ERRORS: ReadonlySet<RemoteErrorCode> = new Set<RemoteErrorCode>([
  'DEVICE_OFFLINE',
  'DEVICE_BUSY',
  'REQUEST_TIMEOUT',
  'INTERNAL_ERROR'
])

/** WSS close code：14 个（协议 §9.2）。4xxx 一律不重连。 */
export const REMOTE_CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 4001,
  VERSION_UNSUPPORTED: 4002,
  DEVICE_REVOKED: 4003,
  DEVICE_SUSPENDED: 4005,
  SUPERSEDED: 4006,
  HEARTBEAT_TIMEOUT: 4008,
  SESSION_ENDED: 4009,
  REAUTH_REQUIRED: 4010,
  SERVER_BUSY: 4011
} as const

/** 这些 close code 出现时**不重连**（协议 §10.3）。 */
export const NO_RECONNECT_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  4001, 4002, 4003, 4004, 4005, 4006, 4009
])

/** 重连时要换凭证的 close code（只重连一次）。 */
export const REAUTH_CLOSE_CODE = 4010

export const REMOTE_PROTOCOL_VERSION = 1
export const REMOTE_MAX_FRAME_BYTES = 1024 * 1024
export const DEFAULT_CLOUD_ORIGIN = 'https://cloud.brewphase.app'

/** 缓存上限（设计建议值，未压测；OQ-15）。 */
export const REMOTE_CACHE_MAX_ENTRIES = 256
export const REMOTE_CACHE_MAX_BYTES = 8 * 1024 * 1024
export const REMOTE_CACHE_TTL_MS = 60_000

/** 连接稳定多久后把退避 attempt 归零（协议 §10.1）。 */
export const REMOTE_BACKOFF_RESET_MS = 60_000

// MARK: - 帧

/** `serviceable=false` 的原因；只进日志与状态，不进协议语义。 */
export const REMOTE_UNSERVICEABLE_REASONS = [
  'remote_disabled',
  'user_mismatch',
  'db_unavailable',
  'services_unavailable',
  'shutting_down'
] as const
export type RemoteUnserviceableReason = (typeof REMOTE_UNSERVICEABLE_REASONS)[number]

/** `hello`（Desktop → Cloud）。闭合键集：未知键一律 PROTOCOL_VIOLATION。 */
export const remoteHelloSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('hello'),
    ts: z.number().int(),
    device_id: z.string().min(1).max(128),
    nonce: z.string().min(16).max(128),
    sig: z.string().min(1).max(512),
    serviceable: z.boolean(),
    client_version: z.string().min(1).max(64)
  })
  .strict()
export type RemoteHello = z.infer<typeof remoteHelloSchema>

/** `status`（Desktop → Cloud）。提示帧，不是授权帧。 */
export const remoteStatusFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('status'),
    ts: z.number().int(),
    serviceable: z.boolean(),
    reason: z.enum(REMOTE_UNSERVICEABLE_REASONS).optional()
  })
  .strict()
export type RemoteStatusFrame = z.infer<typeof remoteStatusFrameSchema>

/** 单个 Grant 的上下文（`hello_ok.grants[]` 与 `grant_update.grant` 共用）。 */
export const remoteGrantSchema = z
  .object({
    grant_ctx: z.string().min(1).max(128),
    grant_id: z.string().min(1).max(128),
    client_id: z.string().min(1).max(128),
    client_name: z.string().min(1).max(128),
    scopes: z.array(z.enum(REMOTE_SCOPES)).max(REMOTE_SCOPES.length),
    bound_user_id: z.string().min(1).max(128),
    epoch: z.number().int().nonnegative()
  })
  .strict()
export type RemoteGrant = z.infer<typeof remoteGrantSchema>

/** `hello_ok`（Cloud → Desktop）。没有 `serviceable`——它是 Cloud 的帧。 */
export const remoteHelloOkSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('hello_ok'),
    ts: z.number().int(),
    connection_id: z.string().min(1).max(128),
    instance_id: z.string().min(1).max(64),
    server_time: z.number().int(),
    heartbeat_ms: z.number().int().positive(),
    idle_timeout_ms: z.number().int().positive(),
    max_inflight: z.number().int().positive(),
    max_frame_bytes: z.number().int().positive(),
    allowed_tools: z.array(z.string()).max(64),
    grant_epoch: z.number().int().nonnegative(),
    grants: z.array(remoteGrantSchema).max(64)
  })
  .strict()
export type RemoteHelloOk = z.infer<typeof remoteHelloOkSchema>

/** `grant_update`（Cloud → Desktop）。 */
export const remoteGrantUpdateSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('grant_update'),
    ts: z.number().int(),
    grant_epoch: z.number().int().nonnegative(),
    op: z.enum(['install', 'revoke']),
    grant: remoteGrantSchema.optional(),
    grant_ctx: z.string().min(1).max(128).optional(),
    reason: z.string().max(64).optional()
  })
  .strict()
  .refine((value) => (value.op === 'install' ? value.grant !== undefined : value.grant_ctx !== undefined), {
    message: 'install requires grant; revoke requires grant_ctx'
  })
export type RemoteGrantUpdate = z.infer<typeof remoteGrantUpdateSchema>

/** `req`（Cloud → Desktop）。闭合键集。 */
export const remoteReqSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('req'),
    id: z.string().min(1).max(128),
    ts: z.number().int(),
    tool: z.string().min(1).max(64),
    arguments: z.unknown(),
    request_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    deadline_ms: z.number().int(),
    grant_ctx: z.string().min(1).max(128),
    trace: z
      .object({
        mcp_request_id: z.string().max(128).optional(),
        received_at: z.number().int().optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type RemoteReq = z.infer<typeof remoteReqSchema>

/** `ping` / `cancel` / `drain` 的最小形状（只校验用得到的字段）。 */
export const remotePingSchema = z
  .object({ v: z.literal(1), type: z.literal('ping'), ts: z.number().int(), seq: z.number().int() })
  .strict()

export const remoteCancelSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('cancel'),
    ts: z.number().int(),
    id: z.string().min(1).max(128),
    reason: z.string().max(64).optional()
  })
  .strict()

export const remoteDrainSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('drain'),
    ts: z.number().int(),
    reason: z.string().max(64).optional(),
    grace_ms: z.number().int().nonnegative()
  })
  .strict()

// MARK: - 状态

/**
 * 连接状态机。
 *
 * `blocked` 是终态：需要用户重新配对或切换账户，**不自动重连**。
 */
export const REMOTE_LINK_STATES = [
  'idle',
  'connecting',
  'handshaking',
  'online',
  'draining',
  'backoff',
  'blocked'
] as const
export type RemoteLinkState = (typeof REMOTE_LINK_STATES)[number]

/** 设置页可见的远程状态。**不含任何凭据**。 */
export const remoteStatusSchema = z.object({
  /** 用户可见的总开关（持久化在 local_state）。 */
  enabled: z.boolean(),
  linkState: z.enum(REMOTE_LINK_STATES),
  deviceId: z.string().nullable(),
  /** 本机绑定的 Cloud 用户；用于展示「当前绑定用户」。 */
  boundUserId: z.string().nullable(),
  /** `boundUserId` 与当前登录用户不匹配：需要解绑或换账户。 */
  needsReauth: z.boolean(),
  /**
   * 处于 `blocked` 时的原因（「device revoked」「user mismatch」等）。
   * **必须暴露**：否则用户只看到「不可用」，不知道该重新配对还是换账户。
   */
  blockedReason: z.string().nullable(),
  serviceable: z.boolean(),
  unserviceableReason: z.enum(REMOTE_UNSERVICEABLE_REASONS).nullable(),
  cloudOrigin: z.string().nullable(),
  lastPongAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  reconnectAttempt: z.number().int().nonnegative(),
  /** 已安装的 Grant 摘要（**不含 token**）。 */
  grants: z.array(
    z.object({
      grantCtx: z.string(),
      clientId: z.string(),
      clientName: z.string(),
      scopes: z.array(z.enum(REMOTE_SCOPES)),
      epoch: z.number().int()
    })
  ),
  grantEpoch: z.number().int().nonnegative(),
  auditStatus: z.object({
    consecutiveFailures: z.number().int().nonnegative(),
    totalFailures: z.number().int().nonnegative(),
    lastFailureAt: z.number().int().nullable()
  })
})
export type RemoteStatus = z.infer<typeof remoteStatusSchema>

/** `remote:diagnose` 的返回：比 status 多连接细节，仍不含凭据。 */
export const remoteDiagnosisSchema = remoteStatusSchema.extend({
  socketOpen: z.boolean(),
  inflight: z.number().int().nonnegative(),
  cacheEntries: z.number().int().nonnegative(),
  cacheBytes: z.number().int().nonnegative(),
  lastCloseCode: z.number().int().nullable,
  lastCloseReason: z.string().nullable()
})
export type RemoteDiagnosis = z.infer<typeof remoteDiagnosisSchema>

/** IPC 通道名。**没有 `remote:call`**。 */
export const REMOTE_CHANNELS = {
  status: 'remote:status',
  enable: 'remote:enable',
  disable: 'remote:disable',
  register: 'remote:register',
  forget: 'remote:forget',
  unbind: 'remote:unbind',
  diagnose: 'remote:diagnose',
  changed: 'remote:changed'
} as const

/** 生效范围 = grant.scopes ∩ REMOTE_SCOPES ∩ 本地允许集。 */
export function toolsForScopes(scopes: readonly RemoteScope[]): RemoteToolName[] {
  const set = new Set<RemoteScope>(scopes)
  return REMOTE_TOOLS.filter((tool) => set.has(REMOTE_TOOL_SCOPES[tool]))
}

/** Local `McpScope` 与 `RemoteScope` 的交集（类型层保证只有 4 个只读项能进来）。 */
export function isRemoteScope(scope: McpScope): scope is RemoteScope {
  return (REMOTE_SCOPES as readonly string[]).includes(scope)
}
