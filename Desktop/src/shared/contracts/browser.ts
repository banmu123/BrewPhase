import { z } from 'zod'

/**
 * 内置浏览器的**共享契约**：主进程持有网页与状态，渲染层只读这份快照。
 *
 * 一条硬规则：这里不出现任何浏览历史、Cookie、账号或页面内容。渲染层能看到的
 * 只有「当前这一页的地址、标题、加载态、能力位、错误」。网页正文由 Chromium
 * 自己画，永远不经过 React。
 */

export const BROWSER_MIN_WIDTH = 420
export const BROWSER_MIN_HEIGHT = 300
export const BROWSER_RECENT_LIMIT = 8
/**
 * 状态广播通道。放在 shared 是有意的：preload 是 sandboxed 的，**不能** import
 * 主进程模块（那会把 BrowserWindow/session 整包拉进 preload），通道名只能来自
 * 这一层。
 */
export const BROWSER_CHANGED_CHANNEL = 'browser:changed'
/**
 * 缩略图广播通道。与 `browser:changed` 分开：快照很小、可以每帧合并；缩略图是
 * 几十 KB 的 JPEG，只在真正采集成功时发一次，不能搭在状态广播上。
 */
export const BROWSER_PREVIEW_CHANNEL = 'browser:preview'

/** 浮窗在**窗口坐标**里的位置与尺寸，单位是 CSS px（= Electron 的 DIP）。 */
export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export const browserBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite()
})

/** 一次成功的顶层导航：初始页与最近访问都靠它，只存地址/标题/时间。 */
export type BrowserVisit = {
  url: string
  title: string
  visitedAt: number
}

export const browserVisitSchema = z.object({
  url: z.string().max(2_048),
  title: z.string().max(512),
  visitedAt: z.number().int().nonnegative()
})

/**
 * 一次失败的加载。
 *
 * `reason` 只描述「我们自己在输入阶段就拦下的情况」，由界面翻译成用户语言；
 * `description` 是 Chromium 给的技术原文，仅作次要信息展示——不把它直接当
 * 主文案，否则界面会中英混排。
 */
export type BrowserLoadError = {
  code: number
  description: string
  url: string
  reason?: 'blocked-scheme' | 'empty' | 'malformed'
  kind?: 'input' | 'network' | 'crash'
}

/** 单个标签的信息快照。tabId 是身份：拆分、合并、排序都不改它。 */
export type BrowserTabInfo = {
  id: string
  url: string
  title: string
  loading: boolean
  progress: number
  error: BrowserLoadError | null
  /** 挂在哪个窗口上；null = 活着但未挂载。 */
  windowId: number | null
  /** 在独立浏览器窗口里（不在主窗口）。 */
  detached: boolean
  /** 在缩略图采集宿主里：活着、有绘制表面，但用户看不见（架子上的标签）。 */
  parked: boolean
  /** 该标签是否是主窗口浮窗当前显示的那一个。 */
  active: boolean
}

export type BrowserState = {
  /** 全部标签（按展示顺序，含已拆出的——主窗口标签栏要显示它们的位置）。 */
  tabs: BrowserTabInfo[]
  /** 主窗口浮窗当前显示的标签。null = 起始页。 */
  activeTabId: string | null

  /** 浮窗是否可见。隐藏时 WebContentsView 只是 `setVisible(false)`，页面还在。 */
  visible: boolean
  /** 网页容器是否已经存在。用于判断「再次打开是复用还是新建」。 */
  alive: boolean
  /** 当前地址；空字符串表示还没有打开过页面。 */
  url: string
  /**
   * 是否停在起始页。为 true 时网页只是 `setVisible(false)`，WebContentsView
   * 仍然存在——滚动位置、加载状态与 Session 都不受影响。
   */
  startPage: boolean
  title: string
  /** 正在加载（含同一页面内的前进/后退）。 */
  loading: boolean
  /** 0–1 的估算进度：没有 lengthComputable 的站点会退化成「加载中/完成」。 */
  progress: number
  canGoBack: boolean
  canGoForward: boolean
  error: BrowserLoadError | null
  /** 浮窗的持久化布局（上次拖动/缩放的结果，已按当前窗口修正过）。 */
  layout: BrowserBounds | null
  /** 上一次成功访问的页面，重新打开时据此恢复。 */
  lastVisit: BrowserVisit | null
  /** 最近访问（去重、最新在前），初始页展示。 */
  recent: BrowserVisit[]
}

export type BrowserOpenInput = {
  /** 直接给地址则导航；不给则恢复上次访问，再没有就停在初始页。 */
  url?: string
}

export const browserOpenSchema = z
  .object({ url: z.string().max(2_048).optional() })
  .optional()

export const browserNavigateSchema = z.object({ input: z.string().max(2_048) })

/** 渲染层回报内容区矩形。主进程做一次 clamp，不信任任何越界值。 */
export const browserBoundsUpdateSchema = browserBoundsSchema

/** 拖动落点判定：渲染层只报屏幕坐标，归属由主进程统一裁定。 */
export type BrowserDropInput = {
  screenX: number
  screenY: number
  /** 正在拖动的标签。 */
  tabId: string
}

export const browserDropSchema = z.object({
  screenX: z.number().finite(),
  screenY: z.number().finite(),
  tabId: z.string().min(1).max(64)
})

/** 拖出预览：光标当前是否落在某个窗口上（拖动中节流上报）。 */
export const browserDragProbeSchema = z.object({
  screenX: z.number().finite(),
  screenY: z.number().finite()
})

export type BrowserDragProbe = {
  /** null = 光标在任何已知窗口之外（松手将拆出独立窗口）。 */
  windowId: number | null
  /** 光标所在窗口是否是主窗口。 */
  mainWindow: boolean
}

/* ============================================================
 * 网页缩略图（Phase 2）
 *
 * 缩略图是**真实网页的截图**，由主进程用 `webContents.capturePage()` 采集。
 * 它只存在于本地内存：不进 SQLite、不上云、不进日志。Renderer 拿到的是一张
 * data URL，用于卡片 `<img>`；它不是网页状态的替代品，页面本身仍在主进程。
 * ============================================================ */

export type BrowserPreview = {
  /** 对应 BrowserTabManager 的 tabId；预览永远属于一个真实标签。 */
  tabId: string
  /** `data:image/jpeg;base64,…`，只在本地内存里流转。 */
  dataUrl: string
  /** 压缩后的像素尺寸（不是原网页尺寸）。 */
  width: number
  height: number
  /** 采集时间（epoch ms），用于判断新鲜度与缓存淘汰。 */
  capturedAt: number
}

export type BrowserPreviewEvent =
  | { kind: 'update'; preview: BrowserPreview }
  | { kind: 'clear'; tabId: string }

export const browserPreviewRequestSchema = z.object({
  tabId: z.string().min(1).max(64)
})

/** 在指定标签里导航（卡片的内联地址栏用；不影响主窗口当前标签）。 */
export const browserNavigateTabSchema = z.object({
  tabId: z.string().min(1).max(64),
  input: z.string().min(1).max(2_048)
})

/** 把某个标签拆到独立窗口（卡片拖出主窗口时由渲染层上报屏幕坐标）。 */
export const browserDetachTabSchema = z.object({
  tabId: z.string().min(1).max(64),
  screenX: z.number().finite(),
  screenY: z.number().finite()
})

