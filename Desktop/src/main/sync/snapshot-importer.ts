import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'

/**
 * 非破坏性合并导入：iOS 快照/增量 → Desktop SQLite。
 *
 * 合并语义（见 SYNC_PROTOCOL.md §合并）：
 * - 行不存在 → 插入，记基线指纹；
 * - 行存在且本地指纹 === 来端指纹 → 跳过（内容一致）；
 * - 行存在、基线存在且基线 === 来端指纹 → 桌面端自己改过 → **冲突**，保留本地；
 * - 行存在、基线存在且基线 === 本地指纹 → 桌面端没动过，iOS 是唯一事实 → 覆盖；
 * - 行存在、无基线 → 桌面端本地创建（UUID 撞车，理论罕见）→ **冲突**。
 *
 * 删除（2026-11-07 起）带 `expectedFingerprint`（iOS 上次同步基线）：
 * - 行不存在 → 幂等跳过；
 * - 本地指纹 === expectedFingerprint → 桌面端没改过 → 允许删除；
 * - 其余（桌面端改过 / 未提供基线）→ **删除冲突**，保留桌面数据。
 *
 * 冲突只落 `sync_conflicts` 表 + 计数，绝不静默覆盖；同一实体 + 相同远端
 * 指纹 + 相同操作的未裁决冲突**去重复用**，不随反复同步膨胀。引用缺失的
 * 条目进 `failed`（带原因），不静默丢弃。整批一个事务：失败回滚。
 *
 * 指纹 = SHA-256(规范串)。规范串 = 固定字段序 + `\u001f` 分隔：
 * 字符串原样；null → `~`；布尔 → true/false；数字 → 最多 6 位小数、去尾零
 * （两端同规则，避免 1 vs 1.0 / Double 精度表达差异）。
 */

export const FIELD_SEPARATOR = '\u001f'

export function canonNumber(value: number): string {
  if (!Number.isFinite(value)) return '~'
  return String(Number(value.toFixed(6)))
}

export function canonical(fields: Array<unknown>): string {
  return fields
    .map((value) => {
      if (value === null || value === undefined) return '~'
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      if (typeof value === 'number') return canonNumber(value)
      return value
    })
    .join(FIELD_SEPARATOR)
}

export function fingerprint(canonicalString: string): string {
  return createHash('sha256').update(canonicalString, 'utf8').digest('hex')
}

export type SyncItem = { id: string; fingerprint: string; payload: Record<string, unknown> }
/** 删除意图：`expectedFingerprint` 是 iOS 上次成功同步时的基线指纹（非当前值）。 */
export type SyncDeletion = { id: string; expectedFingerprint?: string }
export type SyncBatch = {
  operations: Array<{
    entityType: EntityType
    upserts: SyncItem[]
    deletes: SyncDeletion[]
  }>
}

export type EntityType =
  | 'bean'
  | 'brew'
  | 'tasting'
  | 'phaseRule'
  | 'phaseReminder'
  | 'record'
  | 'recordTag'
  | 'recordTagLink'
  | 'canvas'
  | 'canvasNode'
  | 'canvasNote'
  | 'canvasStroke'

/** 逐条结果：iOS 按它决定基线推进，绝不能「整批 200 就全部提交」。 */
export type SyncItemResult = {
  entityType: EntityType
  id: string
  status: 'applied' | 'skipped' | 'conflict' | 'failed'
  reason?: string
}

export type ApplyResult = {
  appliedCount: number
  skippedCount: number
  conflictCount: number
  failedItems: Array<{ id: string; reason: string }>
  results: SyncItemResult[]
}

type Row = Record<string, unknown>

/** record_tag_links 复合主键的确定性实体 id：`recordId:tagId`（两端同一构造）。 */
export function recordTagLinkId(recordId: string, tagId: string): string {
  return `${recordId}:${tagId}`
}

export function parseRecordTagLinkId(id: string): { recordId: string; tagId: string } | null {
  const separator = id.indexOf(':')
  if (separator <= 0 || separator === id.length - 1) return null
  const recordId = id.slice(0, separator)
  const tagId = id.slice(separator + 1)
  if (recordId.includes(':') || tagId.includes(':')) return null
  return { recordId, tagId }
}

