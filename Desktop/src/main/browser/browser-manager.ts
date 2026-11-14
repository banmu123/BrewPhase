import { BrowserWindow, screen, shell } from 'electron'
import type { Db } from '../database/client'
import {
  BROWSER_CHANGED_CHANNEL,
  BROWSER_DRAG_CHANNEL,
  BROWSER_PREVIEW_CHANNEL,
  type BrowserBounds,
  type BrowserDragFrame,
  type BrowserDragProbe,
  type BrowserLoadError,
  type BrowserOpenInput,
  type BrowserPreview,
  type BrowserPreviewEvent,
  type BrowserState,
  type BrowserTabInfo,
  type BrowserVisit
} from '../../shared/contracts/browser'
import { isAllowedBrowserURL, normalizeBrowserURL, resolveBrowserInput } from '../../shared/browser-url'
import { clampBrowserBounds, type BrowserViewport } from '../../shared/browser-layout'
import {
  readBrowserLayout,
  readBrowserRecent,
  recordBrowserVisit,
  retitleBrowserVisit,
  writeBrowserLayout
} from './history-store'
import { BrowserTabManager } from './browser-tab-manager'
import { FloatWindowManager, FLOAT_TITLEBAR_HEIGHT } from './float-window'
import { BrowserCaptureHost } from './capture-host'
import { BrowserDragSessionManager, type DragPoint } from './browser-drag'
import {
  BrowserPreviewService,
  PREVIEW_CAPTURE_HEIGHT,
  PREVIEW_CAPTURE_WIDTH,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_PRIME_DELAY_MS,
  PREVIEW_STORE_WIDTH,
  type PreviewCaptureResult
} from './browser-preview'

/**
 * 内置浏览器的总管理者（主进程）。
 *
 * 为什么必须收在一个类里：WebContentsView 是**原生视图**，不在 React DOM 里，
 * 它的创建、销毁、bounds、可见性、导航与权限都不能分散到各个页面。渲染层只能
 * 通过 IPC 表达意图，真实状态永远以这里为准，再广播回去。
 *
 * 边界（在此前四条的基础上新增两条）：
 * 1. **标签制**：一个浏览器里有多个标签；主窗口浮窗显示其中一个（activeTab），
 *    其余挂载在独立窗口或未挂载。tab 的身份与生死由 `BrowserTabManager` 管，
 *    这里只管「显示与调度」。
 * 2. **关闭 ≠ 登出**：销毁 view 不动 `persist:brewphase-browser` 分区。
 * 3. **网页是外来的**：sandbox、无 preload、权限全拒、只认 http/https。
 * 4. **几何单向流入**：各窗口的渲染层上报各自的内容区矩形。
 * 5. **拖动的是页面实例**：拆分/合并 = 改 view 的父窗口，绝不重新 loadURL。
 * 6. **销毁只发生在 TabManager**：窗口关闭只是「归还」。
 */

export type BrowserManagerParams = {
  db: Db
  /** 主窗口按需取：macOS 关窗再激活会换一个 BrowserWindow 实例。 */
  getWindow: () => BrowserWindow | null
  /** 浮窗壳页与主窗口同一份 React 应用；dev 走 dev server。 */
  devServerUrl: string | null
  /**
   * 共享拖拽会话（Phase 3）：由装配层传入，圆桌与网页卡片共用同一个
   * 「单鼠标」会话；不传则内部自建一个（仅网页卡片用）。
   */
  drag?: BrowserDragSessionManager
  /** 标签被销毁时的旁路通知（圆桌用它摘除失效参与者）。 */
  onTabClosed?: (tabId: string) => void
}

/** 主窗口浮窗里网页区的对齐以渲染层上报的 stage 矩形为准（见 applyBounds）。 */

export class BrowserManager {
  private readonly db: Db
  private readonly getWindow: () => BrowserWindow | null
  private readonly devServerUrl: string | null

  private readonly tabs: BrowserTabManager
  private readonly floats: FloatWindowManager
  /** 缩略图：真实截图的内存缓存（不进库、不上云）。 */
  private readonly previews: BrowserPreviewService
  /** 收纳在架子上的标签挂在这里：透明、不可点、不抢焦点，但有绘制表面。 */
  private readonly captureHost: BrowserCaptureHost
  /** 拖拽会话（卡片拖出 / 圆桌拆出的权威裁判）。 */
  private readonly drag: BrowserDragSessionManager

