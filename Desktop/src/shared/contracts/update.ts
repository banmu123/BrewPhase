/**
 * 版本感知（update awareness）契约。
 *
 * 这一版只做「有没有新版本」的判断与提示：**不下载、不安装、不替换 App**。
 * macOS 上自动替换安装要求代码签名与公证链路稳定，而当前发布链还没做到，
 * 所以把决定权留给用户：告诉他有新版本，给出 GitHub Releases 下载页。
 * 所有 URL 都来自 GitHub API，且必须过白名单；Renderer 不能传任意地址进来。
 */

export const UPDATE_RELEASES_PAGE = 'https://github.com/banmu123/BrewPhase/releases'
export const UPDATE_RELEASES_API =
  'https://api.github.com/repos/banmu123/BrewPhase/releases?per_page=20'
export const UPDATE_CHANGED_CHANNEL = 'update:changed'
/** 启动后延迟一点再查，别和开窗、开库、同步抢网络。 */
export const UPDATE_AUTO_CHECK_DELAY_MS = 8_000
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_REQUEST_TIMEOUT_MS = 8_000

export type UpdateCheckStatus = 'up-to-date' | 'available' | 'unavailable'

export type UpdateCheckResult = {
  status: UpdateCheckStatus
  currentVersion: string
  latestVersion: string | null
  /** 永远指向 GitHub 的 Release 页或下载资产，主进程打开前会再校验一次。 */
  releaseUrl: string
  downloadUrl: string | null
  publishedAt: string | null
  checkedAt: number
  /** 失败原因，只用于设置页展示，不含堆栈与本地路径。 */
  reason: string | null
}

export type ReleaseAsset = { name: string; browser_download_url: string }
export type ReleaseEntry = {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  html_url: string
  published_at?: string | null
  assets?: ReleaseAsset[]
}

/** `desktop-v0.1.2` → `0.1.2`；其它 tag（iOS 的、草稿的）一律忽略。 */
export function parseDesktopVersion(tagName: string): string | null {
  const match = /^desktop-v(\d+(?:\.\d+)*)$/.exec(tagName.trim())
  return match ? match[1] : null
}

/** 纯数字段比较：0.1.10 > 0.1.9，缺位按 0 处理。 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/** 只放行 GitHub 的发布域：URL 来自远端 JSON，不能让它变成任意跳转。 */
export function isAllowedReleaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'github.com' || url.hostname === 'release-assets.githubusercontent.com')
    )
  } catch {
    return false
  }
}

/** 当前平台该下哪个安装包；找不到就返回 null（仍可打开 Release 页）。 */
export function pickAssetUrl(
  release: ReleaseEntry,
  platform: string,
  arch: string
): string | null {
  const version = parseDesktopVersion(release.tag_name)
  if (!version) return null
  const suffix =
    platform === 'darwin'
      ? arch === 'arm64'
        ? 'mac-arm64.dmg'
        : 'mac-x64.dmg'
      : platform === 'win32'
        ? 'win-x64.exe'
        : null
  if (!suffix || !Array.isArray(release.assets)) return null
  const asset = release.assets.find((item) => item?.name === `BrewPhase-${version}-${suffix}`)
  const url = asset?.browser_download_url
  return typeof url === 'string' && isAllowedReleaseUrl(url) ? url : null
}

export type UpdateCandidate = {
  version: string
  releaseUrl: string
  downloadUrl: string | null
  publishedAt: string | null
}

/**
 * 从 GitHub Releases API 的响应里挑「值得提示」的最新版本。
 * 草稿跳过；tag 必须是 desktop-vX.Y.Z；版本必须严格大于当前版本。
 * prerelease 要算进去——目前所有桌面端发布都还是 prerelease。
 */
export function selectUpdate(
  releases: unknown,
  currentVersion: string,
  platform: string,
  arch: string
): UpdateCandidate | null {
  if (!Array.isArray(releases)) return null
  let best: UpdateCandidate | null = null
  for (const item of releases) {
    if (!item || typeof item !== 'object') continue
    const entry = item as ReleaseEntry
    if (entry.draft === true) continue
    const version = parseDesktopVersion(
      typeof entry.tag_name === 'string' ? entry.tag_name : ''
    )
    if (!version || compareVersions(version, currentVersion) <= 0) continue
    const rawUrl = typeof entry.html_url === 'string' ? entry.html_url : ''
    const candidate: UpdateCandidate = {
      version,
      releaseUrl: isAllowedReleaseUrl(rawUrl) ? rawUrl : UPDATE_RELEASES_PAGE,
      downloadUrl: pickAssetUrl(entry, platform, arch),
      publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null
    }
    if (!best || compareVersions(version, best.version) > 0) best = candidate
  }
  return best
}
