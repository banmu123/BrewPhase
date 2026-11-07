import type { LinkProvider, RecordItem } from '@shared/contracts'

/**
 * 平台识别与品牌配置（§平台差异化）。
 *
 * 识别依据的优先级：
 * 1. `item.provider` —— iOS 创建记录时用 LinkResolver 解析好并同步过来，
 *    是**权威来源**（空串/'generic' 表示按地址现认）；
 * 2. `canonicalURL` / `urlString` 的 hostname **精确匹配**——只认裸域与
 *    子域（`github.com` / `www.github.com` / `foo.github.com`），
 *    绝不做字符串包含（`notgithub.com` 不能算 GitHub）。
 */

export type PlatformType = 'github' | 'youtube' | 'bilibili' | 'x' | 'web'

export type PlatformView = {
  platform: PlatformType
  /** 角标文本，如 "GitHub" / "YouTube" / "哔哩哔哩" / "X" / 域名 */
  label: string
  /** 品牌点缀色：只用于小面积（角标、色点），不做大面积填充 */
  accent: string
}

const PLATFORM_BRANDS: Record<Exclude<PlatformType, 'web'>, PlatformView> = {
  github: { platform: 'github', label: 'GitHub', accent: '#24292f' },
  youtube: { platform: 'youtube', label: 'YouTube', accent: '#e5202e' },
  bilibili: { platform: 'bilibili', label: '哔哩哔哩', accent: '#e26ba4' },
  x: { platform: 'x', label: 'X', accent: '#0f1419' }
}

/** hostname 是否属于给定域（裸域或任意子域）。 */
function hostnameMatches(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** 从记录里取一个可解析的 URL 文本（canonical 优先）。 */
function bestURLText(item: RecordItem): string {
  return (item.canonicalURL && item.canonicalURL.trim()) || item.urlString.trim()
}

/** 按 URL 现认平台；解析失败或非 http(s) 返回 null（绝不误配）。 */
function detectByURL(item: RecordItem): PlatformType | null {
  const raw = bestURLText(item)
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (hostnameMatches(host, ['github.com'])) return 'github'
  if (hostnameMatches(host, ['youtube.com', 'youtu.be', 'youtube-nocookie.com'])) return 'youtube'
  if (hostnameMatches(host, ['bilibili.com', 'b23.tv'])) return 'bilibili'
  if (hostnameMatches(host, ['x.com', 'twitter.com'])) return 'x'
  return null
}

/** provider 原始值 → 平台（generic/未知返回 null，交 URL 现认）。 */
function detectByProvider(item: RecordItem): PlatformType | null {
  const provider: LinkProvider | string = item.provider
  if (provider === 'github' || provider === 'youtube' || provider === 'bilibili' || provider === 'x') {
    return provider
  }
  return null
}

/** 网页平台的角标：域名（去掉 www.）；没有地址退回「网页」。 */
function webLabel(item: RecordItem): string {
  const raw = bestURLText(item)
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname.replace(/^www\./, '') || '网页'
    }
  } catch {
    /* fallthrough */
  }
  return '网页'
}

/**
 * 记录的链接平台视图。本地媒体与文字不走这里（carrier 决定）。
 * provider 与 URL 现认冲突时**以 provider 为准**——它是创建时的解析结果。
 */
export function detectPlatform(item: RecordItem): PlatformView {
  if (item.carrier !== 'link') {
    return { platform: 'web', label: webLabel(item), accent: 'var(--ink-faint)' }
  }
  const byProvider = detectByProvider(item)
  const platform = byProvider ?? detectByURL(item) ?? 'web'
  if (platform === 'web') {
    return { platform: 'web', label: webLabel(item), accent: 'var(--ink-faint)' }
  }
  return PLATFORM_BRANDS[platform]
}
