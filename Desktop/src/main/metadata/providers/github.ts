import type { ParsedLink } from '../../../shared/link-parser'
import { MAX_JSON_BYTES, type FetchOptions } from '../metadata-security'
import { emptyMetadata, normalizeThumbnail, type ResolvedLinkMetadata, type TextFetcher } from '../metadata-normalizer'

/**
 * GitHub 元数据：公开仓库 API（无 token、公开仓库）。
 *
 * - 成功：仓库名、描述、语言、stars/forks、license；
 * - 封面用公开的 Open Graph 图服务（`opengraph.githubassets.com`），
 *   这是 GitHub 官方给社交卡生成图的服务，不需要额外请求；
 * - 404 / 403（限流）/ 网络失败：**保留已解析出的 owner/repo**，统计留空，
 *   状态 failed —— 卡片回退仓库信息卡，绝不伪造数字。
 */

const JSON_OPTS: FetchOptions = {
  accept: 'application/vnd.github+json',
  maxBytes: MAX_JSON_BYTES,
  allowedTypes: ['application/json']
}

type GitHubRepoResponse = {
  full_name?: string
  description?: string | null
  language?: string | null
  stargazers_count?: number
  forks_count?: number
  license?: { spdx_id?: string | null } | null
  owner?: { login?: string }
  name?: string
}

export async function resolveGitHub(parsed: ParsedLink, fetchText: TextFetcher): Promise<ResolvedLinkMetadata> {
  const owner = parsed.repositoryOwner
  const repo = parsed.repositoryName
  if (!owner || !repo) {
    const metadata = emptyMetadata('github', parsed.canonicalUrl)
    metadata.errorMessage = '不是可识别的仓库地址'
    return metadata
  }
  // 无论 API 成败，仓库身份与官方 og 图都是可确定的事实
  const metadata = emptyMetadata('github', parsed.canonicalUrl)
  metadata.contentId = `${owner}/${repo}`
  metadata.title = `${owner}/${repo}`
  metadata.thumbnailUrl = normalizeThumbnail(`https://opengraph.githubassets.com/1/${owner}/${repo}`)

  try {
    const response = await fetchText(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, JSON_OPTS)
    const payload = JSON.parse(response.body) as GitHubRepoResponse
    metadata.title = payload.full_name ?? metadata.title
    metadata.description = payload.description?.trim() || null
    metadata.repositoryLanguage = payload.language?.trim() || null
    metadata.repositoryStars = typeof payload.stargazers_count === 'number' ? payload.stargazers_count : null
    metadata.repositoryForks = typeof payload.forks_count === 'number' ? payload.forks_count : null
    const license = payload.license?.spdx_id
    metadata.repositoryLicense = license && license !== 'NOASSERTION' ? license : null
    metadata.authorName = payload.owner?.login ?? owner
    metadata.sourceName = 'GitHub'
    metadata.status = 'success'
    return metadata
  } catch (error) {
    metadata.errorMessage = (error as Error).message
    return metadata
  }
}
