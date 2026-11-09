import { describe, expect, it } from 'vitest'
import {
  previewFileFor,
  selectThumbnailItems
} from '../../src/renderer/src/features/canvas/canvas-thumbnail-model'
import type { CanvasNodeWithRecord } from '../../src/shared/contracts'

/** 复刻 iOS CanvasThumbnailDataTests 的验收口径：选点确定性、包围盒、载体覆盖。 */

function node(partial: Partial<CanvasNodeWithRecord> & { id: string; recordCarrier: string }): CanvasNodeWithRecord {
  const { id, ...rest } = partial
  return {
    canvasID: '00000000-0000-4000-8000-000000000000',
    recordID: id,
    positionX: 0,
    positionY: 0,
    width: 200,
    height: 150,
    zIndex: 0,
    annotation: '',
    createdAt: 1_000,
    updatedAt: 1_000,
    recordTitle: `标题 ${id.slice(-2)}`,
    recordMediaPath: null,
    recordPreviewPath: null,
    recordNote: '',
    recordSourceName: '',
    recordSummary: '',
    recordProvider: 'generic',
    recordPlatformContentID: null,
    recordURLString: '',
    recordUpdatedAt: 1_000,
    ...rest,
    id
  } as CanvasNodeWithRecord
}

describe('selectThumbnailItems（对标 iOS CanvasThumbnailData.make）', () => {
  it('包围盒包含全部节点（不只是被选中的 8 个）', () => {
    const nodes = [
      node({ id: 'n1', recordCarrier: 'text', positionX: 0, positionY: 0 }),
      node({ id: 'n2', recordCarrier: 'text', positionX: 5_000, positionY: 4_000 })
    ]
    const result = selectThumbnailItems(nodes)!
    expect(result.bounds.minX).toBe(0)
    expect(result.bounds.minY).toBe(0)
    expect(result.bounds.width).toBeGreaterThanOrEqual(5_200)
    expect(result.bounds.height).toBeGreaterThanOrEqual(4_150)
  })

  it('四种载体各先来一个：一眼看出画布装了什么', () => {
    const nodes = [
      node({ id: 't1', recordCarrier: 'text' }),
      node({ id: 't2', recordCarrier: 'text' }),
      node({ id: 'i1', recordCarrier: 'image', positionX: 300 }),
      node({ id: 'v1', recordCarrier: 'video', positionX: 600 }),
      node({ id: 'l1', recordCarrier: 'link', positionX: 900 })
    ]
    const items = selectThumbnailItems(nodes)!.items
    const carriers = items.map((item) => item.carrier)
    expect(carriers).toContain('text')
    expect(carriers).toContain('image')
    expect(carriers).toContain('video')
    expect(carriers).toContain('link')
  })

  it('超过 8 个节点时只选 8 个，且剩余名额偏向远离已选节点（空间分布）', () => {
    const nodes: CanvasNodeWithRecord[] = []
    // 8 个挤在左上角 + 1 个远在右下角
    for (let i = 0; i < 8; i += 1) {
      nodes.push(node({ id: `c${i}`, recordCarrier: 'text', positionX: i * 10, positionY: 0, createdAt: 1_000 + i }))
    }
    nodes.push(node({ id: 'far', recordCarrier: 'text', positionX: 8_000, positionY: 6_000, createdAt: 900 }))
    const items = selectThumbnailItems(nodes)!.items
    expect(items).toHaveLength(8)
    // 右下角那个必须入选（离已选节点最远）
    expect(items.some((item) => item.id === 'far')).toBe(true)
  })

  it('同一份数据选点完全确定（排序 + 打分无随机）', () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      node({ id: `n${i}`, recordCarrier: i % 2 ? 'text' : 'image', positionX: i * 130, positionY: (i % 5) * 100 })
    )
    const first = selectThumbnailItems(nodes)!
    const second = selectThumbnailItems(nodes)!
    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id))
    expect(first.bounds).toEqual(second.bounds)
  })

  it('空画布返回 null（Gallery 显示品牌封面）', () => {
    expect(selectThumbnailItems([])).toBeNull()
  })
})

describe('previewFileFor（按载体选预览文件）', () => {
  it('image：优先 previewPath，缺省回退 mediaPath', () => {
    expect(previewFileFor('image', 'thumb.jpg', 'full.jpg')).toBe('thumb.jpg')
    expect(previewFileFor('image', null, 'full.jpg')).toBe('full.jpg')
  })
  it('video / link：只用 previewPath，绝不把视频本体当图片', () => {
    expect(previewFileFor('video', 'cover.jpg', 'movie.mov')).toBe('cover.jpg')
    expect(previewFileFor('video', null, 'movie.mov')).toBeNull()
    expect(previewFileFor('link', 'shot.jpg', null)).toBe('shot.jpg')
    expect(previewFileFor('link', null, null)).toBeNull()
  })
  it('text：不加载图片', () => {
    expect(previewFileFor('text', 'x.jpg', 'y.jpg')).toBeNull()
  })
})
