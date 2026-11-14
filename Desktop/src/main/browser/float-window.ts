import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { WINDOW_CHROME } from '../appearance'
import { fitRectIntoBounds } from '../../shared/window-placement'

/**
 * 独立浏览器窗口：标签被拖出主窗口后的新家。
 *
 * 用与主窗口**同一套融合标题栏**（macOS hiddenInset / Windows titleBarOverlay），
 * 加载本应用的页面（`?bpFloat=1`），React 检测到参数后只渲染「品牌标题栏 +
 * 标签条」——它不是另一个软件的窗口，是 BrewPhase 的第二张桌子。
 *
 * 生命周期铁律：**这个窗口不拥有任何网页**。`close` 时把 tab 全部归还主窗口
 *（在窗口真正销毁之前，'close' 事件里做），然后才允许默认关闭流程继续。
 * 网页实例的生杀只在 BrowserTabManager 手里。
 */

export const FLOAT_WINDOW_MIN_WIDTH = 560
export const FLOAT_WINDOW_MIN_HEIGHT = 420
/** 浮窗 React 壳的标题栏高度：与主窗口 .topbar 同为 44px。 */
export const FLOAT_TITLEBAR_HEIGHT = 44

type FloatWindowRecord = {
  window: BrowserWindow
  /** 当前归属这个窗口的标签（维护一份镜像，便于归还与判空）。 */
  tabIds: Set<string>
  /** 浮窗内当前激活的标签（浮窗自己的切换语义）。 */
  activeTabId: string | null
}

export type FloatWindowManagerParams = {
  /** 主窗口 id：归还 tab 的目的地。可能随 macOS 关窗重建，用取值函数。 */
  mainWindowId: () => number | null
  devServerUrl: string | null
  /** tab 归还 / 窗口增减后通知（刷新状态广播）。 */
  onChange: () => void
  /** 窗口关闭流程完成后的清理回调（含「最后一个浮窗关了」）。 */
  onWindowClosed: (windowId: number) => void
  /** 归还回调：BrowserManager 注入「moveToWindow 主窗口」的实际动作。 */
  onReattach: (tabId: string) => void
}

export class FloatWindowManager {
  private readonly windows = new Map<number, FloatWindowRecord>()

  constructor(private readonly params: FloatWindowManagerParams) {}

  windowIds(): number[] {
    return [...this.windows.keys()]
  }

  record(windowId: number): FloatWindowRecord | null {
    return this.windows.get(windowId) ?? null
  }

  /** 主窗口 bounds（screen 坐标，DIP），拖动落点判定与浮窗初始位置都用它。 */
  mainWindowBounds(): { x: number; y: number; width: number; height: number } | null {
    const main = BrowserWindow.fromId(this.params.mainWindowId() ?? -1)
    if (!main || main.isDestroyed()) return null
    return main.getBounds()
  }

  /** 光标落在哪个已知窗口里。null = 窗口之外（松手将拆出新浮窗）。 */
  windowAt(screenX: number, screenY: number): { windowId: number | null; mainWindow: boolean } {
    const mainId = this.params.mainWindowId()
    for (const id of [mainId, ...this.windowIds()]) {
      if (id === null) continue
      const win = BrowserWindow.fromId(id)
      if (!win || win.isDestroyed()) continue
      const b = win.getBounds()
      if (screenX >= b.x && screenX <= b.x + b.width && screenY >= b.y && screenY <= b.y + b.height) {
        return { windowId: id, mainWindow: id === mainId }
      }
    }
    return { windowId: null, mainWindow: false }
  }

