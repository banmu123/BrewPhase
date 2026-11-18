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

/**
 * 设备 token 的形态：`bp_dev_` + base64url。
 *
 * 长度下限 16 是**形态校验**，不是安全门槛——真正的判据是 Cloud 侧
 * `sha256(token)` 命中 `mcp_devices.token_hash`。这条正则的作用是便宜地挡掉
 * 明显不是设备 token 的东西（用户 access token、`bp_mcp_*`、空串），
 * 让「拿错凭据域」在握手第一步就失败。
 */
export const REMOTE_DEVICE_TOKEN_PATTERN = /^bp_dev_[A-Za-z0-9_-]{16,}$/

/**
 * WSS 子协议（协议 §4.1）。
 *
 * 它不是装饰：握手时协商失败会让 Cloud 直接 400，从而在**进入帧层之前**
 * 就把「不是我们的客户端」挡掉。也正因为它出现在 HTTP 头上，
 * **绝不能把 token 塞进子协议**——反向代理会记 `Sec-WebSocket-Protocol`。
 */
export const REMOTE_WS_SUBPROTOCOL = 'brewphase.remote.v1'

/** `hello.capabilities` 的 v1 取值（协议 §4.2）。 */
export const REMOTE_HELLO_CAPABILITIES = ['tools.call', 'cancel', 'drain'] as const
export type RemoteHelloCapability = (typeof REMOTE_HELLO_CAPABILITIES)[number]

/**
 * 版本区间协商（协议 §1.1 的公式，唯一实现）。
 *
 * 返回共同支持的最高版本；无交集返回 `null`（调用方据此 close 4002）。
 * 之所以做成纯函数而不是内联在握手流程里：Mock 与真实 Cloud 必须用**同一条公式**，
 * 否则「本地测过了」不构成任何证据。
 */
export function negotiateProtocolVersion(
  clientMin: number,
  clientMax: number,
  serverMin: number = REMOTE_PROTOCOL_VERSION,
  serverMax: number = REMOTE_PROTOCOL_VERSION
): number | null {
  if (clientMin > clientMax) return null
  if (serverMin > serverMax) return null
  const lo = Math.max(clientMin, serverMin)
  const hi = Math.min(clientMax, serverMax)
  return lo > hi ? null : hi
}

/** 缓存上限（设计建议值，未压测；OQ-15）。 */
export const REMOTE_CACHE_MAX_ENTRIES = 256
export const REMOTE_CACHE_MAX_BYTES = 8 * 1024 * 1024
export const REMOTE_CACHE_TTL_MS = 60_000

/** 连接稳定多久后把退避 attempt 归零（协议 §10.1）。 */
export const REMOTE_BACKOFF_RESET_MS = 60_000

/**
 * 主动轮换的提前量：在 token 到期前 **7 天**开始尝试。
 *
 * 取值依据（不是拍的）：
 * - Cloud 的 `DEVICE_TOKEN_TTL_MS` 是 **30 天**。提前量必须是它的一个显著
 *   比例，否则「提前」没有意义；
 * - 7 天覆盖「用户一周没开电脑」这类空档。更短的提前量（例如 1 天）会让
 *   「关笔记本一周」直接越过窗口，只能重新配对；
 * - 也不能太大：提前 20 天意味着每次启动都可能在轮换，而轮换是一次
 *   带签名的写操作，没必要这么频繁。
 *
 * 与 `DEVICE_TOKEN_TTL_MS` 的**关系**（而非数值）由 Cloud 测试锁住：
 * `cloud/tests/mcp-devices/rotate.test.ts` 断言 TTL 存在且为 30 天。
 */
export const REMOTE_ROTATION_LEAD_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 轮换检查的最小间隔（在线期间的兜底定时器）。
 *
 * 提前量是 7 天，每小时查一次已经绰绰有余；这个间隔的作用不是「及时」，
 * 而是让「笔记本合盖 20 天后打开」这种情况在**下一次**检查时被发现，
 * 而不是等到某个连接事件。
 */
export const REMOTE_ROTATION_CHECK_INTERVAL_MS = 60 * 60 * 1000

// MARK: - 帧

