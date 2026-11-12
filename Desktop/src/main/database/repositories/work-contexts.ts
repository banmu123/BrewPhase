import { and, desc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../client'
import { workContextResources, workContexts } from '../schema'
import type {
  WorkContext,
  WorkContextResource,
  WorkContextResourceRole,
  WorkContextResourceType,
  WorkContextStatus
} from '../../../shared/contracts/work-context'

/**
 * Work Context 仓储：纯 SQL 组装，不含业务规则（校验与清理在 Service）。
 * 所有时间都是 epoch 毫秒，与既有实体一致。
 */

type WorkContextRow = typeof workContexts.$inferSelect
type ResourceRow = typeof workContextResources.$inferSelect

function toContext(row: WorkContextRow): WorkContext {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    summary: row.summary,
    nextStep: row.nextStep,
    status: row.status as WorkContextStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt
  }
}

function toResource(row: ResourceRow): WorkContextResource {
  return {
    id: row.id,
    workContextId: row.workContextId,
    resourceType: row.resourceType as WorkContextResourceType,
    resourceId: row.resourceId,
    role: row.role as WorkContextResourceRole,
    note: row.note,
    createdAt: row.createdAt
  }
}

export type CreateWorkContextInput = {
  title: string
  goal: string
  summary: string
  nextStep: string
  now: number
}

export function insertWorkContext(db: Db, input: CreateWorkContextInput): WorkContext {
  const row = {
    id: randomUUID(),
    title: input.title,
    goal: input.goal,
    summary: input.summary,
    nextStep: input.nextStep,
    status: 'active' as const,
    createdAt: input.now,
    updatedAt: input.now,
    lastActivityAt: input.now
  }
  db.insert(workContexts).values(row).run()
  return toContext(row as WorkContextRow)
}

export function selectWorkContext(db: Db, id: string): WorkContext | null {
  const row = db.select().from(workContexts).where(eq(workContexts.id, id)).get()
  return row ? toContext(row) : null
}

export function selectWorkContexts(db: Db, status: WorkContextStatus | null): WorkContext[] {
  const rows = status
    ? db
        .select()
        .from(workContexts)
        .where(eq(workContexts.status, status))
        .orderBy(desc(workContexts.lastActivityAt))
        .all()
    : db.select().from(workContexts).orderBy(desc(workContexts.lastActivityAt)).all()
  return rows.map(toContext)
}

export type UpdateWorkContextPatch = {
  title?: string
  goal?: string
  summary?: string
  nextStep?: string
  status?: WorkContextStatus
}

/**
 * 乐观并发更新：`expectedUpdatedAt` 不匹配时返回 null（STALE_RECORD）。
 * 任何一次成功更新都会刷新 updated_at 与 last_activity_at。
 */
export function updateWorkContext(
  db: Db,
  id: string,
  expectedUpdatedAt: number,
  patch: UpdateWorkContextPatch,
  now: number
): WorkContext | null {
  const current = db
    .select()
    .from(workContexts)
    .where(and(eq(workContexts.id, id), eq(workContexts.updatedAt, expectedUpdatedAt)))
    .get()
  if (!current) return null

  db.update(workContexts)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.nextStep !== undefined ? { nextStep: patch.nextStep } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: now,
      lastActivityAt: now
    })
    .where(eq(workContexts.id, id))
    .run()
  return selectWorkContext(db, id)
}

export type LinkResourceInput = {
  workContextId: string
  resourceType: WorkContextResourceType
  resourceId: string
  role: WorkContextResourceRole
  note: string
  now: number
}

/** 幂等关联：UNIQUE 冲突时返回已有关联（created=false），不产生副本。 */
export function insertWorkContextResource(
  db: Db,
  input: LinkResourceInput
): { resource: WorkContextResource; created: boolean } {
  const existing = db
    .select()
    .from(workContextResources)
    .where(
      and(
        eq(workContextResources.workContextId, input.workContextId),
        eq(workContextResources.resourceType, input.resourceType),
        eq(workContextResources.resourceId, input.resourceId)
      )
    )
    .get()
  if (existing) return { resource: toResource(existing), created: false }

  const row = {
    id: randomUUID(),
    workContextId: input.workContextId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    role: input.role,
    note: input.note,
    createdAt: input.now
  }
  db.insert(workContextResources).values(row).run()
  // 关联成功也算一次工作活动。
  db.update(workContexts)
    .set({ lastActivityAt: input.now })
    .where(eq(workContexts.id, input.workContextId))
    .run()
  return { resource: toResource(row as ResourceRow), created: true }
}

export function selectWorkContextResource(db: Db, id: string): WorkContextResource | null {
  const row = db.select().from(workContextResources).where(eq(workContextResources.id, id)).get()
  return row ? toResource(row) : null
}

export function selectWorkContextResources(db: Db, workContextId: string): WorkContextResource[] {
  return db
    .select()
    .from(workContextResources)
    .where(eq(workContextResources.workContextId, workContextId))
    .orderBy(workContextResources.createdAt)
    .all()
    .map(toResource)
}

/** prune-on-read：删除指向已不存在实体（record / canvas）的失效关联。 */
export function deleteWorkContextResources(db: Db, ids: string[]): void {
  for (const id of ids) {
    db.delete(workContextResources).where(eq(workContextResources.id, id)).run()
  }
}

export function deleteWorkContext(db: Db, id: string): void {
  db.delete(workContexts).where(eq(workContexts.id, id)).run()
}
