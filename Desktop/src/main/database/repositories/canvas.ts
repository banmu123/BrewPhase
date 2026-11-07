import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Canvas, CanvasNode, CanvasNodeWithRecord, RecordCarrier } from '../../../shared/contracts'
import { nextNodeOrigin } from '../../../shared/domain/placement'
import type { Db } from '../client'
import { canvasNodes, canvases, records } from '../schema'
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
    .select({ node: canvasNodes, title: records.title, carrier: records.carrier, mediaPath: records.mediaPath, previewPath: records.previewPath })
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
    recordPreviewPath: row.previewPath
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
