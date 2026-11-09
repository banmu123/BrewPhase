import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Canvas, CanvasNode, CanvasNodeWithRecord, CanvasNote, CanvasStroke, RecordCarrier } from '../../../shared/contracts'
import { nextNodeOrigin } from '../../../shared/domain/placement'
import type { Db } from '../client'
import { canvasNodes, canvasNotes, canvasStrokes, canvases, records } from '../schema'
import { recordChange } from './sync-log'

/**
 * 画布读写。节点只存世界坐标与引用；同一画布内同一记录只允许一个节点
 * （数据库有唯一索引兜底，这里先查再插，避免把约束错误抛给用户）。
 */

/** iOS `CanvasNodeStore.defaultSize` 的同一套默认尺寸。 */
const DEFAULT_SIZES: Record<RecordCarrier, { width: number; height: number }> = {
  image: { width: 220, height: 280 },
  video: { width: 240, height: 210 },
  link: { width: 240, height: 220 },
  text: { width: 220, height: 170 }
}

export function listCanvases(db: Db): Canvas[] {
  return db.select().from(canvases).orderBy(desc(canvases.updatedAt)).all().map(toCanvas)
}

export function createCanvas(db: Db, deviceId: string, name: string, note = ''): Canvas {
  const id = crypto.randomUUID()
  const at = Date.now()
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.insert(canvases).values({ id, name, note, createdAt: at, updatedAt: at }).run()
    recordChange(scoped, { deviceId, entityType: 'canvas', entityId: id, operation: 'create' })
  })
  return toCanvas(db.select().from(canvases).where(eq(canvases.id, id)).get()!)
}

/** 删画布：外键级联带走节点与笔迹，记录不受影响。 */
export function deleteCanvas(db: Db, deviceId: string, id: string): void {
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.delete(canvases).where(eq(canvases.id, id)).run()
    recordChange(scoped, { deviceId, entityType: 'canvas', entityId: id, operation: 'delete' })
  })
}

export function listNodes(db: Db, canvasId: string): CanvasNodeWithRecord[] {
  const rows = db
    .select({
      node: canvasNodes,
      title: records.title,
      carrier: records.carrier,
      mediaPath: records.mediaPath,
      previewPath: records.previewPath,
      note: records.note,
      sourceName: records.sourceName,
      summary: records.summary,
      provider: records.provider,
      platformContentID: records.platformContentId,
      urlString: records.urlString,
      recordUpdatedAt: records.updatedAt
    })
    .from(canvasNodes)
    .innerJoin(records, eq(records.id, canvasNodes.recordId))
    .where(eq(canvasNodes.canvasId, canvasId))
    .orderBy(asc(canvasNodes.zIndex), asc(canvasNodes.createdAt))
    .all()

  return rows.map((row) => ({
    ...toNode(row.node),
    recordTitle: row.title,
    recordCarrier: row.carrier,
    recordMediaPath: row.mediaPath,
    recordPreviewPath: row.previewPath,
    recordNote: row.note,
    recordSourceName: row.sourceName,
    recordSummary: row.summary,
    recordProvider: row.provider,
    recordPlatformContentID: row.platformContentID,
    recordURLString: row.urlString,
    recordUpdatedAt: row.recordUpdatedAt
  }))
}

export function addNode(db: Db, deviceId: string, canvasId: string, recordId: string): CanvasNode {
  const existing = db
    .select()
    .from(canvasNodes)
    .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.recordId, recordId)))
    .get()
  if (existing) return toNode(existing)

  const record = db.select().from(records).where(eq(records.id, recordId)).get()
  if (!record) throw new Error('record not found')
  const canvas = db.select().from(canvases).where(eq(canvases.id, canvasId)).get()
  if (!canvas) throw new Error('canvas not found')

  const size = DEFAULT_SIZES[record.carrier as RecordCarrier] ?? DEFAULT_SIZES.text
  const occupied = db
    .select({ x: canvasNodes.positionX, y: canvasNodes.positionY, width: canvasNodes.width, height: canvasNodes.height })
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, canvasId))
    .all()
  const origin = nextNodeOrigin({ occupied, width: size.width, height: size.height })
  const maxZ = db
    .select({ z: sql<number>`coalesce(max(${canvasNodes.zIndex}), 0)` })
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, canvasId))
    .get()?.z

  const id = crypto.randomUUID()
  const at = Date.now()

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .insert(canvasNodes)
      .values({
        id,
        canvasId,
        recordId,
        positionX: origin.x,
        positionY: origin.y,
        width: size.width,
        height: size.height,
        zIndex: (maxZ ?? 0) + 1,
        annotation: '',
        createdAt: at,
        updatedAt: at
      })
      .run()
    touchCanvas(scoped, canvasId, at)
    recordChange(scoped, { deviceId, entityType: 'canvasNode', entityId: id, operation: 'create' })
    recordChange(scoped, { deviceId, entityType: 'canvas', entityId: canvasId, operation: 'update' })
  })

  return toNode(db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).get()!)
}

