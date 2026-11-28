import { app, net } from 'electron'
import {
  UPDATE_AUTO_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_INSTALL_DELAY_MS,
  UPDATE_RELEASES_API,
  UPDATE_RELEASES_PAGE,
  UPDATE_REQUEST_TIMEOUT_MS,
  initialUpdateState,
  isAllowedReleaseUrl,
  normalizeVersion,
  selectUpdate,
  type UpdateState
} from '../../shared/contracts/update'
import type { UpdaterAdapter, UpdaterHandlers } from './updater'

/**
 * 更新服务：主进程里**唯一**的更新状态机。
 *
 * 两条来源，一个出口：
 * 1. 打包版走 electron-updater（权威）：能检查、能下载、能安装；
 * 2. 不能自动更新的场景（开发态、平台不支持、元数据缺失/出错）走 GitHub API
 *    发现，只给出「有新版本 + 手动下载」——保证 UI 不会因为拿不到
 *    latest-mac.yml 就变成一片空白。
 *
 * 不管走哪条，对外只有一份 `UpdateState`，Renderer 不持有第二份判断。
 *
 * 几条硬规则：
 * - `autoDownload = false`：检查不下载，下载必须由用户点「立即更新」；
 * - 同一时间只有一个任务：下载中/安装中不收新的 check，重复 download 直接返回；
 * - 安装前先让主进程把该写的写完（prepareForInstall），失败就停在 error，
 *   旧版本与用户数据都不动。
 */

export type UpdateDiscoveryResult =
  | { status: 'up-to-date' }
  | { status: 'available'; version: string; downloadUrl: string; releaseUrl: string }
  | { status: 'error'; reason: string }

export type UpdateDiscovery = () => Promise<UpdateDiscoveryResult>

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const defaultFetch: FetchLike = (url, init) => net.fetch(url, init)

/**
 * GitHub Releases 兜底发现：Stable + 平台资产 + 版本比较的规则都在
 * `selectUpdate` 里（Phase 1 起有完整单测）。这里只负责取数与超时。
 */
