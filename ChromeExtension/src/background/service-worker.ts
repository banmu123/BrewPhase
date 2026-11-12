import { collectPageFromTab } from '../lib/page-metadata'
import { openCaptureEditor } from '../lib/capture-draft'
import { pingDesktop, savePage } from '../lib/native-messaging'
import {
  HOST_NAME,
  MAX_SELECTED_TEXT,
  PROTOCOL_VERSION,
  appNotRunning,
  clampText,
  internalError,
  newRequestId,
  parseResponse,
  type CaptureDraft,
  type ChromeCompanionRequest,
  type ChromeCompanionResponse,
  type PagePayload,
  type PopupMessage
} from '../shared/protocol'

/**
 * MV3 Service Worker：Popup / 右键菜单与本机 Native Host 之间唯一的桥。
 *
 * - 菜单只在 `onInstalled` / `onStartup` / Worker 启动时重建，ID 固定，
 *   重复注册是幂等的；
 * - 点击菜单后**才**注入脚本读当前页，没有常驻 content script；
 * - 结果用页面内 toast 反馈，不依赖额外通知权限。
 */

const MENU_ROOT = 'brewphase'
const MENU_PAGE = 'brewphase-save-page'
const MENU_SELECTION = 'brewphase-save-selection'
const MENU_IMAGE = 'brewphase-save-image'

function ensureContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ROOT,
      title: 'BrewPhase',
      contexts: ['page', 'selection', 'image']
    })
    chrome.contextMenus.create({
      id: MENU_PAGE,
      parentId: MENU_ROOT,
      title: '保存当前网页到 Records',
      contexts: ['page']
    })
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      parentId: MENU_ROOT,
      title: '保存选中的文字',
      contexts: ['selection']
    })
    chrome.contextMenus.create({
      id: MENU_IMAGE,
      parentId: MENU_ROOT,
      title: '保存图片到 BrewPhase',
      contexts: ['image']
    })
  })
}

ensureContextMenus()
chrome.runtime.onInstalled.addListener(ensureContextMenus)
chrome.runtime.onStartup.addListener(ensureContextMenus)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(String(info.menuItemId), info.selectionText, { srcUrl: info.srcUrl }, tab)
})

async function handleMenuClick(
  action: string,
  selectionText: string | undefined,
  info: { srcUrl?: string },
  tab: chrome.tabs.Tab | undefined
): Promise<void> {
  if (!tab?.id) return
  if (action === MENU_IMAGE) {
    await handleImageMenu(tab, info.srcUrl ?? '')
    return
  }
  if (action !== MENU_PAGE && action !== MENU_SELECTION) return

  const collected = await collectPageFromTab(tab.id)
  if (!collected.ok) {
    await showToast(
      tab.id,
      collected.reason === 'unsupported' ? '当前网页暂不支持保存' : '未能读取当前网页',
      'error'
    )
    return
  }

  const page = { ...collected.page }
  if (action === MENU_SELECTION) {
    page.selectedText = clampText((selectionText ?? page.selectedText).trim(), MAX_SELECTED_TEXT)
  }

  const response = await savePage(page)
  await showToast(
    tab.id,
    response.success ? '已保存到 BrewPhase Records' : menuErrorText(response.code),
    response.success ? 'ok' : 'error'
  )
}

/**
 * 右键图片：定位元素 → 截取可见区域 → 裁剪 → 打开编辑页让用户确认。
 *
 * 不申请 <all_urls>、不直接抓 CDN 原图：可见区域截屏拿到的就是用户看到的
 * 像素，跨域、防盗链都不构成障碍。定位不到/不可见时如实报错，不静默降级。
 */
