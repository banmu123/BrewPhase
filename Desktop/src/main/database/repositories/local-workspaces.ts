import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { cardWorkspaceBindings, localWorkspaces } from '../schema'

/**
 * 本地工作区与卡片绑定的存储层（migration 12）。只做行 ↔ 记录映射，
 * 校验与业务规则在 LocalWorkspaceService。
 */

export type LocalWorkspaceRow = {
  id: string
  name: string
  absolutePath: string
  platform: string
  createdAt: number
  updatedAt: number
}

export type CardBindingRow = {
  tabId: string
  workspaceId: string
  createdAt: number
  updatedAt: number
}

export function insertWorkspace(
  db: Db,
  input: { id: string; name: string; absolutePath: string; platform: string; now: number }
): LocalWorkspaceRow | null {
  try {
    db.insert(localWorkspaces)
      .values({
        id: input.id,
        name: input.name,
        absolutePath: input.absolutePath,
        platform: input.platform,
        createdAt: input.now,
        updatedAt: input.now
      })
      .run()
  } catch {
    // 唯一索引冲突（并发添加同一路径）按「已存在」处理。
    return null
  }
  return {
    id: input.id,
    name: input.name,
    absolutePath: input.absolutePath,
    platform: input.platform,
    createdAt: input.now,
    updatedAt: input.now
  }
}

export function selectWorkspaces(db: Db): LocalWorkspaceRow[] {
  return db
    .select({
      id: localWorkspaces.id,
      name: localWorkspaces.name,
      absolutePath: localWorkspaces.absolutePath,
      platform: localWorkspaces.platform,
      createdAt: localWorkspaces.createdAt,
      updatedAt: localWorkspaces.updatedAt
    })
    .from(localWorkspaces)
    .orderBy(localWorkspaces.createdAt)
    .all()
}

export function selectWorkspace(db: Db, id: string): LocalWorkspaceRow | null {
  const row = db
    .select({
      id: localWorkspaces.id,
      name: localWorkspaces.name,
      absolutePath: localWorkspaces.absolutePath,
      platform: localWorkspaces.platform,
      createdAt: localWorkspaces.createdAt,
      updatedAt: localWorkspaces.updatedAt
    })
    .from(localWorkspaces)
    .where(eq(localWorkspaces.id, id))
    .get()
  return row ?? null
}

/** 大小写不敏感的同路径查重（Windows / macOS 默认盘上只差大小写是同一目录）。 */
export function selectWorkspaceByPathCI(db: Db, absolutePath: string): LocalWorkspaceRow | null {
  const row = db
    .select({
      id: localWorkspaces.id,
      name: localWorkspaces.name,
      absolutePath: localWorkspaces.absolutePath,
      platform: localWorkspaces.platform,
      createdAt: localWorkspaces.createdAt,
      updatedAt: localWorkspaces.updatedAt
    })
    .from(localWorkspaces)
    .where(sql`lower(${localWorkspaces.absolutePath}) = lower(${absolutePath})`)
    .get()
  return row ?? null
}

export function updateWorkspaceName(db: Db, id: string, name: string, now: number): LocalWorkspaceRow | null {
  db.update(localWorkspaces)
    .set({ name, updatedAt: now })
    .where(eq(localWorkspaces.id, id))
    .run()
  return selectWorkspace(db, id)
}

export function deleteWorkspace(db: Db, id: string): boolean {
  const result = db.delete(localWorkspaces).where(eq(localWorkspaces.id, id)).run()
  return result.changes > 0
}

export function selectBinding(db: Db, tabId: string): CardBindingRow | null {
  const row = db
    .select({
      tabId: cardWorkspaceBindings.tabId,
      workspaceId: cardWorkspaceBindings.workspaceId,
      createdAt: cardWorkspaceBindings.createdAt,
      updatedAt: cardWorkspaceBindings.updatedAt
    })
    .from(cardWorkspaceBindings)
    .where(eq(cardWorkspaceBindings.tabId, tabId))
    .get()
  return row ?? null
}

export function upsertBinding(
  db: Db,
  input: { tabId: string; workspaceId: string | null; now: number }
): CardBindingRow | null {
  db.transaction((tx) => {
    tx.delete(cardWorkspaceBindings).where(eq(cardWorkspaceBindings.tabId, input.tabId)).run()
    if (input.workspaceId !== null) {
      tx.insert(cardWorkspaceBindings)
        .values({
          tabId: input.tabId,
          workspaceId: input.workspaceId,
          createdAt: input.now,
          updatedAt: input.now
        })
        .run()
    }
  })
  return input.workspaceId === null ? null : selectBinding(db, input.tabId)
}

/** tab 关闭后清理不再需要的绑定（规格 §5.8）。 */
export function deleteBinding(db: Db, tabId: string): boolean {
  const result = db.delete(cardWorkspaceBindings).where(eq(cardWorkspaceBindings.tabId, tabId)).run()
  return result.changes > 0
}

export function countBindingsForWorkspace(db: Db, workspaceId: string): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(cardWorkspaceBindings)
    .where(and(eq(cardWorkspaceBindings.workspaceId, workspaceId)))
    .get()
  return Number(row?.total ?? 0)
}