export function createReleaseDiscovery(params: {
  currentVersion: string
  platform: string
  arch: string
  fetchImpl?: FetchLike
}): UpdateDiscovery {
  return async () => {
    try {
      const response = await (params.fetchImpl ?? defaultFetch)(UPDATE_RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `BrewPhase/${params.currentVersion}`
        },
        signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` }
      const candidate = selectUpdate(
        await response.json(),
        params.currentVersion,
        params.platform,
        params.arch
      )
      if (!candidate) return { status: 'up-to-date' }
      return {
        status: 'available',
        version: candidate.version,
        downloadUrl: candidate.downloadUrl,
        releaseUrl: candidate.releaseUrl
      }
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.message : 'unknown error' }
    }
  }
}

export class UpdateService {
  private state: UpdateState
  private inFlightCheck: Promise<UpdateState> | null = null
  private downloadInFlight = false
  private installTimer: NodeJS.Timeout | null = null
  private delayTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  /** 自动检查是否启用（startAutoCheck 置位）：fail 在首检的同步调用链里，
   *  此时 intervalTimer 还没建，不能拿它当「自动模式开着」的判据。 */
  private autoCheckEnabled = false
  private checkedAt = 0

  constructor(
    private readonly params: {
      currentVersion?: string
      adapter: UpdaterAdapter
      discover?: UpdateDiscovery
      /** 安装前收尾：flush 证据、停服务、关库。抛错则不安装。 */
      prepareForInstall?: () => Promise<void> | void
      broadcast?: (state: UpdateState) => void
      now?: () => number
      installDelayMs?: number
    }
  ) {
    const currentVersion = normalizeVersion(
      this.params.currentVersion?.trim() || app.getVersion()
    )
    this.state = initialUpdateState(currentVersion, this.params.adapter.supported)
    this.params.adapter.bind(this.handlers())
  }

  get snapshot(): UpdateState {
    return this.state
  }

  /** `force` 只给设置页「检查更新」按钮；24 小时内的自动检查直接吃缓存。 */
  async check(options: { force?: boolean } = {}): Promise<UpdateState> {
    if (this.busy()) return this.state
    const now = this.now()
    if (!options.force && this.checkedAt > 0 && now - this.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
      return this.state
    }
    if (this.inFlightCheck) return this.inFlightCheck
    const run = this.performCheck(now).finally(() => {
      this.inFlightCheck = null
    })
    this.inFlightCheck = run
    return run
  }

  /**
   * 用户点「立即更新」。
   * - 只接受 `available`（或下载失败后的 `error`）→ 其余状态直接忽略，
   *   避免检查还没结束就被误触发；
   * - 不支持自动更新的构建永远不会走到这里（IPC 也会拒绝）。
   */
  async download(): Promise<UpdateState> {
    if (!this.state.autoUpdate) return this.state
    if (this.downloadInFlight) return this.state
    const retryable = this.state.phase === 'error' && this.state.failedAt === 'download'
    if (this.state.phase !== 'available' && !retryable) return this.state

    this.downloadInFlight = true
    this.clearInstallTimer()
    this.patch({
      phase: 'downloading',
      percent: 0,
      transferred: 0,
      total: null,
      error: null,
      failedAt: null
    })
    try {
      await this.params.adapter.download()
    } catch (error) {
      // 事件里的 error 也会走到这里；以第一次落定的错误为准。
      if (this.state.phase === 'downloading') this.fail('download', error)
    } finally {
      this.downloadInFlight = false
    }
    return this.state
  }

  /** 打开下载页：只从自己缓存的状态里取地址，且必须是白名单内的。 */
  releaseUrl(): string {
    const url = this.state.downloadUrl ?? this.state.releaseUrl ?? UPDATE_RELEASES_PAGE
    return isAllowedReleaseUrl(url) ? url : UPDATE_RELEASES_PAGE
  }

  /** 打包版才启动；dev / e2e 不需要联网探针。定时器不阻止应用退出。 */
  startAutoCheck(): void {
    if (this.delayTimer || this.intervalTimer) return
    this.autoCheckEnabled = true
    this.clearRetryTimer()
    const tick = (): void => {
      void this.check().catch(() => undefined)
    }
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null
      tick()
      this.intervalTimer = setInterval(tick, UPDATE_CHECK_INTERVAL_MS)
      this.intervalTimer.unref?.()
    }, UPDATE_AUTO_CHECK_DELAY_MS)
    this.delayTimer.unref?.()
  }

  stopAutoCheck(): void {
    this.autoCheckEnabled = false
    if (this.delayTimer) clearTimeout(this.delayTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.delayTimer = null
    this.intervalTimer = null
    this.clearRetryTimer()
    this.clearInstallTimer()
  }

  // ————————————————— 内部 —————————————————

  private handlers(): UpdaterHandlers {
    return {
      checking: () => {
        if (this.busy()) return
        this.patch({ phase: 'checking', error: null, failedAt: null })
      },
      available: (info) => {
        if (this.busy()) return
        this.checkedAt = this.now()
        this.patch({
          phase: 'available',
          latestVersion: info.version,
          autoUpdate: true,
          downloadUrl: null,
          percent: null,
          transferred: null,
          total: null,
          error: null,
          failedAt: null,
          checkedAt: this.checkedAt
        })
      },
      notAvailable: () => {
        if (this.busy()) return
        this.checkedAt = this.now()
        this.patch({
          phase: 'up-to-date',
          latestVersion: null,
          error: null,
          failedAt: null,
          checkedAt: this.checkedAt
        })
      },
      progress: (progress) => {
        if (this.state.phase !== 'downloading') return
        this.patch({
          percent: Math.round(progress.percent),
          transferred: progress.transferred,
          total: progress.total
        })
      },
      downloaded: (info) => {
        if (this.state.phase !== 'downloading') return
        this.patch({ phase: 'downloaded', latestVersion: info.version, percent: 100 })
        this.scheduleInstall()
      },
      error: (error) => {
        if (this.state.phase === 'installing') return
        this.fail(this.state.phase === 'downloading' ? 'download' : 'check', error)
      }
    }
  }

  private async performCheck(now: number): Promise<UpdateState> {
    this.patch({ phase: 'checking', error: null, failedAt: null })

    if (!this.params.adapter.supported) {
      await this.applyDiscovery(now)
      return this.state
    }

    try {
      await this.params.adapter.check()
    } catch {
      // 没有事件落定（例如 app-update.yml 读不到）才需要在这里补一次兜底。
      if (this.state.phase === 'checking') await this.applyDiscovery(now)
      return this.state
    }
    // adapter 通过 error 事件报错（latest-mac.yml 缺失等）时也走兜底：
    // 至少让用户知道有新版本、能手动下载，而不是只看到一句「检查失败」。
    if (this.state.phase === 'error' && this.state.failedAt === 'check') {
      await this.applyDiscovery(now)
    }
    return this.state
  }

  /** 兜底发现：不能自动更新时，至少让用户知道有新版本、能手动下载。 */
  private async applyDiscovery(now: number, cause?: unknown): Promise<void> {
    const discover = this.params.discover
    if (!discover) {
      this.fail('check', cause ?? new Error('automatic update unavailable'))
      this.patch({ phase: 'unsupported', autoUpdate: false, checkedAt: now })
      return
    }
    const result = await discover()
    if (result.status === 'available') {
      this.checkedAt = now
      this.patch({
        phase: 'available',
        latestVersion: result.version,
        autoUpdate: false,
        downloadUrl: result.downloadUrl,
        releaseUrl: result.releaseUrl,
        error: null,
        failedAt: null,
        percent: null,
        transferred: null,
        total: null,
        checkedAt: now
      })
      return
    }
    if (result.status === 'up-to-date') {
      this.checkedAt = now
      this.patch({
        phase: 'up-to-date',
        latestVersion: null,
        autoUpdate: this.params.adapter.supported,
        downloadUrl: null,
        error: null,
        failedAt: null,
        checkedAt: now
      })
      return
    }
    this.patch({
      phase: 'error',
      failedAt: 'check',
      error: result.reason,
      latestVersion: null,
      downloadUrl: null,
      checkedAt: now
    })
  }

  private fail(scope: 'check' | 'download', cause: unknown): void {
    const message =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error'
    this.patch({
      phase: 'error',
      failedAt: scope,
      error: message,
      // 下载失败保留版本号：界面可以「重试下载」，而不是重新发现一遍。
      latestVersion: scope === 'download' ? this.state.latestVersion : null,
      percent: null,
      transferred: null,
      total: null
    })
    // 2026-11-28：检查失败后安排短间隔自动重试——之前失败要等 24 小时的
    // 整点 interval 才再试一次，用户看到的体验是「自动提示不见了」。
    // 下载失败不自动重试（大文件 + 用户已看到错误条，由用户决定重试时机）。
    if (scope === 'check' && this.autoCheckEnabled) {
      this.clearRetryTimer()
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        void this.check().catch(() => undefined)
      }, UPDATE_CHECK_RETRY_MS)
      this.retryTimer.unref?.()
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleInstall(): void {
    this.clearInstallTimer()
    const delay = this.params.installDelayMs ?? UPDATE_INSTALL_DELAY_MS
    this.installTimer = setTimeout(() => {
      this.installTimer = null
      void this.install()
    }, delay)
    this.installTimer.unref?.()
  }

  /** 安装前必须把该写的写完：任何一步失败都不安装，停在可重试的错误上。 */
  private async install(): Promise<void> {
    if (this.state.phase !== 'downloaded') return
    this.patch({ phase: 'installing' })
    try {
      await this.params.prepareForInstall?.()
    } catch (error) {
      this.fail('download', error)
      return
    }
    this.params.adapter.quitAndInstall()
  }

  private busy(): boolean {
    return (
      this.state.phase === 'downloading' ||
      this.state.phase === 'downloaded' ||
      this.state.phase === 'installing'
    )
  }

  private clearInstallTimer(): void {
    if (!this.installTimer) return
    clearTimeout(this.installTimer)
    this.installTimer = null
  }

  private now(): number {
    return this.params.now?.() ?? Date.now()
  }

  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.params.broadcast?.(this.state)
  }
}