async function handleImageMenu(tab: chrome.tabs.Tab, srcUrl: string): Promise<void> {
  if (!tab.id) return
  if (!srcUrl || !/^https?:/i.test(srcUrl)) {
    await showToast(tab.id, '只能采集 http / https 图片', 'error')
    return
  }

  let located: LocateResult
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: locateImageInPage,
      args: [srcUrl]
    })
    located = (results[0]?.result as LocateResult | undefined) ?? { ok: false, reason: 'not-found' }
  } catch {
    await showToast(tab.id, '当前页面无法定位图片（受限页面）', 'error')
    return
  }

  if (!located.ok) {
    await showToast(
      tab.id,
      located.reason === 'not-visible'
        ? '图片不在可见区域，滚动到完整可见后重试'
        : '没有找到这张图片（可能是背景图或框架内元素）',
      'error'
    )
    return
  }

  const scale = located.dpr
  const rect = {
    x: Math.round(located.rect.x * scale),
    y: Math.round(located.rect.y * scale),
    width: Math.round(located.rect.width * scale),
    height: Math.round(located.rect.height * scale)
  }

  let shot: string
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 })
  } catch {
    await showToast(tab.id, '无法截取当前页面', 'error')
    return
  }

  let cropped: string
  try {
    cropped = await cropImageRegion(shot, rect)
  } catch {
    await showToast(tab.id, '图片裁剪失败，请重试', 'error')
    return
  }

  const collected = await collectPageFromTab(tab.id)
  const page: PagePayload = collected.ok
    ? collected.page
    : {
        title: tab.title ?? '',
        url: tab.url ?? '',
        domain: hostOf(tab.url ?? ''),
        faviconUrl: tab.favIconUrl ?? null,
        description: '',
        selectedText: ''
      }
  if (!/^https?:/i.test(page.url)) {
    await showToast(tab.id, '当前网页暂不支持保存', 'error')
    return
  }

  const draft: CaptureDraft = {
    kind: 'screenshot',
    dataUrl: cropped,
    page,
    selectedText: page.selectedText,
    note: '',
    createdAt: Date.now()
  }
  await openCaptureEditor(draft)
}

type LocateResult =
  | { ok: true; rect: { x: number; y: number; width: number; height: number }; dpr: number }
  | { ok: false; reason: 'not-found' | 'not-visible' }

/** 在页面里找与 srcUrl 一致且完整可见的 `<img>`；必须自包含（不引用模块变量）。 */
function locateImageInPage(srcUrl: string): LocateResult {
  const images = Array.from(document.images).filter(
    (img) => (img.currentSrc || img.src) === srcUrl && img.complete && img.naturalWidth > 0
  )
  for (const img of images) {
    const rect = img.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) continue
    const fullyVisible =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth
    if (!fullyVisible) continue
    return {
      ok: true,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      dpr: window.devicePixelRatio || 1
    }
  }
  return { ok: false, reason: images.length > 0 ? 'not-visible' : 'not-found' }
}

/** Service Worker 里没有 DOM canvas：用 OffscreenCanvas 裁剪。 */
async function cropImageRegion(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(rect.width, rect.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('offscreen canvas is not available')
  context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  const output = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('could not encode the crop'))
    reader.readAsDataURL(output)
  })
}

function hostOf(value: string): string {
  try {
    return new URL(value).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function menuErrorText(code: string): string {
  if (code === 'APP_NOT_RUNNING') return '请先启动 BrewPhase Desktop'
  if (code === 'UNSUPPORTED_URL') return '当前网页暂不支持保存'
  return '保存失败，请稍后重试'
}

/** 在页面里显示一条轻提示；注入函数必须自包含（不引用模块变量）。 */
function toastInPage(message: string, tone: string): void {
  const id = 'brewphase-toast'
  document.getElementById(id)?.remove()
  const element = document.createElement('div')
  element.id = id
  element.textContent = message
  element.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:50%',
    'bottom:28px',
    'transform:translateX(-50%)',
    'padding:10px 16px',
    'border-radius:10px',
    'font:500 13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif',
    'color:#fff',
    `background:${tone === 'error' ? '#a8503f' : '#30372f'}`,
    'box-shadow:0 8px 24px rgba(0,0,0,.18)',
    'pointer-events:none',
    'opacity:0',
    'transition:opacity .18s ease'
  ].join(';')
  document.documentElement.appendChild(element)
  requestAnimationFrame(() => {
    element.style.opacity = '1'
  })
  window.setTimeout(() => {
    element.style.opacity = '0'
    window.setTimeout(() => element.remove(), 220)
  }, 2600)
}

async function showToast(tabId: number, message: string, tone: 'ok' | 'error'): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: toastInPage,
      args: [message, tone]
    })
  } catch {
    // 注入受限（chrome:// 等）：静默，保存结果仍然已经返回。
  }
}

