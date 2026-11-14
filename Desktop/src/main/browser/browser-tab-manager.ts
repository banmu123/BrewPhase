import { BaseWindow, type WebContents } from 'electron'
import type { BrowserLoadError } from '../../shared/contracts/browser'
import { isAllowedBrowserURL, normalizeBrowserURL } from '../../shared/browser-url'
import { attachBrowserGuards, createBrowserView } from './browser-view-factory'

/**
 * 浏览器标签的**唯一管理者**：tab 身份、页面实例、窗口归属、展示顺序、销毁。
 *
 * 职责边界（窗口管理三原则）：
 * 1. **窗口只负责显示**。把 view 从一个窗口 `contentView` 挪到另一个（Electron
 *    支持，WebContents 实例不变）；窗口 `closed` 时不销毁 view，只把它的 tab
 *    归还/置空——销毁 webContents 的代码只存在于本类的 `closeTab`/`disposeAll`。
 * 2. **tabId 是身份**。拆分、合并、排序都不改 tabId；自动化（DOM 脚本）一律
 *    通过 `webContentsFor(tabId)` 定位，与页面在哪个窗口无关。
 * 3. **归属唯一**。一个 tab 同一时刻至多挂在一个窗口上；`windowId === null`
 *    表示「活着但无处显示」。
 */

export type BrowserTabRecord = {
  id: string
  view: Electron.WebContentsView
  url: string
  title: string
  loading: boolean
  progress: number
  error: BrowserLoadError | null
  /** 挂在哪个 BrowserWindow 上；null = 未挂载。 */
  windowId: number | null
  /** 挂在非主窗口（独立浏览器窗口）上。 */
  detached: boolean
  /** 挂在缩略图采集宿主上：用户看不见，但页面有绘制表面。 */
  parked: boolean
}

/** 主窗口的 id 由构造方传入；它决定 `detached` 的语义。 */
export type BrowserTabManagerParams = {
  mainWindowId: () => number | null
  /** 采集宿主窗口 id：挂在它上面的标签算「收纳」，不算拆出。 */
  captureWindowId?: () => number | null
  onChange: () => void
  /** 顶层导航完成时回调（历史记录由 browser-manager 统一写）。 */
  onPageVisited?: (url: string, title: string) => void
  /**
   * 页面「内容可能变了」时回调：加载结束、顶层导航、站内导航、标题更新。
   * 缩略图服务用它做 debounce；频率由对方控制，这里不做节流。
   */
  onPageSettled?: (tabId: string) => void
  /** 标签被销毁（正常关闭或外部销毁）：缩略图缓存必须同步清理。 */
  onTabClosed?: (tabId: string) => void
}

export class BrowserTabManager {
  private readonly tabs = new Map<string, BrowserTabRecord>()
  /** 标签展示顺序（主窗口标签栏用；浮窗按自己窗口过滤）。 */
  readonly order: string[] = []
  private seq = 0
  private notify: () => void

  constructor(private readonly params: BrowserTabManagerParams) {
    this.notify = params.onChange
  }

  // MARK: - 查询

  get(tabId: string): BrowserTabRecord | null {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    return tab
  }

  list(): BrowserTabRecord[] {
    return this.order.map((id) => this.tabs.get(id)).filter((tab): tab is BrowserTabRecord => tab !== null)
  }

  tabsInWindow(windowId: number | null): BrowserTabRecord[] {
    return this.list().filter((tab) => tab.windowId === windowId)
  }

  webContentsFor(tabId: string): WebContents | null {
    return this.get(tabId)?.view.webContents ?? null
  }

  /** 自动化入口：通过 tabId 在页面里执行脚本，与页面在哪个窗口无关。 */
  async executeOnTab(tabId: string, script: string): Promise<unknown> {
    const webContents = this.webContentsFor(tabId)
    if (!webContents) throw new Error(`tab ${tabId} has no live webContents`)
    return webContents.executeJavaScript(script)
  }

  mainWindowId(): number | null {
    return this.params.mainWindowId()
  }

  // MARK: - 创建 / 关闭

  /**
   * 新建标签。`url` 给了就导航；没给就停在新标签空白页（about:blank 的
   * 语义由渲染层起始页承担——不加载任何远程内容）。
   */
  createTab(url?: string): BrowserTabRecord {
    this.seq += 1
    const id = `tab-${this.seq}`
    const view = createBrowserView()
    const tab: BrowserTabRecord = {
      id,
      view,
      url: '',
      title: '',
      loading: false,
      progress: 0,
      error: null,
      windowId: null,
      detached: false,
      parked: false
    }
    this.tabs.set(id, tab)
    this.order.push(id)
    this.attachListeners(tab)
    if (url) this.navigateInTab(id, url)
    this.notify()
    return tab
  }

