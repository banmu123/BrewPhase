import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { I18nProvider } from './i18n'
import { ThemeProvider } from './shared/ThemeProvider'
import './styles/app.css'

// 外观在最外层：`ThemeProvider` 的初始状态会把 `data-theme` 同步写到 `<html>`，
// 所以下面这棵树的第一次绘制就已经是浅色或深色，不会先亮一下再变暗。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
)
