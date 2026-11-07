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
  cream: '--cream',
  phaseResting: '--phase-resting',
  phaseOpening: '--phase-opening',
  phasePeak: '--phase-peak',
  phaseDeclining: '--phase-declining',
  priority: '--priority'
}

let cache: ThemeColors | null = null

/** 读一次 CSS 变量并缓存。画布挂载时与 `RefreshOnThemeChange` 场景调用。 */
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
  return cache
}

/** Konva 渲染时取色。首次调用会自动初始化缓存。 */
export function themeColors(): ThemeColors {
  if (!cache) return refreshThemeColors()
  return cache
}
