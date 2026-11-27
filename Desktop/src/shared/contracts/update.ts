/**
 * 版本感知（update awareness）契约。
 *
 * 这一版只做「有没有可安装的新版本」的判断与提示：**不下载、不安装、不替换 App**。
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

/**
 * Release tag 的两代写法：
 * - `desktop-v0.1.4`：0.2.0 之前的全部 Desktop Release；
 * - `v0.2.0`：0.2.0 那一次正式发布用的写法（历史事实，不能重命名）。
 *
 * 从下一个版本起统一 `desktop-vX.Y.Z`，但两种都必须能读。
 */
export type ReleaseTagKind = 'desktop' | 'generic'
export type ReleaseTag = { version: string; kind: ReleaseTagKind }

const DESKTOP_TAG_PATTERN = /^desktop-v(\d+(?:\.\d+)*)$/
const GENERIC_TAG_PATTERN = /^v(\d+(?:\.\d+)*)$/

/** tag → 版本号 + 写法。带预发布后缀（`-beta`）或无关前缀的一律 null。 */
export function parseReleaseTag(tagName: string): ReleaseTag | null {
  const tag = typeof tagName === 'string' ? tagName.trim() : ''
  const desktop = DESKTOP_TAG_PATTERN.exec(tag)
  if (desktop) return { version: desktop[1], kind: 'desktop' }
  const generic = GENERIC_TAG_PATTERN.exec(tag)
  if (generic) return { version: generic[1], kind: 'generic' }
  return null
}

/**
 * tag → 版本号（两种写法都认），保留旧名字给既有调用与阅读习惯。
 *
 * `vX.Y.Z` 到底是不是 Desktop 版本，光看 tag 分不出来（iOS 也用 v*）。
 * 那一步由 `selectUpdate` 用「这个 Release 里有没有本平台的安装包」判定，
 * 所以这里只负责语法，不负责归属。
 */
export function parseDesktopVersion(tagName: string): string | null {
  return parseReleaseTag(tagName)?.version ?? null
}

/**
 * Stable 渠道的准入：Draft（含 tag 触发后待人工审核的草稿）与 Prerelease
 * 都不参与比较，只比已经正式发布的版本。
 *
 * 目前项目只有一个渠道；将来要开 Beta 时，在这里按渠道分派，而不是放宽
 * 这个判断——放宽会让 0.1.x 那些 Prerelease 重新变成「新版本」。
 */
export function isPublishedStable(entry: ReleaseEntry): boolean {
  return entry.draft !== true && entry.prerelease !== true
}

/** 比较用的规范化：去空白、去前导 v、去预发布后缀（`0.2.0-beta.1` → `0.2.0`）。 */
export function normalizeVersion(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
}

/** 纯数字段比较：0.2.10 > 0.2.9，缺位按 0 处理。 */
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

/**
 * 某版本在本平台的安装包文件名，按优先级排列。
 *
 * 必须与 electron-builder 的 `artifactName`
 * （`BrewPhase-${version}-${os}-${arch}.${ext}`）逐字一致——版本号取自 tag，
 * 文件名取自 package.json，两者不同就会「发布成功但没人能匹配到」，
 * 所以发布工作流里另有 tag/package.json 的一致性校验。
 *
 * macOS 主选 dmg（正式安装包），zip 只在某些 Release 里存在，作次选；
 * 本阶段不消费 zip 做自动更新，只是让「有这个包」的 Release 也能被识别。
 */
export function assetCandidates(version: string, platform: string, arch: string): string[] {
  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') return []
    const stem = `BrewPhase-${version}-mac-${arch}`
    return [`${stem}.dmg`, `${stem}.zip`]
  }
  if (platform === 'win32') {
    // 目前只发布 x64 安装包：ARM 机器跑 x64 属模拟执行，不冒充「本平台更新」。
    if (arch !== 'x64') return []
    return [`BrewPhase-${version}-win-x64.exe`]
  }
  return []
}

/**
 * 当前平台该下哪个安装包；找不到就返回 null。
 *
 * 命中第一个存在的候选文件后不再回退：如果它的地址不在白名单里，宁可返回
 * null（不可直接更新），也不悄悄换成另一个文件。
 */
export function pickAssetUrl(
  release: ReleaseEntry,
  platform: string,
  arch: string
): string | null {
  const version = parseDesktopVersion(release.tag_name)
  if (!version || !Array.isArray(release.assets)) return null
  for (const name of assetCandidates(version, platform, arch)) {
    const asset = release.assets.find((item) => item?.name === name)
    if (!asset) continue
    const url = asset.browser_download_url
    return typeof url === 'string' && isAllowedReleaseUrl(url) ? url : null
  }
  return null
}

export type UpdateCandidate = {
  version: string
  releaseUrl: string
  /** available 一定可下载：没有本平台安装包的 Release 不会被选中。 */
  downloadUrl: string
  publishedAt: string | null
}

/**
 * 从 GitHub Releases API 的响应里挑「值得提示」的最新版本。
 *
 * 四道门，缺一不可：
 * 1. Stable 渠道（`isPublishedStable`）：Draft 与 Prerelease 跳过；
 * 2. tag 可解析：`desktop-vX.Y.Z` 或 `vX.Y.Z`（后者是 0.2.0 的历史写法）；
 * 3. 版本严格大于当前版本（数字段比较，等于也不提示）；
 * 4. **Release 里确实有本平台、且文件名版本号与 tag 一致的安装包**——
 *    这一条同时挡掉纯 iOS 的 `v1.1.0`、只发了 macOS 的 Release，
 *    以及「tag 是 0.3.0、包还是 0.2.0」的错配。
 */
export function selectUpdate(
  releases: unknown,
  currentVersion: string,
  platform: string,
  arch: string
): UpdateCandidate | null {
  if (!Array.isArray(releases)) return null
  const current = normalizeVersion(currentVersion)
  let best: UpdateCandidate | null = null
  for (const item of releases) {
    if (!item || typeof item !== 'object') continue
    const entry = item as ReleaseEntry
    if (!isPublishedStable(entry)) continue
    const tag = parseReleaseTag(typeof entry.tag_name === 'string' ? entry.tag_name : '')
    if (!tag || compareVersions(tag.version, current) <= 0) continue
    const downloadUrl = pickAssetUrl(entry, platform, arch)
    if (!downloadUrl) continue
    if (best && compareVersions(tag.version, best.version) <= 0) continue
    const rawUrl = typeof entry.html_url === 'string' ? entry.html_url : ''
    best = {
      version: tag.version,
      releaseUrl: isAllowedReleaseUrl(rawUrl) ? rawUrl : UPDATE_RELEASES_PAGE,
      downloadUrl,
      publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null
    }
  }
  return best
}
