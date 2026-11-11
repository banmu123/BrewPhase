import { isSupportedUrl, normalizePayload, type PagePayload } from '../shared/protocol'

/**
 * 页面信息采集。
 *
 * 原则：
 * - **只在用户点击扩展时执行一次**（activeTab 授权 + scripting.executeScript），
 *   没有 content script 常驻，也没有后台扫描；
 * - 注入的函数必须自包含（Chrome 会把它序列化到页面上下文执行），不能引用模块变量；
 * - 不在页面里读取 Cookie / localStorage / 表单值，只拿标题、地址、meta 与选区。
 */

export type RawPageMetadata = {
  title: string
  url: string
  description: string
  selectedText: string
  faviconUrl: string
}

/**
 * 在页面上下文里运行：**不要引用外部变量**。
 * 只读 DOM 的展示信息，不碰任何登录凭据。
 */
export function readPageMetadata(): RawPageMetadata {
  const selection = window.getSelection()?.toString() ?? ''
  const metaContent = (selector: string): string =>
    document.querySelector(selector)?.getAttribute('content') ?? ''
  const description =
    metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]')
  const iconHref = document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? ''

  let faviconUrl = ''
  try {
    faviconUrl = iconHref ? new URL(iconHref, location.href).toString() : ''
  } catch {
    faviconUrl = ''
  }

  return {
    title: document.title,
    url: location.href,
    description,
    selectedText: selection,
    faviconUrl
  }
}

export type CollectResult =
  | { ok: true; page: PagePayload }
  | { ok: false; reason: 'no-tab' | 'unsupported' | 'extract-failed'; url: string }

export async function collectActivePage(): Promise<CollectResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { ok: false, reason: 'no-tab', url: '' }

  const tabUrl = tab.url ?? ''
  if (!isSupportedUrl(tabUrl)) {
    return { ok: false, reason: 'unsupported', url: tabUrl }
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageMetadata
    })
    const raw = results[0]?.result
    if (!raw) return { ok: false, reason: 'extract-failed', url: tabUrl }

    return {
      ok: true,
      page: normalizePayload({
        title: raw.title || tab.title || '',
        url: raw.url || tabUrl,
        faviconUrl: raw.faviconUrl,
        description: raw.description,
        selectedText: raw.selectedText
      })
    }
  } catch {
    // chrome://、扩展页、PDF 查看器等注入受限：按「不支持采集」处理。
    return { ok: false, reason: 'extract-failed', url: tabUrl }
  }
}