/** 从本地行算规范指纹（与 iOS 侧同一字段序，见 SYNC_PROTOCOL.md）。 */
export function localFingerprint(entityType: EntityType, row: Row): string | null {
  const str = (key: string): string | null => {
    const value = row[key]
    return value === null || value === undefined ? null : String(value)
  }
  const num = (key: string): number | null => {
    const value = row[key]
    return value === null || value === undefined ? null : Number(value)
  }
  const bool = (key: string): boolean => Number(row[key] ?? 0) === 1
  switch (entityType) {
    // canvasNote / canvasStroke 由 iOS 侧暂不发送；指纹未知时按 null 处理，
    // 上层会跳过基线比对，不会静默破坏现有实体的同步。
    case 'canvasNote':
    case 'canvasStroke':
      return null
    case 'bean':
      return fingerprint(
        canonical([
          str('name'), str('roaster'), str('origin'), str('process'), str('roast_level'),
          num('roast_date'), num('purchase_date'), num('open_date'),
          num('weight_g'), num('remaining_g'), num('price'), str('channel'),
          str('image_path'), str('flavor_tags_raw'), str('notes'), str('status'),
          num('stock_counted_at'), bool('is_sample')
        ])
      )
    case 'brew':
      return fingerprint(
        canonical([
          str('bean_id'), num('date'), str('method'), str('grinder'), str('grind_size'),
          num('water_temp'), num('coffee_g'), num('water_g'), num('time_seconds'),
          num('score'), num('acidity'), num('sweetness'), num('bitterness'),
          num('body'), num('aftertaste'), str('flavor_tags_raw'), str('notes'),
          num('stock_deducted_g')
        ])
      )
    case 'tasting':
      return fingerprint(
        canonical([
          str('bean_id'), str('brew_id'), num('date'), num('day_after_roast'),
          str('flavor_tags_raw'), num('score'), str('notes'), str('source')
        ])
      )
    case 'phaseRule':
      return fingerprint(
        canonical([
          str('roast_level'), num('rest_min_days'), num('rest_max_days'),
          num('peak_start_day'), num('peak_end_day'), num('decline_start_day'),
          bool('enabled')
        ])
      )
    case 'phaseReminder':
      return fingerprint(
        canonical([str('bean_id'), str('kind'), num('fire_date'), bool('enabled')])
      )
    case 'record':
      return fingerprint(
        canonical([
          str('carrier'), str('title'), str('note'), str('url_string'), str('canonical_url'),
          str('provider'), str('content_kind'), str('platform_content_id'), num('link_page'),
          str('source_name'), str('author_name'), str('summary'), str('thumbnail_url_string'),
          str('metadata_status'), num('repository_stars'), num('repository_forks'),
          num('repository_issues'), str('repository_language'), str('repository_license'),
          str('media_path'), str('preview_path'),
          bool('is_sample')
        ])
      )
    case 'recordTag':
      return fingerprint(canonical([str('name')]))
    case 'recordTagLink':
      return fingerprint(canonical([str('record_id'), str('tag_id')]))
    case 'canvas':
      return fingerprint(
        canonical([str('name'), str('note'), bool('is_sample')])
      )
    case 'canvasNode':
      return fingerprint(
        canonical([
          str('canvas_id'), str('record_id'), num('position_x'), num('position_y'),
          num('width'), num('height'), num('z_index'), str('annotation')
        ])
      )
  }
}

function readRow(sqlite: Database, table: string, id: string): Row | undefined {
  return sqlite.prepare(`select * from ${table} where id = ?`).get(id) as Row | undefined
}

function readLink(
  sqlite: Database,
  recordId: string,
  tagId: string
): { record_id: string; tag_id: string } | undefined {
  return sqlite
    .prepare('select record_id, tag_id from record_tag_links where record_id = ? and tag_id = ?')
    .get(recordId, tagId) as { record_id: string; tag_id: string } | undefined
}

/**
 * entityType → SQLite 表名的**唯一**清单。recordTagLink 是复合主键关系表，
 * 没有独立行表，走专用分支（null）。sync-service 的冲突裁决也用这份映射。
 */
export const TABLE_FOR_ENTITY: Record<EntityType, string | null> = {
  bean: 'beans',
  brew: 'brews',
  tasting: 'tastings',
  phaseRule: 'phase_rules',
  phaseReminder: 'phase_reminders',
  record: 'records',
  recordTag: 'record_tags',
  recordTagLink: null,
  canvas: 'canvases',
  canvasNode: 'canvas_nodes',
  canvasNote: 'canvas_notes',
  canvasStroke: 'canvas_strokes'
}

