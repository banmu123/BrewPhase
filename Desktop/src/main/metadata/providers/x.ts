import type { ParsedLink } from '../../../shared/link-parser'
import { MAX_JSON_BYTES, type FetchOptions } from '../metadata-security'
import { emptyMetadata, stripHtml, type ResolvedLinkMetadata, type TextFetcher } from '../metadata-normalizer'

/**
 * X（Twitter）元数据：公开 oEmbed（publish.twitter.com，无需登录）+ 媒体发现。
 *
 * - 文本：oEmbed 的作者显示名 / 正文纯文本（HTML 一律 strip 成文本，
 *   **绝不把第三方 HTML 交给 React**）；
 * - 媒体（2026-11-28 新增）：oEmbed 不给图片 URL，因此按序尝试两个公开的
 *   推文 JSON 端点拿图片地址——
 *     1) 官方 syndication CDN（react-tweet 同款端点，token 由推文 ID 推导，无密钥）；
 *     2) FXTwitter 公共 API（第三方发现服务；只消费其中的图片 URL 与文本字段，
 *        与处理 og:image 同等信任级别，图片字节本身仍从 X 的媒体 CDN 加载）。
 *   图片 URL 必须 https 且 host 落在 X 的媒体 CDN（pbs/ton.twimg.com）白名单内，
 *   否则不采纳；两个来源都失败 → 保持「作者 + 正文」的无图卡片（不劣化）。
 * - 发往这两个端点的只有推文 ID（公开信息），不出本机任何用户数据。
 * - 失败：保留 URL 里解析出的 @作者，正文留空。
 */

const JSON_OPTS: FetchOptions = {
  accept: 'application/json',
  maxBytes: MAX_JSON_BYTES,
  allowedTypes: ['application/json']
}

/** X 媒体 CDN 白名单：图片 URL 只接受这两个 host（渲染端 CSP img-src 再兜一道）。 */
const MEDIA_HOSTS = new Set(['pbs.twimg.com', 'ton.twimg.com'])

type TwitterOEmbed = {
  author_name?: string
  author_url?: string
  html?: string
}

/** syndication tweet-result 的防御式形状（不同时期字段名有漂移）。 */
type SyndicationTweet = {
  text?: string
  user?: { name?: string }
  mediaDetails?: Array<{ media_url_https?: string; type?: string }>
  photos?: Array<{ url?: string }>
}

/** FXTwitter /status 响应的防御式形状。 */
type FxTweet = {
  tweet?: {
    text?: string
    author?: { name?: string; screen_name?: string }
    media?: { photos?: Array<{ url?: string }> }
  }
}

/** react-tweet 的公开 token 算法：从推文 ID 确定性推导（无密钥、无鉴权）。 */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

function isMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && MEDIA_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 媒体发现：只负责找第一张**可采纳**的照片 URL；任何失败都吞掉（返回 null），
 * 不影响 oEmbed 主路径的结果。
 */
async function discoverPhoto(parsed: ParsedLink, fetchText: TextFetcher): Promise<string | null> {
  const id = parsed.contentId
  if (!id) return null

  // 1) 官方 syndication CDN
  try {
    const response = await fetchText(
      `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${encodeURIComponent(syndicationToken(id))}&lang=zh-cn`,
      JSON_OPTS
    )
    const data = JSON.parse(response.body) as SyndicationTweet
    const candidates = [
      ...(data.mediaDetails ?? [])
        .filter((item) => item.type === 'photo')
        .map((item) => item.media_url_https ?? ''),
      ...(data.photos ?? []).map((item) => item.url ?? '')
    ]
    const found = candidates.find((url) => url.length > 0 && isMediaUrl(url))
    if (found) return found
  } catch {
    // 下一个来源
  }

  // 2) FXTwitter 公共 API
  try {
    const response = await fetchText(
      `https://api.fxtwitter.com/i/status/${encodeURIComponent(id)}`,
      JSON_OPTS
    )
    const data = JSON.parse(response.body) as FxTweet
    const found = (data.tweet?.media?.photos ?? [])
      .map((item) => item.url ?? '')
      .find((url) => url.length > 0 && isMediaUrl(url))
    if (found) return found
  } catch {
    // 全部来源失败：保持无图卡片
  }
  return null
}

