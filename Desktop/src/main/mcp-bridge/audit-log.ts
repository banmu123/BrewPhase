import { randomUUID } from 'node:crypto'
import type { Db } from '../database/client'
import { mcpOperationLog } from '../database/schema'

/**
 * 写调用的记账：审计日志 + 幂等表。
 *
 * - 审计只记「谁、用什么工具、动了哪个实体、成功与否、错误码」——不记参数、
 *   正文、token、路径（见 docs/MCP_SECURITY.md §7）。
 * - 幂等表只存请求摘要（sha256），不存参数原文。
 *
 * **幂等的存取函数已下沉到 `database/repositories/mcp-idempotency.ts`**
 * （Agent Journey 的业务事务要在同一事务里写幂等记录，业务层不能反向依赖
 * 桥接层）。这里**再导出**同一批函数，`request-router.ts` 的调用路径不变，
 * 全仓仍然只有一套幂等实现。
 */
export {
  digestParams,
  lookupIdempotency,
  recordIdempotency,
  type IdempotencyRecord
} from '../database/repositories/mcp-idempotency'

export type AuditEntry = {
  clientId: string
  toolName: string
  entityType?: string | null
  entityId?: string | null
  success: boolean
  errorCode?: string | null
  idempotencyKey?: string | null
}

/**
 * 审计写入的**底层**实现：失败就抛，成功才返回 `true`。
 *
 * 为什么要拆出来：`writeAudit` 为了「审计失败不能把已完成的业务报成失败」
 * 而吞掉异常，于是调用方拿不到任何成败信息。Remote 侧需要靠这个布尔值维护
 * 「连续失败几次」的告警，如果继续复用吞异常的版本，**失败永远会被记成成功**，
 * 设置页那个告警就成了摆设。
 *
 * 判据不只是「没抛错」：还要求 `changes === 1`。一条被 `INSERT OR IGNORE`
 * 之类语义静默丢弃的写入，在「没抛错」的判据下会被当成成功。
 */
export function writeAuditResult(db: Db, entry: AuditEntry): boolean {
  const result = db
    .insert(mcpOperationLog)
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
  return result.changes === 1
}

export function writeAudit(db: Db, entry: AuditEntry): void {
  try {
    writeAuditResult(db, entry)
  } catch (error) {
    // 审计写失败不能把一次已经完成的业务写入报成失败。
    console.error('[mcp] audit write failed', error)
  }
}
