import type { BrowserDragFrame } from '../../shared/contracts/browser'

/**
 * 主进程拖拽会话（Phase 3）——「拖出主窗口」的权威裁判。
 *
 * 为什么判定必须住在主进程：真实桌面上，光标离开 BrowserWindow 之后渲染层
 * 拿不到可靠的 pointer 事件（macOS/Windows 都只保证窗口内投递；Phase 2 的
 * E2E 用合成事件绕过了这一点，真实拖动因此经常丢 pointerup、会话挂死）。
 * 主进程用 `screen.getCursorScreenPoint()` 轮询系统光标——它在拖动全程、
 * 包括光标在任何窗口之外时都有效。
 *
 * 终态语义（与规格 §3 对齐）：
 * - 渲染层 `drop` 在窗口内被接受（排序 / 加入圆桌）→ `markDropHandled()`：
 *   会话按「内部投放」收尾，**不**拆窗；
 * - `end()` 时光标（或兜底坐标）在任何已知窗口之外 → `onReleaseOutside`，
 *   由调用方拆出独立窗口；
 * - 其余情况（窗口内松手、Esc 取消、会话被顶掉）→ 取消，什么都不做。
 *
 * 会话是**单例**：一次只可能有一个鼠标拖动；重复 begin 返回 false 并保留
 * 现有会话，绝不会一次拖动拆出两个窗口。
 */

export type DragKind = 'webcard' | 'roundtable'
export type DragPoint = { x: number; y: number }

export type BrowserDragSessionParams = {
  /** 系统光标读数（screen.getCursorScreenPoint）。可注入以便单测。 */
  cursor: () => DragPoint
  /** 光标落点判定：null = 任何已知窗口之外。可注入以便单测。 */
  classify: (point: DragPoint) => { windowId: number | null; mainWindow: boolean }
  /** 会话帧广播（outside 变化或会话开始/结束时各推一次）。 */
  onFrame: (frame: BrowserDragFrame) => void
  /** 会话以「窗口外松手」收尾（调用方负责拆窗）。 */
  onReleaseOutside: (kind: DragKind, tabId: string | null, point: DragPoint) => void
  /** 轮询间隔；默认 32ms（约两帧）。 */
  pollIntervalMs?: number
  /** 看门狗上限：begin 后超过这个毫秒数还没有 end/cancel，强制收尾。 */
  watchdogMs?: number
  /** 链路埋点（开发期排障用；缺省不打）。 */
  log?: (message: string) => void
}

type ActiveSession = {
  kind: DragKind
  tabId: string | null
  outside: boolean
  dropHandled: boolean
  timer: ReturnType<typeof setInterval>
  watchdog: ReturnType<typeof setTimeout>
  /** 最近一次轮询到的光标位置；end() 无兜底坐标时用它。 */
  lastCursor: DragPoint | null
}

export class BrowserDragSessionManager {
  private session: ActiveSession | null = null
  private readonly pollIntervalMs: number
  private readonly watchdogMs: number
  private readonly log: (message: string) => void

  constructor(private readonly params: BrowserDragSessionParams) {
    this.pollIntervalMs = Math.max(8, params.pollIntervalMs ?? 32)
    this.watchdogMs = Math.max(this.pollIntervalMs * 4, params.watchdogMs ?? 45_000)
    this.log = params.log ?? (() => undefined)
  }

  /** 是否有进行中的会话（供测试与调试）。 */
  active(): BrowserDragFrame | null {
    const session = this.session
    if (!session) return null
    return { active: true, kind: session.kind, tabId: session.tabId, outside: session.outside }
  }

  /**
   * 开始会话。已有会话时**拒绝**新会话并保持旧会话——一次物理拖动只会
   * 产生一个 dragstart；竞态下宁可不响应，也不能双开窗口。
   */
  begin(kind: DragKind, tabId: string | null): boolean {
    if (this.session) {
      this.log(`begin rejected: session ${this.session.kind}/${this.session.tabId ?? '-'} still active`)
      return false
    }
    const point = this.readCursor()
    const outside = this.params.classify(point).windowId === null
    const session: ActiveSession = {
      kind,
      tabId,
      outside,
      dropHandled: false,
      lastCursor: point,
      timer: setInterval(() => this.poll(), this.pollIntervalMs),
      watchdog: setTimeout(() => {
        // dragend 丢失（原生会话被外部打断）时的兜底：强制收尾，
        // 否则单例会挡住之后每一次拖动（「永远拖不出来」的次生灾害）。
        this.log(`watchdog fired: session ${kind}/${tabId ?? '-'} exceeded ${this.watchdogMs}ms`)
        this.cancel()
      }, this.watchdogMs)
    }
    this.session = session
    this.log(`begin ${kind}/${tabId ?? '-'} at (${Math.round(point.x)}, ${Math.round(point.y)}) outside=${outside}`)
    this.params.onFrame({ active: true, kind, tabId, outside })
    return true
  }