/** syndication / FXTwitter 的文本兜底：oEmbed 缺作者名或正文时用。 */
async function fallbackText(
  parsed: ParsedLink,
  fetchText: TextFetcher,
  metadata: ResolvedLinkMetadata
): Promise<boolean> {
  if (metadata.description && metadata.authorName) return true
  const id = parsed.contentId
  if (!id) return false
  try {
    const response = await fetchText(
      `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${encodeURIComponent(syndicationToken(id))}&lang=zh-cn`,
      JSON_OPTS
    )
    const data = JSON.parse(response.body) as SyndicationTweet
    let hit = false
    if (!metadata.description && data.text?.trim()) {
      metadata.description = data.text.trim()
      hit = true
    }
    if (!metadata.authorName && data.user?.name?.trim()) {
      metadata.authorName = data.user.name.trim()
      hit = true
    }
    if (hit) return true
    return false
  } catch {
    // 下一个来源
  }
  try {
    const response = await fetchText(
      `https://api.fxtwitter.com/i/status/${encodeURIComponent(id)}`,
      JSON_OPTS
    )
    const data = JSON.parse(response.body) as FxTweet
    let hit = false
    if (!metadata.description && data.tweet?.text?.trim()) {
      metadata.description = data.tweet.text.trim()
      hit = true
    }
    if (!metadata.authorName && data.tweet?.author?.name?.trim()) {
      metadata.authorName = data.tweet.author.name.trim()
      hit = true
    }
    if (hit) return true
    return false
  } catch {
    // 两个兜底都失败：保持 oEmbed 的部分结果
  }
  return false
}

export async function resolveX(parsed: ParsedLink, fetchText: TextFetcher): Promise<ResolvedLinkMetadata> {
  const metadata = emptyMetadata('x', parsed.canonicalUrl)
  metadata.contentId = parsed.contentId
  metadata.sourceName = 'X'
  // URL 里能直接读出的账号名是可靠事实（不是猜测），但**不算验证成功**：
  // 只有作者名 / 正文 / 图片至少一项来自外部数据源，卡片才算 resolved。
  metadata.authorName = parsed.authorHint ? `@${parsed.authorHint}` : null
  let verified = false
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
    if (payload.author_name?.trim()) {
      metadata.authorName = payload.author_name.trim()
      verified = true
    }
    if (payload.html) {
      // blockquote 里第一段 <p> 就是正文；strip 后去掉尾部署名行
      const text = stripHtml(payload.html)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^—\s/.test(line) && !/^https?:\/\//.test(line))
        .join('\n')
        .trim()
      if (text) {
        metadata.description = text
        verified = true
      }
    }
  } catch {
    // oEmbed 失败不致命：媒体发现与 syndication 的文本兜底还能救回一条卡片
  }

  // 媒体与文本兜底：任何失败都保持现状（无图 / 部分字段），绝不劣化主结果
  try {
    const photo = await discoverPhoto(parsed, fetchText)
    if (photo) metadata.thumbnailUrl = photo
  } catch {
    // discoverPhoto 内部已吞错；这里防御意外
  }
  try {
    if (await fallbackText(parsed, fetchText, metadata)) verified = true
  } catch {
    // 同上
  }

  // 契约明确：无图时 thumbnailUrl 是 null 而不是 undefined
  metadata.thumbnailUrl = metadata.thumbnailUrl ?? null
  metadata.status = metadata.description || metadata.thumbnailUrl || verified ? 'success' : 'failed'
  if (metadata.status === 'failed') metadata.errorMessage = '没有可用的公开动态信息'
  return metadata
}
