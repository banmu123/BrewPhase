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
 * 冲突只落 `sync_conflicts` 表 + 计数，绝不静默覆盖。引用缺失的条目进
 * `failed`（带原因），不静默丢弃。整批一个事务：失败回滚，不留半批状态。
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
export type SyncBatch = {
  operations: Array<{
    entityType: EntityType
    upserts: SyncItem[]
    deletes: Array<{ id: string }>
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
  | 'canvas'
  | 'canvasNode'

export type ApplyResult = {
  appliedCount: number
  skippedCount: number
  conflictCount: number
  failedItems: Array<{ id: string; reason: string }>
}

type Row = Record<string, unknown>

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
          bool('is_sample')
        ])
      )
    case 'recordTag':
      return fingerprint(canonical([str('name')]))
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

const TABLES: Record<EntityType, string> = {
  bean: 'beans',
  brew: 'brews',
  tasting: 'tastings',
  phaseRule: 'phase_rules',
  phaseReminder: 'phase_reminders',
  record: 'records',
  recordTag: 'record_tags',
  canvas: 'canvases',
  canvasNode: 'canvas_nodes'
}

const TEXT_COLUMNS = new Set([
  'name', 'roaster', 'origin', 'process', 'roast_level', 'channel', 'image_path',
  'flavor_tags_raw', 'notes', 'status', 'method', 'grinder', 'grind_size',
  'source', 'kind', 'carrier', 'title', 'note', 'url_string', 'canonical_url',
  'provider', 'content_kind', 'platform_content_id', 'source_name', 'author_name',
  'summary', 'preview_path', 'media_path', 'thumbnail_url_string', 'metadata_status',
  'repository_language', 'repository_license', 'canvas_id', 'record_id', 'bean_id',
  'brew_id', 'tag_id', 'record_id', 'annotation'
])
const BOOL_COLUMNS = new Set(['enabled', 'is_sample'])

/** payload → 列值。字段名用 iOS 侧的 camelCase，映射到 snake_case 列。 */
function toColumns(payload: Record<string, unknown>): Record<string, unknown> {
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
  // 指纹**不含时间戳**（避免 iOS 触碰 updatedAt 触发假变更），落库时补默认值。
  const info = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
  const filled = { ...columns }
  for (const column of info) {
    if (column.name !== 'created_at' && column.name !== 'updated_at') continue
    if (filled[column.name] === undefined) filled[column.name] = Date.now()
  }
  const names = ['id', ...Object.keys(filled)]
  const placeholders = names.map(() => '?').join(', ')
  sqlite
    .prepare(`insert into ${table} (${names.join(', ')}) values (${placeholders})`)
    .run(id, ...Object.values(filled))
}

function updateRow(sqlite: Database, table: string, id: string, columns: Record<string, unknown>): void {
  const assignments = Object.keys(columns)
    .map((name) => `${name} = ?`)
    .join(', ')
  sqlite.prepare(`update ${table} set ${assignments} where id = ?`).run(...Object.values(columns), id)
}

function setBaseline(sqlite: Database, type: EntityType, id: string, fp: string): void {
  sqlite
    .prepare(
      `insert into sync_baseline (entity_type, entity_id, fingerprint, synced_at) values (?, ?, ?, ?)
       on conflict (entity_type, entity_id) do update set fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`
    )
    .run(type, id, fp, Date.now())
}

