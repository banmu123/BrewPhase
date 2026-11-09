/**
 * 语言识别与持久化。
 *
 * 规则（见任务书）：
 * - 首次启动按系统语言：zh* → zh-CN，en* → en-US，其余 → zh-CN；
 * - 用户手动切换后以用户选择为准（localStorage）；
 * - 只持久化到 localStorage，不建数据库迁移。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_STORAGE_KEY = 'brewphase.desktop.locale'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** 系统语言探测：按 navigator.languages 顺序取第一个能识别的。 */
export function detectSystemLocale(): Locale {
  const candidates =
    typeof navigator === 'undefined'
      ? []
      : [navigator.language, ...(navigator.languages ?? [])].filter(Boolean)
  for (const tag of candidates) {
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) return 'zh-CN'
    if (lower.startsWith('en')) return 'en-US'
  }
  return 'zh-CN'
}

/**
 * 存储访问走 `globalThis` 的防御性读取：renderer 里是 window.localStorage，
 * 而单测（node 环境，无 DOM lib）只 stub 了 globalThis.window——用最小结构
 * 类型而不是 DOM 的 `Storage`，两边都能通过类型检查。
 */
type LocaleStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function getStorage(): LocaleStorage | null {
  const candidate = (globalThis as { localStorage?: LocaleStorage }).localStorage
  return candidate ?? null
}

export function readStoredLocale(): Locale | null {
  try {
    const stored = getStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null
    return isLocale(stored) ? stored : null
  } catch {
    return null
  }
}

export function storeLocale(locale: Locale): void {
  try {
    getStorage()?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage 不可用（隐私模式/受限环境）时只影响持久化，不影响当前会话。
  }
}

/** 初始语言：用户选择 > 系统语言 > 简体中文。 */
export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectSystemLocale()
}

/**
 * 按语言创建 Intl 格式化器。抽成纯函数是为了单测能直接验证
 * 「日期/数字随语言变化」这条要求，而不必渲染 React。
 */
export function createFormatters(locale: Locale): {
  formatDate: (value: number | Date) => string
  formatDateTime: (value: number | Date) => string
  formatNumber: (value: number) => string
} {
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const dateTimeFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const numberFormatter = new Intl.NumberFormat(locale)
  const toDate = (value: number | Date): Date => (value instanceof Date ? value : new Date(value))
  return {
    formatDate: (value) => dateFormatter.format(toDate(value)),
    formatDateTime: (value) => dateTimeFormatter.format(toDate(value)),
    formatNumber: (value) => numberFormatter.format(value)
  }
}
