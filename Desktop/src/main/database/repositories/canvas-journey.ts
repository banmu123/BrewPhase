import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { canvasJourneyPlacements } from '../schema'

/**
 * Journey 在画布上的摆位（R6-4.1，`canvas_journey_placements`）。
 *
 * **纯展示层**：这里任何写入都不改 `sequence`、`agent_journey_edges`
 * 或 `journey_record_links`——拖动只挪坐标，业务关系一个字节都不动。
 *
 * 一张表两种行，由 `eventId` 是否为空区分：
 * - `eventId === null` → Journey Group 分组行（整组位置/尺寸/折叠）
 * - `eventId !== null` → 组内事件节点行（节点位置）
 * 数据库用两个**部分唯一索引**分别兜底（`(canvas_id, journey_id)` 与
 * `(canvas_id, event_id)`），SQLite 里 `NULL` 不参与普通唯一索引，
 * 所以不能只靠一个 `UNIQUE(canvas_id, event_id)`。
 *
 * 不写 `recordChange`：本表不进 change_log / iOS 同步（local-first）。
 */

export type JourneyPlacement = {
  id: string
  canvasId: string
  journeyId: string
  eventId: string | null
  positionX: number
  positionY: number
  width: number
  height: number
  zIndex: number
  collapsed: boolean
  updatedAt: number
}

type Row = typeof canvasJourneyPlacements.$inferSelect

function toPlacement(row: Row): JourneyPlacement {
  return {
    id: row.id,
    canvasId: row.canvasId,
    journeyId: row.journeyId,
    eventId: row.eventId,
    positionX: row.positionX,
    positionY: row.positionY,
    width: row.width,
    height: row.height,
    zIndex: row.zIndex,
    collapsed: row.collapsed,
    updatedAt: row.updatedAt
  }
}

/** 某块画布上的全部 Journey 摆位（分组行在前，事件行按 sequence 排在后由调用方拼）。 */
export function listPlacements(db: Db, canvasId: string): JourneyPlacement[] {
  return db
    .select()
    .from(canvasJourneyPlacements)
    .where(eq(canvasJourneyPlacements.canvasId, canvasId))
    .all()
    .map(toPlacement)
}

export function getGroupPlacement(
  db: Db,
  canvasId: string,
  journeyId: string
): JourneyPlacement | null {
  const row = db
    .select()
    .from(canvasJourneyPlacements)
    .where(
      and(
        eq(canvasJourneyPlacements.canvasId, canvasId),
        eq(canvasJourneyPlacements.journeyId, journeyId),
        isNull(canvasJourneyPlacements.eventId)
      )
    )
    .get()
  return row ? toPlacement(row) : null
}

export function listEventPlacements(
  db: Db,
  canvasId: string,
  journeyId: string
): JourneyPlacement[] {
  return db
    .select()
    .from(canvasJourneyPlacements)
    .where(
      and(
        eq(canvasJourneyPlacements.canvasId, canvasId),
        eq(canvasJourneyPlacements.journeyId, journeyId),
        sql`${canvasJourneyPlacements.eventId} is not null`
      )
    )
    .all()
    .map(toPlacement)
}

/**
 * 把一条 Journey 放进画布：写分组行，并为每个事件写节点行。
 *
 * 坐标约定（**两种，别混**）：
 * - `group.positionX/Y` 是分组左上角的**画布绝对坐标**；
 * - `nodes[].positionX/Y` 是各事件节点的**画布绝对坐标**
 *   （= 分组原点 + `layoutJourneyEvents` 给出的组内偏移），
 *   与普通 Record Node 同一坐标系，才能共存、对齐、互相连接。
 *
 * 幂等：分组行已存在就只补缺失的事件行（同一块画布重复拖入不报错、不重复）。
 * 返回是否是**首次**放置——调用方据此决定要不要 fit 到视口。
 */
export function placeJourney(
  db: Db,
  input: {
    canvasId: string
    journeyId: string
    group: { positionX: number; positionY: number; width: number; height: number }
    nodes: readonly { eventId: string; positionX: number; positionY: number; width: number; height: number }[]
    now: number
  }
): { created: boolean } {
  const existing = getGroupPlacement(db, input.canvasId, input.journeyId)
  const placedEventIds = new Set(
    listEventPlacements(db, input.canvasId, input.journeyId).map((item) => item.eventId)
  )

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    if (!existing) {
      scoped
        .insert(canvasJourneyPlacements)
        .values({
          id: crypto.randomUUID(),
          canvasId: input.canvasId,
          journeyId: input.journeyId,
          eventId: null,
          positionX: input.group.positionX,
          positionY: input.group.positionY,
          width: input.group.width,
          height: input.group.height,
          zIndex: 0,
          collapsed: false,
          updatedAt: input.now
        })
        .run()
    }
    for (const node of input.nodes) {
      if (placedEventIds.has(node.eventId)) continue
      scoped
        .insert(canvasJourneyPlacements)
        .values({
          id: crypto.randomUUID(),
          canvasId: input.canvasId,
          journeyId: input.journeyId,
          eventId: node.eventId,
          positionX: node.positionX,
          positionY: node.positionY,
          width: node.width,
          height: node.height,
          zIndex: 0,
          collapsed: false,
          updatedAt: input.now
        })
        .run()
    }
  })

  return { created: existing === null }
}