/** 拖动结束才调用：一次拖动只写一次库，过程中只改渲染层的内存状态。 */
export function moveNode(db: Db, deviceId: string, id: string, positionX: number, positionY: number): void {
  if (!Number.isFinite(positionX) || !Number.isFinite(positionY)) throw new Error('invalid position')
  const node = db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).get()
  if (!node) return
  const at = Date.now()

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .update(canvasNodes)
      .set({ positionX, positionY, updatedAt: at })
      .where(eq(canvasNodes.id, id))
      .run()
    touchCanvas(scoped, node.canvasId, at)
    recordChange(scoped, { deviceId, entityType: 'canvasNode', entityId: id, operation: 'update' })
  })
}

/** 从画布移除节点：只删引用，源记录原样保留。 */
export function resizeNode(db: Db, deviceId: string, id: string, width: number, height: number): void {
  const at = Date.now()
  const row = db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).get()
  if (!row) return
  db.transaction((tx) => {
    tx.update(canvasNodes).set({ width, height, updatedAt: at }).where(eq(canvasNodes.id, id)).run()
    recordChange(tx, { deviceId, entityType: 'canvasNode', entityId: id, operation: 'update' })
    touchCanvas(tx, row.canvasId, at)
  })
}

export function setAnnotation(db: Db, deviceId: string, id: string, annotation: string): void {
  const at = Date.now()
  const row = db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).get()
  if (!row) return
  db.transaction((tx) => {
    tx.update(canvasNodes)
      .set({ annotation: annotation.trim().slice(0, 2000), updatedAt: at })
      .where(eq(canvasNodes.id, id))
      .run()
    recordChange(tx, { deviceId, entityType: 'canvasNode', entityId: id, operation: 'update' })
    touchCanvas(tx, row.canvasId, at)
  })
}

export function removeNode(db: Db, deviceId: string, id: string): void {
  const node = db.select().from(canvasNodes).where(eq(canvasNodes.id, id)).get()
  if (!node) return
  const at = Date.now()
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.delete(canvasNodes).where(eq(canvasNodes.id, id)).run()
    touchCanvas(scoped, node.canvasId, at)
    recordChange(scoped, { deviceId, entityType: 'canvasNode', entityId: id, operation: 'delete' })
  })
}

function touchCanvas(db: Db, canvasId: string, at: number): void {
  db.update(canvases).set({ updatedAt: at }).where(eq(canvases.id, canvasId)).run()
}

type CanvasRow = typeof canvases.$inferSelect
type NodeRow = typeof canvasNodes.$inferSelect

