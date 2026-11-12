import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import {
  applyInitialTheme,
  applyTheme,
  resolveTheme,
  storeTheme,
  subscribeSystemTheme,
  type ResolvedTheme,
  type ThemePreference
} from './theme'

/**
 * 全局外观上下文。
 *
 * 状态只保存两份东西：用户**偏好**（三档）与**解析后**的明暗。前者决定
 * 设置页哪个按钮高亮，后者决定画面——两者在「跟随系统」下并不相同，
 * 混成一个字段就没法既显示「跟随系统」又画出深色。
 *
 * `<html data-theme>` 是唯一的落点，CSS 负责其余一切；这里不向组件分发
 * 任何色值，组件也不该知道现在是哪一档。
 */

export type ThemeContextValue = {
  /** 用户选的那一档，决定设置页的选中态。 */
  preference: ThemePreference
  /** 实际渲染的明暗。 */
  theme: ResolvedTheme
  setPreference: (next: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * 通知主进程调整窗口自身那一层（底色、Windows 标题栏按钮）。
 *
 * 这一步失败不该影响界面：页面已经按新外观画好了，只是窗口边缘那一条
 * 没跟上。所以异常吞掉，不弹错、不回滚。
 */
function reportToMain(theme: ResolvedTheme): void {
  try {
    void api.app.setAppearance(theme).catch(() => {})
  } catch {
    // 启动早期 api 尚未注入，或窗口已销毁：外观照旧生效，只是主进程不知道。
  }
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // 惰性初始化：`applyInitialTheme` 同步把 data-theme 写到 DOM 上，
  // 页面的第一次绘制就已经是对的颜色，没有「先浅后深」的闪动。
  const [state, setState] = useState(applyInitialTheme)

  const setPreference = useCallback((next: ThemePreference) => {
    const resolved = resolveTheme(next)
    storeTheme(next)
    applyTheme(resolved)
    setState({ preference: next, theme: resolved })
    reportToMain(resolved)
  }, [])

  // 系统外观只在「跟随系统」时跟着走。用户明确选了浅色/深色，就不该被
  // 系统设置从背后改掉——这正是手动档存在的理由。
  useEffect(() => {
    if (state.preference !== 'system') return
    return subscribeSystemTheme((dark) => {
      const resolved: ResolvedTheme = dark ? 'dark' : 'light'
      applyTheme(resolved)
      setState((prev) => (prev.theme === resolved ? prev : { ...prev, theme: resolved }))
      reportToMain(resolved)
    })
  }, [state.preference])

  // 建窗时主进程只能按系统猜（它读不到 localStorage）。用户强制过外观的话，
  // 这里补报一次，把窗口底色与标题栏按钮纠正过来。
  useEffect(() => {
    reportToMain(state.theme)
    // 只在挂载时补报；后续每次切换都由 setPreference 与系统监听各自上报。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference: state.preference, theme: state.theme, setPreference }),
    [state.preference, state.theme, setPreference]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
