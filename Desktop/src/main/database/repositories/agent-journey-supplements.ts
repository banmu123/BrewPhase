import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { agentJourneyNotes, journeyRecordLinks } from '../schema'

/**
 * Journey 的**用户侧补充**（R6-4.1）：跨记录关系 + 个人笔记。
 *
 * 两者都归属 **Agent Journey 领域**，不是 Canvas 展示层：
 * - 两端（Event ↔ Record）与画布无关，画布只是发现入口；
 * - 未来 MCP 复用要在读 Journey 时一并读到（不能要求先打开某块画布）；
 * - 删画布不得销毁知识关系与用户经验。
 *
 * local-first：不写 `recordChange`，不进 change_log / iOS 同步 / Cloud。
 * 与 Agent 原始事件**完全分离**——改笔记、删关系都绝不写 `agent_journey_events`。
 */

/** 五种基础关系，语义固定，不做本体扩展。 */
export const JOURNEY_LINK_TYPES = [
  'references',
  'supports',
  'produces',
  'validates',
  'related_to'
] as const
export type JourneyLinkType = (typeof JOURNEY_LINK_TYPES)[number]

export function isJourneyLinkType(value: string): value is JourneyLinkType {
  return (JOURNEY_LINK_TYPES as readonly string[]).includes(value)
}

export type JourneyRecordLink = {
  id: string
  journeyId: string
  eventId: string
  recordId: string
  relationshipType: JourneyLinkType
  createdAt: number
  updatedAt: number
}

export type JourneyNote = {
  id: string
  journeyId: string
  /** null = Journey 级笔记；非空 = Event 级笔记。 */
  eventId: string | null
  body: string
  createdAt: number
  updatedAt: number
}

type LinkRow = typeof journeyRecordLinks.$inferSelect
type NoteRow = typeof agentJourneyNotes.$inferSelect

