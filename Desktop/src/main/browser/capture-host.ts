import { BaseWindow } from 'electron'
import { PREVIEW_CAPTURE_HEIGHT, PREVIEW_CAPTURE_WIDTH } from './browser-preview'

/**
 * 缩略图采集宿主：一个**用户看不见**的 BaseWindow。
 *
 * 为什么需要它：实测 `WebContentsView` 只有真正落在可见窗口内容区里才会
 * 获得绘制表面；隐藏或放在窗口外的视图 `capturePage()` 直接返回空图。
 * 但把网页在主窗口里闪一下再截既打扰用户，也不符合「卡片安静收纳」的语义。
 *
 * 这里的做法：
 * - 窗口 `opacity: 0` + `focusable: false` + `ignoreMouseEvents`，用户看不见、
 *   点不到、也抢不走焦点；
 * - 收在架子上的标签**挂在这个窗口里**（同一个 WebContentsView，不是第二份
 *   网页实例），保持 1280×800 的桌面视口，所以卡片预览永远是正常桌面比例；
 * - 展开时把 view 迁回主窗口，收回时再迁回来——只动父子关系，不 loadURL。
 *
 * BaseWindow 没有 renderer，因此不会出现在 `BrowserWindow.getAllWindows()`
 * 的界面列表里，也不会被 Playwright 当成一个页面窗口。
 */
export class BrowserCaptureHost {
  private window: BaseWindow | null = null

  constructor(private readonly mainWindowBounds: () => Electron.Rectangle | null) {}

  /** 按需创建并显示（inactive）。创建失败时返回 null：预览退化为占位。 */
  ensure(): BaseWindow | null {
    // Linux 的窗口 opacity 不受支持：透明宿主会变成一个真窗口盖在主界面上。
    // 宁可没有「未展示页」的缩略图，也不能打扰用户。
    if (process.platform === 'linux') return null
    if (this.window && !this.window.isDestroyed()) {
      // 主窗口关闭时 hide 过；再次收纳时要重新显示，否则没有绘制表面。
      if (!this.window.isVisible()) this.window.showInactive()
      return this.window
    }
    const main = this.mainWindowBounds()
    const window = new BaseWindow({
      show: false,
      opacity: 0,
      width: PREVIEW_CAPTURE_WIDTH,
      height: PREVIEW_CAPTURE_HEIGHT,
      x: (main?.x ?? 40) + 24,
      y: (main?.y ?? 40) + 24,
      focusable: false,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      skipTaskbar: true,
      title: 'BrewPhase Preview Surface',
      backgroundColor: '#00000000'
    })
    // 透明窗口仍然会接鼠标事件；显式穿透，避免挡住主窗口（尤其拖拽时）。
    window.setIgnoreMouseEvents(true, { forward: true })
    window.showInactive()
    this.window = window
    return window
  }

  id(): number | null {
    if (!this.window || this.window.isDestroyed()) return null
    return this.window.id
  }

  is(windowId: number | null): boolean {
    return windowId !== null && windowId === this.id()
  }

  /** 主窗口关闭时把宿主也藏起来：此时没有预览需求，也不该留一个空窗口。 */
  hide(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.hide()
  }

  dispose(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = null
      return
    }
    this.window.destroy()
    this.window = null
  }
}
