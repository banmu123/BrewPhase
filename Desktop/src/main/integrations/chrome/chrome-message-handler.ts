import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  type ChromeCompanionRequest,
  type ChromeCompanionResponse
} from '../../../shared/contracts/chrome-bridge'
import { isApplicationError } from '../../application/errors'
import type { RecordService } from '../../application/records/record-service'

/**
 * 一次 Chrome 保存请求的业务处理。
 *
 * 职责边界：
 * - 结构校验已经在 `ChromeBridgeServer` 用 Zod 做完，这里只处理「已合法的请求」；
 * - 落库只走 `RecordService.createFromChrome`，不碰 SQLite；
 * - `requestId` 在 5 分钟内幂等：Popup 重复点击 / Native Host 重发都只产生一条记录；
 * - 日志只记录错误类型与 requestId，**不打印 URL、标题或选中文字**。
 */

const DEDUPE_TTL_MS = 5 * 60_000
const DEDUPE_LIMIT = 200

export class ChromeMessageHandler {
  private readonly recent = new Map<string, { at: number; response: ChromeCompanionResponse }>()

  constructor(
    private readonly records: RecordService,
    private readonly appVersion: string
  ) {}

  handle(request: ChromeCompanionRequest): ChromeCompanionResponse {
    const cached = this.recent.get(request.requestId)
    if (cached && Date.now() - cached.at < DEDUPE_TTL_MS) {
      return cached.response
    }

    const response: ChromeCompanionResponse =
      request.type === 'PING'
        ? {
            version: CHROME_BRIDGE_PROTOCOL_VERSION,
            requestId: request.requestId,
            success: true,
            code: 'OK',
            data: { appVersion: this.appVersion }
          }
        : this.save(request)

    this.remember(request.requestId, response)
    return response
  }

  private save(request: ChromeCompanionRequest): ChromeCompanionResponse {
    if (!request.payload) {
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        success: false,
        code: 'INVALID_REQUEST',
        message: 'missing page payload'
      }
    }

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
      console.error('[chrome] save failed', request.requestId, error instanceof Error ? error.name : 'unknown')
      return {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        success: false,
        code: 'SAVE_FAILED',
        message: 'failed to save page'
      }
    }
  }

  private remember(requestId: string, response: ChromeCompanionResponse): void {
    this.recent.set(requestId, { at: Date.now(), response })
    if (this.recent.size <= DEDUPE_LIMIT) return
    const oldest = this.recent.keys().next()
    if (!oldest.done) this.recent.delete(oldest.value)
  }
}
