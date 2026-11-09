import { and, eq } from 'drizzle-orm'
import type { Canvas, CanvasNode, CanvasNodeWithRecord, CanvasNote } from '../../../shared/contracts'
import { nextNodeOrigin } from '../../../shared/domain/placement'
import type { Db } from '../../database/client'
import {
  addNode,
  createCanvas,
  createNote,
  listCanvases,
  listNodes,
  listNotes,
  listStrokes,
  setAnnotation,
  updateNote
} from '../../database/repositories/canvas'
import { canvasNodes, canvasNotes, canvases, records } from '../../database/schema'
import type { ApplicationEvents } from '../events/application-events'
import { ApplicationError } from '../errors'

/**
 * 画布的业务入口：读取 + 受控写入（创建画布 / 添加记录节点 / 便签增改 /
 * 节点备注）。摆放位置由 `nextNodeOrigin` 计算——AI 永远不接触屏幕坐标。
 *
 * 删除类操作（画布、节点、便签）V1 不开放。
 */

const NOTE_WIDTH = 220
const NOTE_HEIGHT = 180

export class CanvasService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string,
    private readonly events: ApplicationEvents
  ) {}

  listForMcp() {
    const items = listCanvases(this.db).map((canvas) => ({
      ...canvasDto(canvas),
      node_count: listNodes(this.db, canvas.id).length,
      note_count: listNotes(this.db, canvas.id).length
    }))
    return { items }
  }

  getForMcp(canvasId: string) {
    const canvas = requireCanvas(this.db, canvasId)
    const nodes = listNodes(this.db, canvasId)
    const notes = listNotes(this.db, canvasId)
    // 笔迹只给元数据：点集是渲染细节，AI 不需要，也不该承担响应体成本。
    const strokes = listStrokes(this.db, canvasId).map((stroke) => ({
      id: stroke.id,
      color: stroke.color,
      width: stroke.width,
      point_count: Math.floor(stroke.points.length / 2),
      z_index: stroke.zIndex
    }))
    return {
      canvas: canvasDto(canvas),
      nodes: nodes.map(nodeDto),
      notes: notes.map(noteDto),
      strokes
    }
  }

  createForMcp(input: { name: string; note?: string }) {
    const canvas = createCanvas(this.db, this.deviceId, input.name.trim(), input.note ?? '')
    this.events.emit('canvas')
    return canvasDto(canvas)
  }

  addRecordForMcp(input: { canvasId: string; recordId: string; annotation?: string }) {
    requireCanvas(this.db, input.canvasId)
    requireRecord(this.db, input.recordId)

    const existing = this.db
      .select()
      .from(canvasNodes)
      .where(and(eq(canvasNodes.canvasId, input.canvasId), eq(canvasNodes.recordId, input.recordId)))
      .get()

    if (existing) {
      if (input.annotation !== undefined && input.annotation !== existing.annotation) {
        setAnnotation(this.db, this.deviceId, existing.id, input.annotation)
      }
      const node = this.db.select().from(canvasNodes).where(eq(canvasNodes.id, existing.id)).get()!
      this.events.emit('canvas')
      return { node: nodeDto(nodeFromRow(node)), created: false }
    }

    const node = addNode(this.db, this.deviceId, input.canvasId, input.recordId)
    if (input.annotation !== undefined && input.annotation.trim()) {
      setAnnotation(this.db, this.deviceId, node.id, input.annotation)
    }
    const latest = this.db.select().from(canvasNodes).where(eq(canvasNodes.id, node.id)).get()!
    this.events.emit('canvas')
    return { node: nodeDto(nodeFromRow(latest)), created: true }
  }

  createNoteForMcp(input: { canvasId: string; title: string; body: string; color?: string }) {
    requireCanvas(this.db, input.canvasId)
    const occupied = listNotes(this.db, input.canvasId).map((note) => ({
      x: note.positionX,
      y: note.positionY,
      width: note.width,
      height: note.height
    }))
    const origin = nextNodeOrigin({ occupied, width: NOTE_WIDTH, height: NOTE_HEIGHT })
    const note = createNote(this.db, this.deviceId, {
      canvasId: input.canvasId,
      positionX: origin.x,
      positionY: origin.y,
      title: input.title.trim(),
      body: input.body,
      color: input.color
    })
    this.events.emit('canvas')
    return noteDto(note)
  }

  updateNoteForMcp(input: {
    noteId: string
    expectedUpdatedAt: number
    title?: string
    body?: string
    color?: string
  }) {
    const current = this.db.select().from(canvasNotes).where(eq(canvasNotes.id, input.noteId)).get()
    if (!current) throw new ApplicationError('NOT_FOUND', `note ${input.noteId} not found`)
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new ApplicationError(
        'STALE_RECORD',
        `note changed since ${input.expectedUpdatedAt} (now ${current.updatedAt}); re-read and retry`
      )
    }
    const merged: CanvasNote = {
      id: current.id,
      canvasID: current.canvasId,
      title: input.title !== undefined ? input.title.trim() : current.title,
      body: input.body !== undefined ? input.body : current.body,
      color: input.color !== undefined ? input.color : current.color,
      positionX: current.positionX,
      positionY: current.positionY,
      width: current.width,
      height: current.height,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt
    }
    const updated = updateNote(this.db, this.deviceId, merged)
    this.events.emit('canvas')
    return noteDto(updated)
  }

  annotateNodeForMcp(input: { nodeId: string; annotation: string }) {
    const node = this.db.select().from(canvasNodes).where(eq(canvasNodes.id, input.nodeId)).get()
    if (!node) throw new ApplicationError('NOT_FOUND', `canvas node ${input.nodeId} not found`)
    setAnnotation(this.db, this.deviceId, input.nodeId, input.annotation)
    const latest = this.db.select().from(canvasNodes).where(eq(canvasNodes.id, input.nodeId)).get()!
    this.events.emit('canvas')
    return nodeDto(nodeFromRow(latest))
  }

  /** 幂等重放用：只读单个实体（不存在时 NOT_FOUND）。 */
  getCanvasBase(canvasId: string) {
    return canvasDto(requireCanvas(this.db, canvasId))
  }

  getNodeForMcp(nodeId: string) {
    const node = this.db.select().from(canvasNodes).where(eq(canvasNodes.id, nodeId)).get()
    if (!node) throw new ApplicationError('NOT_FOUND', `canvas node ${nodeId} not found`)
    return nodeDto(nodeFromRow(node))
  }

  getNoteForMcp(noteId: string) {
    const note = this.db.select().from(canvasNotes).where(eq(canvasNotes.id, noteId)).get()
    if (!note) throw new ApplicationError('NOT_FOUND', `note ${noteId} not found`)
    return noteDto({
      id: note.id,
      canvasID: note.canvasId,
      title: note.title,
      body: note.body,
      color: note.color,
      positionX: note.positionX,
      positionY: note.positionY,
      width: note.width,
      height: note.height,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    })
  }
}

