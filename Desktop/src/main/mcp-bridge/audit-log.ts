import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../database/client'
import { mcpIdempotency, mcpOperationLog } from '../database/schema'

/**
 * 写调用的记账：审计日志 + 幂等表。
 *
 * - 审计只记「谁、用什么工具、动了哪个实体、成功与否、错误码」——不记参数、
 *   正文、token、路径（见 docs/MCP_SECURITY.md §7）。
 * - 幂等表只存请求摘要（sha256），不存参数原文。
 */

export type AuditEntry = {
  clientId: string
  toolName: string
  entityType?: string | null
  entityId?: string | null
  success: boolean
  errorCode?: string | null
  idempotencyKey?: string | null
}

export function writeAudit(db: Db, entry: AuditEntry): void {
  try {
    db.insert(mcpOperationLog)
      .values({
        id: randomUUID(),
        clientId: entry.clientId,
        toolName: entry.toolName,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        success: entry.success,
        errorCode: entry.errorCode ?? null,
        idempotencyKey: entry.idempotencyKey ?? null,
        createdAt: Date.now()
      })
      .run()
  } catch (error) {
    // 审计写失败不能把一次已经完成的业务写入报成失败。
    console.error('[mcp] audit write failed', error)
  }
}

export type IdempotencyRecord = {
  requestDigest: string
  toolName: string
  entityType: string | null
  entityId: string | null
}

export function lookupIdempotency(db: Db, clientId: string, key: string): IdempotencyRecord | null {
  const row = db
    .select()
    .from(mcpIdempotency)
    .where(and(eq(mcpIdempotency.clientId, clientId), eq(mcpIdempotency.idempotencyKey, key)))
    .get()
  if (!row) return null
  return {
    requestDigest: row.requestDigest,
    toolName: row.toolName,
    entityType: row.entityType,
    entityId: row.entityId
  }
}

export function recordIdempotency(
  db: Db,
  input: {
    clientId: string
    key: string
    requestDigest: string
    toolName: string
    entityType: string | null
    entityId: string | null
  }
): void {
  db.insert(mcpIdempotency)
    .values({
      clientId: input.clientId,
      idempotencyKey: input.key,
      requestDigest: input.requestDigest,
      toolName: input.toolName,
      entityType: input.entityType,
      entityId: input.entityId,
      createdAt: Date.now()
    })
    .onConflictDoNothing()
    .run()
}

/**
 * 请求摘要：键名排序后的规范 JSON 的 sha256。
 * 只用于判断「同 key 的两次请求是否相同」，不可逆、不保留原文。
 */
export function digestParams(params: unknown): string {
  return createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}
