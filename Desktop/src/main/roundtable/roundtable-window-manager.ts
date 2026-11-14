import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { WINDOW_CHROME } from '../appearance'
import { fitRectIntoBounds } from '../../shared/window-placement'
import { ROUNDTABLE_WINDOW_MIN_HEIGHT, ROUNDTABLE_WINDOW_MIN_WIDTH } from '../../shared/roundtable'
import { FLOAT_TITLEBAR_HEIGHT } from '../browser/float-window'

/**
 * 圆桌独立窗口（Phase 3）：**唯一实例**的 BrowserWindow。
 *
 * 与浏览器浮窗同一套规则：
 * - 加载本应用自己的 Renderer，hash 路由 `#bpRoundtable=<id>`（与
 *   `#bpFloat` 互不冲突；不用 query，file:// 下 hash 不触发 CORS 问题）；
 * - 同一套 preload / sandbox / contextIsolation；
 * - macOS hiddenInset 融合标题栏。
 *
 * 生命周期铁律：**这个窗口不拥有圆桌状态**。状态在 RoundtableService；
 * 用户点系统 ✕ = 归位（intercept close → onUserClose），参与者、草稿、
 * 顺序全部保留。重复 detach 时只聚焦现有窗口，绝不创建第二个。
 */

export type RoundtableWindowManagerParams = {
  devServerUrl: string | null
  /** 圆桌 id（目前固定一张桌）。 */
  roundtableId: string
  /** 主窗口位置（按钮拆出时级联摆放的锚点；macOS 关窗会换实例，用取值函数）。 */
  mainWindowPosition: () => { x: number; y: number } | null
  /** 用户点系统 ✕（非程序化关闭）：装配层接 RoundtableService.dock()。 */
  onUserClose: () => void
  /**
   * 窗口被**外部**销毁（崩溃 / destroy()，没走 'close' 事件）：
   * 装配层接 RoundtableService.dock()，避免状态永远卡在 detached。
   */
  onWindowLost: () => void
  /** 窗口增减后的通知（刷新广播范围）。 */
  onChange: () => void
  /** 应用正在退出：系统 ✕ 拦截必须放行，否则 quit 被卡死。 */
  isQuitting?: () => boolean
}

export class RoundtableWindowManager {
  private window: BrowserWindow | null = null
  /** 程序化关闭（归位）标记：系统 ✕ 的拦截只在用户发起时生效。 */
  private closing = false

  constructor(private readonly params: RoundtableWindowManagerParams) {}

  isAlive(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  windowId(): number | null {
    return this.isAlive() ? this.window!.id : null
  }

  /** 创建（或聚焦已存在的）圆桌窗口；`near` 是松手的屏幕坐标。 */
  create(near?: { x: number; y: number }): BrowserWindow {
    if (this.isAlive()) {
      this.focus()
      return this.window!
    }

    const mac = process.platform === 'darwin'
    const windows = process.platform === 'win32'
    const chrome = WINDOW_CHROME.light
    const width = 680
    const height = 540

    const window = new BrowserWindow({
      width,
      height,
      minWidth: ROUNDTABLE_WINDOW_MIN_WIDTH,
      minHeight: ROUNDTABLE_WINDOW_MIN_HEIGHT,
      show: false,
      title: 'BrewPhase Roundtable',
      backgroundColor: chrome.background,
      titleBarStyle: mac ? 'hiddenInset' : windows ? 'hidden' : 'default',
      ...(windows
        ? {
            titleBarOverlay: {
              color: chrome.background,
              symbolColor: chrome.symbol,
              height: FLOAT_TITLEBAR_HEIGHT
            }
          }
        : {}),
      autoHideMenuBar: !mac,
      // 壳页是自家可信页面：同一套 preload / sandbox（要读圆桌快照与调 IPC）。
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false
      }
    })

    this.window = window
    this.closing = false

    // 系统 ✕ = 归位：拦下关闭，交给装配层调 service.dock()（它再程序化
    // 关窗）。窗口不拥有状态，所以「关闭」永远不丢数据。
    // 应用退出（quitting）时不拦：否则 app.quit() 会被永远卡住。
    window.on('close', (event) => {
      if (this.closing || this.params.isQuitting?.()) return
      event.preventDefault()
      this.params.onUserClose()
    })
    window.on('closed', () => {
      const lostNotViaDock = !this.closing && !this.params.isQuitting?.()
      this.window = null
      this.closing = false
      this.params.onChange()
      if (lostNotViaDock) this.params.onWindowLost()
    })

    if (this.params.devServerUrl) {
      void window.loadURL(`${this.params.devServerUrl}/#bpRoundtable=${this.params.roundtableId}`)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'), {
        hash: `bpRoundtable=${this.params.roundtableId}`
      })
    }

    window.once('ready-to-show', () => {
      window.show()
      if (near) this.placeNear(window, near, width, height)
    })
    // 没给落点（按钮拆出）：贴着主窗口右上方向级联摆放。
    if (!near) {
      const main = this.params.mainWindowPosition()
      if (main) window.setPosition(main.x + 80, main.y + 80)
    }
    return window
  }

  /** 落点所在显示器的工作区内贴着松手点摆窗（允许负坐标，禁止跑出屏幕）。 */
  private placeNear(window: BrowserWindow, point: { x: number; y: number }, width: number, height: number): void {
    try {
      const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
      const rect = fitRectIntoBounds(point, width, height, display.workArea)
      window.setPosition(rect.x, rect.y)
    } catch {
      // screen API 失效：停在默认位置，不阻断拆出。
    }
  }

  /** 程序化归位关闭；窗口不存在时是空操作。 */
  close(): void {
    const window = this.window
    if (!window || window.isDestroyed()) {
      this.window = null
      return
    }
    this.closing = true
    window.close()
  }

  focus(): boolean {
    if (!this.isAlive()) return false
    this.window!.focus()
    return true
  }

  /** 应用退出：直接销毁（不触发归位回环）。 */
  closeAll(): void {
    if (!this.window) return
    const window = this.window
    this.window = null
    this.closing = true
    if (!window.isDestroyed()) window.destroy()
  }

  /** 向圆桌窗口广播（装配层把 service.broadcast 接到这里合并发送）。 */
  send(channel: string, payload: unknown): void {
    if (this.isAlive()) {
      this.window!.webContents.send(channel, payload)
    }
  }
}
