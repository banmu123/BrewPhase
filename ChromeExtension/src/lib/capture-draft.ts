import type { CaptureDraft } from '../shared/protocol'

/**
 * 截图/裁剪草稿的落盘与入口打开。
 *
 * 草稿只进 `chrome.storage.session`：随浏览器会话消失、不上云、不进历史；
 * 打开的 capture.html 是扩展自己的页面（不需要 web_accessible_resources）。
 */
export async function openCaptureEditor(draft: CaptureDraft): Promise<void> {
  await chrome.storage.session.set({ captureDraft: draft })
  await chrome.tabs.create({ url: chrome.runtime.getURL('capture.html'), active: true })
}
