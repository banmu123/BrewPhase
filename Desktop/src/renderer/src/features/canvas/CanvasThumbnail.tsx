import { useEffect, useState } from 'react'
import type { Canvas } from '@shared/contracts'
import { api } from '../../shared/api'
import { selectThumbnailItems, type ThumbnailItem } from './canvas-thumbnail-model'

/**
 * 画布缩略图：展示的是画布的**真实空间构成**，不是图片宫格（对标 iOS
 * `CanvasThumbnailPreview`）。选点算法在 `canvas-thumbnail-model.ts`
 * （组件渲染与单元测试共用）；这里只负责渲染：
 *
 * - 只读已有的 previewPath 缩略图，不创建播放器、不建 iframe、不读原图；
 * - 读失败保留上一张缩略图——清空会让人以为画布空了；
 * - 按 `canvas.updatedAt` 刷新，模块级缓存避免 Gallery 重渲染时重复 IPC。
 */

const THUMB_LIMIT = 8

/** 模块级缓存：Gallery 打开期间重渲染不重复查询；画布 updatedAt 变了才失效。 */
const cache = new Map<string, { updatedAt: number; data: ThumbData | null }>()

type ThumbData = {
  items: ThumbnailItem[]
  bounds: { minX: number; minY: number; width: number; height: number }
  total: number
}

export function CanvasThumbnail(props: { canvas: Canvas; height?: number }) {
  const { canvas } = props
  const height = props.height ?? 132
  const [data, setData] = useState<ThumbData | null>(() => {
    const hit = cache.get(canvas.id)
    return hit && hit.updatedAt === canvas.updatedAt ? hit.data : null
  })

  useEffect(() => {
    const hit = cache.get(canvas.id)
    if (hit && hit.updatedAt === canvas.updatedAt) {
      setData(hit.data)
      return
    }
    let alive = true
    api.canvas
      .nodes(canvas.id)
      .then((nodes) => {
        if (!alive) return
        const picked = selectThumbnailItems(nodes)
        const next: ThumbData | null = picked
          ? { items: picked.items, bounds: picked.bounds, total: nodes.length }
          : null
        cache.set(canvas.id, { updatedAt: canvas.updatedAt, data: next })
        setData(next)
      })
      .catch(() => {
        // 读失败保留上一张：清空会让人以为画布空了。
      })
    return () => {
      alive = false
    }
  }, [canvas.id, canvas.updatedAt])

  if (!data || data.items.length === 0) {
    return (
      <div className="canvas-thumb canvas-thumb--empty" style={{ height }}>
        <span className="canvas-thumb__brand">◈</span>
        <span className="canvas-thumb__brand-name">{canvas.name || '未命名画布'}</span>
      </div>
    )
  }

  // 等比装进封面：与 iOS ThumbnailLayout 同一条公式（含 10px 内边距）。
  const padding = 10
  const width = 100 // 容器按百分比铺满，这里用固定基数算 scale 的宽度项
  const scale = Math.min(
    (width - padding * 2) / data.bounds.width,
    (height - padding * 2) / data.bounds.height
  )
  const originX = (width - data.bounds.width * scale) / 2
  const originY = (height - data.bounds.height * scale) / 2

  return (
    <div className="canvas-thumb" style={{ height }}>
      {data.items.map((item) => {
        const w = Math.max(6, item.frame.width * scale)
        const h = Math.max(5, item.frame.height * scale)
        const left = originX + (item.frame.x + item.frame.width / 2 - data.bounds.minX) * scale - w / 2
        const top = originY + (item.frame.y + item.frame.height / 2 - data.bounds.minY) * scale - h / 2
        const symbol = item.carrier === 'text' ? '¶' : item.carrier === 'video' ? '▶' : '▣'
        return (
          <span
            key={item.id}
            className={`canvas-thumb__node canvas-thumb__node--${item.carrier}`}
            style={{ left: `${(left / width) * 100}%`, top, width: w, height: h }}
          >
            {item.carrier === 'text' ? (
              <span className="canvas-thumb__lines">
                <i style={{ width: '92%' }} />
                <i style={{ width: '70%' }} />
                <i style={{ width: '78%' }} />
              </span>
            ) : item.previewPath ? (
              <img src={api.records.mediaUrl(item.previewPath)} alt="" loading="lazy" />
            ) : (
              <span className="canvas-thumb__symbol">{symbol}</span>
            )}
          </span>
        )
      })}
      {data.total > data.items.length && (
        <span className="canvas-thumb__more">+{data.total - data.items.length}</span>
      )}
    </div>
  )
}
