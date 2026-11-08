import type { CanvasNodeWithRecord } from '@shared/contracts'

/**
 * 缩略图选点算法（对标 iOS `CanvasThumbnailData.make`，纯函数、无 DOM 依赖，
 * 组件渲染与单元测试共用同一份实现）。
 *
 * 1. **全部节点**参与世界坐标包围盒计算——缩略图看的是分布，不是内容合集；
 * 2. 只选最多 8 个代表性节点：四种载体各先来一个，其余按「离已选节点最远」
 *    补齐，让名额覆盖整块画布而不是全堆在左上角；
 * 3. 排序与打分全部确定性：同一份数据每次选出的点完全一样。
 */

export const THUMBNAIL_LIMIT = 8

export type ThumbnailItem = {
  id: string
  carrier: string
  title: string
  previewPath: string | null
  frame: { x: number; y: number; width: number; height: number }
}

export type ThumbnailSelection = {
  items: ThumbnailItem[]
  bounds: { minX: number; minY: number; width: number; height: number }
}

export function selectThumbnailItems(
  nodes: CanvasNodeWithRecord[],
  limit = THUMBNAIL_LIMIT
): ThumbnailSelection | null {
  if (nodes.length === 0) return null

  // 全部节点算包围盒。
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.positionX)
    minY = Math.min(minY, node.positionY)
    maxX = Math.max(maxX, node.positionX + node.width)
    maxY = Math.max(maxY, node.positionY + node.height)
  }
  const bounds = { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }

  // 确定性排序：创建时间，同分用 id。
  const ordered = [...nodes].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : 1
  })

  const toThumb = (node: CanvasNodeWithRecord): ThumbnailItem => ({
    id: node.id,
    carrier: node.recordCarrier,
    title: node.recordTitle,
    previewPath: node.recordPreviewPath ?? node.recordMediaPath,
    frame: { x: node.positionX, y: node.positionY, width: node.width, height: node.height }
  })

  // 四种载体各先来一个：一眼看出这块画布装了什么。
  const selected: CanvasNodeWithRecord[] = []
  const used = new Set<string>()
  for (const carrier of ['image', 'video', 'link', 'text']) {
    const match = ordered.find((node) => !used.has(node.id) && node.recordCarrier === carrier)
    if (match) {
      selected.push(match)
      used.add(match.id)
    }
  }

  // 剩余名额按「离已选节点最近有多远」最大者补（iOS spreadScore 同语义）。
  const spreadScore = (node: CanvasNodeWithRecord): number => {
    if (selected.length === 0) return Number.POSITIVE_INFINITY
    const cx = node.positionX + node.width / 2
    const cy = node.positionY + node.height / 2
    let best = Number.POSITIVE_INFINITY
    for (const other of selected) {
      const dx = cx - (other.positionX + other.width / 2)
      const dy = cy - (other.positionY + other.height / 2)
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy))
    }
    return best
  }
  while (selected.length < limit) {
    let chosen: CanvasNodeWithRecord | null = null
    let chosenScore = -1
    for (const candidate of ordered) {
      if (used.has(candidate.id)) continue
      const score = spreadScore(candidate)
      if (score > chosenScore) {
        chosenScore = score
        chosen = candidate
      }
    }
    if (!chosen) break
    selected.push(chosen)
    used.add(chosen.id)
  }

  return { items: selected.map(toThumb), bounds }
}
