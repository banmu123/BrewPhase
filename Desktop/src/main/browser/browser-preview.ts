import type { BrowserPreview, BrowserPreviewEvent } from '../../shared/contracts/browser'

/**
 * 网页缩略图的调度与缓存（主进程）。
 *
 * 只做三件事：**节流采集、内存缓存、变化广播**。真正「怎么截图」由注入的
 * `capture` 完成（BrowserManager 用它去动真实的 WebContentsView），所以这里
 * 不 import electron，可以在 Vitest 的 node 环境里用假时钟与假采集器验证。
 *
 * 铁律：
 * - 一张预览只属于一个真实 tabId；标签销毁必须 `forget`。
 * - 采集失败**保留最后一张有效预览**，不广播空值、不删缓存。
 * - 同一时刻只跑一个采集任务（截图会短暂改 view 的 bounds，不能并发）。
 * - 不做无限重试：失败也记节流时间，等下一次真实事件再试。
 */

export type PreviewCaptureResult = {
  /** `data:image/jpeg;base64,…`，只在本地内存里流转。 */
  dataUrl: string
  width: number
  height: number
}

export type BrowserPreviewServiceParams = {
  /** 采集某个真实标签的当前画面；返回 null = 这次没采到（保留旧图）。 */
  capture: (tabId: string) => Promise<PreviewCaptureResult | null>
  emit: (event: BrowserPreviewEvent) => void
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 同一标签的事件合并窗口。 */
  debounceMs?: number
  /** 同一标签两次采集的最小间隔（含失败）。 */
  minIntervalMs?: number
  /** 内存里最多保留多少张预览（超出按最旧淘汰）。 */
  maxEntries?: number
}

export const PREVIEW_DEBOUNCE_MS = 700
export const PREVIEW_MIN_INTERVAL_MS = 2_000
export const PREVIEW_MAX_ENTRIES = 12

/**
 * 采集几何：16:10 的桌面视口，不是把页面缩成手机宽度。
 * 卡片按 object-fit: cover 展示，比例一致就不会拉伸。
 */
export const PREVIEW_CAPTURE_WIDTH = 1280
export const PREVIEW_CAPTURE_HEIGHT = 800
/** 入库前的压缩宽度：640 宽在 2x 屏上仍然清晰，单张约 40–80 KB。 */
export const PREVIEW_STORE_WIDTH = 640
export const PREVIEW_JPEG_QUALITY = 68
/** 把视图临时放到窗口外后，等一帧再截图（Chromium 需要一次绘制）。 */
export const PREVIEW_PRIME_DELAY_MS = 140

export class BrowserPreviewService {
  private readonly cache = new Map<string, BrowserPreview>()
  private readonly pending = new Set<string>()
  private readonly timers = new Map<string, unknown>()
  private readonly lastAttemptAt = new Map<string, number>()
  private readonly capture: BrowserPreviewServiceParams['capture']
  private readonly emit: BrowserPreviewServiceParams['emit']
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly debounceMs: number
  private readonly minIntervalMs: number
  private readonly maxEntries: number

  private running = false
  private disposed = false

  constructor(params: BrowserPreviewServiceParams) {
    this.capture = params.capture
    this.emit = params.emit
    this.now = params.now ?? Date.now
    this.setTimer = params.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = params.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.debounceMs = params.debounceMs ?? PREVIEW_DEBOUNCE_MS
    this.minIntervalMs = params.minIntervalMs ?? PREVIEW_MIN_INTERVAL_MS
    this.maxEntries = params.maxEntries ?? PREVIEW_MAX_ENTRIES
  }

  /** 页面加载/导航/标题变化时调用：合并短时间内的多次事件。 */
  schedule(tabId: string): void {
    if (this.disposed || !tabId) return
    const existing = this.timers.get(tabId)
    if (existing !== undefined) this.clearTimer(existing)
    const handle = this.setTimer(() => {
      this.timers.delete(tabId)
      this.pending.add(tabId)
      void this.drain()
    }, this.debounceMs)
    this.timers.set(tabId, handle)
  }

  /** 立即排队一次采集（用户主动刷新、从独立窗口归位后）。 */
  async refresh(tabId: string): Promise<void> {
    if (this.disposed || !tabId) return
    const scheduled = this.timers.get(tabId)
    if (scheduled !== undefined) {
      this.clearTimer(scheduled)
      this.timers.delete(tabId)
    }
    this.pending.add(tabId)
    await this.drain()
  }

  get(tabId: string): BrowserPreview | null {
    return this.cache.get(tabId) ?? null
  }

  list(): BrowserPreview[] {
    return [...this.cache.values()].sort((a, b) => b.capturedAt - a.capturedAt)
  }

  /** 标签关闭/销毁：清掉缓存与待办，广播 clear。 */
  forget(tabId: string): void {
    const timer = this.timers.get(tabId)
    if (timer !== undefined) {
      this.clearTimer(timer)
      this.timers.delete(tabId)
    }
    this.pending.delete(tabId)
    this.lastAttemptAt.delete(tabId)
    if (this.cache.delete(tabId)) this.emit({ kind: 'clear', tabId })
  }

  /** 对账：只保留仍然存在的标签（标签在别处被销毁时的兜底）。 */
  prune(liveTabIds: readonly string[]): void {
    const alive = new Set(liveTabIds)
    for (const tabId of [...this.cache.keys()]) {
      if (!alive.has(tabId)) this.forget(tabId)
    }
    for (const tabId of [...this.pending]) {
      if (!alive.has(tabId)) this.pending.delete(tabId)
    }
    for (const tabId of [...this.timers.keys()]) {
      if (!alive.has(tabId)) this.forget(tabId)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const tabId of [...this.timers.keys()]) this.forget(tabId)
    this.timers.clear()
    this.pending.clear()
    this.cache.clear()
    this.lastAttemptAt.clear()
  }

  /** 一次只跑一个采集；期间到达的新任务排在下一轮。 */
  private async drain(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (!this.disposed && this.pending.size > 0) {
        const [tabId] = this.pending
        this.pending.delete(tabId)

        const last = this.lastAttemptAt.get(tabId)
        const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this.now() - last
        if (elapsed < this.minIntervalMs) {
          // 节流：不丢事件，等在剩余时间之后再来一次。
          if (!this.timers.has(tabId)) {
            const handle = this.setTimer(() => {
              this.timers.delete(tabId)
              this.pending.add(tabId)
              void this.drain()
            }, this.minIntervalMs - elapsed)
            this.timers.set(tabId, handle)
          }
          continue
        }

        this.lastAttemptAt.set(tabId, this.now())
        let result: PreviewCaptureResult | null = null
        try {
          result = await this.capture(tabId)
        } catch {
          // 截图失败是常态（页面还没绘制、窗口最小化、渲染进程崩溃）：
          // 保留上一张有效预览，等下一个页面事件再试。
          result = null
        }
        if (this.disposed) return
        if (!result) continue

        const preview: BrowserPreview = {
          tabId,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          capturedAt: this.now()
        }
        this.cache.set(tabId, preview)
        this.evict()
        this.emit({ kind: 'update', preview })
      }
    } finally {
      this.running = false
    }
  }

  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      let oldestId: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, preview] of this.cache) {
        if (preview.capturedAt < oldestAt) {
          oldestAt = preview.capturedAt
          oldestId = id
        }
      }
      if (oldestId === null) return
      this.cache.delete(oldestId)
      this.emit({ kind: 'clear', tabId: oldestId })
    }
  }
}