// MARK: - 存在性检查与 DTO

function requireCanvas(db: Db, canvasId: string): Canvas {
  const row = db.select().from(canvases).where(eq(canvases.id, canvasId)).get()
  if (!row) throw new ApplicationError('NOT_FOUND', `canvas ${canvasId} not found`)
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    isSample: row.isSample,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function requireRecord(db: Db, recordId: string): void {
  const row = db.select({ id: records.id }).from(records).where(eq(records.id, recordId)).get()
  if (!row) throw new ApplicationError('NOT_FOUND', `record ${recordId} not found`)
}

function canvasDto(canvas: Canvas) {
  return {
    id: canvas.id,
    name: canvas.name,
    note: canvas.note,
    created_at: canvas.createdAt,
    updated_at: canvas.updatedAt
  }
}

/** drizzle 行 → 契约节点（canvasId→canvasID 等字段名映射只在这一次转换里）。 */
function nodeFromRow(row: typeof canvasNodes.$inferSelect): CanvasNode {
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

function nodeDto(
  node: CanvasNode | CanvasNodeWithRecord
) {
  const withRecord = node as CanvasNodeWithRecord
  return {
    id: node.id,
    canvas_id: node.canvasID,
    record_id: node.recordID,
    position_x: node.positionX,
    position_y: node.positionY,
    width: node.width,
    height: node.height,
    z_index: node.zIndex,
    annotation: node.annotation,
    record: withRecord.recordTitle !== undefined
      ? {
          title: withRecord.recordTitle,
          carrier: withRecord.recordCarrier,
          source_name: withRecord.recordSourceName,
          summary: withRecord.recordSummary,
          has_media: Boolean(withRecord.recordMediaPath || withRecord.recordPreviewPath)
        }
      : null,
    created_at: node.createdAt,
    updated_at: node.updatedAt
  }
}

function noteDto(note: CanvasNote) {
  return {
    id: note.id,
    canvas_id: note.canvasID,
    title: note.title,
    body: note.body,
    color: note.color,
    position_x: note.positionX,
    position_y: note.positionY,
    width: note.width,
    height: note.height,
    created_at: note.createdAt,
    updated_at: note.updatedAt
  }
}
