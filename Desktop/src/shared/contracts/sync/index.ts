import { z } from 'zod'
import { SYNC_PROTOCOL_VERSION } from '../version'

/**
 * 局域网同步协议 v1 —— **只有结构，没有传输实现**（Phase 1 的范围）。
 *
 * 设计要点（完整说明见 docs/SYNC_PROTOCOL.md）：
 * 1. 不依赖云、不需要账号；Desktop 是 Host，iOS 是配对客户端。
 * 2. 一次性配对码 + 交换设备凭据；之后每个请求带 Bearer token。
 * 3. 每个写操作产生一条 change log（Outbox），增量同步按 revision 拉取。
 * 4. 删除是 tombstone，不是「查不到」。
 * 5. 冲突不静默覆盖：同一实体两端都改过时上报，由用户选择或按规则合并。
 */

export const ENTITY_TYPES = ['bean', 'brew', 'tasting', 'phaseRule', 'phaseReminder', 'record', 'recordTag', 'canvas', 'canvasNode'] as const
export const entityTypeSchema = z.enum(ENTITY_TYPES)
export type EntityType = z.infer<typeof entityTypeSchema>

/** 每条可同步数据都带的元数据。与业务字段分开存（`sync_meta` 表）。 */
export const syncMetaSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
  /** 单调递增，每次本地写入 +1。 */
  revision: z.number().int().min(1),
  originDeviceId: z.string().min(1),
  modifiedAt: z.number().int(),
  /** 造成这次修改的客户端操作 id：重试时可幂等去重。 */
  operationId: z.string().uuid(),
  /** 非 null 表示已删除（tombstone）。 */
  deletedAt: z.number().int().nullable()
})
export type SyncMeta = z.infer<typeof syncMetaSchema>

export const changeLogEntrySchema = syncMetaSchema.extend({
  payload: z.string().nullable()
})
export type ChangeLogEntry = z.infer<typeof changeLogEntrySchema>

/** 二维码里放的东西。故意不含 token 之外的身份信息，扫码即用、过期即废。 */
export const pairingPayloadSchema = z.object({
  v: z.literal(SYNC_PROTOCOL_VERSION),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  /** 一次性配对码；服务端只保存它的哈希，且 2 分钟内有效、用过即作废。 */
  pairingCode: z.string().min(6),
  expiresAt: z.number().int()
})
export type PairingPayload = z.infer<typeof pairingPayloadSchema>

export const pairRequestSchema = z.object({
  v: z.literal(SYNC_PROTOCOL_VERSION),
  pairingCode: z.string().min(6),
  clientDeviceId: z.string().min(1),
  clientDeviceName: z.string().min(1),
  /** 客户端长期身份公钥（Ed25519），用于之后重新握手。 */
  clientPublicKey: z.string().min(1)
})
export type PairRequest = z.infer<typeof pairRequestSchema>

export const pairResponseSchema = z.object({
  v: z.literal(SYNC_PROTOCOL_VERSION),
  serverDeviceId: z.string().min(1),
  serverDeviceName: z.string().min(1),
  /** Bearer token，客户端存钥匙串；服务端只存哈希。 */
  accessToken: z.string().min(24),
  serverPublicKey: z.string().min(1),
  expiresAt: z.number().int()
})
export type PairResponse = z.infer<typeof pairResponseSchema>

export const SYNC_ERRORS = [
  'unauthorized',
  'pairing_expired',
  'pairing_used',
  'protocol_mismatch',
  'conflict',
  'payload_too_large',
  'internal'
] as const
export type SyncError = (typeof SYNC_ERRORS)[number]

/** 客户端每次请求都带这四个头（参考 BrewPing 的防重放设计）。 */
export const syncRequestHeadersSchema = z.object({
  authorization: z.string().startsWith('Bearer '),
  'x-device-id': z.string().min(1),
  'x-timestamp': z.string().regex(/^\d+$/),
  'x-nonce': z.string().min(16),
  'x-signature': z.string().min(16)
})
export type SyncRequestHeaders = z.infer<typeof syncRequestHeadersSchema>

export const snapshotRequestSchema = z.object({ sinceRevision: z.number().int().min(0).default(0) })

/** 全量快照：一份 JSON + 媒体清单（媒体本体按块拉，逐块 SHA-256 校验）。 */
export const snapshotFrameSchema = z.object({
  v: z.literal(SYNC_PROTOCOL_VERSION),
  generatedAt: z.number().int(),
  entities: z.record(entityTypeSchema, z.array(z.unknown())),
  media: z.array(z.object({
    fileName: z.string(),
    sha256: z.string(),
    byteSize: z.number().int()
  }))
})
export type SnapshotFrame = z.infer<typeof snapshotFrameSchema>

/** 冲突：两端都改过同一条实体，交给用户决定，不做 last-write-wins。 */
export const conflictSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
  localRevision: z.number().int(),
  remoteRevision: z.number().int(),
  localModifiedAt: z.number().int(),
  remoteModifiedAt: z.number().int(),
  resolution: z.enum(['keepLocal', 'keepRemote', 'mergeLater']).nullable().default(null)
})
export type Conflict = z.infer<typeof conflictSchema>

// ===== Phase 2：传输实现落地后的界面与结果类型 =====

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