const BOOL_COLUMNS = new Set(['enabled', 'is_sample'])

/** payload → 列值。字段名用 iOS 侧的 camelCase，映射到 snake_case 列。 */
export function toColumns(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    const column = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase()
    if (BOOL_COLUMNS.has(column)) out[column] = value ? 1 : 0
    else out[column] = value
  }
  return out
}

function insertRow(sqlite: Database, table: string, id: string, columns: Record<string, unknown>): void {
  // 指纹**不含时间戳**（避免 iOS 触碰 updatedAt 触发假变更）。created_at 等
  // 业务时间：iOS payload 带了就用原始值（§11）；缺省或 null（旧客户端/
  // 传输异常）才补 now——NOT NULL 列必须有值，null 直接插入只会报约束失败。
  const info = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
  const filled = { ...columns }
  for (const column of info) {
    if (column.name !== 'created_at' && column.name !== 'updated_at') continue
    if (filled[column.name] === undefined || filled[column.name] === null) filled[column.name] = Date.now()
  }
  const names = ['id', ...Object.keys(filled)]
  const placeholders = names.map(() => '?').join(', ')
  sqlite
    .prepare(`insert into ${table} (${names.join(', ')}) values (${placeholders})`)
    .run(id, ...Object.values(filled))
}

/**
 * iOS 更新记录后，本地派生元数据只对「同一 URL + 仍是链接」有效。
 * URL 或载体变了 → 整行删除，旧封面绝不能挂到新链接上（Phase 3.1）。
 */
function reconcileRecordMetadata(sqlite: Database, recordId: string): void {
  sqlite
    .prepare(
      `delete from record_metadata
        where record_id = ?
          and (
            url_string <> (select url_string from records where id = ?)
            or (select carrier from records where id = ?) <> 'link'
          )`
    )
    .run(recordId, recordId, recordId)
}

export function updateRow(sqlite: Database, table: string, id: string, columns: Record<string, unknown>): void {
  const assignments = Object.keys(columns)
    .map((name) => `${name} = ?`)
    .join(', ')
  sqlite.prepare(`update ${table} set ${assignments} where id = ?`).run(...Object.values(columns), id)
}

/** 桌面接受远端内容后把基线推进到该指纹（冲突裁决「接受手机版本」也走这里）。 */
export function setBaseline(sqlite: Database, type: EntityType, id: string, fp: string): void {
  sqlite
    .prepare(
      `insert into sync_baseline (entity_type, entity_id, fingerprint, synced_at) values (?, ?, ?, ?)
       on conflict (entity_type, entity_id) do update set fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`
    )
    .run(type, id, fp, Date.now())
}

function clearBaseline(sqlite: Database, type: EntityType, id: string): void {
  sqlite.prepare('delete from sync_baseline where entity_type = ? and entity_id = ?').run(type, id)
}

function recordConflict(
  sqlite: Database,
  type: EntityType,
  id: string,
  localFp: string,
  incoming: SyncItem
): void {
  upsertConflict(sqlite, {
    type,
    id,
    localFp,
    remoteFp: incoming.fingerprint,
    remoteOperation: 'upsert',
    remotePayload: JSON.stringify(incoming.payload)
  })
}

function recordDeleteConflict(
  sqlite: Database,
  type: EntityType,
  id: string,
  localFp: string | null,
  expectedFingerprint: string | null
): void {
  upsertConflict(sqlite, {
    type,
    id,
    localFp: localFp ?? '~',
    remoteFp: expectedFingerprint ?? '~',
    remoteOperation: 'delete',
    remotePayload: '{}'
  })
}

type ConflictRow = {
  type: EntityType
  id: string
  localFp: string
  remoteFp: string
  remoteOperation: 'upsert' | 'delete'
  remotePayload: string
}

/**
 * 落冲突，**先去重**（§7.3）：同一实体 + 相同远端指纹 + 相同操作的未裁决
 * 冲突只保留一条；远端内容再变（指纹不同）时正常新增。
 */