  /**
   * 关闭标签：**唯一**销毁 webContents 的地方。
   * 先从所在窗口摘下，再 close；顺序错了会留下孤儿原生视图。
   */
  closeTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    this.detachFromWindow(tab)
    this.order.splice(this.order.indexOf(tabId), 1)
    this.tabs.delete(tabId)
    try {
      tab.view.webContents.close()
    } catch {
      // 已经销毁：忽略。
    }
    this.params.onTabClosed?.(tabId)
    this.notify()
    return true
  }

  // MARK: - 窗口归属

  /**
   * 把标签挂到某个窗口（或摘下）。**不改 URL、不重建 view、不碰 Session**——
   * 这是「拖动的是页面实例」的全部实现：只动 contentView 的父子关系。
   */
  moveToWindow(tabId: string, targetWindowId: number | null): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    if (tab.windowId === targetWindowId) return true

    this.detachFromWindow(tab)

    if (targetWindowId !== null) {
      const target = BaseWindow.fromId(targetWindowId)
      if (!target || target.isDestroyed()) return false
      target.contentView.addChildView(tab.view)
    }
    tab.windowId = targetWindowId
    const captureWindowId = this.params.captureWindowId?.() ?? null
    tab.parked = targetWindowId !== null && targetWindowId === captureWindowId
    tab.detached =
      targetWindowId !== null && targetWindowId !== this.params.mainWindowId() && !tab.parked
    this.syncBounds(tab)
    this.notify()
    return true
  }

  private detachFromWindow(tab: BrowserTabRecord): void {
    if (tab.windowId === null) return
    const current = BaseWindow.fromId(tab.windowId)
    if (current && !current.isDestroyed()) {
      current.contentView.removeChildView(tab.view)
    }
    tab.windowId = null
    tab.parked = false
  }

  /** 窗口 resize / 挂载后，渲染层会重新上报 bounds；这里只兜底可见性。 */
  private syncBounds(tab: BrowserTabRecord): void {
    // 可见性由各窗口的渲染层上报 bounds 决定（0×0 不绘制）；
    // 这里确保挂载后 view 的 bounds 立即有效之前不要闪出一块白。
    if (tab.windowId === null) {
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }

  // MARK: - 顺序与激活

  /** 把 tabId 移到 beforeTabId 之前（beforeTabId 为 null = 末尾）。 */
  reorder(tabId: string, beforeTabId: string | null): void {
    const from = this.order.indexOf(tabId)
    if (from === -1) return
    this.order.splice(from, 1)
    if (beforeTabId === null) {
      this.order.push(tabId)
    } else {
      const to = this.order.indexOf(beforeTabId)
      this.order.splice(to === -1 ? this.order.length : to, 0, tabId)
    }
    this.notify()
  }

  // MARK: - 导航（manager 代管状态，view 只是执行者）

  navigateInTab(tabId: string, rawInput: string): boolean {
    const tab = this.get(tabId)
    if (!tab) return false
    const normalized = normalizeBrowserURL(rawInput)
    if (!normalized) {
      tab.error = {
        code: 0,
        url: rawInput,
        reason: 'blocked-scheme',
        kind: 'input',
        description: 'blocked scheme (only http / https)'
      }
      this.notify()
      return false
    }
    tab.url = normalized
    tab.title = ''
    tab.loading = true
    tab.progress = 0.08
    tab.error = null
    void tab.view.webContents.loadURL(normalized).catch(() => undefined)
    this.notify()
    return true
  }

  private attachListeners(tab: BrowserTabRecord): void {
    const webContents = tab.view.webContents
    attachBrowserGuards(webContents, (url) => isAllowedBrowserURL(url))

    webContents.on('did-start-loading', () => {
      tab.loading = true
      tab.progress = 0.08
      this.notify()
    })
    webContents.on('dom-ready', () => {
      if (!tab.loading) return
      tab.progress = Math.max(tab.progress, 0.7)
      this.notify()
    })
    webContents.on('did-stop-loading', () => {
      tab.loading = false
      tab.progress = tab.error ? 0 : 1
      this.notify()
      if (!tab.error) this.params.onPageSettled?.(tab.id)
    })
    webContents.on('did-start-navigation', (event, url) => {
      if (!event.isMainFrame || event.isSameDocument) return
      if (!isAllowedBrowserURL(url)) return
      tab.url = url
      tab.error = null
      this.notify()
    })
    webContents.on('did-navigate', (_event, url) => {
      if (!normalizeBrowserURL(url)) return
      tab.url = url
      tab.title = webContents.getTitle()
      tab.error = null
      tab.progress = 1
      this.params.onPageVisited?.(url, tab.title)
      this.notify()
      this.params.onPageSettled?.(tab.id)
    })
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      if (!normalizeBrowserURL(url)) return
      tab.url = url
      this.notify()
      this.params.onPageSettled?.(tab.id)
    })
    webContents.on('page-title-updated', (_event, title) => {
      tab.title = title
      this.notify()
      this.params.onPageSettled?.(tab.id)
    })
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 子资源失败不判死；-3 是用户主动停止/跳转。
      if (!isMainFrame || errorCode === -3) return
      tab.error = { code: errorCode, description: errorDescription, url: validatedURL, kind: 'network' }
      tab.loading = false
      tab.progress = 0
      this.notify()
    })
    webContents.on('render-process-gone', () => {
      tab.error = { code: -1, description: 'renderer process gone', url: tab.url, kind: 'crash' }
      tab.loading = false
      this.notify()
    })
    webContents.on('destroyed', () => {
      // view 被外部销毁（例如窗口异常）：同步清账，避免留幽灵 tab。
      if (this.tabs.get(tab.id) === tab) {
        const at = this.order.indexOf(tab.id)
        if (at !== -1) this.order.splice(at, 1)
        this.tabs.delete(tab.id)
        this.params.onTabClosed?.(tab.id)
        this.notify()
      }
    })
  }

  /** 应用退出：唯一批量销毁点。 */
  disposeAll(): void {
    for (const tab of [...this.tabs.values()]) {
      this.detachFromWindow(tab)
      try {
        tab.view.webContents.close()
      } catch {
        // 已销毁：忽略。
      }
    }
    this.tabs.clear()
    this.order.length = 0
  }
}