type NativeSession = {
  send: (request: ChromeCompanionRequest) => Promise<ChromeCompanionResponse>
  close: () => void
}

let imageSession: NativeSession | null = null

/**
 * 一次图片传输复用同一个 Native Messaging port。
 *
 * 如果每块都 `connectNative`，Chrome 会为每一块启动一个新的 Host 进程，
 * 几十块就要付几十次进程启动成本。这里保持一个 port，直到 COMMIT。
 */
function createSession(): NativeSession {
  const port = chrome.runtime.connectNative(HOST_NAME)
  let pending: ((response: ChromeCompanionResponse) => void) | null = null

  const settle = (response: ChromeCompanionResponse): void => {
    const resolve = pending
    pending = null
    resolve?.(response)
  }

  port.onMessage.addListener((message: unknown) => {
    const response = parseResponse(message, '')
    if (response) settle(response)
  })
  port.onDisconnect.addListener(() => {
    // 必须读取 lastError，否则 Chrome 控制台会报 unchecked runtime.lastError。
    void chrome.runtime.lastError
    settle(appNotRunning(''))
    imageSession = null
  })

  return {
    send(request) {
      return new Promise((resolve) => {
        pending = resolve
        try {
          port.postMessage(request)
        } catch {
          settle(appNotRunning(request.requestId))
          return
        }
        setTimeout(() => {
          if (pending === resolve) settle(internalError(request.requestId, 'native host timed out'))
        }, 12_000)
      })
    },
    close() {
      try {
        port.disconnect()
      } catch {
        // 已经断开：忽略。
      }
    }
  }
}

function isPopupMessage(value: unknown): value is PopupMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.source !== 'brewphase-popup') return false
  return (
    record.type === 'PING' ||
    record.type === 'SAVE_PAGE' ||
    record.type === 'IMAGE_BEGIN' ||
    record.type === 'IMAGE_CHUNK' ||
    record.type === 'IMAGE_COMMIT'
  )
}

async function handlePopupMessage(message: PopupMessage): Promise<ChromeCompanionResponse> {
  if (message.type === 'PING') return pingDesktop()
  if (message.type === 'SAVE_PAGE') return savePage(message.payload)

  if (message.type === 'IMAGE_BEGIN') {
    imageSession?.close()
    imageSession = createSession()
    return imageSession.send({
      version: PROTOCOL_VERSION,
      requestId: newRequestId(),
      type: 'IMAGE_BEGIN',
      payload: message.payload
    })
  }

  if (!imageSession) {
    return internalError(newRequestId(), 'no image transfer in progress')
  }

  if (message.type === 'IMAGE_CHUNK') {
    return imageSession.send({
      version: PROTOCOL_VERSION,
      requestId: newRequestId(),
      type: 'IMAGE_CHUNK',
      payload: message.payload
    })
  }

  const response = await imageSession.send({
    version: PROTOCOL_VERSION,
    requestId: newRequestId(),
    type: 'IMAGE_COMMIT',
    payload: message.payload
  })
  imageSession.close()
  imageSession = null
  return response
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isPopupMessage(message)) return false

  void handlePopupMessage(message)
    .then((response) => sendResponse(response))
    .catch(() => sendResponse(internalError(newRequestId(), 'unexpected error')))

  // 异步 sendResponse：必须返回 true 保持消息通道。
  return true
})
