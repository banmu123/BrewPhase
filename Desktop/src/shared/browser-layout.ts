import {
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  type BrowserBounds
} from './contracts/browser'

/**
 * 浏览器浮窗的几何计算（纯函数，主进程与渲染层共用）。
 *
 * 坐标系只有一个：**窗口内容区的 CSS px**。渲染层传 `getBoundingClientRect()`
 * 的结果，主进程直接给 `WebContentsView.setBounds()`——两边单位一致（DIP），
 * 不需要任何缩放换算。所有入口都从这里过一遍 clamp，越界值不会被信任。
 */

export type BrowserViewport = { width: number; height: number }

/**
 * 顶栏高度（`.topbar` 52px）。浮窗的标题栏不能压住它——
 * 一旦压住，用户就点不到搜索与设置，也拖不动窗口本身（红绿灯区）。
 */
export const BROWSER_TOP_INSET = 52

/** 八向缩放的方向：四边 + 四角。 */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * 把矩形收进窗口：先钳尺寸，再钳位置。
 *
 * 顺序很重要——先尺寸后位置，才能保证「窗口比最小尺寸还小」时也不会算出
 * 负的可用空间（位置下限取 0，不取负）。
 *
 * 纵向还有一个额外下限：不能盖住顶栏。窗口太矮、扣掉顶栏放不下最小高度时，
 * 让底部对齐窗口底边（此时 `minY` 被 `maxY` 压回去），而不是把窗口顶出去。
 */
export function clampBrowserBounds(bounds: BrowserBounds, viewport: BrowserViewport): BrowserBounds {
  const maxWidth = Math.max(BROWSER_MIN_WIDTH, Math.floor(viewport.width))
  const maxHeight = Math.max(BROWSER_MIN_HEIGHT, Math.floor(viewport.height))
  const width = Math.min(Math.max(Math.round(bounds.width), BROWSER_MIN_WIDTH), maxWidth)
  const height = Math.min(Math.max(Math.round(bounds.height), BROWSER_MIN_HEIGHT), maxHeight)
  const x = Math.min(Math.max(Math.round(bounds.x), 0), Math.max(0, Math.round(viewport.width) - width))
  const maxY = Math.max(0, Math.round(viewport.height) - height)
  const minY = Math.min(BROWSER_TOP_INSET, maxY)
  const y = Math.min(Math.max(Math.round(bounds.y), minY), maxY)
  return { x, y, width, height }
}

/** 首次打开（或旧布局不可用）时的默认位置：居中、约 82%，避让顶栏。 */
export function defaultBrowserBounds(viewport: BrowserViewport): BrowserBounds {
  const width = Math.min(1080, Math.max(BROWSER_MIN_WIDTH, Math.round(viewport.width * 0.82)))
  const height = Math.min(880, Math.max(BROWSER_MIN_HEIGHT, Math.round(viewport.height * 0.82)))
  const x = Math.max(0, Math.round((viewport.width - width) / 2))
  // 顶栏 52px + 一点呼吸：窗口再矮，标题栏也不能压在顶栏底下。
  const y = Math.max(BROWSER_TOP_INSET + 12, Math.round((viewport.height - height) / 2))
  return clampBrowserBounds({ x, y, width, height }, viewport)
}

/** 拖动：位移加在起点上，再 clamp——拖到边上就停住，不会被甩出窗口。 */
export function moveBrowserBounds(
  start: BrowserBounds,
  deltaX: number,
  deltaY: number,
  viewport: BrowserViewport
): BrowserBounds {
  return clampBrowserBounds(
    { x: start.x + deltaX, y: start.y + deltaY, width: start.width, height: start.height },
    viewport
  )
}

/**
 * 缩放：按住哪个方向就只改哪条边，对角同时改两边。
 *
 * 关键细节：改左/上边时**对边固定**。如果先用「新宽度」再算 x，会出现
 * 拖到最小宽度后左边缘继续跑、右边缘跟着动的漂移。所以这里先确定锚定边，
 * 再用 `x = anchor右 - width` 反推。
 */
export function resizeBrowserBounds(
  start: BrowserBounds,
  deltaX: number,
  deltaY: number,
  direction: ResizeDirection,
  viewport: BrowserViewport
): BrowserBounds {
  const right = start.x + start.width
  const bottom = start.y + start.height

  let x = start.x
  let y = start.y
  let width = start.width
  let height = start.height

  if (direction.includes('e')) {
    const maxWidth = Math.max(BROWSER_MIN_WIDTH, Math.round(viewport.width) - start.x)
    width = Math.min(Math.max(start.width + deltaX, BROWSER_MIN_WIDTH), maxWidth)
  }
  if (direction.includes('s')) {
    const maxHeight = Math.max(BROWSER_MIN_HEIGHT, Math.round(viewport.height) - start.y)
    height = Math.min(Math.max(start.height + deltaY, BROWSER_MIN_HEIGHT), maxHeight)
  }
  if (direction.includes('w')) {
    const maxWidth = right
    width = Math.min(Math.max(start.width - deltaX, BROWSER_MIN_WIDTH), maxWidth)
    x = right - width
  }
  if (direction.includes('n')) {
    // 上边最多长到顶栏下沿。用 `bottom - TOP_INSET` 而不是 `bottom`：
    // 否则拖到顶以后 clamp 会把 y 抬回 52，锚定边跟着上移，用户继续拖
    // 浮窗就会一直变高（一次拖动里连涨几百像素）。
    const maxHeight = Math.max(BROWSER_MIN_HEIGHT, bottom - BROWSER_TOP_INSET)
    height = Math.min(Math.max(start.height - deltaY, BROWSER_MIN_HEIGHT), maxHeight)
    y = bottom - height
  }

  return clampBrowserBounds({ x, y, width, height }, viewport)
}

/**
 * 窗口尺寸变化后修正浮窗：保持原位置，尺寸超出就收回来。
 * 位置已经在屏幕外（比如窗口从大屏缩到小窗）时，clamp 会把它推回可视区。
 */
export function fitBrowserBounds(bounds: BrowserBounds, viewport: BrowserViewport): BrowserBounds {
  return clampBrowserBounds(bounds, viewport)
}

/** 保存的布局是否还能用：尺寸必须够大，坐标不能是 NaN。 */
export function isUsableBrowserBounds(bounds: BrowserBounds | null): bounds is BrowserBounds {
  if (!bounds) return false
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (values.some((value) => !Number.isFinite(value))) return false
  return bounds.width >= BROWSER_MIN_WIDTH && bounds.height >= BROWSER_MIN_HEIGHT
}
