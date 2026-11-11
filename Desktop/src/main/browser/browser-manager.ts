import { BrowserWindow, session, shell, WebContentsView, type WebContents } from 'electron'
import type { Db } from '../database/client'
import {
  BROWSER_CHANGED_CHANNEL,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  type BrowserBounds,
  type BrowserLoadError,
  type BrowserOpenInput,
  type BrowserState,
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

/**
 * 内置浏览器浮窗的唯一管理者（主进程）。
 *
 * 为什么必须收在一个类里：WebContentsView 是**原生视图**，不在 React DOM 里，
 * 它的创建、销毁、bounds、可见性、导航与权限都不能分散到各个页面。渲染层只能
 * 通过 IPC 表达意图（打开/导航/隐藏/关闭/我这边内容区多大），真实状态永远以
 * 这里为准，再广播回去。
 *
 * 四条边界：
 * 1. **只有一个页面**：本阶段不做标签页，重复 open 只会复用同一个 view；
 * 2. **关闭 ≠ 登出**：销毁 view 不动 `persist:brewphase-browser` 分区，
 *    Cookie / LocalStorage 由 Chromium 自己落盘，应用层不读也不导出；
 * 3. **网页是外来的**：无 preload、无 Node、sandbox、权限一律拒绝、
 *    导航只认 http/https、`window.open` 一律 deny；
 * 4. **几何单向流入**：渲染层报内容区矩形，这里 clamp 后写进原生 view。
 */

export const BROWSER_PARTITION = 'persist:brewphase-browser'

/** `did-fail-load` 里 -3 = ERR_ABORTED：用户主动停止/跳转，不是错误。 */
const ERR_ABORTED = -3

export type BrowserManagerParams = {
  db: Db
  /** 主窗口按需取：macOS 关窗再激活会换一个 BrowserWindow 实例。 */
  getWindow: () => BrowserWindow | null
}

export class BrowserManager {
  private readonly db: Db
  private readonly getWindow: () => BrowserWindow | null

  private view: WebContentsView | null = null
  /** view 绑在哪个窗口上：窗口换了就必须重建，否则原生视图挂在已销毁的父节点里。 */
  private boundWindowId: number | null = null

  /** 浮窗是否被用户打开（与 view 是否绘制是两件事）。 */
  private panelVisible = false
  /**
   * 是否停在起始页。与 `currentURL` 分开：从网页回到起始页时地址仍然保留，
   * 网页容器也不销毁，只是让原生层让开，由 React 画书签与最近访问。
   */
  private startPage = true
  private currentURL = ''
  private title = ''
  private loading = false
  private progress = 0
  private error: BrowserLoadError | null = null
  private bounds: BrowserBounds | null
  private recent: BrowserVisit[]

  /** 同一 tick 内的多次变化合并成一次广播，避免拖动时刷屏。 */
  private emitScheduled = false
  /** 持久化布局的防抖：拖动/缩放过程中不写库。 */
  private persistTimer: NodeJS.Timeout | null = null

  constructor(params: BrowserManagerParams) {
    this.db = params.db
    this.getWindow = params.getWindow
    this.bounds = readBrowserLayout(params.db)
    this.recent = readBrowserRecent(params.db)
  }

  // MARK: - 对外状态

  state(): BrowserState {
    const webContents = this.view?.webContents
    const history = readHistory(webContents)
    return {
      visible: this.panelVisible,
      alive: this.view !== null && !this.view.webContents.isDestroyed(),
      url: this.currentURL,
      startPage: this.startPage,
      title: this.title,
      loading: this.loading,
      progress: this.progress,
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward,
      error: this.error,
      layout: this.bounds,
      lastVisit: this.recent[0] ?? null,
      recent: this.recent
    }
  }

  // MARK: - 打开 / 隐藏 / 关闭

  /**
   * 打开浮窗：
   * - 有 `url` → 导航到它（已打开就在同一个 view 里跳，不新建）；
   * - 没有 → 恢复上次访问；连历史都没有就停在初始页（url 为空）。
   *
   * 停在初始页时**不创建网页容器**：那一页完全由 React 画，多开一个
   * Chromium 进程只会白占内存。第一次真正导航时才 `ensureView()`。
   */
  open(input?: BrowserOpenInput): BrowserState {
    this.panelVisible = true
    const requested = input?.url?.trim()
    const target = requested || (this.currentURL ? null : this.recent[0]?.url)

    if (!target) {
      this.startPage = true
      this.syncVisibility()
      this.emit()
      return this.state()
    }
    return this.navigate(target)
  }

  /**
   * 回到起始页（看导入的书签、最近访问）。
   *
   * 只改显示状态：`WebContentsView` 不销毁、`currentURL` 不清空，用户再点
   * 书签时直接复用同一个网页容器，加载状态、滚动位置、登录态都还在。
   */
  showStart(): BrowserState {
    this.panelVisible = true
    this.startPage = true
    this.error = null
    this.loading = false
    this.progress = 0
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /** 隐藏：不销毁页面。滚动位置、播放进度、登录态都留着。 */
  hide(): BrowserState {
    this.panelVisible = false
    this.syncVisibility()
    this.emit()
    return this.state()
  }

  /**
   * 关闭：销毁 view，释放内存；但**保留分区与上次访问地址**。
   * 下次打开会按 `lastVisit` 恢复，登录状态由 Chromium 分区自己维持。
   */
  close(): BrowserState {
    this.panelVisible = false
    if (this.currentURL) {
      this.recent = recordBrowserVisit(this.db, this.currentURL, this.title)
    }
    this.destroyView()
    this.currentURL = ''
    this.title = ''
    this.startPage = true
    this.loading = false
    this.progress = 0
    this.error = null
    this.emit()
    return this.state()
  }

  // MARK: - 导航

  navigate(rawInput: string): BrowserState {
    const resolved = resolveBrowserInput(rawInput)
    if (resolved.kind === 'invalid') {
      // 危险协议（javascript:/file:/data:）不导航、不搜索，只作为一次错误状态
      // 回到界面。这里不抛异常：地址栏不该因为一次输错就整块崩掉。
      this.error = {
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
      this.startPage = false
      this.loading = false
      this.progress = 0
      this.syncVisibility()
      this.emit()
      return this.state()
    }
    return this.loadURL(resolved.url)
  }

  /** 已经解析好的 URL（Records 入口 / 初始页最近访问）走这里。 */
  loadURL(url: string): BrowserState {
    const normalized = normalizeBrowserURL(url)
    if (!normalized) {
      this.error = {
        code: 0,
        description: 'blocked scheme (only http / https)',
        url,
        reason: 'blocked-scheme',
        kind: 'input'
      }
      this.emit()
      return this.state()
    }

    this.panelVisible = true
    const view = this.ensureView()
    if (!view) return this.state()

    // 先乐观地切到「加载中」：原生 view 立刻显示，避免初始页/错误态残留一帧。
    this.startPage = false
    this.currentURL = normalized
    this.title = ''
    this.loading = true
    this.progress = 0.08
    this.error = null
    this.syncVisibility()
    this.emit()

    // `loadURL` 的失败会同时走 loadURL reject 与 did-fail-load，只处理后者，
    // 这里吞掉 rejection，避免主进程出现未捕获的 promise。
    void view.webContents.loadURL(normalized).catch(() => undefined)
    return this.state()
  }

  back(): BrowserState {
    const webContents = this.view?.webContents
    if (webContents && readHistory(webContents).canGoBack) {
      this.traverse(webContents, 'back')
    }
    return this.state()
  }

  forward(): BrowserState {
    const webContents = this.view?.webContents
    if (webContents && readHistory(webContents).canGoForward) {
      this.traverse(webContents, 'forward')
    }
    return this.state()
  }

  /**
   * 前进/后退。
   *
   * 不能用 `navigationHistory.goBack()`：Electron 45 的 WebContentsView 上
   * 这个调用是**空操作**——`getAllEntries()` 读得到两条历史、`getActiveIndex()`
   * 也对，但调完之后 index 一格都不动（实测）。而页面自己的 `history.back()`
   * 正常。所以主路径走页面内导航，API 只作为兜底（别的版本可能反过来）。
   */
  private traverse(webContents: WebContents, direction: 'back' | 'forward'): void {
    const script = direction === 'back' ? 'history.back()' : 'history.forward()'
    void webContents
      .executeJavaScript(`${script}; void 0`)
      .catch(() => {
        if (direction === 'back') webContents.navigationHistory.goBack()
        else webContents.navigationHistory.goForward()
      })
  }

  reload(): BrowserState {
    const webContents = this.view?.webContents
    if (!webContents) return this.state()
    this.error = null
    this.loading = true
    this.progress = 0.08
    this.syncVisibility()
    this.emit()
    webContents.reload()
    return this.state()
  }

  stop(): BrowserState {
    this.view?.webContents.stop()
    return this.state()
  }

  /** 用户主动选择系统浏览器打开；网页自己的 `window.open` 不会被转到这里。 */
  openExternal(url?: string): void {
    const target = normalizeBrowserURL(url ?? this.currentURL)
    if (target) void shell.openExternal(target)
  }

  // MARK: - 几何

  setBounds(bounds: BrowserBounds): void {
    const viewport = this.viewport()
    if (!viewport) return
    const clamped = clampBrowserBounds(bounds, viewport)
    this.bounds = clamped
    this.applyBounds(clamped)
    this.schedulePersist(clamped)
    // 首次打开时 view 是「等一个有效矩形」的状态（宽高为 0 时不绘制），
    // 这里补一次可见性判断，否则会一直白着。
    this.syncVisibility()
  }

  /** 窗口尺寸变化后的兜底修正（渲染层也会重报，这里保证原生层不会掉队）。 */
  refit(): void {
    if (!this.bounds) return
    const viewport = this.viewport()
    if (!viewport) return
    const clamped = clampBrowserBounds(this.bounds, viewport)
    if (clamped.x === this.bounds.x && clamped.y === this.bounds.y && clamped.width === this.bounds.width && clamped.height === this.bounds.height) {
      return
    }
    this.bounds = clamped
    this.applyBounds(clamped)
    this.schedulePersist(clamped)
    this.emit()
  }

  /** 窗口销毁时调用：原生视图必须跟着释放，否则会留下孤儿 webContents。 */
  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.destroyView()
  }

  // MARK: - 内部：view 生命周期

  private viewport(): BrowserViewport | null {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return null
    const [width, height] = window.getContentSize()
    if (width <= 0 || height <= 0) return null
    return { width, height }
  }

  private ensureView(): WebContentsView | null {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return null

    if (this.view && this.boundWindowId === window.id && !this.view.webContents.isDestroyed()) {
      return this.view
    }
    // 窗口换了（macOS 关窗后重新激活）：旧 view 已随父窗口失效，重建一个。
    if (this.view) this.destroyView()

    const partition = session.fromPartition(BROWSER_PARTITION)
    this.hardenSession(partition)

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        // 网页是外来的：不给 Node、不给 preload、不给 contextIsolation 之外的任何桥。
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false
      }
    })

    view.setBackgroundColor('#ffffff')
    window.contentView.addChildView(view)
    this.view = view
    this.boundWindowId = window.id

    const webContents = view.webContents
    this.attachNavigationGuards(webContents)
    this.attachStateListeners(webContents)

    const viewport = this.viewport()
    const initial = this.bounds && viewport ? clampBrowserBounds(this.bounds, viewport) : null
    if (initial) {
      this.bounds = initial
      this.applyBounds(initial)
    }
    this.syncVisibility()
    return view
  }

  private destroyView(): void {
    const view = this.view
    this.view = null
    this.boundWindowId = null
    if (!view) return
    try {
      view.webContents.stop()
    } catch {
      // 已经销毁或正在销毁：忽略。
    }
    try {
      view.webContents.close()
    } catch {
      // 同上。
    }
  }

  private applyBounds(bounds: BrowserBounds): void {
    const view = this.view
    if (!view) return
    view.setBounds(bounds)
    // 圆角是「浮窗」的视觉前提；必须与 `.browser-panel` 的圆角一致，
    // 否则四角会露出一圈底色。平台不支持时静默跳过，不影响功能。
    try {
      view.setBorderRadius(10)
    } catch {
      // 老平台没有这个 API。
    }
  }

  /**
   * 可见性由四件事共同决定：用户打开了浮窗、没停在起始页、有要显示的页面、
   * 且当前不是错误态。起始页与错误页都由 React 画，此时原生 view 必须让开——
   * 它永远在最上层，任何 z-index 都盖不住。
   */
  private syncVisibility(): void {
    const view = this.view
    if (!view) return
    // 没有有效矩形时也不要画：此时原生层会以 0×0 出现在左上角，看起来像
    // 一块贴边的白条。等 setBounds 到达后再显示。
    const hasArea = this.bounds !== null && this.bounds.width > 0 && this.bounds.height > 0
    const shouldShow =
      this.panelVisible && !this.startPage && this.currentURL !== '' && this.error === null && hasArea
    view.setVisible(shouldShow)
  }

  private schedulePersist(bounds: BrowserBounds): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      writeBrowserLayout(this.db, bounds)
    }, 220)
  }

  // MARK: - 内部：安全

  /**
   * 分区级策略：只设置一次也幂等。
   *
   * 权限**全部拒绝**——摄像头、麦克风、定位、通知、剪贴板读、MIDI……本阶段没有
   * 任何「用户明确同意」的界面，默认给出去就是漏洞。下载同理：网页不该能往
   * 用户的下载目录里丢文件。
   */
  private hardenSession(partition: Electron.Session): void {
    if (this.hardenedSessions.has(partition)) return
    this.hardenedSessions.add(partition)

    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    partition.on('will-download', (event) => event.preventDefault())
  }

  private readonly hardenedSessions = new WeakSet<Electron.Session>()

  private attachNavigationGuards(webContents: WebContents): void {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    webContents.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserURL(url)) event.preventDefault()
    })

    webContents.on('will-frame-navigate', (event) => {
      if (!isAllowedBrowserURL(event.url)) event.preventDefault()
    })

    webContents.on('will-attach-webview', (event) => event.preventDefault())
  }

  // MARK: - 内部：状态

  private attachStateListeners(webContents: WebContents): void {
    webContents.on('did-start-loading', () => {
      this.loading = true
      // 没有真实进度可用（Chromium 不暴露），用阶段估算：开始 8%、DOM 就绪 70%。
      this.progress = 0.08
      this.emit()
    })

    webContents.on('dom-ready', () => {
      if (!this.loading) return
      this.progress = Math.max(this.progress, 0.7)
      this.emit()
    })

    webContents.on('did-stop-loading', () => {
      this.loading = false
      this.progress = this.error ? 0 : 1
      this.syncVisibility()
      this.emit()
    })

    webContents.on('did-start-navigation', (event) => {
      if (!event.isMainFrame) return
      // 页面内的同文档跳转（history.pushState）不重置错误，交给 did-navigate-in-page。
      if (event.isSameDocument) return
      if (!isAllowedBrowserURL(event.url)) return
      this.currentURL = event.url
      this.error = null
      this.syncVisibility()
      this.emit()
    })

    webContents.on('did-navigate', (_event, url) => {
      if (!normalizeBrowserURL(url)) return
      this.currentURL = url
      this.title = webContents.getTitle()
      this.error = null
      this.progress = 1
      this.recent = recordBrowserVisit(this.db, url, this.title)
      this.syncVisibility()
      this.emit()
    })

    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      if (!normalizeBrowserURL(url)) return
      this.currentURL = url
      this.emit()
    })

    webContents.on('page-title-updated', (_event, title) => {
      this.title = title
      if (this.currentURL) {
        this.recent = retitleBrowserVisit(this.db, this.currentURL, title)
      }
      this.emit()
    })

    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 子资源失败不该把整页判死；-3 是「被主动中止」，不是错误。
      if (!isMainFrame || errorCode === ERR_ABORTED) return
      this.error = {
        code: errorCode,
        description: errorDescription,
        url: validatedURL,
        kind: 'network'
      }
      this.loading = false
      this.progress = 0
      this.syncVisibility()
      this.emit()
    })

    webContents.on('render-process-gone', () => {
      this.error = {
        code: -1,
        description: 'renderer process gone',
        url: this.currentURL,
        kind: 'crash'
      }
      this.loading = false
      this.progress = 0
      this.syncVisibility()
      this.emit()
    })

    webContents.on('destroyed', () => {
      if (this.view?.webContents === webContents) {
        this.view = null
        this.boundWindowId = null
      }
      this.emit()
    })
  }

  private emit(): void {
    if (this.emitScheduled) return
    this.emitScheduled = true
    queueMicrotask(() => {
      this.emitScheduled = false
      const window = this.getWindow()
      if (!window || window.isDestroyed()) return
      window.webContents.send(BROWSER_CHANGED_CHANNEL, this.state())
    })
  }
}

/**
 * 前后退能力位。
 *
 * 不能直接用 `navigationHistory.canGoBack()`：Electron 45 的 WebContentsView
 * 上它会在历史已经存在时仍返回 false（实测 entries 有两条、activeIndex=1，
 * `canGoBack()` 依然是 false），界面就会把「后退」按钮一直画成禁用。
 * 索引是自己数出来的，和 `getAllEntries()` 对得上，不依赖那个 API 的实现。
 */
function readHistory(webContents: WebContents | undefined): {
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
