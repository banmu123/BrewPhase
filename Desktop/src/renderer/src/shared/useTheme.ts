import { useContext } from 'react'
import { ThemeContext, type ThemeContextValue } from './ThemeProvider'

/** 读当前外观。必须在 `ThemeProvider` 之内调用，否则直接报错而不是静默取默认值。 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 之内使用')
  return value
}
