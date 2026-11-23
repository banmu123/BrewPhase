import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client'
import {
  agentJourneyEdges,
  agentJourneyEvents,
  agentJourneyLayouts,
  agentJourneys
} from '../schema'

/**
 * Agent Journey 仓储：**纯 SQL 组装，不含业务规则**（状态机、脱敏、幂等判定
 * 都在 `AgentJourneyService`）。与 `work-contexts.ts` 同一惯例。
 *
 * 所有函数都接受 `Db`，因此**可以直接把事务作用域的句柄传进来**（调用方按
 * `tx as unknown as Db` 转换，与 `repositories/records.ts` 的写法一致），
 * 从而让「查幂等 → 分配 sequence → 插入 → 写幂等」落在同一个事务里。
 *
 * 时间一律 epoch 毫秒；ID 一律 UUID。
 */

// MARK: - 领域枚举

export const AGENT_JOURNEY_STATUSES = [
  'created',
  'running',
  'paused',
  'failed',
  'completed',
  'cancelled',
  'abandoned'
] as const
export type AgentJourneyStatus = (typeof AGENT_JOURNEY_STATUSES)[number]

/** `completed` / `cancelled` 是不可逆终态。 */
export const AGENT_JOURNEY_TERMINAL_STATUSES: readonly AgentJourneyStatus[] = [
  'completed',
  'cancelled'
]

export const AGENT_JOURNEY_EVENT_TYPES = [
  'user_input',
  'plan',
  'decision',
  'execution',
  'observation',
  'revision',
  'verification',
  'outcome',
  'user_annotation'
] as const
export type AgentJourneyEventType = (typeof AGENT_JOURNEY_EVENT_TYPES)[number]

export const AGENT_JOURNEY_EVENT_STATUSES = [
  'planned',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled'
] as const
export type AgentJourneyEventStatus = (typeof AGENT_JOURNEY_EVENT_STATUSES)[number]

/** 陈述类事件：创建即 `completed`，正文不可再改。 */
export const AGENT_JOURNEY_STATEMENT_EVENT_TYPES: readonly AgentJourneyEventType[] = [
  'user_input',
  'plan',
  'decision',
  'observation',
  'revision',
  'outcome',
  'user_annotation'
]

/** 执行类事件：唯一允许状态推进的两类。 */
export const AGENT_JOURNEY_EXECUTION_EVENT_TYPES: readonly AgentJourneyEventType[] = [
  'execution',
  'verification'
]

export const AGENT_JOURNEY_ROLES = ['user', 'agent', 'system'] as const
export type AgentJourneyRole = (typeof AGENT_JOURNEY_ROLES)[number]

export const AGENT_JOURNEY_EVIDENCE_LEVELS = [
  'agent_reported',
  'runtime_observed',
  'tool_result'
] as const
export type AgentJourneyEvidenceLevel = (typeof AGENT_JOURNEY_EVIDENCE_LEVELS)[number]

/** v1 唯一可写的证据等级：没有运行时观察通道，就不许把自述包装成系统事实。 */
export const WRITABLE_EVIDENCE_LEVELS: readonly AgentJourneyEvidenceLevel[] = ['agent_reported']

export const AGENT_JOURNEY_EDGE_TYPES = [
  'depends_on',
  'branch_from',
  'revises',
  'retries'
] as const
export type AgentJourneyEdgeType = (typeof AGENT_JOURNEY_EDGE_TYPES)[number]

export const AGENT_JOURNEY_CAPTURE_MODES = [
  'workflow_summary',
  'conversation_capture',
  'detailed_capture'
] as const
export type AgentJourneyCaptureMode = (typeof AGENT_JOURNEY_CAPTURE_MODES)[number]

// MARK: - 实体视图

type JourneyRow = typeof agentJourneys.$inferSelect
type EventRow = typeof agentJourneyEvents.$inferSelect
type EdgeRow = typeof agentJourneyEdges.$inferSelect
type LayoutRow = typeof agentJourneyLayouts.$inferSelect

export type AgentJourney = {
  id: string
  title: string
  goal: string
  status: AgentJourneyStatus
  sourceClientId: string
  sourceAgent: string
  model: string
  workContextId: string | null
  createdAt: number
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  captureMode: AgentJourneyCaptureMode
  schemaVersion: number
}

export type AgentJourneyEvent = {
  id: string
  journeyId: string
  sequence: number
  eventType: AgentJourneyEventType
  role: AgentJourneyRole
  status: AgentJourneyEventStatus
  evidenceLevel: AgentJourneyEvidenceLevel
  title: string
  summary: string
  content: string
  reason: string
  sourceClientId: string
  sourceAgent: string
  model: string
  attemptId: string | null
  parentEventId: string | null
  idempotencyKey: string
  occurredAt: number
  receivedAt: number
  updatedAt: number
  metadata: string | null
}