  /**
   * 创建独立窗口并把标签接进去。
   *
   * `moveToWindow` 由调用方（BrowserManager）完成——这里只管窗口本身的创建、
   * 壳页加载与关闭语义，不碰 view。
   */
  create(tabId: string, near?: { screenX: number; screenY: number }): BrowserWindow {
    const main = this.mainWindowBounds()
    const width = Math.max(FLOAT_WINDOW_MIN_WIDTH, Math.round((main?.width ?? 1200) * 0.62))
    const height = Math.max(FLOAT_WINDOW_MIN_HEIGHT, Math.round((main?.height ?? 760) * 0.72))
    const offset = this.windows.size * 32

    const mac = process.platform === 'darwin'
    const windows = process.platform === 'win32'
    const chrome = WINDOW_CHROME.light

    const window = new BrowserWindow({
      width,
      height,
      minWidth: FLOAT_WINDOW_MIN_WIDTH,
      minHeight: FLOAT_WINDOW_MIN_HEIGHT,
      show: false,
      title: 'BrewPhase Browser',
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
      // 壳页是自家可信页面，与主窗口同一套 preload / sandbox——
      // 它要通过 brewphase.* 调 IPC（标签切换、bounds 上报、拖回）。
      // 漏了 preload，window.brewphase 就是 undefined，React 初始化即崩、
      // 界面只剩一块底色。
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

    const record: FloatWindowRecord = { window, tabIds: new Set([tabId]), activeTabId: tabId }
    this.windows.set(window.id, record)

    // close（销毁前）：把还挂在这里的标签全部归还主窗口。主窗口不存在时
    // （macOS 关主窗），tab 落到「未挂载」，等主窗口重建或应用退出处理。
    window.on('close', () => {
      // 归还动作必须在窗口销毁前完成；BrowserManager 通过 onReattach 接手。
      this.reattachAll(window.id)
    })
    window.on('closed', () => {
      this.windows.delete(window.id)
      this.params.onWindowClosed(window.id)
    })

    // 壳页：同一个 React 应用，靠 **hash** 走浮窗分支。
    // 不用 query：file:// 页面带 query 时，ES module 的脚本在部分场景下
    // 会被 CORS 拦掉（实测 #root 空白且 console 全静默）；hash 则完全无此问题。
    if (this.params.devServerUrl) {
      void window.loadURL(`${this.params.devServerUrl}/#bpFloat=${window.id}`)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'), {
        hash: `bpFloat=${window.id}`
      })
    }

    window.once('ready-to-show', () => window.show())
    if (near) {
      // 落点所在显示器的工作区：扩展屏在主屏左/上时坐标是负的，
      // 绝不能 Math.max(0, …)——那会把窗口拽到主显示器上（Phase 3 修的真实缺陷）。
      const point = { x: Math.round(near.screenX), y: Math.round(near.screenY) }
      const display = screen.getDisplayNearestPoint(point)
      const rect = fitRectIntoBounds(point, width, height, display.workArea)
      window.setPosition(rect.x, rect.y)
    } else if (main) {
      window.setPosition(main.x + 60 + offset, main.y + 60 + offset)
    }
    return window
  }

  /** 把 tab 记进这个窗口的镜像（BrowserManager 在 moveToWindow 成功后调用）。 */
  adopt(windowId: number, tabId: string): void {
    const record = this.windows.get(windowId)
    if (!record) return
    record.tabIds.add(tabId)
    record.activeTabId = tabId
    this.params.onChange()
  }

  /** tab 离开这个窗口（拖回主窗口 / 关闭）。 */
  release(windowId: number, tabId: string): void {
    const record = this.windows.get(windowId)
    if (!record) return
    record.tabIds.delete(tabId)
    if (record.activeTabId === tabId) {
      record.activeTabId = [...record.tabIds][0] ?? null
    }
    this.params.onChange()
  }

  activateIn(windowId: number, tabId: string): void {
    const record = this.windows.get(windowId)
    if (!record || !record.tabIds.has(tabId)) return
    record.activeTabId = tabId
    this.params.onChange()
  }

  activeTabId(windowId: number): string | null {
    return this.windows.get(windowId)?.activeTabId ?? null
  }

  focus(windowId: number): void {
    BrowserWindow.fromId(windowId)?.focus()
  }

  /** 归还本窗口全部标签到主窗口；窗口随后按正常关闭流程销毁。 */
  reattachAll(windowId: number): void {
    const record = this.windows.get(windowId)
    if (!record) return
    for (const tabId of [...record.tabIds]) {
      // 归还动作由 BrowserManager 完成（moveToWindow 主窗口 + 清 active），
      // 这里只负责窗口自己的账——避免两个管理者互相改对方的状态。
      this.release(windowId, tabId)
      this.params.onReattach(tabId)
    }
  }

  /** 空浮窗就地关闭（最后一个标签被拖回/关闭后）。 */
  closeEmpty(windowId: number): void {
    const record = this.windows.get(windowId)
    if (!record || record.tabIds.size > 0) return
    record.window.destroy()
    this.windows.delete(windowId)
    this.params.onWindowClosed(windowId)
  }

  /** 应用退出 / 主窗口销毁：窗口也要一并收掉（tab 由 TabManager 统一销毁）。 */
  closeAll(): void {
    for (const record of [...this.windows.values()]) {
      const win = record.window
      if (!win.isDestroyed()) win.destroy()
    }
    this.windows.clear()
  }
}
