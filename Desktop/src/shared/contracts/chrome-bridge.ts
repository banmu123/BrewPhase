import { z } from 'zod'

/**
 * Chrome Companion 的线协议（Desktop 侧为权威定义）。
 *
 * 两条链路各有一套约束：
 * - Chrome ↔ Native Host：Chrome 的 4 字节长度前缀 + UTF-8 JSON；
 * - Native Host ↔ Desktop：NDJSON（一行一条），首行握手带 token。
 *
 * 网页信息是**不可信外部输入**：这里对每个字段做长度上限与协议白名单，
 * 手写文案一律不参与渲染，只作为纯文本落进 Records。
 */

export const CHROME_BRIDGE_PROTOCOL_VERSION = 1
/** 本地 IPC 单行上限：一条 SAVE_PAGE 远小于这个值，超限直接拒绝。 */
export const CHROME_BRIDGE_MAX_LINE_BYTES = 256 * 1024
/** 单次请求完整字节上限（Native Host 侧同样按这个值截断）。 */
export const CHROME_BRIDGE_MAX_REQUEST_BYTES = 512 * 1024

export const CHROME_MAX_TITLE = 500
export const CHROME_MAX_URL = 2_000
export const CHROME_MAX_DOMAIN = 255
export const CHROME_MAX_DESCRIPTION = 4_000
export const CHROME_MAX_SELECTED_TEXT = 20_000
export const CHROME_MAX_REQUEST_ID = 100

export const CHROME_HOST_NAME = 'com.brewphase.chrome'
export const CHROME_HOST_VERSION = '0.1.0'

/** 与 ChromeExtension/src/shared/protocol.ts 保持一致（有测试守护）。 */
export const CHROME_COMPANION_ERROR_CODES = [
  'OK',
  'APP_NOT_RUNNING',
  'INVALID_REQUEST',
  'UNSUPPORTED_URL',
  'SAVE_FAILED',
  'INTERNAL_ERROR'
] as const
export const chromeCompanionErrorCodeSchema = z.enum(CHROME_COMPANION_ERROR_CODES)
export type ChromeCompanionErrorCode = z.infer<typeof chromeCompanionErrorCodeSchema>

/** 只接受 http/https；`javascript:` / `data:` / `file:` / `chrome://` 一律拒。 */
export function isSupportedPageURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const chromePagePayloadSchema = z.object({
  title: z.string().max(CHROME_MAX_TITLE).default(''),
  url: z
    .string()
    .trim()
    .min(1)
    .max(CHROME_MAX_URL)
    .refine(isSupportedPageURL, { message: 'only http(s) URLs are supported' }),
  /** 扩展自己算的域名只用于展示；Desktop 不信任它做任何判断。 */
  domain: z.string().max(CHROME_MAX_DOMAIN).default(''),
  faviconUrl: z.string().max(CHROME_MAX_URL).nullable().default(null),
  /** `<meta name="description">` / og:description 的纯文本。 */
  description: z.string().max(CHROME_MAX_DESCRIPTION).default(''),
  /** 用户选中的文字；没有选中就是空串。 */
  selectedText: z.string().max(CHROME_MAX_SELECTED_TEXT).default('')
})
export type ChromePagePayload = z.infer<typeof chromePagePayloadSchema>

export const chromeCompanionRequestSchema = z
  .object({
    version: z.literal(CHROME_BRIDGE_PROTOCOL_VERSION),
    requestId: z.string().min(1).max(CHROME_MAX_REQUEST_ID),
    type: z.enum(['PING', 'SAVE_PAGE']),
    payload: chromePagePayloadSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.type === 'SAVE_PAGE' && !value.payload) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'SAVE_PAGE requires payload' })
    }
  })
export type ChromeCompanionRequest = z.infer<typeof chromeCompanionRequestSchema>

export const chromeCompanionResponseSchema = z.object({
  version: z.literal(CHROME_BRIDGE_PROTOCOL_VERSION),
  requestId: z.string().max(CHROME_MAX_REQUEST_ID),
  success: z.boolean(),
  code: chromeCompanionErrorCodeSchema,
  message: z.string().max(300).optional(),
  data: z
    .object({
      recordId: z.string().uuid().optional(),
      appVersion: z.string().max(60).optional()
    })
    .optional()
})
export type ChromeCompanionResponse = z.infer<typeof chromeCompanionResponseSchema>

/** Native Host ↔ Desktop 的握手行；token 由 Desktop 每次启动随机生成。 */
export const chromeBridgeHelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().min(16).max(256),
  version: z.literal(CHROME_BRIDGE_PROTOCOL_VERSION)
})

export const chromeBridgeHelloAckSchema = z.object({
  type: z.literal('hello'),
  ok: z.boolean(),
  appVersion: z.string().max(60).optional(),
  message: z.string().max(300).optional()
})
export type ChromeBridgeHelloAck = z.infer<typeof chromeBridgeHelloAckSchema>

/**
 * `host-config.json`：交给 Native Host 的连接信息。
 *
 * 它放在 Native Host 自己的安装目录里（同目录读取），所以 Host 不需要知道
 * Desktop 的 userData 路径。token 每次 Desktop 启动轮换，旧文件立即失效。
 */
export const chromeHostConfigSchema = z.object({
  version: z.literal(CHROME_BRIDGE_PROTOCOL_VERSION),
  endpoint: z.string().min(1),
  token: z.string().min(16),
  appVersion: z.string().max(60),
  installedAt: z.number().int()
})
export type ChromeHostConfig = z.infer<typeof chromeHostConfigSchema>

// MARK: - Settings 状态与操作

export const chromeCompanionStatusSchema = z.object({
  /** Desktop 本地 IPC 是否在监听。 */
  bridgeRunning: z.boolean(),
  /** Windows 是 `\\.\pipe\...`，macOS/Linux 是 socket 绝对路径。 */
  endpoint: z.string().nullable(),
  /** Native Host 可执行文件和 manifest 是否已经就位。 */
  hostInstalled: z.boolean(),
  hostVersion: z.string().nullable(),
  hostPath: z.string().nullable(),
  manifestPath: z.string().nullable(),
  /** 扩展 ID；Host manifest 的 allowed_origins 用的就是它。 */
  extensionId: z.string().nullable(),
  /** 开发态可直接「加载已解压」的目录。 */
  extensionDir: z.string().nullable(),
  appVersion: z.string(),
  platformSupported: z.boolean(),
  lastError: z.string().nullable()
})
export type ChromeCompanionStatus = z.infer<typeof chromeCompanionStatusSchema>

export const chromeCompanionInstallResultSchema = z.object({
  ok: z.boolean(),
  status: chromeCompanionStatusSchema,
  message: z.string().max(300).nullable()
})
export type ChromeCompanionInstallResult = z.infer<typeof chromeCompanionInstallResultSchema>
