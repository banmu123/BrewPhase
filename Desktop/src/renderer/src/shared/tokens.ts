/**
 * Konva 画在 canvas 上，读不到 CSS——这里的职责只有一件事：
 * 在运行时把 `app.css` 里 `:root` 的设计令牌取出来，交给 Konva 的 Shape 用。
 *
 * 颜色的**唯一来源**是 `app.css` 的 CSS 变量；本文件不持有任何色值，
 * 也不提供回退默认——CSS 缺了变量就按透明处理并在开发期报出来，
 * 这样「两套颜色配置漂移」在结构上不可能发生。
 */

export type ThemeColors = {
  paper: string
  card: string
  well: string
  wellDeep: string
  hairline: string
  ink: string
  inkSoft: string
  inkFaint: string
  espresso: string
  roast: string
  latte: string
  sage: string
  cream: string
  phaseResting: string
  phaseOpening: string
  phasePeak: string
  phaseDeclining: string
  priority: string
}

const VARS: Record<keyof ThemeColors, string> = {
  paper: '--paper',
  card: '--card',
  well: '--well',
  wellDeep: '--well-deep',
  hairline: '--hairline',
  ink: '--ink',
  inkSoft: '--ink-soft',
  inkFaint: '--ink-faint',
  espresso: '--espresso',
  roast: '--roast',
  latte: '--latte',
  sage: '--sage',
  cream: '--cream',
  phaseResting: '--phase-resting',
  phaseOpening: '--phase-opening',
  phasePeak: '--phase-peak',
  phaseDeclining: '--phase-declining',
  priority: '--priority'
}

let cache: ThemeColors | null = null
/** 缓存是对着哪一套明暗读的。`data-theme` 一变，这份缓存立即作废。 */
let cachedTheme: string | null = null

/** 当前落在 `<html>` 上的外观；未设置时按浅色的一组变量读。 */
function currentTheme(): string {
  if (typeof document === 'undefined') return ''
  return document.documentElement.dataset.theme ?? ''
}

/** 强制丢弃缓存并重读。画布挂载时，以及外观切换后调用。 */
export function refreshThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string): string => style.getPropertyValue(name).trim()
  const missing = Object.entries(VARS).filter(([, cssName]) => !read(cssName))
  if (missing.length > 0 && import.meta.env.DEV) {
    console.warn(`[tokens] CSS 变量缺失：${missing.map(([, name]) => name).join(', ')}`)
  }
  cache = Object.fromEntries(
    Object.entries(VARS).map(([key, cssName]) => [key, read(cssName)])
  ) as ThemeColors
  cachedTheme = currentTheme()
  return cache
}

/**
 * Konva 渲染时取色。
 *
 * 缓存自己带外观标记：切换浅色/深色之后不需要任何调用点显式刷新——
 * 下一次取色发现 `data-theme` 变了就重读。少了这一步，画布会一直停在
 * 打开它那一刻的配色，页面全黑而画布仍是白的。
 */
export function themeColors(): ThemeColors {
  if (!cache || cachedTheme !== currentTheme()) return refreshThemeColors()
  return cache
}
