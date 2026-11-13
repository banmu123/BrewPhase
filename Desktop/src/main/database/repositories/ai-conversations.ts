import { desc, eq } from 'drizzle-orm'
import { aiConversations, aiMessages } from '../schema'
import type { Db } from '../client'

/**
 * Multi-AI 讨论的落库。一次「同时提问」写三条消息：问题一条、
 * 每个平台回答各一条；执行状态与失败原因进 metadata，不进正文。
 */

export type AIConversationRow = {
  id: string
  title: string
  prompt: string
  providers: string
  createdAt: number
  updatedAt: number
}

export type AIMessageRow = {
  id: string
  conversationId: string
  provider: string
  accountId: string
  role: string
  content: string
  status: string
  metadata: string
  createdAt: number
}

export function insertConversation(
  db: Db,
  input: { id: string; title: string; prompt: string; providers: string; now: number }
): AIConversationRow {
  db.insert(aiConversations)
    .values({
      id: input.id,
      title: input.title,
      prompt: input.prompt,
      providers: input.providers,
      createdAt: input.now,
      updatedAt: input.now
    })
    .run()
  return selectConversation(db, input.id)!
}

export function insertMessage(db: Db, input: Omit<AIMessageRow, 'accountId'> & { accountId?: string }): AIMessageRow {
  const row: AIMessageRow = {
    id: input.id,
    conversationId: input.conversationId,
    provider: input.provider,
    accountId: input.accountId ?? '',
    role: input.role,
    content: input.content,
    status: input.status,
    metadata: input.metadata,
    createdAt: input.createdAt
  }
  db.insert(aiMessages).values(row).run()
  db.update(aiConversations)
    .set({ updatedAt: Math.max(input.createdAt, 0) })
    .where(eq(aiConversations.id, input.conversationId))
    .run()
  return row
}

export function selectConversation(db: Db, id: string): AIConversationRow | null {
  return (db.select().from(aiConversations).where(eq(aiConversations.id, id)).all() as AIConversationRow[])[0] ?? null
}

export function selectMessages(db: Db, conversationId: string): AIMessageRow[] {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(aiMessages.createdAt)
    .all() as AIMessageRow[]
}

/** 最近优先；列表页只显示问题行，不 join 消息。 */
export function selectRecentConversations(db: Db, limit: number): AIConversationRow[] {
  return db.select().from(aiConversations).orderBy(desc(aiConversations.createdAt)).limit(limit).all() as AIConversationRow[]
}

export function deleteConversation(db: Db, id: string): boolean {
  const existing = selectConversation(db, id)
  if (!existing) return false
  db.delete(aiConversations).where(eq(aiConversations.id, id)).run()
  return true
}