function toLink(row: LinkRow): JourneyRecordLink {
  return {
    id: row.id,
    journeyId: row.journeyId,
    eventId: row.eventId,
    recordId: row.recordId,
    relationshipType: row.relationshipType as JourneyLinkType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toNote(row: NoteRow): JourneyNote {
  return {
    id: row.id,
    journeyId: row.journeyId,
    eventId: row.eventId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

// MARK: - 跨记录关系

export function listLinksForJourney(db: Db, journeyId: string): JourneyRecordLink[] {
  return db
    .select()
    .from(journeyRecordLinks)
    .where(eq(journeyRecordLinks.journeyId, journeyId))
    .all()
    .map(toLink)
}

export function listLinksForEvent(db: Db, eventId: string): JourneyRecordLink[] {
  return db
    .select()
    .from(journeyRecordLinks)
    .where(eq(journeyRecordLinks.eventId, eventId))
    .all()
    .map(toLink)
}

export function listLinksForRecord(db: Db, recordId: string): JourneyRecordLink[] {
  return db
    .select()
    .from(journeyRecordLinks)
    .where(eq(journeyRecordLinks.recordId, recordId))
    .all()
    .map(toLink)
}

/**
 * 建立关系。重复的 (event, record, type) 由唯一索引兜底：
 * 先查再插，返回既有行，避免把约束错误抛给用户。
 *
 * **不创建、不修改任何 Journey 事件或业务 Edge**——这是纯用户侧的补充。
 */
export function createLink(
  db: Db,
  input: {
    journeyId: string
    eventId: string
    recordId: string
    relationshipType: JourneyLinkType
    now: number
  }
): JourneyRecordLink {
  const existing = db
    .select()
    .from(journeyRecordLinks)
    .where(
      and(
        eq(journeyRecordLinks.eventId, input.eventId),
        eq(journeyRecordLinks.recordId, input.recordId),
        eq(journeyRecordLinks.relationshipType, input.relationshipType)
      )
    )
    .get()
  if (existing) return toLink(existing)

  const id = crypto.randomUUID()
  db.insert(journeyRecordLinks)
    .values({
      id,
      journeyId: input.journeyId,
      eventId: input.eventId,
      recordId: input.recordId,
      relationshipType: input.relationshipType,
      createdAt: input.now,
      updatedAt: input.now
    })
    .run()
  const row = db.select().from(journeyRecordLinks).where(eq(journeyRecordLinks.id, id)).get()
  if (!row) throw new Error('failed to create journey record link')
  return toLink(row)
}

/**
 * 删除关系。**只删这一行**：原始 Record 与 Journey 事件都必须原样保留
 * （场景 D.6）。
 */
export function removeLink(db: Db, id: string): { removed: boolean } {
  const row = db.select().from(journeyRecordLinks).where(eq(journeyRecordLinks.id, id)).get()
  if (!row) return { removed: false }
  db.delete(journeyRecordLinks).where(eq(journeyRecordLinks.id, id)).run()
  return { removed: true }
}

// MARK: - 用户笔记

export function listNotesForJourney(db: Db, journeyId: string): JourneyNote[] {
  return db
    .select()
    .from(agentJourneyNotes)
    .where(eq(agentJourneyNotes.journeyId, journeyId))
    .all()
    .map(toNote)
}

/** Journey 级笔记（`event_id IS NULL`）。 */
export function listJourneyLevelNotes(db: Db, journeyId: string): JourneyNote[] {
  return db
    .select()
    .from(agentJourneyNotes)
    .where(and(eq(agentJourneyNotes.journeyId, journeyId), isNull(agentJourneyNotes.eventId)))
    .all()
    .map(toNote)
}

export function listEventNotes(db: Db, eventId: string): JourneyNote[] {
  return db
    .select()
    .from(agentJourneyNotes)
    .where(eq(agentJourneyNotes.eventId, eventId))
    .all()
    .map(toNote)
}

export function createNote(
  db: Db,
  input: { journeyId: string; eventId?: string | null; body: string; now: number }
): JourneyNote {
  const id = crypto.randomUUID()
  db.insert(agentJourneyNotes)
    .values({
      id,
      journeyId: input.journeyId,
      eventId: input.eventId ?? null,
      body: input.body,
      createdAt: input.now,
      updatedAt: input.now
    })
    .run()
  const row = db.select().from(agentJourneyNotes).where(eq(agentJourneyNotes.id, id)).get()
  if (!row) throw new Error('failed to create journey note')
  return toNote(row)
}

/**
 * 编辑笔记。**只动 `agent_journey_notes`**——
 * Agent 原始事件（`agent_journey_events`）在此路径上完全不可达。
 */
export function updateNote(db: Db, id: string, body: string, now: number): JourneyNote | null {
  const row = db.select().from(agentJourneyNotes).where(eq(agentJourneyNotes.id, id)).get()
  if (!row) return null
  db.update(agentJourneyNotes).set({ body, updatedAt: now }).where(eq(agentJourneyNotes.id, id)).run()
  const updated = db.select().from(agentJourneyNotes).where(eq(agentJourneyNotes.id, id)).get()
  return updated ? toNote(updated) : null
}

export function removeNote(db: Db, id: string): { removed: boolean } {
  const row = db.select().from(agentJourneyNotes).where(eq(agentJourneyNotes.id, id)).get()
  if (!row) return { removed: false }
  db.delete(agentJourneyNotes).where(eq(agentJourneyNotes.id, id)).run()
  return { removed: true }
}

/** 关联内容计数：卡片上「关联 N 条」与笔记数。 */
export function countLinksForJourney(db: Db, journeyId: string): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(journeyRecordLinks)
    .where(eq(journeyRecordLinks.journeyId, journeyId))
    .get()
  return Number(row?.value ?? 0)
}

export function countNotesForJourney(db: Db, journeyId: string): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(agentJourneyNotes)
    .where(eq(agentJourneyNotes.journeyId, journeyId))
    .get()
  return Number(row?.value ?? 0)
}
