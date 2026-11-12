import type { TitleBarPlatform } from '../app/TopBar'

/**
 * 平台形态（渲染层唯一来源）：
 * - `mac`：hiddenInset 红绿灯占左上角约 80px；
 * - `windows`：titleBarOverlay 原生按钮画在右上角，用 env(titlebar-area-*) 避开；
 * - `other`（Linux 等）：保留系统标题栏，无需额外留白。
 *
 * 画布工作区会把全局顶栏换成 canvas-topbar，所以两个组件都要用同一份判定。
 */
export function titleBarPlatform(): TitleBarPlatform {
  if (typeof navigator === 'undefined') return 'other'
  if (navigator.userAgent.includes('Mac')) return 'mac'
  if (navigator.userAgent.includes('Windows')) return 'windows'
  return 'other'
}