/**
 * `serviceable=false` 的原因；只进日志与状态，不进协议语义。
 *
 * `blocked` 是 Phase 1.1B.1 新增：设备处于 `blocked`（被撤销 / 用户不匹配 /
 * 需要重新配对）时，本地确实不具备执行条件，必须如实上报。此前它被折成
 * `user_mismatch`，对「设备被撤销」这种情形是错的描述。
 * 新增枚举值属于兼容变更（协议 §1.1：接收方必须忽略未知值）。
 */
export const REMOTE_UNSERVICEABLE_REASONS = [
  'remote_disabled',
  'user_mismatch',
  'db_unavailable',
  'services_unavailable',
  'shutting_down',
  'blocked'
] as const
export type RemoteUnserviceableReason = (typeof REMOTE_UNSERVICEABLE_REASONS)[number]

/**
 * `hello`（Desktop → Cloud）。闭合键集：未知键一律 PROTOCOL_VIOLATION。
 *
 * ## 字段为什么是这 12 个（Phase 1.1B.1 定稿）
 *
 * 旧文档写的是 `min_version` / `max_version` / `app_version` / `platform` /
 * `capabilities`，旧代码写的是 `client_version` / `serviceable`——两边各缺一半，
 * 结果是**版本协商根本没法执行**（§4.3 第 8 步要读区间，而帧里没有区间），
 * 而 `serviceable` 又是 1.1B 明确要求的。这里取并集，并各自只留一个名字：
 *
 * | 字段 | 为什么必须在 |
 * |---|---|
 * | `device_id` + `nonce` + `ts` + `sig` | 设备持钥证明 + 防重放（§4.3 第 5–7 步） |
 * | `min_version` / `max_version` | §1.1 协商公式的输入；缺了只能硬编码 v=1 |
 * | `app_version` | 排障与灰度；**不参与**任何授权判断 |
 * | `platform` | 同 `app_version`，纯诊断 |
 * | `capabilities` | 声明客户端支持哪些帧型；Cloud 据此决定能不能发 `cancel` |
 * | `serviceable` | Desktop 独占的自我判定（§4.4.1），Cloud 只能当提示 |
 *
 * **`device_token` 不在其中**：它走 `Authorization` 头，重复传递只增加泄漏面。
 */
export const remoteHelloSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('hello'),
    ts: z.number().int(),
    device_id: z.string().min(1).max(128),
    nonce: z.string().min(16).max(128),
    min_version: z.number().int().positive(),
    max_version: z.number().int().positive(),
    app_version: z.string().min(1).max(64),
    platform: z.string().min(1).max(32),
    capabilities: z.array(z.string().min(1).max(64)).max(16),
    serviceable: z.boolean(),
    sig: z.string().min(1).max(512)
  })
  .strict()
  .refine((value) => value.min_version <= value.max_version, {
    message: 'min_version must not exceed max_version'
  })
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

// MARK: - 设备注册（HTTPS，协议 §3）

/**
 * `POST /mcp-devices/register` 的请求体（协议 §3.2）。
 *
 * `public_key` 是**裸 32 字节**的 base64url（43 字符），不是 SPKI DER——
 * DER 是 Desktop 本地格式，Cloud 只存裸公钥（与现有 `sync` 的设备表一致）。
 */
export const remoteDeviceRegisterRequestSchema = z
  .object({
    name: z.string().min(1).max(80),
    platform: z.string().min(1).max(32),
    public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'public_key must be base64url of 32 bytes'),
    app_version: z.string().min(1).max(64)
  })
  .strict()
export type RemoteDeviceRegisterRequest = z.infer<typeof remoteDeviceRegisterRequestSchema>

/** 注册响应：`claim_secret` **只在这里出现一次**，Desktop 只放内存。 */
export const remoteDeviceRegisterResponseSchema = z
  .object({
    device_id: z.string().min(1).max(128),
    confirm_code: z.string().regex(/^\d{6}$/),
    claim_secret: z.string().min(16).max(128),
    expires_in: z.number().int().positive()
  })
  .strict()
export type RemoteDeviceRegisterResponse = z.infer<typeof remoteDeviceRegisterResponseSchema>

/** `POST /mcp-devices/{id}/credentials` 的请求体：`claim_secret` **不入 URL**。 */
export const remoteDeviceClaimRequestSchema = z
  .object({ claim_secret: z.string().min(16).max(128) })
  .strict()