function recordConflict(
  sqlite: Database,
  type: EntityType,
  id: string,
  localFp: string,
  incoming: SyncItem
): void {
  sqlite
    .prepare(
      `insert into sync_conflicts (id, entity_type, entity_id, local_fingerprint, remote_fingerprint, remote_payload, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cryptoId(), type, id, localFp, incoming.fingerprint,
      JSON.stringify(incoming.payload), Date.now()
    )
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID()
}

export function applyBatch(sqlite: Database, batch: SyncBatch, sourceDeviceId: string): ApplyResult {
  const result: ApplyResult = { appliedCount: 0, skippedCount: 0, conflictCount: 0, failedItems: [] }

  const run = sqlite.transaction(() => {
    for (const operation of batch.operations) {
      const table = TABLES[operation.entityType]
      if (!table) {
        result.failedItems.push({ id: '*', reason: `unknown entity type ${operation.entityType}` })
        continue
      }

      // 依赖顺序由调用方保证（批次内 entities 顺序）；引用检查在这里显式做，
      // 让「引用缺失」成为可读的失败项而不是外键异常。
      for (const upsert of operation.upserts) {
        try {
          const existing = readRow(sqlite, table, upsert.id)
          if (!existing) {
            // PhaseRule 特殊：按 roastLevel 匹配（两端默认规则 UUID 各自生成），
            // 同一烘焙度只保留一份有效规则——包括「id 不存在」的首次导入。
            if (operation.entityType === 'phaseRule') {
              const matched = phaseRuleIdByRoastLevel(sqlite, toColumns(upsert.payload))
              if (matched) {
                updateRow(sqlite, 'phase_rules', matched, toColumns(upsert.payload))
                setBaseline(sqlite, operation.entityType, upsert.id, upsert.fingerprint)
                logChange(sqlite, operation.entityType, matched, 'upsert', sourceDeviceId)
                result.appliedCount += 1
                continue
              }
            }
            const columns = toColumns(upsert.payload)
            insertRow(sqlite, table, upsert.id, columns)
            setBaseline(sqlite, operation.entityType, upsert.id, upsert.fingerprint)
            logChange(sqlite, operation.entityType, upsert.id, 'upsert', sourceDeviceId)
            result.appliedCount += 1
            continue
          }

          const localFp = localFingerprint(operation.entityType, existing)
          if (localFp === upsert.fingerprint) {
            setBaseline(sqlite, operation.entityType, upsert.id, upsert.fingerprint)
            result.skippedCount += 1
            continue
          }
          const baseline = sqlite
            .prepare('select fingerprint from sync_baseline where entity_type = ? and entity_id = ?')
            .get(operation.entityType, upsert.id) as { fingerprint: string } | undefined

          if (baseline && baseline.fingerprint === localFp) {
            // 桌面端没改过：iOS 是该实体的唯一事实来源。
            if (operation.entityType === 'phaseRule') {
              applyPhaseRule(sqlite, upsert)
            } else {
              updateRow(sqlite, table, upsert.id, toColumns(upsert.payload))
            }
            setBaseline(sqlite, operation.entityType, upsert.id, upsert.fingerprint)
            logChange(sqlite, operation.entityType, upsert.id, 'upsert', sourceDeviceId)
            result.appliedCount += 1
            continue
          }

          if (baseline && baseline.fingerprint === upsert.fingerprint) {
            // iOS 没改、桌面端改了：保留本地，落冲突。
            recordConflict(sqlite, operation.entityType, upsert.id, localFp ?? '~', upsert)
            result.conflictCount += 1
            continue
          }

          // 两端都改过 / 无基线：不静默覆盖。
          recordConflict(sqlite, operation.entityType, upsert.id, localFp ?? '~', upsert)
          result.conflictCount += 1
        } catch (error) {
          result.failedItems.push({ id: upsert.id, reason: (error as Error).message })
        }
      }

      for (const deletion of operation.deletes) {
        try {
          const existing = readRow(sqlite, table, deletion.id)
          if (!existing) {
            result.skippedCount += 1
            continue
          }
          sqlite.prepare(`delete from ${table} where id = ?`).run(deletion.id)
          sqlite
            .prepare('delete from sync_baseline where entity_type = ? and entity_id = ?')
            .run(operation.entityType, deletion.id)
          logChange(sqlite, operation.entityType, deletion.id, 'delete', sourceDeviceId)
          result.appliedCount += 1
        } catch (error) {
          result.failedItems.push({ id: deletion.id, reason: (error as Error).message })
        }
      }
    }
  })

  try {
    run()
  } catch (error) {
    // 事务级失败：整批回滚（better-sqlite3 的 transaction 已处理回滚），
    // 这里把失败转成可报告项而不是让服务 500。
    result.failedItems.push({ id: '*', reason: (error as Error).message })
  }
  return result
}

/** 找同一烘焙度的既有规则 id；没有返回 null。 */
function phaseRuleIdByRoastLevel(sqlite: Database, columns: Record<string, unknown>): string | null {
  const roastLevel = String(columns.roast_level ?? '')
  const existing = sqlite
    .prepare('select id from phase_rules where roast_level = ? limit 1')
    .get(roastLevel) as { id: string } | undefined
  return existing?.id ?? null
}

/** PhaseRule 更新路径：按 roastLevel 找到行就原位更新，找不到才按 id 更新/插入。 */
function applyPhaseRule(sqlite: Database, upsert: SyncItem): void {
  const columns = toColumns(upsert.payload)
  const matched = phaseRuleIdByRoastLevel(sqlite, columns)
  if (matched && matched !== upsert.id) {
    updateRow(sqlite, 'phase_rules', matched, columns)
    return
  }
  updateRow(sqlite, 'phase_rules', upsert.id, columns)
}

function logChange(sqlite: Database, type: EntityType, id: string, operation: string, deviceId: string): void {
  sqlite
    .prepare(
      `insert into change_log (entity_type, entity_id, operation, revision, device_id, created_at)
       values (?, ?, ?, 1, ?, ?)`
    )
    .run(type, id, operation, deviceId, Date.now())
}