export type AgentJourneyEdge = {
  id: string
  journeyId: string
  fromEventId: string
  toEventId: string
  relationshipType: AgentJourneyEdgeType
  createdAt: number
}

export type AgentJourneyLayout = {
  id: string
  journeyId: string
  eventId: string
  positionX: number
  positionY: number
  width: number
  height: number
  zIndex: number
  collapsed: boolean
  updatedAt: number
}

function toJourney(row: JourneyRow): AgentJourney {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status as AgentJourneyStatus,
    sourceClientId: row.sourceClientId,
    sourceAgent: row.sourceAgent,
    model: row.model,
    workContextId: row.workContextId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    captureMode: row.captureMode as AgentJourneyCaptureMode,
    schemaVersion: row.schemaVersion
  }
}

function toEvent(row: EventRow): AgentJourneyEvent {
  return {
    id: row.id,
    journeyId: row.journeyId,
    sequence: row.sequence,
    eventType: row.eventType as AgentJourneyEventType,
    role: row.role as AgentJourneyRole,
    status: row.status as AgentJourneyEventStatus,
    evidenceLevel: row.evidenceLevel as AgentJourneyEvidenceLevel,
    title: row.title,
    summary: row.summary,
    content: row.content,
    reason: row.reason,
    sourceClientId: row.sourceClientId,
    sourceAgent: row.sourceAgent,
    model: row.model,
    attemptId: row.attemptId,
    parentEventId: row.parentEventId,
    idempotencyKey: row.idempotencyKey,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata
  }
}

function toEdge(row: EdgeRow): AgentJourneyEdge {
  return {
    id: row.id,
    journeyId: row.journeyId,
    fromEventId: row.fromEventId,
    toEventId: row.toEventId,
    relationshipType: row.relationshipType as AgentJourneyEdgeType,
    createdAt: row.createdAt
  }
}

