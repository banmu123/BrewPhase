import type { LinkProvider } from './contracts'

/**
 * 链接本地解析（纯函数，**不发任何网络请求**）：renderer 用它做「已识别」
 * 状态，main process 用它做元数据抓取前的平台判定。两侧共用同一份规则。
 *
 * 识别一律 hostname 精确匹配（裸域或子域），不做字符串包含——`notgithub.com`
 * 不能被当成 GitHub；只接受 http/https，`javascript:` / `file:` / `data:` 直接判无效。
 * **原始 URL 原样保留**（`originalUrl`），规范化只写 `canonicalUrl`。
 */

export type GitHubSubresource = 'repo' | 'tree' | 'blob' | 'issues' | 'pull' | 'releases' | 'gist' | 'other'

export type ParsedLink = {
  /** 用户输入的原始文本（清理首尾空白后原样保留） */
  originalUrl: string
  /** 规范化地址：去锚点/跟踪参数（用于去重与「打开原链接」） */
  canonicalUrl: string
  provider: LinkProvider
  /** 平台内容 ID：YouTube videoId / Bilibili BV 号 / X 动态 ID / GitHub owner/repo */
  contentId: string | null
  repositoryOwner: string | null
  repositoryName: string | null
  /** GitHub 子页面类型（仓库首页 / 文件树 / issues / PR…），其余平台为 null */
  subresource: GitHubSubresource | null
  /** b23.tv 等短链：本地无法得知最终目标，保存后由 main 安全解析 */
  shortLink: boolean
  /** 从 URL 直接读出的作者名（X 的 @username），其余平台 null */
  authorHint: string | null
  valid: boolean
}

const GITHUB_HOSTS = ['github.com']
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']
const BILIBILI_HOSTS = ['bilibili.com', 'b23.tv']
const X_HOSTS = ['x.com', 'twitter.com']

function hostMatches(host: string, domains: string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))
}

