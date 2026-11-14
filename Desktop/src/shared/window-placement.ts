/**
 * 窗口摆放的纯几何（Phase 3）。
 *
 * Electron 的屏幕坐标是**虚拟桌面坐标系**：扩展显示器在主显示器左边或上方
 * 时，坐标是负的。这里绝对不能用 `Math.max(0, …)` 修正——那会把窗口拽到
 * 主显示器上，多显示器下「拖出后窗口出现在错误位置」就是这么来的。
 *
 * 唯一正确的做法：先用 `screen.getDisplayNearestPoint()` 找到落点所在的
 * 显示器，再把窗口矩形收进它的 `workArea`（允许负坐标，只保证完整可见）。
 * 本模块是纯函数，Electron 无关，可以带负坐标用例直接单测。
 */

export type ScreenPoint = { x: number; y: number }
export type ScreenRect = { x: number; y: number; width: number; height: number }

/**
 * 把「贴着落点居中」的窗口矩形收进边界内。
 * 窗口比边界还大时贴齐边界左上角（调用方负责给窗口设 minWidth/minHeight）。
 */
export function fitRectIntoBounds(
  point: ScreenPoint | null,
  width: number,
  height: number,
  bounds: { x: number; y: number; width: number; height: number }
): ScreenRect {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const maxX = bounds.x + Math.max(0, bounds.width - w)
  const maxY = bounds.y + Math.max(0, bounds.height - h)
  const anchorX = point ? point.x : bounds.x + bounds.width / 2
  const anchorY = point ? point.y : bounds.y + bounds.height / 2
  const clamp = (value: number, min: number, max: number): number =>
    max < min ? min : Math.min(Math.max(value, min), max)
  return {
    x: clamp(Math.round(anchorX - w / 2), bounds.x, maxX),
    y: clamp(Math.round(anchorY - h / 2), bounds.y, maxY),
    width: w,
    height: h
  }
}
