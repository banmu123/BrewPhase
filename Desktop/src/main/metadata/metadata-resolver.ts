import { parseLink, type ParsedLink } from '../../shared/link-parser'
import { safeFetchText } from './metadata-security'
import { emptyMetadata, type ResolvedLinkMetadata, type TextFetcher } from './metadata-normalizer'
import { resolveBilibili } from './providers/bilibili'
import { resolveGeneric } from './providers/generic'
import { resolveGitHub } from './providers/github'
import { resolveX } from './providers/x'
import { resolveYouTube } from './providers/youtube'

/**
 * 元数据解析门面：本地解析 → 平台 provider → 归一化模型。
 *
 * - `fetchText` 可注入（测试用 mock，不依赖任何外部站点在线）；
 * - 同一 URL 的并发请求合并为一次实际抓取；
 * - 任何异常都归一成 `status: 'failed'`，绝不抛出到 IPC 层导致记录保存失败。
 */

const inflight = new Map<string, Promise<ResolvedLinkMetadata>>()

export async function resolveMetadata(
  parsed: ParsedLink,
  fetchText: TextFetcher = safeFetchText
): Promise<ResolvedLinkMetadata> {
  if (!parsed.valid) {
    return { ...emptyMetadata('generic', ''), errorMessage: '不是有效的网页地址' }
  }

  try {
    switch (parsed.provider) {
      case 'github':
        return await resolveGitHub(parsed, fetchText)
      case 'youtube':
        return await resolveYouTube(parsed, fetchText)
      case 'bilibili':
        return await resolveBilibili(parsed, fetchText)
      case 'x':
        return await resolveX(parsed, fetchText)
      default:
        return await resolveGeneric(parsed, fetchText)
    }
  } catch (error) {
    // provider 内部已兜底；这里是最后的防线（比如构造 payload 时的意外）
    const metadata = emptyMetadata(parsed.provider, parsed.canonicalUrl)
    metadata.contentId = parsed.contentId
    metadata.authorName = parsed.authorHint ? `@${parsed.authorHint}` : null
    metadata.errorMessage = (error as Error).message.slice(0, 200)
    return metadata
  }
}

/** 并发合并：同 URL 的多个请求只发一次，全部等待同一个结果。 */
export function resolveMetadataDeduped(
  url: string,
  fetchText: TextFetcher = safeFetchText
): Promise<ResolvedLinkMetadata> {
  const parsed = parseLink(url)
  const existing = inflight.get(parsed.originalUrl)
  if (existing) return existing
  const promise = resolveMetadata(parsed, fetchText).finally(() => {
    inflight.delete(parsed.originalUrl)
  })
  inflight.set(parsed.originalUrl, promise)
  return promise
}