  /** 主窗口浮窗当前显示的标签；null = 起始页。 */
  private activeTabId: string | null = null
  /** 主窗口浮窗是否被用户打开。 */
  private panelVisible = false
  /** 主窗口浮窗是否停在起始页（activeTab 仍活着，只是被起始页盖住）。 */
  private startPage = true

  private bounds: BrowserBounds | null
  private recent: BrowserVisit[]

  private emitScheduled = false
  private persistTimer: NodeJS.Timeout | null = null

  constructor(params: BrowserManagerParams) {
    this.db = params.db
    this.getWindow = params.getWindow
    this.devServerUrl = params.devServerUrl
    this.bounds = readBrowserLayout(params.db)
    this.recent = readBrowserRecent(params.db)

    this.previews = new BrowserPreviewService({
      capture: (tabId) => this.capturePreview(tabId),
      emit: (event) => this.emitPreview(event)
    })

    this.captureHost = new BrowserCaptureHost(() => {
      const window = this.getWindow()
      if (!window || window.isDestroyed()) return null
      return window.getBounds()
    })

    this.tabs = new BrowserTabManager({
      mainWindowId: () => this.getWindow()?.id ?? null,
      captureWindowId: () => this.captureHost.id(),
      onPageVisited: (url, title) => {
        this.recent = recordBrowserVisit(this.db, url, title)
      },
      // 页面加载/导航/标题变化 → 合并后重新采集缩略图；标签销毁 → 清缓存
      // 并通知旁路订阅者（圆桌摘除失效参与者）。
      onPageSettled: (tabId) => this.previews.schedule(tabId),
      onTabClosed: (tabId) => {
        // 拖动中的标签被关闭：会话立刻收尾，绝不给死标签拆窗口。
        if (this.drag.active()?.tabId === tabId) this.drag.cancel()
        this.previews.forget(tabId)
        params.onTabClosed?.(tabId)
      },
      onChange: () => this.emit()
    })

    this.floats = new FloatWindowManager({
      mainWindowId: () => this.getWindow()?.id ?? null,
      devServerUrl: this.devServerUrl,
      onChange: () => this.emit(),
      onWindowClosed: () => this.emit(),
      // 浮窗关闭（系统 ✕）：用户没有「关闭网页」的意图——标签收回到
      // 卡片架（采集宿主），**不**打开主窗口 BrowserPanel，不销毁页面。
      // 生杀仍只在 TabManager 手里（卡片架的 ✕ 才是真正的关闭）。
      onReattach: (tabId) => this.recallToShelf(tabId)
    })

    // 拖拽会话：装配层传入共享实例（圆桌同用）；缺省时自建，仅供卡片用。
    this.drag =
      params.drag ??
      new BrowserDragSessionManager({
        cursor: () => screen.getCursorScreenPoint(),
        classify: (point) => this.floats.windowAt(point.x, point.y),
        onFrame: () => undefined,
        onReleaseOutside: (kind, tabId, point) => {
          if (kind === 'webcard' && tabId) this.detachTab(tabId, point.x, point.y)
        },
        log: (message) => console.log(`[drag] ${message}`)
      })
  }

  // MARK: - 对外状态

