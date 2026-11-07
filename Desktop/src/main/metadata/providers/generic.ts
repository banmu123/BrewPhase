import type { ParsedLink } from '../../../shared/link-parser'
import { MAX_HTML_BYTES, type FetchOptions } from '../metadata-security'
import { emptyMetadata, extractHtmlMetadata, normalizeThumbnail, type ResolvedLinkMetadata, type TextFetcher } from '../metadata-normalizer'

/**
 * 普通网页：Open Graph 优先，缺失时退标准 HTML 元数据（title/description）。
 *
 * 注意：这是「访问用户提供的任意 URL」，安全由 `safeFetchText` 的连接级
 * IP 校验 + 逐跳重定向校验保证（见 metadata-security.ts）。没有封面就
 * 留空（renderer 用域名 fallback），不生成随机图、不影响记录本身。
 */

const HTML_OPTS: FetchOptions = {
  accept: 'text/html,application/xhtml+xml',
  maxBytes: MAX_HTML_BYTES,
  allowedTypes: ['text/html', 'application/xhtml+xml']
}

function siteNameFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

export async function resolveGeneric(parsed: ParsedLink, fetchText: TextFetcher): Promise<ResolvedLinkMetadata> {
  const metadata = emptyMetadata('generic', parsed.canonicalUrl)
  metadata.sourceName = siteNameFromUrl(parsed.originalUrl)
  try {
    const response = await fetchText(parsed.originalUrl, HTML_OPTS)
    const html = extractHtmlMetadata(response.body)
    metadata.title = html.title
    metadata.description = html.description
    metadata.thumbnailUrl = normalizeThumbnail(html.image, response.url)
    metadata.authorName = html.author
    metadata.sourceName = html.siteName ?? metadata.sourceName
    metadata.status = metadata.title || metadata.description || metadata.thumbnailUrl ? 'success' : 'failed'
    if (metadata.status === 'failed') metadata.errorMessage = '页面没有可用的元数据'
    return metadata
  } catch (error) {
    metadata.errorMessage = (error as Error).message
    return metadata
  }
}
