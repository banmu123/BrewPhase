import type { ParsedLink } from '../../../shared/link-parser'
import { MAX_JSON_BYTES, type FetchOptions } from '../metadata-security'
import { emptyMetadata, normalizeThumbnail, type ResolvedLinkMetadata, type TextFetcher } from '../metadata-normalizer'

/**
 * YouTube 元数据：公开 oEmbed（无 key、无登录）。
 *
 * - 成功：标题、频道名、缩略图（oEmbed 给出 i.ytimg.com 地址）；
 * - oEmbed 失败时**仍保留官方可构造的缩略图**（`i.ytimg.com/vi/{id}/hqdefault.jpg`，
 *   公开静态地址，不属于伪造数据），标题/频道留空，状态 failed；
 * - 时长与播放量没有可靠公开来源——不获取、不展示。
 */

const JSON_OPTS: FetchOptions = {
  accept: 'application/json',
  maxBytes: MAX_JSON_BYTES,
  allowedTypes: ['application/json']
}

type YouTubeOEmbed = {
  title?: string
  author_name?: string
  thumbnail_url?: string
}

function officialThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
}

export async function resolveYouTube(parsed: ParsedLink, fetchText: TextFetcher): Promise<ResolvedLinkMetadata> {
  const metadata = emptyMetadata('youtube', parsed.canonicalUrl)
  const videoId = parsed.contentId
  if (!videoId) {
    metadata.errorMessage = '没有可识别的视频 ID'
    return metadata
  }
  metadata.contentId = videoId
  metadata.thumbnailUrl = normalizeThumbnail(officialThumbnail(videoId))
  metadata.sourceName = 'YouTube'

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  try {
    const response = await fetchText(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      JSON_OPTS
    )
    const payload = JSON.parse(response.body) as YouTubeOEmbed
    metadata.title = payload.title?.trim() || null
    metadata.authorName = payload.author_name?.trim() || null
    metadata.thumbnailUrl = normalizeThumbnail(payload.thumbnail_url) ?? metadata.thumbnailUrl
    metadata.status = 'success'
    return metadata
  } catch (error) {
    metadata.errorMessage = (error as Error).message
    return metadata
  }
}
