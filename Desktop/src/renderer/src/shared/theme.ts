/**
 * 外观（浅色 / 深色 / 跟随系统）的解析与持久化。
 *
 * 规则与 `i18n/locale.ts` 同一套：
 * - 首次启动跟随系统；
 * - 用户手动选择后以用户选择为准（localStorage）；
 * - 只持久化到 localStorage，不建数据库迁移；
 * - 全局对象一律走 `globalThis` 的**最小结构类型**读取，不用 DOM lib 的
 *   `Document` / `MediaQueryList`——单测跑在 node 环境（无 DOM lib），
 *   而这些文件又同时被 `tsconfig.node.json` 收进去编译。
 *
 * 颜色的**唯一来源**仍然是 `styles/app.css`：本文件只决定 `<html>` 上
 * `data-theme` 的值，深色令牌全部挂在 `[data-theme='dark']` 之下。
 * 组件不自己判断明暗——一旦让每个组件各自看 `prefers-color-scheme`，
 * 就一定会出现「一半深一半浅」的画面。
 */

export const THEMES = ['system', 'light', 'dark'] as const

export type ThemePreference = (typeof THEMES)[number]
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'brewphase.desktop.theme'

/** 与 CSS 里 `prefers-color-scheme` 判断的必须是同一个查询串。 */
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

// MARK: - 最小结构类型

type ThemeStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

type ThemeRoot = {
  dataset: Record<string, string | undefined>
  style: Record<string, string | undefined>
}

type ThemeDocument = {
  documentElement: ThemeRoot
}

type MediaChange = { matches: boolean }
type MediaListener = (event: MediaChange) => void

type MediaQueryLike = {
  matches: boolean
  addEventListener?: (type: string, listener: MediaListener) => void
  removeEventListener?: (type: string, listener: MediaListener) => void
  addListener?: (listener: MediaListener) => void
  removeListener?: (listener: MediaListener) => void
}

type ThemeWindow = {
  matchMedia?: (query: string) => MediaQueryLike
}

function getStorage(): ThemeStorage | null {
  return (globalThis as unknown as { localStorage?: ThemeStorage }).localStorage ?? null
}

function getDocument(): ThemeDocument | null {
  return (globalThis as unknown as { document?: ThemeDocument }).document ?? null
}

function getWindow(): ThemeWindow | null {
  return (globalThis as unknown as { window?: ThemeWindow }).window ?? null
}

// MARK: - 持久化

export function readStoredTheme(): ThemePreference | null {
  try {
    const stored = getStorage()?.getItem(THEME_STORAGE_KEY) ?? null
    return isThemePreference(stored) ? stored : null
  } catch {
    return null
  }
}

export function storeTheme(preference: ThemePreference): void {
  try {
    getStorage()?.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // localStorage 不可用（隐私模式/受限环境）时只影响持久化，不影响当前会话。
  }
}

// MARK: - 解析

/** 系统当前是否深色。没有 matchMedia 的环境（单测）按浅色处理。 */
export function systemPrefersDark(): boolean {
  const media = getWindow()?.matchMedia
  if (typeof media !== 'function') return false
  return media(DARK_MEDIA_QUERY).matches
}

/**
 * 偏好 → 实际明暗。`system` 才需要问系统，其余两种情况直接就是答案。
 * 纯函数：`systemDark` 显式传入，单测不必伪造 matchMedia。
 */
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean = systemPrefersDark()
): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

/**
 * 把解析结果写到根元素。这是**唯一**的写入口。
 *
 * `color-scheme` 一起设：原生滚动条、输入框、系统右键菜单都靠它跟随，
 * 只改 `data-theme` 的话它们会留在浅色，夜里格外刺眼。
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = getDocument()?.documentElement
  if (!root) return
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

/**
 * 首帧前调用一次：读偏好、解析、落到 DOM，并把结果交还给调用方当初始状态。
 * 同步执行——放在 `render()` 之前，页面第一次绘制就已经是对的颜色。
 */
export function applyInitialTheme(): { preference: ThemePreference; theme: ResolvedTheme } {
  const preference = readStoredTheme() ?? 'system'
  const theme = resolveTheme(preference)
  applyTheme(theme)
  return { preference, theme }
}

/**
 * 订阅系统外观变化。只在偏好为 `system` 时才有意义，由调用方决定是否挂载。
 * 返回取消订阅函数——组件卸载时必须断开，否则每次热更新都会叠一个监听器。
 */
export function subscribeSystemTheme(listener: (dark: boolean) => void): () => void {
  const media = getWindow()?.matchMedia
  if (typeof media !== 'function') return () => {}
  const query = media(DARK_MEDIA_QUERY)
  const onChange: MediaListener = (event) => listener(event.matches)
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }
  // 老式 Safari 只有 addListener；Electron 里走不到，留着不亏。
  query.addListener?.(onChange)
  return () => query.removeListener?.(onChange)
}
