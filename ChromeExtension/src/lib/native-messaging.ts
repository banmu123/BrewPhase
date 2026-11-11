import {
  HOST_NAME,
  PROTOCOL_VERSION,
  appNotRunning,
  internalError,
  newRequestId,
  parseResponse,
  type ChromeCompanionRequest,
  type ChromeCompanionResponse,
  type PagePayload
} from '../shared/protocol'

/**
 * 与 Native Host 的一次性连接。
 *
 * 每次请求新建 `connectNative`，拿到响应立即断开：
 * - Popup 关闭后不会留下长期连接；
 * - Host 进程随连接结束退出，不常驻；
 * - Desktop 重启后下一次请求会重新拉起 Host 并重新握手。
 *
 * 超时只是兜底：正常失败会由 Host 返回 `APP_NOT_RUNNING` 或直接断开。
 */

const TIMEOUT_MS = 10_000

export function pingDesktop(): Promise<ChromeCompanionResponse> {
  return send({ version: PROTOCOL_VERSION, requestId: newRequestId(), type: 'PING' })
}

export function savePage(payload: PagePayload): Promise<ChromeCompanionResponse> {
  return send({
    version: PROTOCOL_VERSION,
    requestId: newRequestId(),
    type: 'SAVE_PAGE',
    payload
  })
}

function send(request: ChromeCompanionRequest): Promise<ChromeCompanionResponse> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port | null = null
    let settled = false

    const finish = (response: ChromeCompanionResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        port?.disconnect()
      } catch {
        // 已经断开：忽略。
      }
      resolve(response)
    }

    const timer = setTimeout(
      () => finish(internalError(request.requestId, 'native host did not respond in time')),
      TIMEOUT_MS
    )

    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch {
      finish(appNotRunning(request.requestId))
      return
    }

    port.onMessage.addListener((message: unknown) => {
      const response = parseResponse(message, request.requestId)
      if (response) finish(response)
    })

    port.onDisconnect.addListener(() => {
      // 必须读取 lastError，否则 Chrome 控制台会报 unchecked runtime.lastError。
      const error = chrome.runtime.lastError
      finish(appNotRunning(request.requestId, error?.message))
    })

    try {
      port.postMessage(request)
    } catch {
      finish(appNotRunning(request.requestId))
    }
  })
}
