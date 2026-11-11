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

export type BrowserState = {
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
