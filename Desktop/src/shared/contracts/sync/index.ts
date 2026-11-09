/**
 * 同步链路的 **UI 类型**（设置页展示用）。
 *
 * 协议的传输结构（SyncBatch / SyncItemResult / ApplyResult / EntityType、
 * entity→表映射、指纹 canonical 规则）由实现持有：`snapshot-importer.ts`
 * 是桌面端唯一的协议实现，iOS 端镜像在 BrewPhase/Sync/。这里不再维护第二份
 * protocol schema——曾经的 11 个 zod schema 与两端实现漂移（pairRequestSchema
 * 声称的 clientPublicKey 从未实现、snapshotFrameSchema 的 fileName 实际叫
 * name），且运行时零消费者，已于 2026-11-09 删除；协议真相以
 * docs/SYNC_PROTOCOL.md + 两端实现为准。
 */

export type SyncStatus = {
  enabled: boolean
  running: boolean
  port: number | null
  addresses: string[]
  desktopDeviceId: string
  desktopDeviceName: string
  pairing: { qrText: string; qrDataUrl: string; expiresAt: number } | null
  devices: Array<{ id: string; name: string; pairedAt: number; lastSyncAt: number | null }>
  conflicts: number
}

export type SyncConflictItem = {
  id: string
  entityType: string
  entityId: string
  localFingerprint: string
  remoteFingerprint: string
  /** 'upsert' = 远端内容冲突；'delete' = 手机删除 vs 电脑改动（§6.2）。 */
  remoteOperation: 'upsert' | 'delete'
  createdAt: number
  remoteSummary: string
}

/**
 * 清空同步实体的结果。计数只用于给用户一句「清掉了什么」，
 * 不是对账依据——真正的权威是清空之后重新读库。
 */
export type WipeResult = {
  records: number
  tags: number
  canvases: number
  beans: number
  brews: number
  tastings: number
  mediaFiles: number
}
