import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  type ChromeCompanionRequest,
  type ChromeCompanionResponse
} from '../../../shared/contracts/chrome-bridge'
import { isApplicationError } from '../../application/errors'
import type { RecordService } from '../../application/records/record-service'
import { ChromeImageError, type ChromeImageReceiver } from './chrome-image-receiver'

/**
 * 一次 Chrome 请求的业务处理。
 *
 * 结构校验已经在 `ChromeBridgeServer` 用 Zod 做完；这里只处理已合法的请求：
 * - PING / SAVE_PAGE 走原有逻辑；
 * - IMAGE_BEGIN / CHUNK / COMMIT 交给 `ChromeImageReceiver`（临时文件 + 校验 + 落库）；
 * - `requestId` 在 5 分钟内幂等；
 * - 日志只记录错误类型与 requestId，不打印 URL、标题或选中文字。
 */

const DEDUPE_TTL_MS = 5 * 60_000
const DEDUPE_LIMIT = 200

export class ChromeMessageHandler {
  private readonly recent = new Map<string, { at: number; response: ChromeCompanionResponse }>()

  constructor(
    private readonly records: RecordService,
    private readonly appVersion: string,
    private readonly images: ChromeImageReceiver,
    /** 最近一次请求的时间；Settings 用来区分「已安装」与「正在使用」。 */
    private readonly onRequest?: () => void
  ) {}

  async handle(request: ChromeCompanionRequest): Promise<ChromeCompanionResponse> {
    this.onRequest?.()

    const cached = this.recent.get(request.requestId)
    if (cached && Date.now() - cached.at < DEDUPE_TTL_MS) {
      return cached.response
    }

    let response: ChromeCompanionResponse
    try {
      response = await this.route(request)
    } catch (error) {
      response = this.failure(request.requestId, error)
    }

    this.remember(request.requestId, response)
    return response
  }

  private async route(request: ChromeCompanionRequest): Promise<ChromeCompanionResponse> {
    switch (request.type) {
      case 'PING':
        return {
          version: CHROME_BRIDGE_PROTOCOL_VERSION,
          requestId: request.requestId,
          success: true,
          code: 'OK',
          data: { appVersion: this.appVersion }
        }
      case 'SAVE_PAGE':
        return this.save(request)
      case 'IMAGE_BEGIN':
        await this.images.begin(request.payload)
        return this.ok(request.requestId)
      case 'IMAGE_CHUNK':
        await this.images.chunk(request.payload)
        return this.ok(request.requestId)
      case 'IMAGE_COMMIT': {
        const { recordId } = await this.images.commit(request.payload)
        return {
          version: CHROME_BRIDGE_PROTOCOL_VERSION,
          requestId: request.requestId,
          success: true,
          code: 'OK',
          data: { recordId }
        }
      }
    }
  }

  private save(
    request: Extract<ChromeCompanionRequest, { type: 'SAVE_PAGE' }>
  ): ChromeCompanionResponse {
    try {
      const record = this.records.createFromChrome(request.payload)
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        success: true,
        code: 'OK',
        data: { recordId: record.id }
      }
    } catch (error) {
      if (isApplicationError(error) && error.code === 'VALIDATION_ERROR') {
        return {
          version: CHROME_BRIDGE_PROTOCOL_VERSION,
          requestId: request.requestId,
          success: false,
          code: 'UNSUPPORTED_URL',
          message: 'only http(s) pages can be saved'
        }
      }
      throw error
    }
  }

  private ok(requestId: string): ChromeCompanionResponse {
    return {
      version: CHROME_BRIDGE_PROTOCOL_VERSION,
      requestId,
      success: true,
      code: 'OK'
    }
  }

  private failure(requestId: string, error: unknown): ChromeCompanionResponse {
    if (error instanceof ChromeImageError) {
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId,
        success: false,
        code: error.code,
        message: error.message
      }
    }
    if (isApplicationError(error) && error.code === 'VALIDATION_ERROR') {
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId,
        success: false,
        code: 'UNSUPPORTED_URL',
        message: 'only http(s) pages can be saved'
      }
    }
    console.error('[chrome] request failed', requestId, error instanceof Error ? error.name : 'unknown')
    return {
      version: CHROME_BRIDGE_PROTOCOL_VERSION,
      requestId,
      success: false,
      code: 'SAVE_FAILED',
      message: 'failed to save'
    }
  }

  private remember(requestId: string, response: ChromeCompanionResponse): void {
    this.recent.set(requestId, { at: Date.now(), response })
    if (this.recent.size <= DEDUPE_LIMIT) return
    const oldest = this.recent.keys().next()
    if (!oldest.done) this.recent.delete(oldest.value)
  }
}
