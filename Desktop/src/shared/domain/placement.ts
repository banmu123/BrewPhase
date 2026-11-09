/**
 * 新节点的落位：在画布上找一个不与已有节点重叠的位置。
 *
 * 用「逐行扫描 + 命中即跳过」而不是随机撒点：同一个画布重复添加时位置可预测，
 * 不会出现两张卡叠在一起、用户还得先拖开才能看见的情况。
 */
export type Rect = { x: number; y: number; width: number; height: number }

export const PLACEMENT = {
  step: 24,
  gap: 16,
  maxColumns: 60,
  maxRows: 400
} as const

export function nextNodeOrigin(params: {
  occupied: Rect[]
  width: number
  height: number
  /** 从当前视口的左上角开始找，新卡片会出现在用户正在看的地方。 */
  startX?: number
  startY?: number
}): { x: number; y: number } {
  const { occupied, width, height } = params
  const startX = params.startX ?? 0
  const startY = params.startY ?? 0
  if (occupied.length === 0) return { x: startX, y: startY }

  const { step, gap, maxColumns, maxRows } = PLACEMENT
  for (let row = 0; row < maxRows; row += 1) {
    for (let column = 0; column < maxColumns; column += 1) {
      const candidate = {
        x: startX + column * (width + gap),
        y: startY + row * (height + gap)
      }
      const rect = { ...candidate, width, height }
      if (!occupied.some((other) => intersects(rect, other, gap))) return candidate
    }
  }
  // 极端情况（画布上已经有成千上万个节点）：排到最下方，不阻塞添加。
  const maxY = occupied.reduce((max, rect) => Math.max(max, rect.y + rect.height), 0)
  return { x: startX, y: maxY + gap * 2 }
}

export function intersects(a: Rect, b: Rect, gap = 0): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  )
}

/** 内容包围盒，用于「缩放到适合内容」。 */
export function contentBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  const minX = Math.min(...rects.map((rect) => rect.x))
  const minY = Math.min(...rects.map((rect) => rect.y))
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width))
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * 「缩放到适合内容」的唯一计算：自动装窗与手动 Fit All 共用同一份公式，
 * 不允许两处各写一份迟早漂移的实现。
 *
 * @param rects  全部内容的世界矩形（节点 + 便签；笔迹由调用方展平成点矩形）
 * @param size   画布容器的 CSS 尺寸
 * @param pad    内容四周留白（世界单位）
 * @param limits 缩放上下限
 */
export function fitViewport(
  rects: Rect[],
  size: { width: number; height: number },
  pad: number,
  limits: { minScale: number; maxScale: number }
): { scale: number; offsetX: number; offsetY: number } {
  const bounds = contentBounds(
    rects.map((rect) => ({ x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }))
  )
  if (!bounds || size.width <= 0 || size.height <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 }
  }
  const scale = Math.min(
    limits.maxScale,
    Math.max(limits.minScale, Math.min(size.width / bounds.width, size.height / bounds.height))
  )
  return {
    scale,
    offsetX: -bounds.x * scale + (size.width - bounds.width * scale) / 2,
    offsetY: -bounds.y * scale + (size.height - bounds.height * scale) / 2
  }
}
