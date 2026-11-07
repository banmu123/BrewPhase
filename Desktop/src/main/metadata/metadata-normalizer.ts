import type { FetchOptions, FetchResult } from './metadata-security'

/**
 * 元数据归一化模型（§五）：所有 provider 的输出统一成这一个形状，
 * UI 与数据库只见归一化结果，不见平台原始 JSON。
 *
 * `status === 'failed'` 时仍可能带部分可靠事实（如 GitHub 已解析出的仓库名、
 * YouTube 官方可构造的缩略图）——这些属于「公开地址/URL 解析结果」，不算伪造；
 * 统计数字、作者、正文一律拿不到就留空。
 */
export type ResolvedLinkMetadata = {
  provider: 'github' | 'youtube' | 'bilibili' | 'x' | 'generic'
  contentId: string | null
  canonicalUrl: string
  title: string | null
  description: string | null
  thumbnailUrl: string | null
  sourceName: string | null
  authorName: string | null
  repositoryLanguage: string | null
  repositoryStars: number | null
  repositoryForks: number | null
  repositoryLicense: string | null
  status: 'success' | 'failed'
  errorMessage?: string
}

/** 可注入的抓取器：生产用 safeFetchText，测试注入 mock。 */
export type TextFetcher = (url: string, opts: FetchOptions) => Promise<FetchResult>

/** 归一化空壳：拿不到就是 null，绝不填猜测值。 */
export function emptyMetadata(provider: ResolvedLinkMetadata['provider'], canonicalUrl: string): ResolvedLinkMetadata {
  return {
    provider,
    contentId: null,
    canonicalUrl,
    title: null,
    description: null,
    thumbnailUrl: null,
    sourceName: null,
    authorName: null,
    repositoryLanguage: null,
    repositoryStars: null,
    repositoryForks: null,
    repositoryLicense: null,
    status: 'failed'
  }
}

/** 从 HTML 里提取 meta（og / twitter / 标准 title & description），无第三方解析库。 */
export type HtmlMetadata = {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
  author: string | null
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
}

/**
 * 读取 `<meta>` 的 content。属性顺序不固定（content 可能写在 property 前），
 * 所以按「同一个标签内」双向匹配；只处理双引号/单引号两种合法写法。
 */
function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]*?(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`, 'i')
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return unescapeHtml(match[1]).trim()
  }
  return null
}

export function extractHtmlMetadata(html: string): HtmlMetadata {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const standardDescription = metaContent(html, 'description')
  return {
    title: metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title') ?? (titleTag ? unescapeHtml(titleTag).trim() : null),
    description:
      metaContent(html, 'og:description') ?? metaContent(html, 'twitter:description') ?? standardDescription,
    image: metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image'),
    siteName: metaContent(html, 'og:site_name'),
    author: metaContent(html, 'author')
  }
}

/** 只接受 https 的远程图片 URL（http 图片会被 CSP 拦截，也没有理由降级）。 */
export function normalizeThumbnail(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/** 去掉 HTML 标签取纯文本（X oEmbed 的 blockquote 正文用）。绝不把 HTML 交给 React。 */
export function stripHtml(html: string): string {
  return unescapeHtml(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{1,}/g, '\n')
    .trim()
}
