import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { mcpIdempotency } from '../schema'

/**
 * MCP **请求级**幂等的持久化（基础设施 / Repository 层）。
 *
 * ## 为什么放在这一层
 *
 * 原先这些函数住在 `mcp-bridge/audit-log.ts`，但 `mcp-bridge` 是 **Local 桥接层**
 * 的专属策略（认证、审计规则、`sync_status`）。Agent Journey 的 Application
 * Service 需要在**业务事务内**原子写入同一条幂等记录，业务层反向依赖桥接层
 * 会把 Local 专属策略拖进领域层。
 *
 * 因此能力下沉到这里，`mcp-bridge/audit-log.ts` 改为**再导出**同一批函数：
 * `request-router.ts` 的查询与写入路径行为完全不变，**全仓只有一套幂等实现**
 * （同一张表、同一组函数），不存在两套互不兼容的逻辑。
 *
 * ## 职责边界（R6-1 设计约束 §19.2）
 *
 * - 本模块只负责**存取**：不判断重放语义、不决定业务结果；
 * - 「同 key 同摘要 → 回放 / 同 key 异摘要 → `IDEMPOTENCY_KEY_REUSE`」的判定
 *   由调用方（`request-router` 的 replay 钩子、`AgentJourneyService` 的事务）做；
 * - `requestDigest` 必须来自 **`executeTool` 经 Zod 解析后的完整参数**
 *   （含 `idempotency_key`），调用方不得用残缺的业务字段重新拼接。
 */

export type IdempotencyRecord = {
  requestDigest: string
  toolName: string
  entityType: string | null
  entityId: string | null
}

/** 按 `(client_id, idempotency_key)` 查一条幂等记录；没有则 null。 */
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

/**
 * 写入一条幂等记录。
 *
 * `onConflictDoNothing`：并发/重复写入以「先到者」为准，后来者静默让路——
 * 与「同 key 同摘要回放」语义一致。**调用方负责在业务事务内调用它**，
 * 这样「业务数据已写、幂等记录没写」的崩溃窗口不存在。
 */
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
