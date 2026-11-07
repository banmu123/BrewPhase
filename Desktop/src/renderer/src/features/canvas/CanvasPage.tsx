import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Layer, Rect, Shape, Stage, Text } from 'react-konva'
import type { Context } from 'konva/lib/Context'
import type { Canvas, CanvasNodeWithRecord, CanvasViewport, RecordItem } from '@shared/contracts'
import { zoomAt } from '@shared/contracts'
import { api, formatDate } from '../../shared/api'
import { refreshThemeColors, themeColors } from '../../shared/tokens'

/**
 * Canvas：无限画布的第一版。
 *
 * 坐标系只有一套：节点存**世界坐标**，Stage 承担缩放与平移。拖动结束时把
 * 节点的新世界坐标写库（一次拖动一次写入），平移/缩放只改视口、不动数据。
 * 手绘笔迹这一版只有表结构，工具在 Phase 4（见 docs/CANVAS_SPEC.md）。
 *
 * 视觉与 iOS 的 CanvasWorkspaceView 同一套令牌：中性浅灰底、白卡、细边、
 * 点阵背景；颜色一律走 `shared/tokens.ts`（CSS 变量是唯一来源）。
 */
export function CanvasPage() {
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<CanvasNodeWithRecord[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [viewport, setViewport] = useState<CanvasViewport>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 800, height: 600 })

  const active = canvases.find((canvas) => canvas.id === activeId) ?? canvases[0] ?? null
  const containerRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null)

  const loadCanvases = useCallback(async () => {
    try {
      const next = await api.canvas.list()
      setCanvases(next)
      setActiveId((current) => current ?? next[0]?.id ?? null)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  const loadNodes = useCallback(async (canvasId: string) => {
    try {
      setNodes(await api.canvas.nodes(canvasId))
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadCanvases()
  }, [loadCanvases])

  useEffect(() => {
    if (!active) {
      setNodes([])
      return
    }
    void loadNodes(active.id)
    setSelectedNodeId(null)
  }, [active?.id, loadNodes])

  useEffect(() => {
    api.records
      .list({ search: '', carrier: null, tagId: null, limit: 60, offset: 0 })
      .then(setRecords)
      .catch((cause: Error) => setError(cause.message))
  }, [])

  useEffect(() => {
    // 画布渲染读不到 CSS：挂载时把设计令牌取一次（HMR 或主题调整后再取）。
    refreshThemeColors()
  }, [])

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

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const addedRecordIds = useMemo(() => new Set(nodes.map((node) => node.recordID)), [nodes])

  return (
    <div className="columns" data-inspector="on">
      <section className="column">
        <h1 className="page-title">画布</h1>
        <p className="page-sub">{canvases.length} 块 · 记录只被引用，不被复制</p>

        <button
          className="button"
          style={{ marginBottom: 12 }}
          onClick={async () => {
            const name = window.prompt('这块画布叫什么？', '新的画布')
            if (!name) return
            const created = await api.canvas.create(name)
            await loadCanvases()
            setActiveId(created.id)
          }}
        >
          新建画布
        </button>

        {error && <div className="error">{error}</div>}

        <div className="list">
          {canvases.map((canvas) => (
            <button
              key={canvas.id}
              className="list-item"
              data-active={canvas.id === active?.id}
              onClick={() => setActiveId(canvas.id)}
            >
              <span className="list-item__title">{canvas.name || '未命名画布'}</span>
              <span className="list-item__meta">{formatDate(canvas.updatedAt)} 更新</span>
            </button>
          ))}
          {canvases.length === 0 && <div className="empty">还没有画布。建一块，把记录摆进去。</div>}
        </div>
      </section>

      <section className="column column--main">
        <div className="canvas-wrap" ref={containerRef}>
          {active ? (
            <Stage
              width={size.width}
              height={size.height}
              scaleX={viewport.scale}
              scaleY={viewport.scale}
              x={viewport.offsetX}
              y={viewport.offsetY}
              onWheel={(event) => {
                event.evt.preventDefault()
                const stage = event.target.getStage()
                const pointer = stage?.getPointerPosition()
                if (!pointer) return
                const next = zoomAt(viewport, viewport.scale * (event.evt.deltaY > 0 ? 0.92 : 1.08), pointer)
                setViewport(next)
              }}
              onMouseDown={(event) => {
                const stage = event.target.getStage()
                if (event.target !== stage) return
                const pointer = stage?.getPointerPosition()
                if (!pointer) return
                setSelectedNodeId(null)
                panRef.current = {
                  pointerX: pointer.x,
                  pointerY: pointer.y,
                  offsetX: viewport.offsetX,
                  offsetY: viewport.offsetY
                }
              }}
              onMouseMove={(event) => {
                const pan = panRef.current
                if (!pan) return
                const pointer = event.target.getStage()?.getPointerPosition()
                if (!pointer) return
                setViewport((current) => ({
                  ...current,
                  offsetX: pan.offsetX + (pointer.x - pan.pointerX),
                  offsetY: pan.offsetY + (pointer.y - pan.pointerY)
                }))
              }}
              onMouseUp={() => {
                panRef.current = null
              }}
              onMouseLeave={() => {
                panRef.current = null
              }}
            >
              <Layer listening={false}>
                <DotGrid width={size.width} height={size.height} viewport={viewport} />
              </Layer>
              <Layer>
                {nodes.map((node) => (
                  <CanvasNodeShape
                    key={node.id}
                    node={node}
                    selected={node.id === selectedNodeId}
                    onSelect={() => setSelectedNodeId(node.id)}
                    onMoved={async (positionX, positionY) => {
                      await api.canvas.moveNode(node.id, positionX, positionY)
                      await loadNodes(active.id)
                    }}
                  />
                ))}
              </Layer>
            </Stage>
          ) : (
            <div className="canvas-empty">还没有画布。</div>
          )}

          {active && nodes.length === 0 && <div className="canvas-empty">空的。右边选几条记录放进来。</div>}

          <div className="canvas-hud">
            <span className="canvas-hud__zoom mono">{Math.round(viewport.scale * 100)}%</span>
            <button
              className="button"
              onClick={() => setViewport({ scale: 1, offsetX: 0, offsetY: 0 })}
            >
              复位
            </button>
            <button
              className="button"
              onClick={() => setViewport((current) => zoomAt(current, current.scale * 1.15, { x: size.width / 2, y: size.height / 2 }))}
            >
              ＋
            </button>
            <button
              className="button"
              onClick={() => setViewport((current) => zoomAt(current, current.scale / 1.15, { x: size.width / 2, y: size.height / 2 }))}
            >
              －
            </button>
          </div>
        </div>
      </section>

      <section className="column column--inspector">
        {active ? (
          <>
            <span className="overline">添加到画布</span>
            <div className="list" style={{ maxHeight: 260, overflow: 'auto', marginBottom: 14 }}>
              {records.map((record) => (
                <button
                  key={record.id}
                  className="list-item"
                  disabled={addedRecordIds.has(record.id)}
                  style={{ opacity: addedRecordIds.has(record.id) ? 0.45 : 1 }}
                  onClick={async () => {
                    await api.canvas.addNode(active.id, record.id)
                    await loadNodes(active.id)
                  }}
                >
                  <span className="list-item__title">{record.title || '未命名记录'}</span>
                  <span className="list-item__meta">
                    {record.carrier}
                    {addedRecordIds.has(record.id) && ' · 已在画布'}
                  </span>
                </button>
              ))}
              {records.length === 0 && <div className="empty">记录库里还没有内容。</div>}
            </div>

            <div className="hairline" />
            <span className="overline">节点</span>
            {selectedNode ? (
              <div className="stack">
                <div className="note">
                  {selectedNode.recordTitle || '未命名记录'}
                  <br />
                  世界坐标 <span className="mono">({selectedNode.positionX.toFixed(0)}, {selectedNode.positionY.toFixed(0)})</span>
                  <br />
                  尺寸 <span className="mono">{selectedNode.width}×{selectedNode.height}</span>
                </div>
                <button
                  className="button button--danger"
                  onClick={async () => {
                    await api.canvas.removeNode(selectedNode.id)
                    setSelectedNodeId(null)
                    await loadNodes(active.id)
                  }}
                >
                  从画布移除
                </button>
                <div className="note">只解除引用，原始记录还在记录库里。</div>
              </div>
            ) : (
              <div className="empty">点选一张卡片查看坐标，或直接拖动它。</div>
            )}

            <div className="hairline" />
            <button
              className="button button--danger"
              onClick={async () => {
                if (!window.confirm('删除这块画布？画布上的节点会一起消失，记录不受影响。')) return
                await api.canvas.remove(active.id)
                setActiveId(null)
                await loadCanvases()
              }}
            >
              删除这块画布
            </button>
          </>
        ) : (
          <div className="empty">建一块画布开始。</div>
        )}
      </section>
    </div>
  )
}

/** 画布上的一个节点：图片/链接/视频用封面，文字用正文；拖完才写库。 */
function CanvasNodeShape(props: {
  node: CanvasNodeWithRecord
  selected: boolean
  onSelect: () => void
  onMoved: (x: number, y: number) => void | Promise<void>
}) {
  const { node } = props
  const image = useLocalImage(
    node.recordCarrier === 'image'
      ? node.recordMediaPath
      : node.recordCarrier === 'link' || node.recordCarrier === 'video'
        ? node.recordPreviewPath
        : null
  )
  const colors = themeColors()
  const radius = 16

  return (
    <Group
      x={node.positionX}
      y={node.positionY}
      draggable
      onClick={props.onSelect}
      onTap={props.onSelect}
      onDragEnd={(event) => {
        void props.onMoved(event.target.x(), event.target.y())
      }}
    >
      {image ? (
        <>
          {/* 图片按卡片圆角裁切，封面就是卡片的全部内容 */}
          <Group
            clipFunc={(ctx) =>
              roundedRectPath(ctx, 0, 0, node.width, node.height, radius)
            }
          >
            <KonvaImage image={image} width={node.width} height={node.height} listening={false} />
          </Group>
          <Rect
            width={node.width}
            height={node.height}
            cornerRadius={radius}
            stroke={props.selected ? colors.espresso : colors.hairline}
            strokeWidth={props.selected ? 1.5 : 1}
            listening={false}
          />
        </>
      ) : (
        <>
          {/* 白卡 + 细边，默认无阴影：与 iOS 的 CanvasNodeCard 同一条原则 */}
          <Rect
            width={node.width}
            height={node.height}
            fill={colors.card}
            cornerRadius={radius}
            stroke={props.selected ? colors.espresso : colors.hairline}
            strokeWidth={props.selected ? 1.5 : 1}
          />
          <Text
            x={16}
            y={16}
            width={node.width - 32}
            text={node.recordTitle || '未命名记录'}
            fontSize={13}
            fontStyle="600"
            fontFamily={KONVA_FONT}
            fill={colors.ink}
            lineHeight={1.4}
            wrap="word"
            ellipsis
            height={node.height - 46}
          />
          <Text
            x={16}
            y={node.height - 26}
            text={carrierLabelOf(node.recordCarrier)}
            fontSize={10.5}
            fontFamily={KONVA_FONT}
            fill={colors.inkFaint}
          />
        </>
      )}
    </Group>
  )
}

const KONVA_FONT = "-apple-system, 'PingFang SC', 'Segoe UI', sans-serif"

function carrierLabelOf(carrier: string): string {
  return carrier === 'text'
    ? '文字'
    : carrier === 'link'
      ? '链接'
      : carrier === 'video'
        ? '视频'
        : '图片'
}

function roundedRectPath(
  ctx: Context,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

/**
 * 点阵背景：世界坐标网格，屏幕间距钳在 14–40px（与 iOS CanvasDotGrid
 * 同一条规则）——缩到多小点阵都在，放大也不会糊成噪点。
 */
function DotGrid(props: { width: number; height: number; viewport: CanvasViewport }) {
  const { width, height, viewport } = props
  return (
    <Shape
      sceneFunc={(context) => {
        const colors = themeColors()
        const { scale, offsetX, offsetY } = viewport
        if (scale <= 0) return
        let spacing = 26 // 世界间距基准
        while (spacing * scale < 14) spacing *= 2
        while (spacing * scale > 40) spacing /= 2
        const x0 = -offsetX / scale
        const y0 = -offsetY / scale
        const x1 = (width - offsetX) / scale
        const y1 = (height - offsetY) / scale
        const radius = 1.1 / scale
        context.fillStyle = colors.wellDeep
        for (let wx = Math.floor(x0 / spacing) * spacing; wx <= x1; wx += spacing) {
          for (let wy = Math.floor(y0 / spacing) * spacing; wy <= y1; wy += spacing) {
            context.beginPath()
            context.arc(wx, wy, radius, 0, Math.PI * 2)
            context.fill()
          }
        }
      }}
    />
  )
}

/** 只加载本地媒体（`bpmedia://`），不请求网络；加载失败就退回文字卡。 */
function useLocalImage(fileName: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!fileName) {
      setImage(null)
      return
    }
    const element = new window.Image()
    element.src = api.records.mediaUrl(fileName)
    element.onload = () => setImage(element)
    element.onerror = () => setImage(null)
    return () => {
      element.onload = null
      element.onerror = null
    }
  }, [fileName])
  return image
}
