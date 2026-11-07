import type { ParsedLink } from '../../../shared/link-parser'
import { MAX_JSON_BYTES, type FetchOptions } from '../metadata-security'
import { emptyMetadata, stripHtml, type ResolvedLinkMetadata, type TextFetcher } from '../metadata-normalizer'

/**
 * X（Twitter）元数据：公开 oEmbed（publish.twitter.com，无需登录）。
 *
 * - 成功：作者显示名、@用户名、正文纯文本（HTML 一律 strip 成文本，
 *   **绝不把第三方 HTML 交给 React**）；
 * - 媒体封面 oEmbed 不给——不猜、不抓图，卡片走「作者 + 正文」形态；
 * - 失败：保留 URL 里解析出的 @作者，正文留空。
 */

const JSON_OPTS: FetchOptions = {
  accept: 'application/json',
  maxBytes: MAX_JSON_BYTES,
  allowedTypes: ['application/json']
}

type TwitterOEmbed = {
  author_name?: string
  author_url?: string
  html?: string
}

export async function resolveX(parsed: ParsedLink, fetchText: TextFetcher): Promise<ResolvedLinkMetadata> {
  const metadata = emptyMetadata('x', parsed.canonicalUrl)
  metadata.contentId = parsed.contentId
  metadata.sourceName = 'X'
  // URL 里能直接读出的账号名是可靠事实（不是猜测）
  metadata.authorName = parsed.authorHint ? `@${parsed.authorHint}` : null
  if (!parsed.contentId) {
    metadata.errorMessage = '没有可识别的动态 ID'
    return metadata
  }

  const target = `https://x.com/${parsed.authorHint ?? 'i'}/status/${parsed.contentId}`
  try {
    const response = await fetchText(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(target)}&omit_script=1&dnt=1`,
      JSON_OPTS
    )
    const payload = JSON.parse(response.body) as TwitterOEmbed
    if (payload.author_name?.trim()) metadata.authorName = payload.author_name.trim()
    if (payload.html) {
      // blockquote 里第一段 <p> 就是正文；strip 后去掉尾部署名行
      const text = stripHtml(payload.html)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^—\s/.test(line) && !/^https?:\/\//.test(line))
        .join('\n')
        .trim()
      metadata.description = text || null
    }
    metadata.status = metadata.description || metadata.authorName ? 'success' : 'failed'
    if (metadata.status === 'failed') metadata.errorMessage = '没有可用的公开动态信息'
    return metadata
  } catch (error) {
    metadata.errorMessage = (error as Error).message
    return metadata
  }
}
