import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { actionDrafts, capturedReplies, replySegments } from '../schema'

/**
 * Reply Intelligence 存储层（migration 13）。只做行 ↔ 记录映射；
 * 校验、来源识别与解析在 ReplyIntelligenceService。
 */

export type CapturedReplyRow = {
  id: string
  providerId: string
  providerName: string
  sourceUrl: string
  sourceTitle: string
  tabId: string
  workspaceId: string | null
  captureMethod: string
  rawContent: string
  capturedAt: number
  createdAt: number
}

export type ReplySegmentRow = {
  id: string
  replyId: string
  sequence: number
  categories: string
  content: string
  startOffset: number
  endOffset: number
  confidence: number
  reason: string
  userEdited: boolean
}

export type ActionDraftRow = {
  id: string
  replyId: string
  segmentId: string | null
  workspaceId: string | null
  actionType: string
  title: string
  description: string
  payload: string
  workingDirectory: string
  riskLevel: string
  requiresApproval: boolean
  status: string
  createdAt: number
  updatedAt: number
}

export function insertReply(db: Db, row: CapturedReplyRow): CapturedReplyRow {
  db.insert(capturedReplies).values(row).run()
  return row
}

export function selectReply(db: Db, id: string): CapturedReplyRow | null {
  return db.select().from(capturedReplies).where(eq(capturedReplies.id, id)).get() ?? null
}

export function listReplies(db: Db, limit: number): CapturedReplyRow[] {
  return db
    .select()
    .from(capturedReplies)
    .orderBy(desc(capturedReplies.capturedAt))
    .limit(limit)
    .all()
}

export function deleteReply(db: Db, id: string): boolean {
  const result = db.delete(capturedReplies).where(eq(capturedReplies.id, id)).run()
  return result.changes > 0
}

export function insertSegments(db: Db, rows: ReplySegmentRow[]): void {
  if (rows.length === 0) return
  db.transaction((tx) => {
    for (const row of rows) tx.insert(replySegments).values(row).run()
  })
}

export function selectSegments(db: Db, replyId: string): ReplySegmentRow[] {
  return db
    .select()
    .from(replySegments)
    .where(eq(replySegments.replyId, replyId))
    .orderBy(replySegments.sequence)
    .all()
}

export function selectSegment(db: Db, id: string): ReplySegmentRow | null {
  return db.select().from(replySegments).where(eq(replySegments.id, id)).get() ?? null
}

export function updateSegment(
  db: Db,
  id: string,
  patch: { categories?: string; content?: string; userEdited: boolean }
): ReplySegmentRow | null {
  db.update(replySegments)
    .set({
      ...(patch.categories !== undefined ? { categories: patch.categories } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      userEdited: patch.userEdited
    })
    .where(eq(replySegments.id, id))
    .run()
  return selectSegment(db, id)
}

/** 删除单个分段（草稿的 segment_id 由 FK 置空，草稿保留）。 */
export function deleteSegment(db: Db, id: string): boolean {
  const result = db.delete(replySegments).where(eq(replySegments.id, id)).run()
  return result.changes > 0
}

export function insertDraft(db: Db, row: ActionDraftRow): ActionDraftRow {
  db.insert(actionDrafts).values(row).run()
  return row
}

export function selectDraft(db: Db, id: string): ActionDraftRow | null {
  return db.select().from(actionDrafts).where(eq(actionDrafts.id, id)).get() ?? null
}

export function listDrafts(db: Db, replyId: string | null, limit: number): ActionDraftRow[] {
  if (replyId !== null) {
    return db
      .select()
      .from(actionDrafts)
      .where(eq(actionDrafts.replyId, replyId))
      .orderBy(desc(actionDrafts.createdAt))
      .limit(limit)
      .all()
  }
  return db.select().from(actionDrafts).orderBy(desc(actionDrafts.createdAt)).limit(limit).all()
}

export function updateDraft(
  db: Db,
  id: string,
  patch: Partial<Pick<ActionDraftRow, 'title' | 'description' | 'payload' | 'workingDirectory' | 'riskLevel' | 'status' | 'workspaceId'>>,
  now: number
): ActionDraftRow | null {
  db.update(actionDrafts)
    .set({ ...patch, updatedAt: now })
    .where(eq(actionDrafts.id, id))
    .run()
  return selectDraft(db, id)
}

export function deleteDraft(db: Db, id: string): boolean {
  const result = db.delete(actionDrafts).where(eq(actionDrafts.id, id)).run()
  return result.changes > 0
}

/** tabId 维度的统计（「不同卡片互不串数据」的可观测口径）。 */
export function countRepliesForTab(db: Db, tabId: string): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(capturedReplies)
    .where(and(eq(capturedReplies.tabId, tabId)))
    .get()
  return Number(row?.total ?? 0)
}
