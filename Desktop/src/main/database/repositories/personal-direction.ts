import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../client'
import { currentStates, directions, stageGoals } from '../schema'
import type {
  CurrentState,
  CurrentStateDraft,
  CurrentStateStatus,
  Direction,
  DirectionSource,
  DirectionStatus,
  StageGoal,
  StageGoalStatus
} from '../../../shared/contracts/personal-direction'

/**
 * Personal Direction 仓储：纯 SQL 组装，不含业务规则。
 *
 * 业务规则（草稿不能自我确认、同方向只留一个 active 阶段、现状版本化）
 * 全部在 Service 里——这里只保证每次读写都是完整、一致的记录。
 * 时间一律 epoch 毫秒，与既有实体一致。
 */

type CurrentStateRow = typeof currentStates.$inferSelect
type DirectionRow = typeof directions.$inferSelect
type StageGoalRow = typeof stageGoals.$inferSelect

/** outcomes 存 JSON 字符串；脏数据按空数组处理，不让一条坏记录打穿整页。 */
function parseOutcomes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function toCurrentState(row: CurrentStateRow): CurrentState {
  return {
    id: row.id,
    summary: row.summary,
    workStatus: row.workStatus,
    capabilities: row.capabilities,
    ongoing: row.ongoing,
    capacity: row.capacity,
    constraints: row.constraints,
    other: row.other,
    status: row.status as CurrentStateStatus,
    source: row.source as DirectionSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toDirection(row: DirectionRow): Direction {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    motivation: row.motivation,
    timeHorizon: row.timeHorizon,
    outcomes: parseOutcomes(row.outcomes),
    constraints: row.constraints,
    status: row.status as DirectionStatus,
    source: row.source as DirectionSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toStageGoal(row: StageGoalRow): StageGoal {
  return {
    id: row.id,
    directionId: row.directionId,
    name: row.name,
    goal: row.goal,
    expectedOutcome: row.expectedOutcome,
    completionCriteria: row.completionCriteria,
    timeHorizon: row.timeHorizon,
    obstacles: row.obstacles,
    workContextId: row.workContextId,
    status: row.status as StageGoalStatus,
    source: row.source as DirectionSource,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

// MARK: - Current State

export type InsertCurrentStateInput = CurrentStateDraft & {
  status: CurrentStateStatus
  source: DirectionSource
  now: number
}

export function insertCurrentState(db: Db, input: InsertCurrentStateInput): CurrentState {
  const row = {
    id: randomUUID(),
    summary: input.summary,
    workStatus: input.workStatus,
    capabilities: input.capabilities,
    ongoing: input.ongoing,
    capacity: input.capacity,
    constraints: input.constraints,
    other: input.other,
    status: input.status,
    source: input.source,
    createdAt: input.now,
    updatedAt: input.now
  }
  db.insert(currentStates).values(row).run()
  return toCurrentState(row as CurrentStateRow)
}

export function selectCurrentState(db: Db, id: string): CurrentState | null {
  const row = db.select().from(currentStates).where(eq(currentStates.id, id)).get()
  return row ? toCurrentState(row) : null
}

/** 某一状态里最新的一条；没有就 null。 */
export function selectLatestCurrentState(
  db: Db,
  status: CurrentStateStatus
): CurrentState | null {
  const row = db
    .select()
    .from(currentStates)
    .where(eq(currentStates.status, status))
    .orderBy(desc(currentStates.updatedAt))
    .get()
  return row ? toCurrentState(row) : null
}

/** 历史版本：除当前生效那条以外的 confirmed，新的在前。 */
export function selectArchivedCurrentStates(db: Db, limit = 20): CurrentState[] {
  return db
    .select()
    .from(currentStates)
    .where(eq(currentStates.status, 'archived'))
    .orderBy(desc(currentStates.updatedAt))
    .limit(limit)
    .all()
    .map(toCurrentState)
}

export type UpdateCurrentStatePatch = Partial<CurrentStateDraft> & {
  status?: CurrentStateStatus
}

/** 乐观并发：expectedUpdatedAt 不匹配返回 null（STALE_RECORD）。 */
export function updateCurrentState(
  db: Db,
  id: string,
  expectedUpdatedAt: number,
  patch: UpdateCurrentStatePatch,
  now: number
): CurrentState | null {
  const current = db
    .select()
    .from(currentStates)
    .where(and(eq(currentStates.id, id), eq(currentStates.updatedAt, expectedUpdatedAt)))
    .get()
  if (!current) return null

  // 严格单调：同一毫秒内的第二次写入也要拿到新版本号，否则乐观锁形同虚设。
  const stamp = Math.max(now, current.updatedAt + 1)

  db.update(currentStates)
    .set({
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.workStatus !== undefined ? { workStatus: patch.workStatus } : {}),
      ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
      ...(patch.ongoing !== undefined ? { ongoing: patch.ongoing } : {}),
      ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
      ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {}),
      ...(patch.other !== undefined ? { other: patch.other } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: stamp
    })
    .where(eq(currentStates.id, id))
    .run()
  return selectCurrentState(db, id)
}

/** 确认新版时把其余 confirmed 全部转 archived；status 只有一条生效。 */
export function archiveConfirmedCurrentStates(db: Db, keepId: string, now: number): void {
  db.update(currentStates)
    .set({ status: 'archived', updatedAt: now })
    .where(and(eq(currentStates.status, 'confirmed'), ne(currentStates.id, keepId)))
    .run()
}

export function deleteCurrentState(db: Db, id: string): void {
  db.delete(currentStates).where(eq(currentStates.id, id)).run()
}

// MARK: - Direction

export type InsertDirectionInput = {
  title: string
  description: string
  motivation: string
  timeHorizon: string
  outcomes: string[]
  constraints: string
  status: DirectionStatus
  source: DirectionSource
  now: number
}

export function insertDirection(db: Db, input: InsertDirectionInput): Direction {
  const row = {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    motivation: input.motivation,
    timeHorizon: input.timeHorizon,
    outcomes: JSON.stringify(input.outcomes),
    constraints: input.constraints,
    status: input.status,
    source: input.source,
    createdAt: input.now,
    updatedAt: input.now
  }
  db.insert(directions).values(row).run()
  return toDirection(row as DirectionRow)
}

export function selectDirection(db: Db, id: string): Direction | null {
  const row = db.select().from(directions).where(eq(directions.id, id)).get()
  return row ? toDirection(row) : null
}

/** 全部方向，最近更新的在前；判定「是否需要展示」由调用方决定。 */
export function selectDirections(db: Db): Direction[] {
  return db.select().from(directions).orderBy(desc(directions.updatedAt)).all().map(toDirection)
}

/**
 * 按标题找一条**待确认**的方向。
 *
 * Agent 每次会话都可能重新提议同一件事；若每次都新建，用户会攒下一堆
 * 内容相同的提议。同名提议视为「同一份草稿的再编辑」，覆盖它。
 */
export function selectProposedDirectionByTitle(db: Db, title: string): Direction | null {
  const row = db
    .select()
    .from(directions)
    .where(and(eq(directions.status, 'proposed'), eq(directions.title, title)))
    .orderBy(desc(directions.updatedAt))
    .get()
  return row ? toDirection(row) : null
}

export type UpdateDirectionPatch = {
  title?: string
  description?: string
  motivation?: string
  timeHorizon?: string
  outcomes?: string[]
  constraints?: string
  status?: DirectionStatus
}

export function updateDirection(
  db: Db,
  id: string,
  expectedUpdatedAt: number,
  patch: UpdateDirectionPatch,
  now: number
): Direction | null {
  const current = db
    .select()
    .from(directions)
    .where(and(eq(directions.id, id), eq(directions.updatedAt, expectedUpdatedAt)))
    .get()
  if (!current) return null

  const stamp = Math.max(now, current.updatedAt + 1)

  db.update(directions)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.motivation !== undefined ? { motivation: patch.motivation } : {}),
      ...(patch.timeHorizon !== undefined ? { timeHorizon: patch.timeHorizon } : {}),
      ...(patch.outcomes !== undefined ? { outcomes: JSON.stringify(patch.outcomes) } : {}),
      ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: stamp
    })
    .where(eq(directions.id, id))
    .run()
  return selectDirection(db, id)
}

/** 删除方向会连带删掉它的阶段（FK cascade），这是有意的：阶段离开方向没有意义。 */
export function deleteDirection(db: Db, id: string): void {
  db.delete(directions).where(eq(directions.id, id)).run()
}

// MARK: - Stage Goal

export type InsertStageGoalInput = {
  directionId: string
  name: string
  goal: string
  expectedOutcome: string
  completionCriteria: string
  timeHorizon: string
  obstacles: string
  workContextId: string | null
  status: StageGoalStatus
  source: DirectionSource
  sortOrder: number
  now: number
}

export function insertStageGoal(db: Db, input: InsertStageGoalInput): StageGoal {
  const row = {
    id: randomUUID(),
    directionId: input.directionId,
    name: input.name,
    goal: input.goal,
    expectedOutcome: input.expectedOutcome,
    completionCriteria: input.completionCriteria,
    timeHorizon: input.timeHorizon,
    obstacles: input.obstacles,
    workContextId: input.workContextId,
    status: input.status,
    source: input.source,
    sortOrder: input.sortOrder,
    createdAt: input.now,
    updatedAt: input.now
  }
  db.insert(stageGoals).values(row).run()
  return toStageGoal(row as StageGoalRow)
}

export function selectStageGoal(db: Db, id: string): StageGoal | null {
  const row = db.select().from(stageGoals).where(eq(stageGoals.id, id)).get()
  return row ? toStageGoal(row) : null
}

/** 全部阶段（可按方向过滤），按方向内顺序排。 */
export function selectStageGoals(db: Db, directionId?: string): StageGoal[] {
  const base = db.select().from(stageGoals)
  const rows = directionId
    ? base.where(eq(stageGoals.directionId, directionId)).all()
    : base.all()
  return rows
    .map(toStageGoal)
    .sort((a, b) => (a.directionId === b.directionId
      ? a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
      : a.directionId.localeCompare(b.directionId)))
}

/** 同一方向的下一个 sort_order：接在最后一段之后。 */export function nextStageSortOrder(db: Db, directionId: string): number {
  const rows = db
    .select({ sortOrder: stageGoals.sortOrder })
    .from(stageGoals)
    .where(eq(stageGoals.directionId, directionId))
    .orderBy(asc(stageGoals.sortOrder))
    .all()
  if (rows.length === 0) return 0
  return Math.max(...rows.map((row) => row.sortOrder)) + 1
}

/**
 * 按「方向 + 名称」找一条待确认的阶段，理由同 `selectProposedDirectionByTitle`：
 * 同名提议是同一份草稿的再编辑，不该堆成多条。
 */
export function selectProposedStageByName(
  db: Db,
  directionId: string,
  name: string
): StageGoal | null {
  const row = db
    .select()
    .from(stageGoals)
    .where(
      and(
        eq(stageGoals.directionId, directionId),
        eq(stageGoals.status, 'proposed'),
        eq(stageGoals.name, name)
      )
    )
    .orderBy(desc(stageGoals.updatedAt))
    .get()
  return row ? toStageGoal(row) : null
}

export type UpdateStageGoalPatch = {
  name?: string
  goal?: string
  expectedOutcome?: string
  completionCriteria?: string
  timeHorizon?: string
  obstacles?: string
  workContextId?: string | null
  status?: StageGoalStatus
  sortOrder?: number
}

export function updateStageGoal(
  db: Db,
  id: string,
  expectedUpdatedAt: number,
  patch: UpdateStageGoalPatch,
  now: number
): StageGoal | null {
  const current = db
    .select()
    .from(stageGoals)
    .where(and(eq(stageGoals.id, id), eq(stageGoals.updatedAt, expectedUpdatedAt)))
    .get()
  if (!current) return null

  const stamp = Math.max(now, current.updatedAt + 1)

  db.update(stageGoals)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.expectedOutcome !== undefined ? { expectedOutcome: patch.expectedOutcome } : {}),
      ...(patch.completionCriteria !== undefined
        ? { completionCriteria: patch.completionCriteria }
        : {}),
      ...(patch.timeHorizon !== undefined ? { timeHorizon: patch.timeHorizon } : {}),
      ...(patch.obstacles !== undefined ? { obstacles: patch.obstacles } : {}),
      ...(patch.workContextId !== undefined ? { workContextId: patch.workContextId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      updatedAt: stamp
    })
    .where(eq(stageGoals.id, id))
    .run()
  return selectStageGoal(db, id)
}

/**
 * 同一方向只留一个 active：把其余 active 阶段降为 paused。
 * 「当前阶段」是单数——两个 active 会让「我现在在哪一段」没有答案。
 */
export function pauseOtherActiveStages(db: Db, directionId: string, keepId: string, now: number): void {
  db.update(stageGoals)
    .set({ status: 'paused', updatedAt: now })
    .where(
      and(
        eq(stageGoals.directionId, directionId),
        eq(stageGoals.status, 'active'),
        ne(stageGoals.id, keepId)
      )
    )
    .run()
}

export function deleteStageGoal(db: Db, id: string): void {
  db.delete(stageGoals).where(eq(stageGoals.id, id)).run()
}