function toLayout(row: LayoutRow): AgentJourneyLayout {
  return {
    id: row.id,
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

export { toLayout }

// MARK: - Journey

export type InsertJourneyInput = {
  id?: string
  title: string
  goal: string
  status: AgentJourneyStatus
  sourceClientId: string
  sourceAgent: string
  model: string
  workContextId: string | null
  captureMode: AgentJourneyCaptureMode
  now: number
}

export function insertJourney(db: Db, input: InsertJourneyInput): AgentJourney {
  const row = {
    id: input.id ?? randomUUID(),
    title: input.title,
    goal: input.goal,
    status: input.status,
    sourceClientId: input.sourceClientId,
    sourceAgent: input.sourceAgent,
    model: input.model,
    workContextId: input.workContextId,
    createdAt: input.now,
    startedAt: input.status === 'created' ? null : input.now,
    updatedAt: input.now,
    completedAt: null,
    captureMode: input.captureMode,
    schemaVersion: 1
  }
  db.insert(agentJourneys).values(row).run()
  return toJourney(row as JourneyRow)
}

export function selectJourney(db: Db, id: string): AgentJourney | null {
  const row = db.select().from(agentJourneys).where(eq(agentJourneys.id, id)).get()
  return row ? toJourney(row) : null
}

export type JourneyListFilter = {
  status?: AgentJourneyStatus
  workContextId?: string
  limit?: number
  offset?: number
}

export function selectJourneys(db: Db, filter: JourneyListFilter): AgentJourney[] {
  const conditions = []
  if (filter.status) conditions.push(eq(agentJourneys.status, filter.status))
  if (filter.workContextId) conditions.push(eq(agentJourneys.workContextId, filter.workContextId))

  // `$dynamic()`：drizzle 的链式返回类型是逐步 `Omit` 的，条件拼接必须先
  // 解开静态类型，否则 `let query = …; query = query.where(…)` 编译不过。
  let query = db
    .select()
    .from(agentJourneys)
    .orderBy(desc(agentJourneys.createdAt), desc(agentJourneys.id))
    .$dynamic()
  if (conditions.length > 0) query = query.where(and(...conditions))
  if (filter.limit !== undefined) query = query.limit(filter.limit)
  if (filter.offset !== undefined) query = query.offset(filter.offset)
  return query.all().map(toJourney)
}

export function countJourneys(db: Db, filter: JourneyListFilter): number {
  const conditions = []
  if (filter.status) conditions.push(eq(agentJourneys.status, filter.status))
  if (filter.workContextId) conditions.push(eq(agentJourneys.workContextId, filter.workContextId))

  const query = db.select({ value: sql<number>`count(*)` }).from(agentJourneys).$dynamic()
  const scoped = conditions.length > 0 ? query.where(and(...conditions)) : query
  return scoped.get()?.value ?? 0
}

export type JourneyPatch = Partial<{
  title: string
  goal: string
  status: AgentJourneyStatus
  startedAt: number
  completedAt: number | null
  updatedAt: number
}>

/**
 * 下一个乐观锁版本号：`max(now, previousUpdatedAt + 1)`。
 *
 * 为什么不能直接用 `Date.now()`：CAS 的 WHERE 是 `updated_at = ?`，而
 * `Date.now()` 是**毫秒**值——快速连续更新会得到同一个时间戳，于是「已经
 * 变更过一次」的记录仍然会被一个**旧请求**用同一个 `expectedUpdatedAt` 命中，
 * 乐观锁形同虚设。测试用 `now` 与当前值完全相同就能复现。
 *
 * `previousUpdatedAt` 取自**参与 CAS 的那个值**（`expectedUpdatedAt`）或
 * 更新前重新读出的当前值——两者都严格等于库里的现值，因此结果必然
 * **严格大于**旧版本，且不受调用方传入的 `now` 影响。
 */
function nextUpdatedAt(now: number, previousUpdatedAt: number): number {
  return Math.max(now, previousUpdatedAt + 1)
}

/**
 * **乐观锁**更新：`WHERE id = ? AND updated_at = ?`。不匹配返回 null，
 * 由 Service 翻译成 `STALE_RECORD`（与 `work-contexts.ts` 同一语义）。
 *
 * 写入的 `updated_at` 由 `nextUpdatedAt` 计算，**严格递增**（见其注释）。
 * 由于 WHERE 已经保证命中行的 `updated_at === expectedUpdatedAt`，
 * 直接用 `expectedUpdatedAt` 当「前值」即可，不必额外读一次。
 */
export function updateJourney(
  db: Db,
  id: string,
  expectedUpdatedAt: number,
  patch: JourneyPatch,
  now: number
): AgentJourney | null {
  const result = db
    .update(agentJourneys)
    .set({ ...patch, updatedAt: nextUpdatedAt(now, expectedUpdatedAt) })
    .where(and(eq(agentJourneys.id, id), eq(agentJourneys.updatedAt, expectedUpdatedAt)))
    .run()
  if (result.changes !== 1) return null
  return selectJourney(db, id)
}

/**
 * 事务内的**无条件**更新（Service 已在同一事务里校验过状态前置条件）。
 * 与 `updateJourney` 的区别只在「谁负责保证前置条件」。
 *
 * 没有 CAS 就没有「前值」可用，因此**先读当前版本**再算下一个版本——
 * 同一个事务里连续调用两次（`created → running → completed`）时，
 * 第二次读到的正是第一次写下的值，版本会继续递增而不是原地踏步。
 */
export function updateJourneyUnchecked(db: Db, id: string, patch: JourneyPatch, now: number): AgentJourney {
  const current = selectJourney(db, id)
  if (!current) throw new Error(`journey ${id} disappeared during update`)
  db.update(agentJourneys)
    .set({ ...patch, updatedAt: nextUpdatedAt(now, current.updatedAt) })
    .where(eq(agentJourneys.id, id))
    .run()
  const row = selectJourney(db, id)
  if (!row) throw new Error(`journey ${id} disappeared during update`)
  return row
}

// MARK: - Event

/** Journey 内的下一个 `sequence`：`COALESCE(MAX(sequence), 0) + 1`。 */
export function nextSequence(db: Db, journeyId: string): number {
  const row = db
    .select({ value: sql<number | null>`max(${agentJourneyEvents.sequence})` })
    .from(agentJourneyEvents)
    .where(eq(agentJourneyEvents.journeyId, journeyId))
    .get()
  return (row?.value ?? 0) + 1
}

export type InsertEventInput = {
  id?: string
  journeyId: string
  sequence: number
  eventType: AgentJourneyEventType
  role: AgentJourneyRole
  status: AgentJourneyEventStatus
  evidenceLevel: AgentJourneyEvidenceLevel
  title: string
  summary: string
  content: string
  reason: string
  sourceClientId: string
  sourceAgent: string
  model: string
  attemptId: string | null
  parentEventId: string | null
  idempotencyKey: string
  occurredAt: number
  receivedAt: number
  metadata: string | null
}

export function insertEvent(db: Db, input: InsertEventInput): AgentJourneyEvent {
  const row = {
    id: input.id ?? randomUUID(),
    journeyId: input.journeyId,
    sequence: input.sequence,
    eventType: input.eventType,
    role: input.role,
    status: input.status,
    evidenceLevel: input.evidenceLevel,
    title: input.title,
    summary: input.summary,
    content: input.content,
    reason: input.reason,
    sourceClientId: input.sourceClientId,
    sourceAgent: input.sourceAgent,
    model: input.model,
    attemptId: input.attemptId,
    parentEventId: input.parentEventId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt,
    updatedAt: input.receivedAt,
    metadata: input.metadata
  }
  db.insert(agentJourneyEvents).values(row).run()
  return toEvent(row as EventRow)
}

export function selectEvent(db: Db, id: string): AgentJourneyEvent | null {
  const row = db.select().from(agentJourneyEvents).where(eq(agentJourneyEvents.id, id)).get()
  return row ? toEvent(row) : null
}

export function selectEventByIdempotencyKey(
  db: Db,
  journeyId: string,
  clientId: string,
  key: string
): AgentJourneyEvent | null {
  const row = db
    .select()
    .from(agentJourneyEvents)
    .where(
      and(
        eq(agentJourneyEvents.journeyId, journeyId),
        eq(agentJourneyEvents.sourceClientId, clientId),
        eq(agentJourneyEvents.idempotencyKey, key)
      )
    )
    .get()
  return row ? toEvent(row) : null
}

export type EventListFilter = {
  eventTypes?: readonly AgentJourneyEventType[]
  sinceSequence?: number
  limit?: number
}

export function selectEvents(db: Db, journeyId: string, filter: EventListFilter = {}): AgentJourneyEvent[] {
  const conditions = [eq(agentJourneyEvents.journeyId, journeyId)]
  if (filter.eventTypes && filter.eventTypes.length > 0) {
    conditions.push(inArray(agentJourneyEvents.eventType, [...filter.eventTypes]))
  }
  if (filter.sinceSequence !== undefined) {
    conditions.push(gte(agentJourneyEvents.sequence, filter.sinceSequence))
  }

  let query = db
    .select()
    .from(agentJourneyEvents)
    .where(and(...conditions))
    .orderBy(asc(agentJourneyEvents.sequence))
    .$dynamic()
  if (filter.limit !== undefined) query = query.limit(filter.limit)
  return query.all().map(toEvent)
}

/**
 * 乐观锁推进事件状态；不匹配返回 null → `STALE_RECORD`。
 *
 * 写入的 `updated_at` 严格递增（`nextUpdatedAt`），因此用**同一个 now**
 * 连续推进两次时，第二次必须拿第一次写下的版本号，旧值一律 `STALE_RECORD`。
 */
export function updateEventStatus(
  db: Db,
  input: { id: string; status: AgentJourneyEventStatus; expectedUpdatedAt: number; now: number }
): AgentJourneyEvent | null {
  const result = db
    .update(agentJourneyEvents)
    .set({ status: input.status, updatedAt: nextUpdatedAt(input.now, input.expectedUpdatedAt) })
    .where(
      and(
        eq(agentJourneyEvents.id, input.id),
        eq(agentJourneyEvents.updatedAt, input.expectedUpdatedAt)
      )
    )
    .run()
  if (result.changes !== 1) return null
  return selectEvent(db, input.id)
}

// MARK: - Edge

export type InsertEdgeInput = {
  id?: string
  journeyId: string
  fromEventId: string
  toEventId: string
  relationshipType: AgentJourneyEdgeType
  now: number
}

export function insertEdge(db: Db, input: InsertEdgeInput): AgentJourneyEdge {
  const row = {
    id: input.id ?? randomUUID(),
    journeyId: input.journeyId,
    fromEventId: input.fromEventId,
    toEventId: input.toEventId,
    relationshipType: input.relationshipType,
    createdAt: input.now
  }
  db.insert(agentJourneyEdges).values(row).run()
  return toEdge(row as EdgeRow)
}

export function selectEdges(db: Db, journeyId: string): AgentJourneyEdge[] {
  return db
    .select()
    .from(agentJourneyEdges)
    .where(eq(agentJourneyEdges.journeyId, journeyId))
    .orderBy(asc(agentJourneyEdges.createdAt))
    .all()
    .map(toEdge)
}

/** 事件属于哪个 Journey；不存在返回 null。用于跨 Journey 引用校验。 */
export function eventJourneyId(db: Db, eventId: string): string | null {
  const row = db
    .select({ journeyId: agentJourneyEvents.journeyId })
    .from(agentJourneyEvents)
    .where(eq(agentJourneyEvents.id, eventId))
    .get()
  return row?.journeyId ?? null
}
