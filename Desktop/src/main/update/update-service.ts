import { net } from 'electron'
import { APP_VERSION } from '../../shared/contracts/version'
import {
  UPDATE_AUTO_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RELEASES_API,
  UPDATE_RELEASES_PAGE,
  UPDATE_REQUEST_TIMEOUT_MS,
  isAllowedReleaseUrl,
  selectUpdate,
  type UpdateCheckResult
} from '../../shared/contracts/update'

/**
 * 版本检查服务（主进程唯一状态）。
 *
 * 设计要点：
 * - 结果只有一份，缓存在主进程；两个 Renderer 窗口通过广播同源，不各自缓存；
 * - 检查失败不抛给界面，降级成 `unavailable`，让「无网络也能完整使用」成立；
 * - 请求带超时；GitHub 未认证限流 60 次/时，所以自动检查一天最多一次；
 * - 只读取 JSON，不把任何本地数据放进请求。
 */

type FetchResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}
type FetchInit = { headers: Record<string, string>; signal: AbortSignal }
type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

const defaultFetch: FetchLike = (url, init) => net.fetch(url, init)

export class UpdateService {
  private result: UpdateCheckResult | null = null
  private checkedAt = 0
  private inFlight: Promise<UpdateCheckResult> | null = null
  private delayTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly params: {
      currentVersion?: string
      fetchImpl?: FetchLike
      now?: () => number
      broadcast?: (result: UpdateCheckResult) => void
    } = {}
  ) {}

  get cached(): UpdateCheckResult | null {
    return this.result
  }

  get lastCheckedAt(): number {
    return this.checkedAt
  }

  /** `force` 只给设置页「检查更新」按钮用；24 小时内的自动检查直接吃缓存。 */
  async check(options: { force?: boolean } = {}): Promise<UpdateCheckResult> {
    const now = this.params.now?.() ?? Date.now()
    const force = options.force === true
    if (!force && this.result && now - this.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
      return this.result
    }
    if (this.inFlight) return this.inFlight
    const run = this.perform(now).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async perform(now: number): Promise<UpdateCheckResult> {
    const currentVersion = this.params.currentVersion ?? APP_VERSION
    const base = {
      currentVersion,
      releaseUrl: UPDATE_RELEASES_PAGE,
      checkedAt: now,
      reason: null
    }
    let result: UpdateCheckResult
    try {
      const response = await (this.params.fetchImpl ?? defaultFetch)(UPDATE_RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `BrewPhase/${currentVersion}`
        },
        signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const candidate = selectUpdate(
        await response.json(),
        currentVersion,
        process.platform,
        process.arch
      )
      result = candidate
        ? {
            ...base,
            status: 'available',
            latestVersion: candidate.version,
            releaseUrl: candidate.releaseUrl,
            downloadUrl: candidate.downloadUrl,
            publishedAt: candidate.publishedAt
          }
        : {
            ...base,
            status: 'up-to-date',
            latestVersion: null,
            downloadUrl: null,
            publishedAt: null
          }
    } catch (error) {
      result = {
        ...base,
        status: 'unavailable',
        latestVersion: null,
        downloadUrl: null,
        publishedAt: null,
        reason: error instanceof Error ? error.message : 'unknown error'
      }
    }
    this.result = result
    this.checkedAt = now
    this.params.broadcast?.(result)
    return result
  }

  /**
   * 打开下载页时**不从 Renderer 收 URL**：只用服务自己缓存的、已过白名单的地址。
   * 这样「版本检查」这条链路永远无法被利用来打开任意外部地址。
   */
  releaseUrl(): string {
    const url = this.result?.downloadUrl ?? this.result?.releaseUrl ?? UPDATE_RELEASES_PAGE
    return isAllowedReleaseUrl(url) ? url : UPDATE_RELEASES_PAGE
  }

  /** 打包版才启动；dev / e2e 不需要联网探针。定时器不阻止应用退出。 */
  startAutoCheck(): void {
    if (this.delayTimer || this.intervalTimer) return
    const tick = (): void => {
      void this.check().catch(() => {})
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
    if (this.delayTimer) clearTimeout(this.delayTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.delayTimer = null
    this.intervalTimer = null
  }
}
