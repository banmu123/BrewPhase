import { internalError, newRequestId, type PagePayload } from '../shared/protocol'
import { pingDesktop, savePage } from '../lib/native-messaging'

/**
 * MV3 Service Worker：Popup 与本机 Native Host 之间唯一的桥。
 *
 * 它**不做页面采集**（采集在 popup 里的 activeTab 临时权限下完成），也不缓存
 * 任何网页内容：收到一条请求 → 转给 Host → 原样返回结果 → 结束。
 */

type PopupMessage =
  | { source: 'brewphase-popup'; type: 'PING' }
  | { source: 'brewphase-popup'; type: 'SAVE_PAGE'; payload: PagePayload }

function isPopupMessage(value: unknown): value is PopupMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.source !== 'brewphase-popup') return false
  return record.type === 'PING' || record.type === 'SAVE_PAGE'
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isPopupMessage(message)) return false

  const pending =
    message.type === 'PING'
      ? pingDesktop()
      : savePage(message.payload)

  void pending
    .then((response) => sendResponse(response))
    .catch(() => sendResponse(internalError(newRequestId(), 'unexpected error')))

  // 异步 sendResponse：必须返回 true 保持消息通道。
  return true
})