  /** 窗口内的 drop 被接受（排序 / 加入圆桌）：会话不得再拆窗。 */
  markDropHandled(): void {
    if (this.session) this.session.dropHandled = true
  }

  /**
   * 终态：渲染层 dragend。
   *
   * 松手位置的优先级：主进程轮询的光标（真实拖动，窗口外也可靠）>
   * 渲染层兜底坐标（合成事件 / 单测）> 最后一次轮询读数。
   * `expectedTabId` 用于识别**过期会话**：上报的 tabId 与会话里的不一致
   * （上一次 dragend 丢失留下的残会话）时，只取消、绝不拆错窗口。
   */
  end(fallbackPoint?: DragPoint, expectedTabId?: string): void {
    const session = this.session
    if (!session) {
      this.log('end ignored: no active session')
      return
    }
    if (expectedTabId !== undefined && session.tabId !== expectedTabId) {
      this.log(`end mismatch: session ${session.kind}/${session.tabId ?? '-'} ≠ reported ${expectedTabId}, cancel stale`)
      this.cancel()
      return
    }
    this.teardown()
    if (session.dropHandled) {
      this.log(`end ${session.kind}/${session.tabId ?? '-'}: drop handled inside, no detach`)
      return
    }
    // 松手位置优先级：end() 时实时读一次光标（最准）> 会话期间最后一次
    // 轮询读数 > 渲染层兜底坐标。真实拖动里渲染层在窗口外拿到的坐标不可信
    // （可能停在窗口边缘），所以兜底只在前两者都拿不到时使用。
    const live = this.readCursor()
    const released =
      Number.isFinite(live.x) && Number.isFinite(live.y)
        ? live
        : (this.lastCursorOf(session) ?? (fallbackPoint ?? null))
    if (!released) {
      this.log(`end ${session.kind}/${session.tabId ?? '-'}: no usable cursor reading, cancel`)
      return
    }
    const target = this.params.classify(released)
    if (target.windowId !== null) {
      this.log(`end ${session.kind}/${session.tabId ?? '-'}: released inside window ${target.windowId}, cancel`)
      return
    }
    this.log(`release outside ${session.kind}/${session.tabId ?? '-'} at (${Math.round(released.x)}, ${Math.round(released.y)})`)
    this.params.onReleaseOutside(session.kind, session.tabId, released)
  }

  /** 强制收尾（标签被关闭、窗口销毁、应用退出）：不拆窗、只广播结束。 */
  cancel(): void {
    if (!this.session) return
    this.log(`cancel ${this.session.kind}/${this.session.tabId ?? '-'}`)
    this.teardown()
  }

  /** E2E / 单测注入假光标（真实环境绝不调用）。 */
  overrideCursor(point: DragPoint | null): void {
    this.cursorOverride = point
  }

  private cursorOverride: DragPoint | null = null

  private readCursor(): DragPoint {
    if (this.cursorOverride) return this.cursorOverride
    try {
      return this.params.cursor()
    } catch {
      // screen API 失效（极端环境）：退化为「无读数」，end() 用兜底坐标。
      return this.session?.lastCursor ?? { x: Number.NaN, y: Number.NaN }
    }
  }

  private lastCursorOf(session: ActiveSession): DragPoint | null {
    if (this.cursorOverride) return this.cursorOverride
    if (Number.isFinite(session.lastCursor?.x) && Number.isFinite(session.lastCursor?.y)) {
      return session.lastCursor
    }
    return null
  }

  private poll(): void {
    const session = this.session
    if (!session) return
    const point = this.readCursor()
    // 无有效读数（screen API 失效）：保持上一帧，不要把 NaN 判成「窗口外」。
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    session.lastCursor = point
    const outside = this.params.classify(point).windowId === null
    if (outside !== session.outside) {
      session.outside = outside
      this.params.onFrame({ active: true, kind: session.kind, tabId: session.tabId, outside })
    }
  }

  private teardown(): void {
    const session = this.session
    if (!session) return
    this.session = null
    clearInterval(session.timer)
    clearTimeout(session.watchdog)
    this.params.onFrame({ active: false, kind: session.kind, tabId: session.tabId, outside: session.outside })
  }
}
