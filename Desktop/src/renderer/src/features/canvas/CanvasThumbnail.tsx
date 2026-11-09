import { useEffect, useRef, useState } from 'react'
import type { Canvas } from '@shared/contracts'
import { api } from '../../shared/api'
import { selectThumbnailItems, type ThumbnailItem } from './canvas-thumbnail-model'

/**
 * 画布缩略图：展示的是画布的**真实空间构成**，不是图片宫格（对标 iOS
 * `CanvasThumbnailPreview`）。选点算法在 `canvas-thumbnail-model.ts`；
 * 这里只负责渲染：
 *
 * - **真实容器尺寸**做等比装入（ResizeObserver 测量）——x/y/width/height 用
 *   同一个局部坐标系，横向与纵向映射一致，窗口变化自动重算；
 * - 只读 `previewFileFor` 给出的预览文件，不创建播放器、不建 iframe；
 * - 读失败保留上一张缩略图——清空会让人以为画布空了；
 * - 缓存 key = `canvas.updatedAt` + 源记录最新 `recordUpdatedAt`：媒体或预览
 *   变化时画布自身 updatedAt 不动，也要能刷新。
 */

type ThumbData = {
  items: ThumbnailItem[]
  bounds: { minX: number; minY: number; width: number; height: number }
  total: number
  maxRecordUpdatedAt: number
}

type CacheEntry = { canvasUpdatedAt: number; maxRecordUpdatedAt: number; data: ThumbData | null }

/** 模块级缓存：Gallery 重渲染不重复查询；画布或源记录任一变化即失效。 */
const cache = new Map<string, CacheEntry>()

const THUMB_PADDING = 10

export function CanvasThumbnail(props: { canvas: Canvas; height?: number }) {
  const { canvas } = props
  const height = props.height ?? 132
  const [data, setData] = useState<ThumbData | null>(() => {
    const hit = cache.get(canvas.id)
    return hit && hit.canvasUpdatedAt === canvas.updatedAt ? hit.data : null
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height })

  // 真实容器尺寸：等比装入的唯一依据（窗口变化自动重算，不重复读节点）。
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const hit = cache.get(canvas.id)
    if (hit && hit.canvasUpdatedAt === canvas.updatedAt) {
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
          ? {
              items: picked.items,
              bounds: picked.bounds,
              total: nodes.length,
              maxRecordUpdatedAt: picked.maxRecordUpdatedAt
            }
          : null
        cache.set(canvas.id, {
          canvasUpdatedAt: canvas.updatedAt,
          maxRecordUpdatedAt: next?.maxRecordUpdatedAt ?? 0,
          data: next
        })
        setData(next)
      })
      .catch(() => {
        // 读失败保留上一张：清空会让人以为画布空了。
      })
    return () => {
      alive = false
    }
  }, [canvas.id, canvas.updatedAt])

  // 源记录变化（媒体/预览更新）时画布 updatedAt 不动：单独失效缓存并重算。
  useEffect(() => {
    if (!data) return
    const hit = cache.get(canvas.id)
    if (hit && hit.maxRecordUpdatedAt !== data.maxRecordUpdatedAt) {
      cache.delete(canvas.id)
      setData(null)
    }
  }, [data, canvas.id])

  if (!data || data.items.length === 0) {
    return (
      <div ref={containerRef} className="canvas-thumb canvas-thumb--empty" style={{ height }}>
        <span className="canvas-thumb__brand">◈</span>
        <span className="canvas-thumb__brand-name">{canvas.name || '未命名画布'}</span>
      </div>
    )
  }

  const containerWidth = size.width > 0 ? size.width : 300
  const containerHeight = size.height > 0 ? size.height : height
  const scale = Math.min(
    (containerWidth - THUMB_PADDING * 2) / data.bounds.width,
    (containerHeight - THUMB_PADDING * 2) / data.bounds.height
  )
  const originX = (containerWidth - data.bounds.width * scale) / 2
  const originY = (containerHeight - data.bounds.height * scale) / 2

  return (
    <div ref={containerRef} className="canvas-thumb" style={{ height }}>
      {data.items.map((item) => {
        const w = Math.max(6, item.frame.width * scale)
        const h = Math.max(5, item.frame.height * scale)
        const left = originX + (item.frame.x - data.bounds.minX) * scale
        const top = originY + (item.frame.y - data.bounds.minY) * scale
        return (
          <span
            key={item.id}
            className={`canvas-thumb__node canvas-thumb__node--${item.carrier}`}
            style={{ left, top, width: w, height: h }}
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
              <span className="canvas-thumb__symbol">
                {item.carrier === 'video' ? '▶' : item.carrier === 'link' ? '↗' : '▣'}
              </span>
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
