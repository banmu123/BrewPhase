import { z } from 'zod'

/**
 * 画布契约。节点只存**世界坐标**与引用：屏幕位置 = 世界 × 视口缩放 + 视口偏移，
 * 换算只此一处。节点不复制记录内容，同一记录可以出现在多块画布上。
 */

export const canvasSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(120).default(''),
  note: z.string().max(2_000).default(''),
  isSample: z.boolean().default(false),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type Canvas = z.infer<typeof canvasSchema>

export const canvasNodeSchema = z.object({
  id: z.string().uuid(),
  canvasID: z.string().uuid(),
  recordID: z.string().uuid(),
  positionX: z.number().finite(),
  positionY: z.number().finite(),
  width: z.number().min(48).max(4_000),
  height: z.number().min(48).max(4_000),
  zIndex: z.number().int().min(-10_000).max(10_000),
  annotation: z.string().max(2_000).default(''),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type CanvasNode = z.infer<typeof canvasNodeSchema>

export const canvasNodeMoveSchema = z.object({
  id: z.string().uuid(),
  positionX: z.number().finite(),
  positionY: z.number().finite()
})

export const canvasNodeResizeSchema = z.object({
  id: z.string().uuid(),
  width: z.number().min(48).max(4_000),
  height: z.number().min(48).max(4_000)
})

/**
 * 手绘笔迹。点集是 `[x0, y0, x1, y1, …]` 的**世界坐标**，落库前不做屏幕换算。
 * Phase 1 只建结构与表，编辑工具在 Phase 4（见 docs/CANVAS_SPEC.md）。
 */
export const CANVAS_TOOLS = ['pen', 'eraser'] as const
export const canvasToolSchema = z.enum(CANVAS_TOOLS)
export type CanvasTool = z.infer<typeof canvasToolSchema>

export const canvasStrokeSchema = z.object({
  id: z.string().uuid(),
  canvasID: z.string().uuid(),
  toolType: canvasToolSchema,
  points: z.array(z.number().finite()),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().min(0.5).max(200),
  opacity: z.number().min(0).max(1),
  zIndex: z.number().int().min(-10_000).max(10_000),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type CanvasStroke = z.infer<typeof canvasStrokeSchema>

export type CanvasNodeWithRecord = CanvasNode & {
  recordTitle: string
  recordCarrier: string
  /** 渲染图片节点用；只是文件名，实际路径由主进程的媒体协议解析。 */
  recordMediaPath: string | null
  recordPreviewPath: string | null
  /** 节点内容与 iOS CanvasNodeCard 对齐所需的记录字段（只读，join 而来）。 */
  recordNote: string
  recordSourceName: string
  recordSummary: string
  recordProvider: string
  recordPlatformContentID: string | null
  /** 「打开原始来源」用它；空串表示没有来源链接。 */
  recordURLString: string
  /** 源记录的更新时间：缩略图缓存失效与列表刷新依赖它。 */
  recordUpdatedAt: number
}

/**
 * 画布便签：不进 Records 的自由想法，直接活在画布上。
 * 与 CanvasNode.annotation（挂在引用节点上的备注）是两回事。
 */
export const canvasNoteSchema = z.object({
  id: z.string().uuid(),
  canvasID: z.string().uuid(),
  title: z.string().max(200).default(''),
  body: z.string().max(4_000).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f6f2df'),
  positionX: z.number().finite(),
  positionY: z.number().finite(),
  width: z.number().min(120).max(2_000),
  height: z.number().min(100).max(2_000),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type CanvasNote = z.infer<typeof canvasNoteSchema>

/** 视口是**界面状态**，不落库（Phase 1 的取舍，见 CANVAS_SPEC）。 */
export type CanvasViewport = { scale: number; offsetX: number; offsetY: number }

export const CANVAS_LIMITS = {
  minScale: 0.2,
  maxScale: 3,
  defaultNodeWidth: 240,
  defaultNodeHeight: 180
} as const

/** 世界 → 屏幕。所有视图必须走这一条换算，禁止各自复制公式。 */
export function worldToScreen(world: { x: number; y: number }, viewport: CanvasViewport) {
  return {
    x: world.x * viewport.scale + viewport.offsetX,
    y: world.y * viewport.scale + viewport.offsetY
  }
}

/** 屏幕 → 世界。 */
export function screenToWorld(screen: { x: number; y: number }, viewport: CanvasViewport) {
  return {
    x: (screen.x - viewport.offsetX) / viewport.scale,
    y: (screen.y - viewport.offsetY) / viewport.scale
  }
}

/**
 * 以屏幕上的 `anchor` 为不动点缩放到 `nextScale`：手指（或鼠标）下面的内容不跑。
 * 缩放只改视口，节点世界坐标永远不动。
 */
export function zoomAt(viewport: CanvasViewport, nextScale: number, anchor: { x: number; y: number }): CanvasViewport {
  const scale = Math.min(CANVAS_LIMITS.maxScale, Math.max(CANVAS_LIMITS.minScale, nextScale))
  const ratio = scale / viewport.scale
  return {
    scale,
    offsetX: anchor.x - (anchor.x - viewport.offsetX) * ratio,
    offsetY: anchor.y - (anchor.y - viewport.offsetY) * ratio
  }
}
