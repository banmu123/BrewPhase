/**
 * Chrome Companion 的共享协议（扩展侧）。
 *
 * **权威定义在 Desktop `src/shared/contracts/chrome-bridge.ts`**：
 * 字段、上限、错误码必须与之逐字一致（Desktop 侧有一条测试读取本文件做比对）。
 * 扩展不引入 Zod：请求由 Desktop 做运行时校验，这里只做「发送前的收敛」。
 */

export const PROTOCOL_VERSION = 1
export const HOST_NAME = 'com.brewphase.chrome'

export const MAX_TITLE = 500
export const MAX_URL = 2_000
export const MAX_DOMAIN = 255
export const MAX_DESCRIPTION = 4_000
export const MAX_SELECTED_TEXT = 20_000
/** Popup 里只预览这么多字，完整内容仍然发送（上限以内）。 */
export const PREVIEW_SELECTED_TEXT = 280

export const ERROR_CODES = [
  'OK',
  'APP_NOT_RUNNING',
  'INVALID_REQUEST',
  'UNSUPPORTED_URL',
  'SAVE_FAILED',
  'INTERNAL_ERROR'
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export type PagePayload = {
  title: string
  url: string
  domain: string
  faviconUrl: string | null
  description: string
  selectedText: string
}

// MARK: - 图片分块传输

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 每块原始二进制上限；base64 后约 128KB，低于 Desktop 的 256KB 行上限。 */
export const IMAGE_CHUNK_BYTES = 96 * 1024
export const IMAGE_MAX_CHUNKS = 200

export type ImageMetadata = {
  title: string
  sourceUrl: string
  selectedText: string
  note: string
}

export type ImageBeginPayload = {
  transferId: string
  mimeType: 'image/jpeg' | 'image/png'
  byteSize: number
  width: number
  height: number
  sha256: string
  chunkCount: number
  metadata: ImageMetadata
}

export type ImageChunkPayload = {
  transferId: string
  index: number
  data: string
}

export type ImageCommitPayload = {
  transferId: string
}

export type ChromeCompanionRequest =
  | { version: typeof PROTOCOL_VERSION; requestId: string; type: 'PING' }
  | {
      version: typeof PROTOCOL_VERSION
      requestId: string
      type: 'SAVE_PAGE'
      payload: PagePayload
    }
  | {
      version: typeof PROTOCOL_VERSION
      requestId: string
      type: 'IMAGE_BEGIN'
      payload: ImageBeginPayload
    }
  | {
      version: typeof PROTOCOL_VERSION
      requestId: string
      type: 'IMAGE_CHUNK'
      payload: ImageChunkPayload
    }
  | {
      version: typeof PROTOCOL_VERSION
      requestId: string
      type: 'IMAGE_COMMIT'
      payload: ImageCommitPayload
    }

/** Popup / Capture Page → Service Worker 的消息。 */
export type PopupMessage =
  | { source: 'brewphase-popup'; type: 'PING' }
  | { source: 'brewphase-popup'; type: 'SAVE_PAGE'; payload: PagePayload }
  | { source: 'brewphase-popup'; type: 'IMAGE_BEGIN'; payload: ImageBeginPayload }
  | { source: 'brewphase-popup'; type: 'IMAGE_CHUNK'; payload: ImageChunkPayload }
  | { source: 'brewphase-popup'; type: 'IMAGE_COMMIT'; payload: ImageCommitPayload }

/** Capture Page 的临时草稿（只存 session storage，不上云）。 */
export type CaptureDraft = {
  kind: 'screenshot'
  dataUrl: string
  page: PagePayload
  selectedText: string
  note: string
  createdAt: number
}

export type ChromeCompanionResponse = {
  version: number
  requestId: string
  success: boolean
  code: ErrorCode
  message?: string
  data?: { recordId?: string; appVersion?: string }
}

export function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function hostOf(value: string): string {
  try {
    return new URL(value).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 截断而不是拒绝：用户选中的长文不该让整次保存失败。 */
export function clampText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

export function normalizePayload(input: {
  title: string
  url: string
  faviconUrl: string
  description: string
  selectedText: string
}): PagePayload {
  return {
    title: clampText(input.title.trim(), MAX_TITLE),
    url: clampText(input.url.trim(), MAX_URL),
    domain: clampText(hostOf(input.url), MAX_DOMAIN),
    faviconUrl: input.faviconUrl ? clampText(input.faviconUrl, MAX_URL) : null,
    description: clampText(input.description.trim(), MAX_DESCRIPTION),
    selectedText: clampText(input.selectedText.trim(), MAX_SELECTED_TEXT)
  }
}

export function newRequestId(): string {
  // crypto.randomUUID 在 service worker / popup 都可用。
  return crypto.randomUUID()
}

export function appNotRunning(requestId: string, detail?: string): ChromeCompanionResponse {
  return {
    version: PROTOCOL_VERSION,
    requestId,
    success: false,
    code: 'APP_NOT_RUNNING',
    message: detail ?? 'BrewPhase Desktop is not running'
  }
}

export function internalError(requestId: string, message: string): ChromeCompanionResponse {
  return {
    version: PROTOCOL_VERSION,
    requestId,
    success: false,
    code: 'INTERNAL_ERROR',
    message
  }
}

/** 只接受形状正确的响应；坏响应一律当作内部错误，不把未知字段透给 UI。 */
export function parseResponse(input: unknown, requestId: string): ChromeCompanionResponse | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const code = record.code
  if (typeof code !== 'string' || !ERROR_CODES.includes(code as ErrorCode)) return null
  const data = record.data
  return {
    version: typeof record.version === 'number' ? record.version : PROTOCOL_VERSION,
    requestId: typeof record.requestId === 'string' && record.requestId ? record.requestId : requestId,
    success: record.success === true,
    code: code as ErrorCode,
    message: typeof record.message === 'string' ? record.message : undefined,
    data:
      typeof data === 'object' && data !== null
        ? {
            recordId:
              typeof (data as Record<string, unknown>).recordId === 'string'
                ? ((data as Record<string, unknown>).recordId as string)
                : undefined,
            appVersion:
              typeof (data as Record<string, unknown>).appVersion === 'string'
                ? ((data as Record<string, unknown>).appVersion as string)
                : undefined
          }
        : undefined
  }
}