/** 只会出现在 URL 里、对内容无意义的查询参数（去重与规范化时剔除）。 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'spm_id_from', 'vd_source', 'share_source', 'share_medium', 'share_plat',
  'share_session_id', 'share_tag', 'timestamp', 'unique_k', 'si', 'feature', 't', 's'
])

function canonicalize(url: URL): string {
  const clone = new URL(url.toString())
  clone.hash = ''
  for (const key of [...clone.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) clone.searchParams.delete(key)
  }
  return clone.toString()
}

function githubOwnerRepo(pathname: string): { owner: string; repo: string; sub: GitHubSubresource } | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const [owner, repo, third] = segments
  // owner/repo 只接受 GitHub 合法字符，避免把 /settings 之类当仓库
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null
  const known: Record<string, GitHubSubresource> = {
    tree: 'tree', blob: 'blob', issues: 'issues', pull: 'pull',
    releases: 'releases', actions: 'other', wiki: 'other', settings: 'other'
  }
  const sub: GitHubSubresource = third ? (known[third] ?? 'other') : 'repo'
  return { owner, repo, sub }
}

function parseGitHub(url: URL): ParsedLink | null {
  const host = url.hostname.toLowerCase()
  if (!hostMatches(host, GITHUB_HOSTS)) return null
  const base = { originalUrl: url.toString(), canonicalUrl: canonicalize(url), provider: 'github' as const }
  if (host === 'gist.github.com' || host.endsWith('.gist.github.com')) {
    const gistId = url.pathname.split('/').filter(Boolean).pop() ?? null
    return { ...base, contentId: gistId, repositoryOwner: null, repositoryName: null, subresource: 'gist', shortLink: false, authorHint: null, valid: true }
  }
  const parsed = githubOwnerRepo(url.pathname)
  if (!parsed) {
    // github.com 之外的非仓库页面（首页、探索、通知）：仍算 GitHub，但没有仓库身份
    return { ...base, contentId: null, repositoryOwner: null, repositoryName: null, subresource: 'other', shortLink: false, authorHint: null, valid: true }
  }
  return {
    ...base,
    contentId: `${parsed.owner}/${parsed.repo}`,
    repositoryOwner: parsed.owner,
    repositoryName: parsed.repo,
    subresource: parsed.sub,
    shortLink: false,
    authorHint: null,
    valid: true
  }
}

function parseYouTube(url: URL): ParsedLink | null {
  const host = url.hostname.toLowerCase()
  if (!hostMatches(host, YOUTUBE_HOSTS)) return null
  const base = { originalUrl: url.toString(), canonicalUrl: canonicalize(url), provider: 'youtube' as const }
  const bare = { repositoryOwner: null, repositoryName: null, subresource: null, shortLink: false, authorHint: null, valid: true }
  // youtu.be/{id}
  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? null
    return { ...base, ...bare, contentId: validVideoId(id) ? id : null }
  }
  const v = url.searchParams.get('v')
  if (url.pathname === '/watch' && validVideoId(v)) {
    return { ...base, ...bare, contentId: v }
  }
  const match = url.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,20})/)
  if (match && validVideoId(match[2])) {
    return { ...base, ...bare, contentId: match[2] }
  }
  return { ...base, ...bare, contentId: null }
}

function validVideoId(id: string | null | undefined): id is string {
  return typeof id === 'string' && /^[\w-]{6,20}$/.test(id)
}

function parseBilibili(url: URL): ParsedLink | null {
  const host = url.hostname.toLowerCase()
  if (!hostMatches(host, BILIBILI_HOSTS)) return null
  const base = { originalUrl: url.toString(), canonicalUrl: canonicalize(url), provider: 'bilibili' as const }
  const bare = { repositoryOwner: null, repositoryName: null, subresource: null, authorHint: null }
  // 短链：本地只知道它是 B 站，最终地址要等 main 安全展开
  if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
    return { ...base, ...bare, contentId: null, shortLink: true, valid: true }
  }
  const bv = url.pathname.match(/^\/video\/(BV[\w]{10})/i)
  if (bv) return { ...base, ...bare, contentId: bv[1], shortLink: false, valid: true }
  const av = url.pathname.match(/^\/video\/av(\d+)/i)
  if (av) return { ...base, ...bare, contentId: `av${av[1]}`, shortLink: false, valid: true }
  const read = url.pathname.match(/^\/read\/(cv\d+)/i)
  if (read) return { ...base, ...bare, contentId: read[1], shortLink: false, valid: true }
  return { ...base, ...bare, contentId: null, shortLink: false, valid: true }
}

function parseX(url: URL): ParsedLink | null {
  const host = url.hostname.toLowerCase()
  if (!hostMatches(host, X_HOSTS)) return null
  const base = { originalUrl: url.toString(), canonicalUrl: canonicalize(url), provider: 'x' as const }
  // 动态 ID 是纯数字：早期推文的 ID 很短（`status/20` 就是第一条），
  // 不能按「现代雪花 ID 长度」卡死——这里只要求 1–20 位数字。
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})(?=\/|$)/)
  const author = match?.[1] ?? null
  return {
    ...base,
    contentId: match?.[2] ?? null,
    repositoryOwner: null,
    repositoryName: null,
    subresource: null,
    shortLink: false,
    // X 的“内容 ID”是动态 ID；作者是 URL 里能直接读出的附加事实
    authorHint: author,
    valid: true
  }
}

/** 无法识别的平台归 generic；解析失败/非 http(s) 判 invalid。 */
export function parseLink(raw: string): ParsedLink {
  const text = (raw ?? '').trim()
  const invalid: ParsedLink = {
    originalUrl: text,
    canonicalUrl: '',
    provider: 'generic',
    contentId: null,
    repositoryOwner: null,
    repositoryName: null,
    subresource: null,
    shortLink: false,
    authorHint: null,
    valid: false
  }
  if (!text) return invalid
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return invalid
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid
  if (!url.hostname) return invalid
  const platform =
    parseGitHub(url) ?? parseYouTube(url) ?? parseBilibili(url) ?? parseX(url)
  if (platform) return platform
  return {
    originalUrl: text,
    canonicalUrl: canonicalize(url),
    provider: 'generic',
    contentId: null,
    repositoryOwner: null,
    repositoryName: null,
    subresource: null,
    shortLink: false,
    authorHint: null,
    valid: true
  }
}

/** 平台展示名（新建表单的「已识别 …」文案用）。 */
export const providerLabel: Record<LinkProvider, string> = {
  github: 'GitHub',
  youtube: 'YouTube',
  bilibili: '哔哩哔哩',
  x: 'X',
  generic: '网页'
}
