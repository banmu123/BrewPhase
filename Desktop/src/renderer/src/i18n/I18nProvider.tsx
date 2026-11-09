import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createFormatters, resolveInitialLocale, storeLocale, type Locale } from './locale'
import { zhCN, type Messages } from './messages/zh-CN'
import { enUS } from './messages/en-US'

/**
 * 全局语言上下文。
 *
 * `t` 就是当前语言的整本字典（类型来自 zh-CN），组件直接 `t.settings.title`
 * 取值——没有字符串路径解析，拼错 Key 是编译错误，不是运行时 undefined。
 * 带插值的条目在字典里写成函数（`count: (n) => ...`），两种语言签名相同。
 */

export type I18nContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Messages
  formatDate: (value: number | Date) => string
  formatDateTime: (value: number | Date) => string
  formatNumber: (value: number) => string
}

export const I18nContext = createContext<I18nContextValue | null>(null)

const MESSAGES: Record<Locale, Messages> = { 'zh-CN': zhCN, 'en-US': enUS }

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => resolveInitialLocale())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    storeLocale(next)
  }, [])

  useEffect(() => {
    // 让 <html lang> 跟上：屏幕阅读器与浏览器排版都依赖它。
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<I18nContextValue>(() => {
    return {
      locale,
      setLocale,
      t: MESSAGES[locale],
      ...createFormatters(locale)
    }
  }, [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
