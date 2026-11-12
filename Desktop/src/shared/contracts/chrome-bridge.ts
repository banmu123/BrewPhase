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
export const CHROME_HOST_VERSION = '0.2.0'

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

// MARK: - 图片分块传输

/** 一次传输的总字节上限（截图/右键图片压缩后远小于这个值）。 */
export const CHROME_IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 单个分块的原始二进制上限；base64 后约 128KB，低于本地 IPC 256KB。 */
export const CHROME_IMAGE_MAX_CHUNK_BYTES = 96 * 1024
export const CHROME_IMAGE_MAX_CHUNKS = 200
export const CHROME_IMAGE_MAX_DIMENSION = 10_000
export const CHROME_IMAGE_MAX_NOTE = 20_000

export const chromeImageMetadataSchema = z.object({
  title: z.string().max(CHROME_MAX_TITLE).default(''),
  sourceUrl: z
    .string()
    .trim()
    .max(CHROME_MAX_URL)
    .refine(isSupportedPageURL, { message: 'only http(s) source URLs are supported' }),
  /** 网页里选中的原文。 */
  selectedText: z.string().max(CHROME_MAX_SELECTED_TEXT).default(''),
  /** 用户自己写的备注。 */
  note: z.string().max(CHROME_IMAGE_MAX_NOTE).default('')
})
export type ChromeImageMetadata = z.infer<typeof chromeImageMetadataSchema>

export const chromeImageBeginSchema = z.object({
  transferId: z.string().uuid(),
  mimeType: z.enum(['image/jpeg', 'image/png']),
  byteSize: z.number().int().min(1).max(CHROME_IMAGE_MAX_BYTES),
  width: z.number().int().min(1).max(CHROME_IMAGE_MAX_DIMENSION),
  height: z.number().int().min(1).max(CHROME_IMAGE_MAX_DIMENSION),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chunkCount: z.number().int().min(1).max(CHROME_IMAGE_MAX_CHUNKS),
  metadata: chromeImageMetadataSchema
})
export type ChromeImageBegin = z.infer<typeof chromeImageBeginSchema>

export const chromeImageChunkSchema = z.object({
  transferId: z.string().uuid(),
  index: z.number().int().min(0).max(CHROME_IMAGE_MAX_CHUNKS - 1),
  /** base64；服务端解码后再校验原始字节上限。 */
  data: z.string().min(1).max(Math.ceil((CHROME_IMAGE_MAX_CHUNK_BYTES * 4) / 3) + 16)
})
export type ChromeImageChunk = z.infer<typeof chromeImageChunkSchema>

export const chromeImageCommitSchema = z.object({
  transferId: z.string().uuid()
})
export type ChromeImageCommit = z.infer<typeof chromeImageCommitSchema>

const requestBase = {
  version: z.literal(CHROME_BRIDGE_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(CHROME_MAX_REQUEST_ID)
}

export const chromeCompanionRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...requestBase, type: z.literal('PING') }),
  z.object({ ...requestBase, type: z.literal('SAVE_PAGE'), payload: chromePagePayloadSchema }),
  z.object({ ...requestBase, type: z.literal('IMAGE_BEGIN'), payload: chromeImageBeginSchema }),
  z.object({ ...requestBase, type: z.literal('IMAGE_CHUNK'), payload: chromeImageChunkSchema }),
  z.object({ ...requestBase, type: z.literal('IMAGE_COMMIT'), payload: chromeImageCommitSchema })
])
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
  /** 兼容字段：= installationValid。 */
  hostInstalled: z.boolean(),
  /** 逐项状态：文件、配置、manifest、注册表。 */
  binaryExists: z.boolean(),
  configExists: z.boolean(),
  manifestExists: z.boolean(),
  manifestValid: z.boolean(),
  /** null = 无法确定（注册表查询被系统策略拦截 / 输出无法解析），不当作未安装。 */
  registered: z.boolean().nullable(),
  installationValid: z.boolean(),
  /** connected 优先于 installed：本次运行真的收到过握手。 */
  connectionState: z.enum(['connected', 'installed', 'not-installed', 'invalid', 'unknown']),
  lastHandshakeAt: z.number().int().nullable(),
  lastRequestAt: z.number().int().nullable(),
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

/** 本地 IPC 自检：hello + PING 走一遍，不涉及 Chrome 扩展本身。 */
export const chromeSelfTestResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().max(60),
  message: z.string().max(300).optional(),
  appVersion: z.string().max(60).optional()
})
export type ChromeSelfTestResult = z.infer<typeof chromeSelfTestResultSchema>