function upsertConflict(sqlite: Database, conflict: ConflictRow): void {
  const duplicate = sqlite
    .prepare(
      `select id from sync_conflicts
       where entity_type = ? and entity_id = ? and remote_fingerprint = ? and remote_operation = ?`
    )
    .get(conflict.type, conflict.id, conflict.remoteFp, conflict.remoteOperation) as
    | { id: string }
    | undefined
  if (duplicate) return
  sqlite
    .prepare(
      `insert into sync_conflicts (id, entity_type, entity_id, local_fingerprint, remote_fingerprint, remote_payload, remote_operation, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cryptoId(), conflict.type, conflict.id, conflict.localFp,
      conflict.remoteFp, conflict.remotePayload, conflict.remoteOperation, Date.now()
    )
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID()
}

export function applyBatch(sqlite: Database, batch: SyncBatch, sourceDeviceId: string): ApplyResult {
  const result: ApplyResult = { appliedCount: 0, skippedCount: 0, conflictCount: 0, failedItems: [], results: [] }
  const mark = (item: SyncItemResult): void => {
    if (item.status === 'failed') {
      // 排障：真机同步失败的每条原因必须可见（2026-11-07 真机 52 条全败取证）。
      console.error(`[sync] failed ${item.entityType} ${item.id}: ${item.reason ?? 'unknown'}`)
    }
    result.results.push(item)
    switch (item.status) {
      case 'applied': result.appliedCount += 1; break
      case 'skipped': result.skippedCount += 1; break
      case 'conflict': result.conflictCount += 1; break
      case 'failed':
        result.failedItems.push({ id: item.id, reason: item.reason ?? 'failed' })
        break
    }
  }

  const run = sqlite.transaction(() => {
    for (const operation of batch.operations) {
      if (operation.entityType === 'recordTagLink') {
        applyTagLinkOperation(sqlite, operation, sourceDeviceId, mark)
        continue
      }
      const table = TABLE_FOR_ENTITY[operation.entityType]
      if (!table) {
        mark({ entityType: operation.entityType, id: '*', status: 'failed', reason: `unknown entity type ${operation.entityType}` })
        continue
      }

      // 依赖顺序由调用方保证（批次内 entities 顺序）；引用检查在这里显式做，
      // 让「引用缺失」成为可读的失败项而不是外键异常。
      for (const upsert of operation.upserts) {
        try {
          applyUpsert(sqlite, operation.entityType, table, upsert, sourceDeviceId, mark)
        } catch (error) {
          mark({ entityType: operation.entityType, id: upsert.id, status: 'failed', reason: (error as Error).message })
        }
      }

      for (const deletion of operation.deletes) {
        try {
          applyDeletion(sqlite, operation.entityType, table, deletion, sourceDeviceId, mark)
        } catch (error) {
          mark({ entityType: operation.entityType, id: deletion.id, status: 'failed', reason: (error as Error).message })
        }
      }
    }
  })

  try {
    run()
  } catch (error) {
    // 事务级失败：整批回滚（better-sqlite3 的 transaction 已处理回滚），
    // 这里把失败转成可报告项而不是让服务 500。
    result.results = []
    result.appliedCount = 0
    result.skippedCount = 0
    result.conflictCount = 0
    mark({
      entityType: batch.operations[0]?.entityType ?? 'bean',
      id: '*',
      status: 'failed',
      reason: (error as Error).message
    })
  }
  return result
}

/** 单条 upsert 的四态合并。PhaseRule 先做自然标识映射，再走同一套检测。 */
function applyUpsert(
  sqlite: Database,
  entityType: EntityType,
  table: string,
  upsert: SyncItem,
  sourceDeviceId: string,
  mark: (item: SyncItemResult) => void
): void {
  let targetId = upsert.id
  let existing = readRow(sqlite, table, targetId)

  // PhaseRule 特例：两端默认规则 UUID 各自生成，roastLevel 是自然标识。
  // 命中既有规则后**必须走同一套冲突检测**（2026-11-07 修复：旧实现直接
  // 覆盖并把基线记到 iOS UUID 上，基线与行错位，冲突检测从此失效）。
  if (!existing && entityType === 'phaseRule') {
    const matched = phaseRuleIdByRoastLevel(sqlite, toColumns(upsert.payload))
    if (matched) targetId = matched
    existing = matched ? readRow(sqlite, table, matched) : undefined
  }

  if (!existing) {
    insertRow(sqlite, table, targetId, toColumns(upsert.payload))
    setBaseline(sqlite, entityType, targetId, upsert.fingerprint)
    logChange(sqlite, entityType, targetId, 'upsert', sourceDeviceId)
    mark({ entityType, id: upsert.id, status: 'applied' })
    return
  }

  // 用户已裁决「保留电脑版本」的远端指纹：重复推送直接 skipped（§7）。
  // 不写桌面基线（桌面基线保持 = 本地指纹），iOS 端按 skipped 收敛自己的
  // 基线；iOS 之后产生**新**指纹时正常重新参与合并。
  const rejected = sqlite
    .prepare('select 1 from sync_rejected where entity_type = ? and entity_id = ? and fingerprint = ?')
    .get(entityType, targetId, upsert.fingerprint)
  if (rejected) {
    mark({ entityType, id: upsert.id, status: 'skipped', reason: 'kept desktop version by resolution' })
    return
  }

  const localFp = localFingerprint(entityType, existing)
  if (localFp === upsert.fingerprint) {
    setBaseline(sqlite, entityType, targetId, upsert.fingerprint)
    mark({ entityType, id: upsert.id, status: 'skipped' })
    return
  }

  const baseline = sqlite
    .prepare('select fingerprint from sync_baseline where entity_type = ? and entity_id = ?')
    .get(entityType, targetId) as { fingerprint: string } | undefined

  if (baseline && baseline.fingerprint === localFp) {
    // 桌面端没改过：iOS 是该实体的唯一事实来源。
    if (entityType === 'phaseRule') {
      updateRow(sqlite, 'phase_rules', targetId, toColumns(upsert.payload))
    } else {
      updateRow(sqlite, table, targetId, toColumns(upsert.payload))
    }
    if (entityType === 'record') reconcileRecordMetadata(sqlite, targetId)
    setBaseline(sqlite, entityType, targetId, upsert.fingerprint)
    logChange(sqlite, entityType, targetId, 'upsert', sourceDeviceId)
    mark({ entityType, id: upsert.id, status: 'applied' })
    return
  }

  if (baseline && baseline.fingerprint === upsert.fingerprint) {
    // iOS 没改、桌面端改了：保留本地，落冲突。
    recordConflict(sqlite, entityType, targetId, localFp ?? '~', upsert)
    mark({ entityType, id: upsert.id, status: 'conflict', reason: 'desktop has local changes' })
    return
  }

  // 两端都改过 / 无基线：不静默覆盖。
  recordConflict(sqlite, entityType, targetId, localFp ?? '~', upsert)
  mark({ entityType, id: upsert.id, status: 'conflict', reason: 'both sides changed' })
}

/**
 * 单条删除的冲突保护（§6）。`expectedFingerprint` 缺失或与本地不符时
 * 一律保留桌面数据并落删除冲突，绝不静默删除。
 */
function applyDeletion(
  sqlite: Database,
  entityType: EntityType,
  table: string,
  deletion: SyncDeletion,
  sourceDeviceId: string,
  mark: (item: SyncItemResult) => void
): void {
  const existing = readRow(sqlite, table, deletion.id)
  if (!existing) {
    // 幂等：已经不存在（上次删过或两端都没有）。
    clearBaseline(sqlite, entityType, deletion.id)
    mark({ entityType, id: deletion.id, status: 'skipped' })
    return
  }
  const localFp = localFingerprint(entityType, existing)
  if (deletion.expectedFingerprint && localFp === deletion.expectedFingerprint) {
    sqlite.prepare(`delete from ${table} where id = ?`).run(deletion.id)
    clearBaseline(sqlite, entityType, deletion.id)
    logChange(sqlite, entityType, deletion.id, 'delete', sourceDeviceId)
    mark({ entityType, id: deletion.id, status: 'applied' })
    return
  }
  // 用户已裁决「保留电脑版本」的删除：同基线的重复删除直接收敛（§7）。
  const rejected = deletion.expectedFingerprint
    ? sqlite
        .prepare('select 1 from sync_rejected where entity_type = ? and entity_id = ? and fingerprint = ?')
        .get(entityType, deletion.id, deletion.expectedFingerprint)
    : undefined
  if (rejected) {
    clearBaseline(sqlite, entityType, deletion.id)
    mark({ entityType, id: deletion.id, status: 'skipped', reason: 'kept desktop version by resolution' })
    return
  }
  // 桌面端改过 / iOS 没给基线：进删除冲突队列，桌面数据原样保留。
  recordDeleteConflict(sqlite, entityType, deletion.id, localFp, deletion.expectedFingerprint ?? null)
  mark({
    entityType, id: deletion.id, status: 'conflict',
    reason: deletion.expectedFingerprint ? 'desktop has local changes' : 'delete without baseline fingerprint'
  })
}

/** record_tag_links 复合主键的专用路径，不复用 readRow/insertRow。 */
function applyTagLinkOperation(
  sqlite: Database,
  operation: { upserts: SyncItem[]; deletes: SyncDeletion[] },
  sourceDeviceId: string,
  mark: (item: SyncItemResult) => void
): void {
  for (const upsert of operation.upserts) {
    try {
      const recordId = String(upsert.payload.recordId ?? '')
      const tagId = String(upsert.payload.tagId ?? '')
      if (!recordId || !tagId || recordTagLinkId(recordId, tagId) !== upsert.id) {
        mark({ entityType: 'recordTagLink', id: upsert.id, status: 'failed', reason: 'malformed recordTagLink payload' })
        continue
      }
      // 依赖顺序：record 与 tag 必须已存在，否则进 failed 等下一轮重试。
      const recordExists = readRow(sqlite, 'records', recordId)
      const tagExists = readRow(sqlite, 'record_tags', tagId)
      if (!recordExists || !tagExists) {
        mark({
          entityType: 'recordTagLink', id: upsert.id, status: 'failed',
          reason: !recordExists ? `missing record ${recordId}` : `missing tag ${tagId}`
        })
        continue
      }
      const existing = readLink(sqlite, recordId, tagId)
      if (existing) {
        setBaseline(sqlite, 'recordTagLink', upsert.id, upsert.fingerprint)
        mark({ entityType: 'recordTagLink', id: upsert.id, status: 'skipped' })
        continue
      }
      sqlite
        .prepare('insert into record_tag_links (record_id, tag_id) values (?, ?)')
        .run(recordId, tagId)
      setBaseline(sqlite, 'recordTagLink', upsert.id, upsert.fingerprint)
      logChange(sqlite, 'recordTagLink', upsert.id, 'upsert', sourceDeviceId)
      mark({ entityType: 'recordTagLink', id: upsert.id, status: 'applied' })
    } catch (error) {
      mark({ entityType: 'recordTagLink', id: upsert.id, status: 'failed', reason: (error as Error).message })
    }
  }

  for (const deletion of operation.deletes) {
    try {
      const parsed = parseRecordTagLinkId(deletion.id)
      if (!parsed) {
        mark({ entityType: 'recordTagLink', id: deletion.id, status: 'failed', reason: 'malformed recordTagLink id' })
        continue
      }
      const existing = readLink(sqlite, parsed.recordId, parsed.tagId)
      if (!existing) {
        clearBaseline(sqlite, 'recordTagLink', deletion.id)
        mark({ entityType: 'recordTagLink', id: deletion.id, status: 'skipped' })
        continue
      }
      // 关系行内容只有两个 id，本地指纹恒等于 expected——正常路径都能删。
      sqlite
        .prepare('delete from record_tag_links where record_id = ? and tag_id = ?')
        .run(parsed.recordId, parsed.tagId)
      clearBaseline(sqlite, 'recordTagLink', deletion.id)
      logChange(sqlite, 'recordTagLink', deletion.id, 'delete', '*')
      mark({ entityType: 'recordTagLink', id: deletion.id, status: 'applied' })
    } catch (error) {
      mark({ entityType: 'recordTagLink', id: deletion.id, status: 'failed', reason: (error as Error).message })
    }
  }
}

/** 找同一烘焙度的既有规则 id；没有返回 null。 */
function phaseRuleIdByRoastLevel(sqlite: Database, columns: Record<string, unknown>): string | null {
  const roastLevel = String(columns.roast_level ?? '')
  const existing = sqlite
    .prepare('select id from phase_rules where roast_level = ? limit 1')
    .get(roastLevel) as { id: string } | undefined
  return existing?.id ?? null
}

function logChange(sqlite: Database, type: EntityType, id: string, operation: string, deviceId: string): void {
  sqlite
    .prepare(
      `insert into change_log (entity_type, entity_id, operation, revision, device_id, created_at)
       values (?, ?, ?, 1, ?, ?)`
    )
    .run(type, id, operation, deviceId, Date.now())
}