function toCanvas(row: CanvasRow): Canvas {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    isSample: row.isSample,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toNode(row: NodeRow): CanvasNode {
  return {
    id: row.id,
    canvasID: row.canvasId,
    recordID: row.recordId,
    positionX: row.positionX,
    positionY: row.positionY,
    width: row.width,
    height: row.height,
    zIndex: row.zIndex,
    annotation: row.annotation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

// MARK: - 便签（画布上的自由想法，独立于 Records）

export function listNotes(db: Db, canvasId: string): CanvasNote[] {
  return db
    .select()
    .from(canvasNotes)
    .where(eq(canvasNotes.canvasId, canvasId))
    .orderBy(asc(canvasNotes.createdAt))
    .all()
    .map(toNote)
}

export function createNote(
  db: Db,
  deviceId: string,
  input: {
    canvasId: string
    positionX: number
    positionY: number
    /** 可选：MCP 一次调用就带正文；Renderer 的新建便签不传，走默认空值。 */
    title?: string
    body?: string
    color?: string
  }
): CanvasNote {
  const id = crypto.randomUUID()
  const at = Date.now()
  db.transaction((tx) => {
    tx.insert(canvasNotes)
      .values({
        id,
        canvasId: input.canvasId,
        title: input.title ?? '',
        body: input.body ?? '',
        color: input.color ?? '#f6f2df',
        positionX: input.positionX,
        positionY: input.positionY,
        createdAt: at,
        updatedAt: at
      })
      .run()
    recordChange(tx, { deviceId, entityType: 'canvasNote', entityId: id, operation: 'create' })
    touchCanvas(tx, input.canvasId, at)
  })
  return toNote(db.select().from(canvasNotes).where(eq(canvasNotes.id, id)).get()!)
}

export function updateNote(db: Db, deviceId: string, note: CanvasNote): CanvasNote {
  const at = Date.now()
  db.transaction((tx) => {
    tx.update(canvasNotes)
      .set({
        title: note.title,
        body: note.body,
        color: note.color,
        positionX: note.positionX,
        positionY: note.positionY,
        width: note.width,
        height: note.height,
        updatedAt: at
      })
      .where(eq(canvasNotes.id, note.id))
      .run()
    recordChange(tx, { deviceId, entityType: 'canvasNote', entityId: note.id, operation: 'update' })
    touchCanvas(tx, note.canvasID, at)
  })
  return toNote(db.select().from(canvasNotes).where(eq(canvasNotes.id, note.id)).get()!)
}

export function removeNote(db: Db, deviceId: string, id: string): void {
  const row = db.select().from(canvasNotes).where(eq(canvasNotes.id, id)).get()
  if (!row) return
  const at = Date.now()
  db.transaction((tx) => {
    tx.delete(canvasNotes).where(eq(canvasNotes.id, id)).run()
    recordChange(tx, { deviceId, entityType: 'canvasNote', entityId: id, operation: 'delete' })
    touchCanvas(tx, row.canvasId, at)
  })
}

// MARK: - 笔迹（自由绘制；points 是世界坐标的扁平数组）

export function listStrokes(db: Db, canvasId: string): CanvasStroke[] {
  return db
    .select()
    .from(canvasStrokes)
    .where(eq(canvasStrokes.canvasId, canvasId))
    .orderBy(asc(canvasStrokes.createdAt))
    .all()
    .map(toStroke)
}

export function saveStroke(db: Db, deviceId: string, stroke: CanvasStroke): CanvasStroke {
  const at = Date.now()
  const values = {
    id: stroke.id,
    canvasId: stroke.canvasID,
    toolType: stroke.toolType,
    points: JSON.stringify(stroke.points),
    color: stroke.color,
    width: stroke.width,
    opacity: stroke.opacity,
    zIndex: stroke.zIndex,
    createdAt: stroke.createdAt,
    updatedAt: at
  }
  db.transaction((tx) => {
    tx.insert(canvasStrokes)
      .values(values)
      .onConflictDoUpdate({ target: canvasStrokes.id, set: { ...values, id: undefined } })
      .run()
    const existed = db.select().from(canvasStrokes).where(eq(canvasStrokes.id, stroke.id)).get()
    recordChange(tx, {
      deviceId,
      entityType: 'canvasStroke',
      entityId: stroke.id,
      operation: existed ? 'update' : 'create'
    })
    touchCanvas(tx, stroke.canvasID, at)
  })
  return toStroke(db.select().from(canvasStrokes).where(eq(canvasStrokes.id, stroke.id)).get()!)
}

export function removeStroke(db: Db, deviceId: string, id: string): void {
  const row = db.select().from(canvasStrokes).where(eq(canvasStrokes.id, id)).get()
  if (!row) return
  const at = Date.now()
  db.transaction((tx) => {
    tx.delete(canvasStrokes).where(eq(canvasStrokes.id, id)).run()
    recordChange(tx, { deviceId, entityType: 'canvasStroke', entityId: id, operation: 'delete' })
    touchCanvas(tx, row.canvasId, at)
  })
}

// MARK: - 画布改名

export function renameCanvas(db: Db, deviceId: string, id: string, name: string): Canvas {
  const at = Date.now()
  db.transaction((tx) => {
    tx.update(canvases).set({ name: name.trim(), updatedAt: at }).where(eq(canvases.id, id)).run()
    recordChange(tx, { deviceId, entityType: 'canvas', entityId: id, operation: 'update' })
  })
  return toCanvas(db.select().from(canvases).where(eq(canvases.id, id)).get()!)
}

// MARK: - 行映射

function toNote(row: typeof canvasNotes.$inferSelect): CanvasNote {
  return {
    id: row.id,
    canvasID: row.canvasId,
    title: row.title,
    body: row.body,
    color: row.color,
    positionX: row.positionX,
    positionY: row.positionY,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toStroke(row: typeof canvasStrokes.$inferSelect): CanvasStroke {
  return {
    id: row.id,
    canvasID: row.canvasId,
    toolType: row.toolType === 'eraser' ? 'eraser' : 'pen',
    points: JSON.parse(row.points) as number[],
    color: row.color,
    width: row.width,
    opacity: row.opacity,
    zIndex: row.zIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
