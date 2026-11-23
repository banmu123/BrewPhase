import { and, eq } from 'drizzle-orm'
import type { Canvas, CanvasNode, CanvasNodeWithRecord, CanvasNote } from '../../../shared/contracts'
import { nextNodeOrigin, type Rect } from '../../../shared/domain/placement'
import {
  JOURNEY_GROUP_INSET,
  journeyGroupRect,
  layoutJourneyEvents
} from '../../../shared/domain/journey-layout'
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
import {
  getGroupPlacement,
  listPlacements,
  moveJourneyEvent,
  moveJourneyGroup,
  placeJourney,
  removeJourneyFromCanvas as removeJourneyFromCanvasRow,
  setJourneyCollapsed,
  type JourneyPlacement
} from '../../database/repositories/canvas-journey'
import {
  selectEdges,
  selectEvents,
  selectJourney,
  type AgentJourney,
  type AgentJourneyEdge,
  type AgentJourneyEvent
} from '../../database/repositories/agent-journeys'
import { listLinksForJourney } from '../../database/repositories/agent-journey-supplements'
import { parseJourneyMetadataJson } from '../../../shared/contracts/entities/agent-journey'
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

  // ================================================================
  // R6-4.1：Journey 在画布上的摆位（Canvas 展示适配层）
  //
  // 领域分工（ADR-R6-03 选 A）：
  // - Journey 的**内容**（事件/业务 Edge/笔记/跨记录关系）永远来自 Journey 领域表，
  //   本类只读不写它们；
  // - 本类只写 `canvas_journey_placements`——纯展示层，拖动只挪坐标，
  //   **永不**改 `sequence` 或 `agent_journey_edges`。
  // - 不写 recordChange：摆位不进 change_log / iOS 同步。
  // ================================================================

  /** 某块画布上已放置的全部 Journey（分组 + 组内事件摆位 + 摘要）。 */
  journeysForCanvas(canvasId: string) {
    requireCanvas(this.db, canvasId)
    const placements = listPlacements(this.db, canvasId)
    const groups = placements.filter((item) => item.eventId === null)
    const eventPlacements = placements.filter((item) => item.eventId !== null)

    return groups.map((group) => {
      const journey = selectJourney(this.db, group.journeyId)
      const events = journey ? selectEvents(this.db, journey.id) : []
      return {
        placement: placementDto(group),
        journey: journey ? journeyDto(journey) : null,
        events: events.map(journeyEventDto),
        edges: journey ? selectEdges(this.db, journey.id).map(journeyEdgeDto) : [],
        nodes: eventPlacements
          .filter((item) => item.journeyId === group.journeyId)
          .map(placementDto),
        // 跨记录关系随画布一起返回：渲染层画线要用，不必再发一轮请求。
        links: listLinksForJourney(this.db, group.journeyId).map((link) => ({
          id: link.id,
          journey_id: link.journeyId,
          event_id: link.eventId,
          record_id: link.recordId,
          relationship_type: link.relationshipType,
          created_at: link.createdAt,
          updated_at: link.updatedAt
        }))
      }
    })
  }

  /**
   * 把一条 Journey 放进画布。
   *
   * 布局在这里算（`layoutJourneyEvents` 纯函数）：同一份 events + edges
   * 永远得到同一份坐标，重开画布不跳位。事件行存**画布绝对坐标**
   * （分组原点 + 组内偏移），与普通 Record Node 同一坐标系。
   *
   * 首次放置时用 `nextNodeOrigin` 避开已有节点/便签/其他 Journey 分组。
   */
  placeJourneyOnCanvas(input: { canvasId: string; journeyId: string }) {
    requireCanvas(this.db, input.canvasId)
    const journey = selectJourney(this.db, input.journeyId)
    if (!journey) {
      throw new ApplicationError('NOT_FOUND', `journey ${input.journeyId} not found`)
    }
    const existing = getGroupPlacement(this.db, input.canvasId, input.journeyId)
    if (existing) {
      // 已经在画布上：不重复放置，把现状原样返回（幂等）。
      return { created: false, ...this.journeysForCanvas(input.canvasId).find(
        (item) => item.placement.id === existing.id
      )! }
    }

    const events = selectEvents(this.db, journey.id)
    const edges = selectEdges(this.db, journey.id)
    const relative = layoutJourneyEvents(events, edges)
    const rect = journeyGroupRect(relative)

    // 已占用：普通节点 + 便签 + 其他 Journey 分组（同尺寸矩形）。
    const occupied: Rect[] = [
      ...listNodes(this.db, input.canvasId).map((node) => ({
        x: node.positionX,
        y: node.positionY,
        width: node.width,
        height: node.height
      })),
      ...listNotes(this.db, input.canvasId).map((note) => ({
        x: note.positionX,
        y: note.positionY,
        width: note.width,
        height: note.height
      })),
      ...listPlacements(this.db, input.canvasId)
        .filter((item) => item.eventId === null)
        .map((item) => ({
          x: item.positionX,
          y: item.positionY,
          width: item.width,
          height: item.height
        }))
    ]
    // 避让算的是**整个分组盒**（含标题条），落位写的是**内容原点**——
    // 两者相差 JOURNEY_GROUP_INSET。不减这个量，新分组的标题条会压到上方节点。
    const boxOrigin = nextNodeOrigin({ occupied, width: rect.width, height: rect.height })
    const originX = boxOrigin.x + JOURNEY_GROUP_INSET.x
    const originY = boxOrigin.y + JOURNEY_GROUP_INSET.y
    const now = Date.now()

    placeJourney(this.db, {
      canvasId: input.canvasId,
      journeyId: journey.id,
      group: {
        positionX: originX,
        positionY: originY,
        width: rect.width,
        height: rect.height
      },
      nodes: relative.map((node) => ({
        eventId: node.eventId,
        positionX: originX + node.x,
        positionY: originY + node.y,
        width: node.width,
        height: node.height
      })),
      now
    })

    this.events.emit('canvas')
    const placed = this.journeysForCanvas(input.canvasId).find(
      (item) => item.placement.journey_id === journey.id
    )
    if (!placed) throw new ApplicationError('INTERNAL_ERROR', 'failed to place journey on canvas')
    return { created: true, ...placed }
  }

  /** 挪动分组：分组行改绝对位置，组内事件行同步平移（保持相对关系）。 */
  moveJourneyGroupOnCanvas(input: {
    canvasId: string
    journeyId: string
    positionX: number
    positionY: number
  }) {
    assertFinitePosition(input.positionX, input.positionY)
    const updated = moveJourneyGroup(this.db, {
      canvasId: input.canvasId,
      journeyId: input.journeyId,
      positionX: input.positionX,
      positionY: input.positionY,
      now: Date.now()
    })
    if (!updated) {
      throw new ApplicationError(
        'NOT_FOUND',
        `journey ${input.journeyId} is not on canvas ${input.canvasId}`
      )
    }
    this.events.emit('canvas')
    return placementDto(updated)
  }

  /** 挪动单个事件节点：只写这一行，sequence 与业务 Edge 一个字节都不动。 */
  moveJourneyEventOnCanvas(input: {
    canvasId: string
    eventId: string
    positionX: number
    positionY: number
  }) {
    assertFinitePosition(input.positionX, input.positionY)
    const updated = moveJourneyEvent(this.db, {
      canvasId: input.canvasId,
      eventId: input.eventId,
      positionX: input.positionX,
      positionY: input.positionY,
      now: Date.now()
    })
    if (!updated) {
      throw new ApplicationError(
        'NOT_FOUND',
        `event ${input.eventId} has no placement on canvas ${input.canvasId}`
      )
    }
    this.events.emit('canvas')
    return placementDto(updated)
  }

  /** 折叠 / 展开整组：只改分组行的 collapsed，事件摆位不动。 */
  setJourneyCollapsedOnCanvas(input: {
    canvasId: string
    journeyId: string
    collapsed: boolean
  }) {
    const updated = setJourneyCollapsed(this.db, {
      canvasId: input.canvasId,
      journeyId: input.journeyId,
      collapsed: input.collapsed,
      now: Date.now()
    })
    if (!updated) {
      throw new ApplicationError(
        'NOT_FOUND',
        `journey ${input.journeyId} is not on canvas ${input.canvasId}`
      )
    }
    this.events.emit('canvas')
    return placementDto(updated)
  }

  /**
   * 把 Journey 从画布移除：**只删摆位**。
   * Journey、事件、业务 Edge、笔记、跨记录关系全部保留——画布是视图，不是数据归属。
   */
  removeJourneyFromCanvas(input: { canvasId: string; journeyId: string }) {
    const result = removeJourneyFromCanvasRow(this.db, input.canvasId, input.journeyId)
    if (result.removed) this.events.emit('canvas')
    return result
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

// MARK: - Journey 融合 DTO（R6-4.1）

function assertFinitePosition(positionX: number, positionY: number): void {
  if (!Number.isFinite(positionX) || !Number.isFinite(positionY)) {
    throw new ApplicationError('VALIDATION_ERROR', 'position must be finite numbers')
  }
}

function placementDto(placement: JourneyPlacement) {
  return {
    id: placement.id,
    canvas_id: placement.canvasId,
    journey_id: placement.journeyId,
    event_id: placement.eventId,
    position_x: placement.positionX,
    position_y: placement.positionY,
    width: placement.width,
    height: placement.height,
    z_index: placement.zIndex,
    collapsed: placement.collapsed,
    updated_at: placement.updatedAt
  }
}

function journeyDto(journey: AgentJourney) {
  return {
    id: journey.id,
    title: journey.title,
    goal: journey.goal,
    status: journey.status,
    source_agent: journey.sourceAgent,
    model: journey.model,
    created_at: journey.createdAt,
    updated_at: journey.updatedAt,
    completed_at: journey.completedAt
  }
}

function journeyEventDto(event: AgentJourneyEvent) {
  return {
    id: event.id,
    journey_id: event.journeyId,
    sequence: event.sequence,
    event_type: event.eventType,
    role: event.role,
    status: event.status,
    title: event.title,
    summary: event.summary,
    content: event.content,
    reason: event.reason,
    source_agent: event.sourceAgent,
    model: event.model,
    // R6-4.2：Canvas 侧此前也断链——节点要显示「2 个文件 · 3 项验证」
    // 这类关键辅助信息，Inspector 要展示证据来源，都得先拿到这两个字段。
    evidence_level: event.evidenceLevel,
    occurred_at: event.occurredAt,
    updated_at: event.updatedAt,
    metadata: parseJourneyMetadataJson(event.metadata)
  }
}

function journeyEdgeDto(edge: AgentJourneyEdge) {
  return {
    id: edge.id,
    journey_id: edge.journeyId,
    from_event_id: edge.fromEventId,
    to_event_id: edge.toEventId,
    relationship_type: edge.relationshipType,
    created_at: edge.createdAt
  }
}