export const remoteDeviceCredentialsResponseSchema = z
  .object({
    device_token: z.string().regex(REMOTE_DEVICE_TOKEN_PATTERN),
    expires_at: z.number().int()
  })
  .strict()
export type RemoteDeviceCredentials = z.infer<typeof remoteDeviceCredentialsResponseSchema>

/** 注册失败原因（Client 侧归一化后的枚举；不是 Cloud 的错误码）。 */
export const REMOTE_REGISTRATION_FAILURES = [
  'unauthorized',
  'device_limit',
  'device_exists',
  'invalid_public_key',
  /** 用户还没在 Web 端确认（可继续轮询）。 */
  'pending',
  /** `claim_secret` 不匹配 / 已领取 / 设备不在 pending。 */
  'claim_rejected',
  /** 等待用户在 Web 端确认期间超时。 */
  'expired',
  'cancelled',
  'network',
  'invalid_response'
] as const
export type RemoteRegistrationFailure = (typeof REMOTE_REGISTRATION_FAILURES)[number]

/** `remote:register` 的返回：**只有** 待确认信息，没有 claim_secret。 */
export const remoteRegistrationTicketSchema = z.object({
  deviceId: z.string(),
  confirmCode: z.string().regex(/^\d{6}$/),
  expiresAt: z.number().int()
})
export type RemoteRegistrationTicket = z.infer<typeof remoteRegistrationTicketSchema>

// MARK: - 设备凭据轮换（HTTPS，协议 §3.5 / 生命周期 §11.6）

/**
 * 轮换请求体。
 *
 * `sig` 用**旧私钥**签，覆盖 `brewphase.remote.rotate.v1\n<device_id>\n<new_public_key>\n<ts>`。
 * 三个字段缺一不可：不签 `new_public_key`，只拿到旧 token 的人就能把设备
 * 换成自己的公钥；不签 `ts`，请求可以被无限重放。
 */
export const remoteDeviceRotateRequestSchema = z
  .object({
    new_public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'new_public_key must be base64url of 32 bytes'),
    ts: z.number().int(),
    sig: z.string().min(1).max(512)
  })
  .strict()
export type RemoteDeviceRotateRequest = z.infer<typeof remoteDeviceRotateRequestSchema>

/** 轮换响应：新 `device_token` **只在这一次**出现。 */
export const remoteDeviceRotateResponseSchema = z
  .object({
    device_token: z.string().regex(REMOTE_DEVICE_TOKEN_PATTERN),
    expires_at: z.number().int()
  })
  .strict()
export type RemoteDeviceRotateResponse = z.infer<typeof remoteDeviceRotateResponseSchema>

/**
 * 轮换失败原因（Client 侧归一化后的枚举；不是 Cloud 的错误码）。
 *
 * 分成四类是刻意的——它们的**处置完全不同**：
 *
 * | 原因 | 处置 |
 * |---|---|
 * | `network` | 结果未知（Cloud 可能已经换完）→ 只能 blocked，不能重试 |
 * | `unauthorized` | 旧凭据已失效 → 重新配对 |
 * | `device_state` | 设备被暂停/撤销 → 提示用户，不重连 |
 * | `invalid_response` | 对端不是我们期望的协议 → 记录并 blocked |
 */
export const REMOTE_ROTATION_FAILURES = [
  'network',
  'unauthorized',
  'device_state',
  'not_found',
  'invalid_public_key',
  'rate_limited',
  'account_changed',
  'invalid_response'
] as const
export type RemoteRotationFailure = (typeof REMOTE_ROTATION_FAILURES)[number]

/** 生效范围 = grant.scopes ∩ REMOTE_SCOPES ∩ 本地允许集。 */
export function toolsForScopes(scopes: readonly RemoteScope[]): RemoteToolName[] {
  const set = new Set<RemoteScope>(scopes)
  return REMOTE_TOOLS.filter((tool) => set.has(REMOTE_TOOL_SCOPES[tool]))
}

/** Local `McpScope` 与 `RemoteScope` 的交集（类型层保证只有 4 个只读项能进来）。 */
export function isRemoteScope(scope: McpScope): scope is RemoteScope {
  return (REMOTE_SCOPES as readonly string[]).includes(scope)
}
