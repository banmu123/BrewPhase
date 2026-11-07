import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { changeLog, syncMeta } from '../schema'

/**
 * 写一条同步日志：`sync_meta` 记当前 revision，`change_log` 追加一条变更。
 * 必须与业务写入在**同一个事务**里，否则会出现「数据改了、日志没记」的洞。
 */
export function recordChange(
  db: Db,
  params: {
    deviceId: string
    entityType: string
    entityId: string
    operation: 'create' | 'update' | 'delete'
    payload?: unknown
    modifiedAt?: number
  }
): number {
  const at = params.modifiedAt ?? Date.now()
  const previous = db
    .select()
    .from(syncMeta)
    .where(and(eq(syncMeta.entityType, params.entityType), eq(syncMeta.entityId, params.entityId)))
    .get()
  const revision = (previous?.revision ?? 0) + 1

  db.insert(syncMeta)
    .values({
      entityType: params.entityType,
      entityId: params.entityId,
      revision,
      originDeviceId: params.deviceId,
      modifiedAt: at,
      operationId: crypto.randomUUID(),
      deletedAt: params.operation === 'delete' ? at : null
    })
    .onConflictDoUpdate({
      target: [syncMeta.entityType, syncMeta.entityId],
      set: {
        revision,
        modifiedAt: at,
        originDeviceId: params.deviceId,
        operationId: crypto.randomUUID(),
        deletedAt: params.operation === 'delete' ? at : null
      }
    })
    .run()

  db.insert(changeLog)
    .values({
      entityType: params.entityType,
      entityId: params.entityId,
      operation: params.operation,
      revision,
      payload: params.payload === undefined ? null : JSON.stringify(params.payload),
      deviceId: params.deviceId,
      createdAt: at
    })
    .run()

  return revision
}