  state(): BrowserState {
    const active = this.activeTab()
    const history = readHistory(this.webContentsOf(active))
    const mainWindowId = this.getWindow()?.id ?? null
    const tabs: BrowserTabInfo[] = this.tabs.list().map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      progress: tab.progress,
      error: tab.error,
      windowId: tab.windowId,
      detached: tab.detached,
      parked: tab.parked,
      // 「正在主窗口里看」= 面板打开、不在起始页、且它是当前标签。
      // 只看 activeTabId 会把「面板已收起」误报成正在展开。
      active: tab.id === this.activeTabId && tab.windowId === mainWindowId && this.panelVisible && !this.startPage
    }))
    return {
      tabs,
      activeTabId: this.activeTabId,
      visible: this.panelVisible,
      alive: this.tabs.list().length > 0,
      url: active?.url ?? '',
      startPage: this.startPage,
      title: active?.title ?? '',
      loading: active?.loading ?? false,
      progress: active?.progress ?? 0,
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward,
      error: active?.error ?? null,
      layout: this.bounds,
      lastVisit: this.recent[0] ?? null,
      recent: this.recent
    }
  }

  // MARK: - 打开 / 隐藏 / 关闭

  /** 打开浮窗：给了地址就走导航（必要时开新标签），否则恢复/起始页。 */
  open(input?: BrowserOpenInput): BrowserState {
    this.panelVisible = true
    const requested = input?.url?.trim()
    if (requested) return this.navigate(requested)

    if (this.activeTabId && this.tabs.get(this.activeTabId)) {
      return this.showCurrentPage()
    }
    return this.showStart()
  }

  showStart(): BrowserState {
    this.panelVisible = true
    this.startPage = true
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 从起始页恢复当前标签（不重新加载）。 */
  showCurrentPage(): BrowserState {
    const active = this.activeTab()
    if (!active || !active.url) {
      if (!this.startPage) {
        this.startPage = true
        this.syncVisibility()
        this.emit()
      }
      return this.state()
    }
    // 收纳在采集宿主里的标签：先迁回主窗口，再显示；页面实例不动。
    this.unparkTab(active.id)
    this.panelVisible = true
    this.startPage = false
    active.loading = active.view.webContents.isLoading()
    if (!active.loading && active.error === null) active.progress = 1
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 收起主窗口浮窗：页面回到采集宿主（登录态、滚动位置都留着）。 */
  hide(): BrowserState {
    this.panelVisible = false
    const active = this.activeTab()
    if (active) this.parkTab(active.id)
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /**
   * 关闭主窗口浮窗：**只关闭未拆出的标签**（用户明确要关页面），
   * 已拆出到独立窗口的标签不受影响——它们有自己的窗口与标签条。
   */
  close(): BrowserState {
    this.panelVisible = false
    const active = this.activeTab()
    if (active && active.url) {
      this.recent = recordBrowserVisit(this.db, active.url, active.title)
    }
    // 只关未拆出的标签；detached 的标签在独立窗口里，有自己的关闭入口。
    for (const tab of this.tabs.list()) {
      if (!tab.detached) this.tabs.closeTab(tab.id)
    }
    this.activeTabId = null
    this.startPage = true
    this.emit()
    return this.state()
  }

  // MARK: - 导航

  navigate(rawInput: string): BrowserState {
    const resolved = resolveBrowserInput(rawInput)
    if (resolved.kind === 'invalid') {
      const active = this.activeTab()
      if (active) {
        active.error = {
          code: 0,
          url: rawInput,
          reason: resolved.reason,
          kind: 'input',
          description:
            resolved.reason === 'blocked-scheme'
              ? 'blocked scheme (only http / https)'
              : resolved.reason === 'empty'
                ? 'empty address'
                : 'unparseable address'
        }
      }
      this.startPage = false
      this.syncVisibility()
      this.emit()
      return this.state()
    }
    return this.loadURL(resolved.url)
  }

  loadURL(url: string): BrowserState {
    const normalized = normalizeBrowserURL(url)
    if (!normalized) return this.state()

    this.panelVisible = true
    // 没有激活标签就开一个新标签（并挂到主窗口）——「打开浏览器输入地址」
    // 的第一性语义；已有标签则复用（原单页行为的延续）。
    let active = this.activeTab()
    if (!active) {
      active = this.tabs.createTab(normalized)
      this.activeTabId = active.id
      const mainWindowId = this.getWindow()?.id ?? null
      if (mainWindowId !== null) this.tabs.moveToWindow(active.id, mainWindowId)
    } else {
      this.unparkTab(active.id)
      this.tabs.navigateInTab(active.id, normalized)
    }

    this.startPage = false
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  back(): BrowserState {
    const webContents = this.webContentsOf(this.activeTab())
    if (webContents && readHistory(webContents).canGoBack) {
      this.traverse(webContents, 'back')
    }
    return this.state()
  }

  forward(): BrowserState {
    const webContents = this.webContentsOf(this.activeTab())
    if (webContents && readHistory(webContents).canGoForward) {
      this.traverse(webContents, 'forward')
    }
    return this.state()
  }

  /**
   * 前进/后退。不能用 `navigationHistory.goBack()`：Electron 45 的
   * WebContentsView 上它是空操作（实测）；主路径走页面内导航。
   */
  private traverse(webContents: Electron.WebContents, direction: 'back' | 'forward'): void {
    const script = direction === 'back' ? 'history.back()' : 'history.forward()'
    void webContents
      .executeJavaScript(`${script}; void 0`)
      .catch(() => {
        if (direction === 'back') webContents.navigationHistory.goBack()
        else webContents.navigationHistory.goForward()
      })
  }

  reload(): BrowserState {
    const webContents = this.webContentsOf(this.activeTab())
    if (!webContents) return this.state()
    const active = this.activeTab()
    if (active) active.error = null
    webContents.reload()
    this.emit()
    return this.state()
  }

  stop(): BrowserState {
    this.webContentsOf(this.activeTab())?.stop()
    return this.state()
  }

  openExternal(url?: string): void {
    const active = this.activeTab()
    const target = normalizeBrowserURL(url ?? active?.url ?? '')
    if (target) void shell.openExternal(target)
  }

  /** 关闭某个标签（渲染层标签栏的 ×，或浮窗里最后一个标签）。 */
  closeTab(tabId: string): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    // 关闭激活标签：起始页接管（不自动切别的标签，别替用户做决定）。
    if (this.activeTabId === tabId) {
      this.activeTabId = null
      this.startPage = true
    }
    this.tabs.closeTab(tabId)
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  // MARK: - 标签与窗口

  /** 新建标签：挂在主窗口并立即激活——「＋」的第一性语义。 */
  createTab(): BrowserState {
    const tab = this.tabs.createTab()
    this.activeTabId = tab.id
    this.startPage = false
    this.panelVisible = true
    const mainWindowId = this.getWindow()?.id ?? null
    if (mainWindowId !== null) this.tabs.moveToWindow(tab.id, mainWindowId)
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 主窗口浮窗内切换标签（点击标签条）。拆出去的标签点击 = 聚焦它的浮窗。 */
  activateTab(tabId: string): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    if (tab.detached && tab.windowId !== null) {
      this.floats.focus(tab.windowId)
      return this.state()
    }
    // 架子上的标签（采集宿主）：迁回主窗口再显示；已展开的标签不受影响。
    this.unparkTab(tabId)
    this.activeTabId = tabId
    this.startPage = false
    this.panelVisible = true
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 浮窗内切换标签（独立窗口自己的标签条）。 */
  activateInFloat(windowId: number, tabId: string): BrowserState {
    this.floats.activateIn(windowId, tabId)
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 独立窗口里标签条的 bounds 上报：激活标签铺满标签条以下区域。 */
  setFloatBounds(windowId: number, bounds: BrowserBounds): void {
    const record = this.floats.record(windowId)
    const activeId = record?.activeTabId
    if (!record || !activeId) return
    for (const tabId of record.tabIds) {
      const tab = this.tabs.get(tabId)
      if (!tab) continue
      if (tabId === activeId) {
        // 浮窗壳自己把标题栏/标签条让开，这里直接对齐它上报的 stage 矩形。
        // **必须同时恢复可见性**：从架上拖出的标签在采集宿主里是
        // setVisible(false) 的，moveToWindow 只搬父子关系——漏了这一步，
        // 独立窗口就是「壳正常、内容全空」（Phase 3.4 用户实测 bug）。
        tab.view.setBounds(bounds)
        tab.view.setVisible(true)
      } else {
        tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      }
    }
  }

  /**
   * 拖动落点判定（渲染层在 pointerup 时上报屏幕坐标）：
   * - 主窗口内：接回主窗口（或排序——排序由窗口内 DnD 独立完成，不经过这里）；
   * - 某个浮窗内：移到那个浮窗；
   * - 窗口之外：新建浮窗并移入。
   */
  resolveDrop(tabId: string, screenX: number, screenY: number): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    const target = this.floats.windowAt(screenX, screenY)
    const mainId = this.getWindow()?.id ?? null

    if (target.windowId !== null) {
      // 先记下原窗口再移动：moveToWindow 会改写 tab.windowId，之后就没法
      // 清旧浮窗的账了（这里错过一次，空浮窗就留在屏幕上）。
      const fromWindowId = tab.windowId
      if (target.windowId === mainId) {
        if (fromWindowId !== mainId) this.tabs.moveToWindow(tabId, mainId)
        if (fromWindowId !== null && fromWindowId !== mainId) {
          this.floats.release(fromWindowId, tabId)
          if (this.floats.record(fromWindowId)?.tabIds.size === 0) {
            this.floats.closeEmpty(fromWindowId)
          }
        }
        this.activeTabId = tabId
        this.startPage = false
        this.panelVisible = true
        this.previews.schedule(tabId)
      } else {
        if (fromWindowId !== null && fromWindowId !== target.windowId) {
          this.floats.release(fromWindowId, tabId)
          if (this.floats.record(fromWindowId)?.tabIds.size === 0) {
            this.floats.closeEmpty(fromWindowId)
          }
        }
        this.tabs.moveToWindow(tabId, target.windowId)
        this.floats.adopt(target.windowId, tabId)
      }
    } else {
      // 窗口之外：拆出独立窗口。浮窗初始位置贴着松手点。
      this.detachToNewWindow(tabId, { screenX, screenY })
    }
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 拆出到新独立窗口。 */
  detachToNewWindow(tabId: string, near?: { screenX: number; screenY: number }): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    const window = this.floats.create(tabId, near)
    if (tab.windowId !== null && tab.windowId !== window.id) {
      // 从旧位置摘下（浮窗记账），再挂到新窗口。
      if (this.activeTabId === tabId) {
        // 拆走的是主窗口正显示的那个：起始页接管。
        this.activeTabId = null
        this.startPage = true
      }
      this.floats.release(tab.windowId, tabId)
    }
    this.tabs.moveToWindow(tabId, window.id)
    this.floats.adopt(window.id, tabId)
    this.syncVisibility()
    this.emit()
    // 拆出后重采一次：新窗口尺寸变了，卡片上的预览要跟着更新。
    this.previews.schedule(tabId)
    return this.state()
  }

  /** 拖回主窗口（独立窗口标签栏触发）；最后一个标签离开后浮窗自动关闭。 */
  reattach(tabId: string): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    const mainId = this.getWindow()?.id ?? null
    const fromWindowId = tab.windowId
    if (mainId !== null) this.tabs.moveToWindow(tabId, mainId)
    if (fromWindowId !== null) {
      this.floats.release(fromWindowId, tabId)
      // 空浮窗就地关闭：window 触发 close → reattachAll（已空）→ 清账。
      if (this.floats.record(fromWindowId)?.tabIds.size === 0) {
        this.floats.closeEmpty(fromWindowId)
      }
    }
    this.activeTabId = tabId
    this.startPage = false
    this.panelVisible = true
    this.syncVisibility()
    this.emit()
    // 拖回主窗口后刷新：卡片恢复缩略状态时显示的是当前页面，不是旧画面。
    this.previews.schedule(tabId)
    return this.state()
  }

  /** 拖动中节流探测：光标在窗口上还是外（拆分提示用）。 */
  probeDrag(screenX: number, screenY: number): BrowserDragProbe {
    return this.floats.windowAt(screenX, screenY)
  }

  /** 窗口内排序（HTML5 DnD，同一窗口的标签条上）。 */
  reorderTab(tabId: string, beforeTabId: string | null): BrowserState {
    this.tabs.reorder(tabId, beforeTabId)
    this.emit()
    return this.state()
  }

  /** 自动化入口：按 tabId 执行脚本（与页面在哪个窗口无关）。 */
  async executeOnTab(tabId: string, script: string): Promise<unknown> {
    return this.tabs.executeOnTab(tabId, script)
  }

  // MARK: - 卡片架（Phase 2）
  //
  // 卡片 = 真实标签。这里补的都是「架子视角」的入口：新建但不抢焦点、在指定
  // 标签里导航、拖出成独立窗口、从独立窗口收回架上。任何一个都不重建 view、
  // 不重新 loadURL——迁移的只是父子关系与显示状态。

  /** 卡片架新建标签：挂在采集宿主里（用户看不见），**不**打开浮窗。 */
  createShelfTab(): BrowserState {
    const tab = this.tabs.createTab()
    this.parkTab(tab.id)
    this.emit()
    return this.state()
  }

  /** 在指定标签里导航（卡片的内联地址栏）；不改变主窗口当前展示。 */
  navigateTab(tabId: string, input: string): BrowserState {
    if (!this.tabs.get(tabId)) return this.state()
    this.tabs.navigateInTab(tabId, input)
    this.emit()
    return this.state()
  }

  /** 卡片拖出主窗口：直接拆成独立窗口（不经过浮窗、不打开面板）。 */
  detachTab(tabId: string, screenX: number, screenY: number): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    // 已经在独立窗口里：再拆 = 聚焦现有窗口，绝不创建第二个副本（规格 §3）。
    if (tab.detached && tab.windowId !== null) {
      this.floats.focus(tab.windowId)
      return this.state()
    }
    return this.detachToNewWindow(tabId, { screenX, screenY })
  }

  // MARK: - 拖拽会话（Phase 3）

  /** tabId 是否是活着的真实标签（圆桌 join 校验 / syncTabs 对账用）。 */
  hasTab(tabId: string): boolean {
    return this.tabs.get(tabId) !== null
  }

  /** 活着的全部 tabId（圆桌对账用，不构造完整快照）。 */
  liveTabIds(): string[] {
    return this.tabs.list().map((tab) => tab.id)
  }

  /** 拖拽落点判定（装配层把共享会话的 classify 接到这里）。 */
  classifyDragPoint(point: DragPoint): { windowId: number | null; mainWindow: boolean } {
    return this.floats.windowAt(point.x, point.y)
  }

  /** 卡片开始拖动（HTML5 dragstart）。返回 false = 已有会话在跑（拒绝双开）。 */
  beginCardDrag(tabId: string): boolean {
    if (!this.tabs.get(tabId)) return false
    return this.drag.begin('webcard', tabId)
  }

  /** 窗口内的 drop 被接受（排序 / 加入圆桌）：会话按内部投放收尾，不拆窗。 */
  cardDropHandled(tabId: string): void {
    if (!this.tabs.get(tabId)) return
    this.drag.markDropHandled()
  }

  /** 卡片拖动终态（dragend / Esc / 异常）。松手位置以主进程轮询光标为准。 */
  endCardDrag(tabId: string, fallback?: DragPoint): void {
    if (!this.tabs.get(tabId)) {
      this.drag.cancel()
      return
    }
    // 带上 tabId：会话与上报不一致（过期残会话）时只取消，不拆错窗口。
    this.drag.end(fallback, tabId)
  }

  /** 拖动中标签被关闭 / 会话被打断：强制收尾，不拆窗。 */
  cancelDrag(): void {
    this.drag.cancel()
  }

  /** E2E / 单测注入假光标（打包版不可达，见 index.ts 的测试钩子）。 */
  setDragCursorOverride(point: DragPoint | null): void {
    this.drag.overrideCursor(point)
  }

  /** 拖拽帧广播（装配层把 onFrame 接到这里）。 */
  broadcastDragFrame(frame: BrowserDragFrame): void {
    this.sendToAllKnownShells(BROWSER_DRAG_CHANNEL, frame)
  }

  /** 从独立窗口收回卡片架：接进采集宿主，收起浮窗；页面实例不动。 */
  recallToShelf(tabId: string): BrowserState {
    const tab = this.tabs.get(tabId)
    if (!tab) return this.state()
    const mainId = this.getWindow()?.id ?? null
    const fromWindowId = tab.windowId
    if (fromWindowId !== null && fromWindowId !== mainId && !tab.parked) {
      this.floats.release(fromWindowId, tabId)
      if (this.floats.record(fromWindowId)?.tabIds.size === 0) {
        this.floats.closeEmpty(fromWindowId)
      }
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null
      this.startPage = true
      this.panelVisible = false
    }
    this.parkTab(tabId)
    this.syncVisibility()
    this.emit()
    // 归位后刷新预览：页面已在宿主里，截图不再影响任何可见窗口。
    this.previews.schedule(tabId)
    return this.state()
  }

  previewList(): BrowserPreview[] {
    return this.previews.list()
  }

  previewFor(tabId: string): BrowserPreview | null {
    return this.previews.get(tabId)
  }

  /** 卡片没有预览时的按需采集入口（不会绕过节流）。 */
  requestPreview(tabId: string): void {
    if (!this.tabs.get(tabId)) return
    void this.previews.refresh(tabId)
  }

  /**
   * 真实截图。
   *
   * 两种页面位置，两条采集路径：
   * - **收纳在采集宿主里**（`parked`）：宿主是 `opacity: 0` 的 BaseWindow，
   *   把 view 设为可见只会让 Chromium 绘制，用户看不到；采集完再藏回去。
   * - **正在主窗口/独立窗口里显示**：原地截图，不移动、不闪屏。曾经显示过的
   *   隐藏页面仍有绘制表面，capturePage 依然可用。
   *
   * 这样既不需要把网页在主窗口里闪一下，也不会复制第二个 WebContents。
   */
  private async capturePreview(tabId: string): Promise<PreviewCaptureResult | null> {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    const webContents = tab.view.webContents
    if (webContents.isDestroyed()) return null
    // 加载中/错误页不截：此时画面是半成品或 Chromium 错误页，留着上一张更好。
    if (tab.loading || tab.error) return null
    if (!tab.url || !isAllowedBrowserURL(tab.url)) return null

    const parked = tab.parked
    if (parked) {
      if (this.captureHost.id() === null) return null
    } else {
      const host = tab.windowId === null ? null : BrowserWindow.fromId(tab.windowId)
      if (!host || host.isDestroyed() || !host.isVisible()) return null
    }

    const savedBounds = tab.view.getBounds()
    const savedVisible = tab.view.getVisible()

    try {
      if (parked) {
        tab.view.setBounds({
          x: 0,
          y: 0,
          width: PREVIEW_CAPTURE_WIDTH,
          height: PREVIEW_CAPTURE_HEIGHT
        })
        tab.view.setVisible(true)
        await delay(PREVIEW_PRIME_DELAY_MS)
      }
      const image = await webContents.capturePage()
      if (image.isEmpty()) return null
      const size = image.getSize()
      if (size.width < 8 || size.height < 8) return null
      const targetWidth = Math.min(PREVIEW_STORE_WIDTH, size.width)
      const resized = image.resize({ width: targetWidth, quality: 'good' })
      const jpeg = resized.toJPEG(PREVIEW_JPEG_QUALITY)
      if (jpeg.length === 0) return null
      const stored = resized.getSize()
      return {
        dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        width: stored.width,
        height: stored.height
      }
    } catch {
      // 窗口最小化 / 显示表面回收 / 渲染进程崩溃：这次没图，保留旧预览。
      return null
    } finally {
      // 采集期间用户可能正好展开了卡片（parked → main）或拆出了窗口：
      // 那之后 bounds/visible 归窗口管理，不能再按采集前的值写回去。
      if (parked && tab.parked) {
        tab.view.setVisible(savedVisible)
        tab.view.setBounds(savedBounds)
      }
    }
  }

  /** 把标签收进采集宿主：保持 1280×800 的桌面视口，但不可见。 */
  private parkTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const host = this.captureHost.ensure()
    if (!host) return
    if (tab.windowId !== host.id) this.tabs.moveToWindow(tabId, host.id)
    if (tab.windowId !== host.id) return
    tab.view.setBounds({ x: 0, y: 0, width: PREVIEW_CAPTURE_WIDTH, height: PREVIEW_CAPTURE_HEIGHT })
    tab.view.setVisible(false)
  }

  /** 把标签迁回主窗口（展开卡片 / 面板显示）；未挂载或收纳中都能收回来。 */
  private unparkTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const mainId = this.getWindow()?.id ?? null
    if (mainId === null || tab.windowId === mainId) return
    this.tabs.moveToWindow(tabId, mainId)
  }

  private emitPreview(event: BrowserPreviewEvent): void {
    const targets: (BrowserWindow | null)[] = [this.getWindow()]
    for (const windowId of this.floats.windowIds()) targets.push(BrowserWindow.fromId(windowId))
    for (const target of targets) {
      if (target && !target.isDestroyed()) {
        target.webContents.send(BROWSER_PREVIEW_CHANNEL, event)
      }
    }
  }

  // MARK: - 几何

  setBounds(bounds: BrowserBounds): void {
    const viewport = this.viewport()
    if (!viewport) return
    const clamped = clampBrowserBounds(bounds, viewport)
    this.bounds = clamped
    this.applyBounds(clamped)
    this.schedulePersist(clamped)
    this.syncVisibility()
  }

  refit(): void {
    if (!this.bounds) return
    const viewport = this.viewport()
    if (!viewport) return
    const clamped = clampBrowserBounds(this.bounds, viewport)
    if (
      clamped.x === this.bounds.x &&
      clamped.y === this.bounds.y &&
      clamped.width === this.bounds.width &&
      clamped.height === this.bounds.height
    ) {
      return
    }
    this.bounds = clamped
    this.applyBounds(clamped)
    this.schedulePersist(clamped)
    this.emit()
  }

  /**
   * 生命周期：
   * - 主窗口关闭（macOS 可后台）：挂载在主窗口的标签全部「未挂载」，tab 都活着；
   *   浮窗与 detached 标签不受影响。
   * - 应用退出（dispose）：TabManager 统一销毁一切 webContents，浮窗收掉。
   */
  onMainWindowClosed(): void {
    const mainWindowId = this.getWindow()?.id ?? -1
    for (const tab of this.tabs.list()) {
      if (tab.windowId !== mainWindowId) continue
      // 优先收进采集宿主（页面、Session 与预览都保留）；宿主不可用时退回
      // 「活着但未挂载」，等主窗口重建后再由 showCurrentPage 接回来。
      this.parkTab(tab.id)
      if (tab.windowId === mainWindowId) this.tabs.moveToWindow(tab.id, null)
    }
    this.panelVisible = false
    this.captureHost.hide()
    this.emit()
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.drag.cancel()
    this.floats.closeAll()
    this.tabs.disposeAll()
    this.previews.dispose()
    this.captureHost.dispose()
    this.activeTabId = null
  }

  // MARK: - 内部

  private activeTab() {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : null
  }

  private webContentsOf(tab: ReturnType<BrowserTabManager['get']>): Electron.WebContents | null {
    return tab?.view.webContents ?? null
  }

  private viewport(): BrowserViewport | null {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return null
    const [width, height] = window.getContentSize()
    if (width <= 0 || height <= 0) return null
    return { width, height }
  }

  /** 激活标签铺满 bounds；其他标签 0×0（Chromium 不会绘制零尺寸视图）。 */
  private applyBounds(bounds: BrowserBounds): void {
    const mainWindowId = this.getWindow()?.id ?? null
    for (const tab of this.tabs.list()) {
      if (tab.windowId !== mainWindowId || tab.windowId === null) continue
      if (tab.id === this.activeTabId && !this.startPage && !tab.error) {
        // 渲染层上报的是**网页区（stage）**的矩形，标题栏、标签条与工具栏
        // 都在它上面；这里必须原样对齐，不能再加一次标签条高度——那会让
        // 网页整体下沉 40px，并在顶部留出一条空白。
        tab.view.setBounds(bounds)
      } else {
        tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      }
    }
  }

  /**
   * 可见性：主窗口浮窗打开、不在起始页、有激活标签、无错误态、有有效矩形。
   * 起始页与错误页由 React 画——原生层永远在最上层，z-index 盖不住它。
   */
  private syncVisibility(): void {
    const mainWindowId = this.getWindow()?.id ?? null
    const hasArea = this.bounds !== null && this.bounds.width > 0 && this.bounds.height > 0
    const active = this.activeTab()
    const shouldShow =
      this.panelVisible &&
      !this.startPage &&
      active !== null &&
      active.windowId === mainWindowId &&
      active.error === null &&
      hasArea
    if (active && active.windowId === mainWindowId) {
      active.view.setVisible(shouldShow)
    }
    // activeTab 的归属/激活任何变化都可能让 view 停在 0×0（比如拆走激活标签
    // 又激活另一个），这里统一重算一次 bounds——setBounds 同值代价可忽略。
    if (hasArea) this.applyBounds(this.bounds!)
  }

  private schedulePersist(bounds: BrowserBounds): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      writeBrowserLayout(this.db, bounds)
    }, 220)
  }

  private emit(): void {
    if (this.emitScheduled) return
    this.emitScheduled = true
    queueMicrotask(() => {
      this.emitScheduled = false
      this.sendToAllKnownShells(BROWSER_CHANGED_CHANNEL, this.state())
    })
  }

  /** 给主窗口 + 全部独立浏览器窗口的壳页广播；销毁中的窗口跳过。 */
  private sendToAllKnownShells(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
    for (const windowId of this.floats.windowIds()) {
      const target = BrowserWindow.fromId(windowId)
      if (target && !target.isDestroyed()) {
        target.webContents.send(channel, payload)
      }
    }
  }
}

function readHistory(webContents: Electron.WebContents | null): {
  canGoBack: boolean
  canGoForward: boolean
} {
  if (!webContents || webContents.isDestroyed()) return { canGoBack: false, canGoForward: false }
  try {
    const history = webContents.navigationHistory
    const index = history.getActiveIndex()
    const total = history.getAllEntries().length
    return { canGoBack: index > 0, canGoForward: index >= 0 && index < total - 1 }
  } catch {
    return { canGoBack: false, canGoForward: false }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