/** 挪动分组：只改分组行的绝对位置，组内事件行一并平移（保持相对关系）。 */
export function moveJourneyGroup(
  db: Db,
  input: {
    canvasId: string
    journeyId: string
    positionX: number
    positionY: number
    now: number
  }
): JourneyPlacement | null {
  const group = getGroupPlacement(db, input.canvasId, input.journeyId)
  if (!group) return null
  const deltaX = input.positionX - group.positionX
  const deltaY = input.positionY - group.positionY

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .update(canvasJourneyPlacements)
      .set({ positionX: input.positionX, positionY: input.positionY, updatedAt: input.now })
      .where(
        and(
          eq(canvasJourneyPlacements.canvasId, input.canvasId),
          eq(canvasJourneyPlacements.journeyId, input.journeyId),
          isNull(canvasJourneyPlacements.eventId)
        )
      )
      .run()
    if (deltaX !== 0 || deltaY !== 0) {
      scoped
        .update(canvasJourneyPlacements)
        .set({
          positionX: sql`${canvasJourneyPlacements.positionX} + ${deltaX}`,
          positionY: sql`${canvasJourneyPlacements.positionY} + ${deltaY}`,
          updatedAt: input.now
        })
        .where(
          and(
            eq(canvasJourneyPlacements.canvasId, input.canvasId),
            eq(canvasJourneyPlacements.journeyId, input.journeyId),
            sql`${canvasJourneyPlacements.eventId} is not null`
          )
        )
        .run()
    }
  })

  return getGroupPlacement(db, input.canvasId, input.journeyId)
}

/** 挪动单个事件节点：只写这一行，**绝不碰** sequence 或业务 Edge。 */
export function moveJourneyEvent(
  db: Db,
  input: {
    canvasId: string
    eventId: string
    positionX: number
    positionY: number
    now: number
  }
): JourneyPlacement | null {
  const row = db
    .select()
    .from(canvasJourneyPlacements)
    .where(
      and(
        eq(canvasJourneyPlacements.canvasId, input.canvasId),
        eq(canvasJourneyPlacements.eventId, input.eventId)
      )
    )
    .get()
  if (!row) return null
  db.update(canvasJourneyPlacements)
    .set({ positionX: input.positionX, positionY: input.positionY, updatedAt: input.now })
    .where(eq(canvasJourneyPlacements.id, row.id))
    .run()
  const updated = db
    .select()
    .from(canvasJourneyPlacements)
    .where(eq(canvasJourneyPlacements.id, row.id))
    .get()
  return updated ? toPlacement(updated) : null
}

/** 折叠 / 展开整组：只改分组行，事件行位置不动。 */
export function setJourneyCollapsed(
  db: Db,
  input: { canvasId: string; journeyId: string; collapsed: boolean; now: number }
): JourneyPlacement | null {
  const group = getGroupPlacement(db, input.canvasId, input.journeyId)
  if (!group) return null
  db.update(canvasJourneyPlacements)
    .set({ collapsed: input.collapsed, updatedAt: input.now })
    .where(eq(canvasJourneyPlacements.id, group.id))
    .run()
  return getGroupPlacement(db, input.canvasId, input.journeyId)
}

/**
 * 把 Journey 从画布移除：删分组行 + 事件行。
 * **只删摆位**——Journey、事件、关系、笔记一律保留（画布是视图，不是数据归属）。
 */
export function removeJourneyFromCanvas(
  db: Db,
  canvasId: string,
  journeyId: string
): { removed: boolean } {
  const group = getGroupPlacement(db, canvasId, journeyId)
  if (!group) return { removed: false }
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .delete(canvasJourneyPlacements)
      .where(
        and(
          eq(canvasJourneyPlacements.canvasId, canvasId),
          eq(canvasJourneyPlacements.journeyId, journeyId)
        )
      )
      .run()
  })
  return { removed: true }
}

/** 分组行 + 事件行一起读，供渲染层一次性拿到摆位。 */
export function readPlacementBundle(
  db: Db,
  canvasId: string,
  journeyId: string
): { group: JourneyPlacement | null; events: JourneyPlacement[] } {
  return {
    group: getGroupPlacement(db, canvasId, journeyId),
    events: listEventPlacements(db, canvasId, journeyId)
  }
}
