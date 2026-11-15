import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'

/**
 * 窗口自身那一层的配色：`backgroundColor` 与 Windows 标题栏按钮。
 *
 * 这里必须和 `styles/app.css` 的 `--paper` / `--ink` 保持一致——窗口底色是
 * 页面还没画出来、或者被拖动缩放时露出的那一层，两边差一点就是一道白光。
 * 这两组值是主进程唯一需要的颜色，其余全部交给 CSS，所以只抄这一对，
 * 不把整份色板搬进主进程。
 */
export const WINDOW_CHROME = {
  light: { background: '#f7f8f6', symbol: '#30372f' },
  dark: { background: '#15120f', symbol: '#efe7dc' }
} as const

export type WindowAppearance = keyof typeof WINDOW_CHROME

/**
 * 窗口创建时的初始外观。
 *
 * 首帧取系统设置：默认偏好就是「跟随系统」，这是覆盖最多用户的那一档。
 * 强制浅色/深色的用户会在 Renderer 起来后由 IPC 纠正——但那时窗口还没
 * `show()`（`ready-to-show` 之后才显示），所以看不到这一瞬的差异。
 */
export function initialWindowAppearance(): WindowAppearance {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * 开发态的窗口/任务栏/Alt-Tab 图标：不设就是 Electron 原子默认图标。
 * 打包版由 electron-builder 把 build/icon.ico 烧进 exe，这里只补 dev /
 * preview；macOS 不需要（子窗口任务栏不单独显示，dock 图标走应用包）。
 * 主窗口、圆桌窗口、浏览器浮窗共用这一个来源。
 */
export function windowIconPath(): string | null {
  if (process.platform === 'darwin') return null
  const candidates =
    process.platform === 'win32'
      ? [join(app.getAppPath(), 'build/icon.ico'), join(app.getAppPath(), 'build/icon.png')]
      : [join(app.getAppPath(), 'build/icon.png')]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
