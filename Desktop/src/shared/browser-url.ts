/**
 * 地址栏输入 → 真正要导航的 URL（纯函数，可单测）。
 *
 * 规则刻意保持保守：**只有 http / https 会被放行**。`javascript:`、`file:`、
 * `data:`、`about:`、`chrome:` 一律返回 invalid——地址栏是用户输入，网页容器
 * 不该有机会执行本地文件或脚本。判断顺序是先看 scheme，再猜域名，最后才
 * 当搜索词，避免把 `file:///etc/passwd` 这种当成「普通关键词」送去搜索。
 */

export type SearchEngine = {
  id: string
  /** 搜索 URL 模板，`%s` 会被 encodeURIComponent 后的关键词替换。 */
  template: string
}

/**
 * 引擎列表可扩展：默认 Google，但**不是唯一选项**（设置项与未来的 UI 都能换）。
 * 没有 UI 之前，主进程可以通过本地状态覆盖默认值。
 */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'google', template: 'https://www.google.com/search?q=%s' },
  { id: 'duckduckgo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'bing', template: 'https://www.bing.com/search?q=%s' }
]

export const DEFAULT_SEARCH_ENGINE: SearchEngine = SEARCH_ENGINES[0]!

export type BrowserInputResult =
  | { kind: 'url'; url: string }
  /** 输入看起来是搜索词：调用方仍然拿 URL，因为最终都是导航。 */
  | { kind: 'search'; url: string; query: string }
  | { kind: 'invalid'; reason: 'empty' | 'blocked-scheme' | 'malformed' }

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
/** 单个标签：字母数字开头，允许连字符，不以连字符结尾。 */
const LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/
/** 允许的 TLD 形态：纯字母（含国际化拼音域名的 ASCII 形式），至少两位。 */
const TLD = /^(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9-]+)$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** 这个 URL 能不能交给网页容器：只认 http / https，且必须能被解析。 */
export function isAllowedBrowserURL(raw: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

/** 统一成「可导航」的形态：解析成功 + 协议白名单。失败返回 null。 */
export function normalizeBrowserURL(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
    return url.toString()
  } catch {
    return null
  }
}

function isIPv4(host: string): boolean {
  const match = IPV4.exec(host)
  if (!match) return false
  return match.slice(1).every((part) => {
    const value = Number(part)
    return value >= 0 && value <= 255 && String(value) === part.replace(/^0+(?=\d)/, '')
  })
}

/**
 * 是否像一个「主机名 + 可选路径」的输入。
 *
 * 判定看第一段：`localhost`、IPv4、或至少两段合法标签且 TLD 像样。
 * `foo.bar` 会通过（用户可能就是想访问内网域名），但 `hello world`、
 * `咖啡豆` 这类含空格/非 ASCII 的输入不会，它们走搜索。
 */
export function looksLikeHost(input: string): boolean {
  if (/\s/.test(input)) return false
  // 去掉查询串与锚点后再看主机部分。
  const authority = input.split(/[/?#]/, 1)[0] ?? ''
  if (!authority) return false
  const hostAndPort = authority.split(':')
  if (hostAndPort.length > 2) return false
  const host = hostAndPort[0] ?? ''
  const port = hostAndPort[1]
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return false
  if (!host) return false
  if (host.toLowerCase() === 'localhost') return true
  if (isIPv4(host)) return true
  const labels = host.split('.')
  if (labels.length < 2) return false
  if (labels.some((label) => !LABEL.test(label))) return false
  return TLD.test(labels[labels.length - 1]!)
}

/** 主机是 localhost / IP 时用 http：这类地址通常没有证书，https 会直接失败。 */
function prefersPlainHTTP(host: string): boolean {
  const name = host.split(':')[0]!.toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || isIPv4(name)
}

export function searchURL(query: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): string {
  return engine.template.replace('%s', encodeURIComponent(query))
}

/**
 * 地址栏输入的**唯一**入口。
 *
 * - `https://a.com`、`http://a.com` → 原样（规范化）
 * - `example.com`、`localhost:3000`、`192.168.1.4` → 补协议
 * - `javascript:alert(1)`、`file:///etc/passwd` → invalid（绝不搜索、绝不导航）
 * - 其它（含空格、中文、纯词）→ 搜索引擎
 *
 * 顺序上有一个坑必须在这里解决：`localhost:3000` 与 `scheme:` **同形**。
 * 先判协议会把本地开发地址当成被拦的协议；所以非 http/https 时先看它是否
 * 像一个「主机:端口」，只有连这个都不像才判 blocked-scheme。反过来
 * `javascript:alert(1)` 的「端口」是 `alert(1)`，不像 host:port，仍然被拦。
 */
export function resolveBrowserInput(
  raw: string,
  engine: SearchEngine = DEFAULT_SEARCH_ENGINE
): BrowserInputResult {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'invalid', reason: 'empty' }

  const schemeMatch = SCHEME.exec(trimmed)
  if (schemeMatch) {
    const scheme = `${schemeMatch[1]!.toLowerCase()}:`
    if (ALLOWED_PROTOCOLS.has(scheme)) {
      const normalized = normalizeBrowserURL(trimmed)
      return normalized
        ? { kind: 'url', url: normalized }
        : { kind: 'invalid', reason: 'malformed' }
    }
    // 不是 http/https：只有确实长得像「主机:端口/路径」才继续往下走。
    if (!looksLikeHost(trimmed)) return { kind: 'invalid', reason: 'blocked-scheme' }
  }

  if (looksLikeHost(trimmed)) {
    const scheme = prefersPlainHTTP(trimmed) ? 'http' : 'https'
    const normalized = normalizeBrowserURL(`${scheme}://${trimmed}`)
    return normalized ? { kind: 'url', url: normalized } : { kind: 'invalid', reason: 'malformed' }
  }

  return { kind: 'search', url: searchURL(trimmed, engine), query: trimmed }
}

/** 地址栏展示用：去掉末尾斜杠之外的噪音，但保留原始路径。 */
export function displayURL(raw: string): string {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const tail = `${url.pathname}${url.search}${url.hash}`
    return `${url.protocol}//${url.host}${tail === '/' ? '' : tail}`
  } catch {
    return raw
  }
}

/** 链接记录里的 URL 是否可以直接交给内置浏览器（Records 入口用）。 */
export function canOpenInBrowser(raw: string): boolean {
  return normalizeBrowserURL(raw) !== null
}
