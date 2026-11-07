import type { ParsedLink } from '../../../shared/link-parser'
import { MAX_HTML_BYTES, type FetchOptions } from '../metadata-security'
import { emptyMetadata, extractHtmlMetadata, normalizeThumbnail, type ResolvedLinkMetadata, type TextFetcher } from '../metadata-normalizer'

/**
 * Bilibili 元数据：公开网页 Open Graph（不登录、不绕验证码、不签名破解）。
 *
 * - BV/av 视频页：og:title（去掉 `_哔哩哔哩_bilibili` 后缀）、og:image、
 *   `meta[name=author]`（UP 主，页面有这个标签时才有）；
 * - 短链（b23.tv）：安全抓取会跟随重定向，`FetchResult.url` 就是最终地址——
 *   从最终地址重新提取 BV 号，HTML 直接复用；
 * - 取不到 UP 主就留空，绝不从标题里猜。
 */

const HTML_OPTS: FetchOptions = {
  accept: 'text/html,application/xhtml+xml',
  maxBytes: MAX_HTML_BYTES,
  allowedTypes: ['text/html', 'application/xhtml+xml']
}

function cleanBilibiliTitle(title: string | null): string | null {
  if (!title) return null
  return title.replace(/_哔哩哔哩_bilibili\s*$/u, '').replace(/_bilibili\s*$/i, '').trim() || null
}

function videoIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    const match = url.pathname.match(/^\/video\/(BV[\w]{10}|av\d+)/i)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export async function resolveBilibili(parsed: ParsedLink, fetchText: TextFetcher): Promise<ResolvedLinkMetadata> {
  const metadata = emptyMetadata('bilibili', parsed.canonicalUrl)
  metadata.contentId = parsed.contentId
  metadata.sourceName = '哔哩哔哩'

  // 短链：先抓短链页面让安全层跟随重定向拿到最终地址
  let pageUrl = parsed.originalUrl
  if (parsed.shortLink) {
    try {
      const response = await fetchText(parsed.originalUrl, HTML_OPTS)
      metadata.contentId = videoIdFromUrl(response.url) ?? metadata.contentId
      pageUrl = response.url
      const html = extractHtmlMetadata(response.body)
      metadata.title = cleanBilibiliTitle(html.title)
      metadata.description = html.description
      metadata.thumbnailUrl = normalizeThumbnail(html.image)
      metadata.authorName = html.author
      metadata.status = metadata.title || metadata.thumbnailUrl ? 'success' : 'failed'
      return metadata
    } catch (error) {
      metadata.errorMessage = (error as Error).message
      return metadata
    }
  }

  if (!parsed.contentId) {
    metadata.errorMessage = '没有可识别的视频 ID'
    return metadata
  }

  try {
    const response = await fetchText(pageUrl, HTML_OPTS)
    const html = extractHtmlMetadata(response.body)
    metadata.title = cleanBilibiliTitle(html.title)
    metadata.description = html.description
    metadata.thumbnailUrl = normalizeThumbnail(html.image)
    metadata.authorName = html.author
    metadata.status = metadata.title || metadata.thumbnailUrl ? 'success' : 'failed'
    if (metadata.status === 'failed') metadata.errorMessage = '页面没有可用的公开元数据'
    return metadata
  } catch (error) {
    metadata.errorMessage = (error as Error).message
    return metadata
  }
}
