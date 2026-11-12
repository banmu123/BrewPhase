import { nativeTheme } from 'electron'

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
