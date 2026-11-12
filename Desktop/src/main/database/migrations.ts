import type { Database } from 'better-sqlite3'

/**
 * 迁移是**数组 + user_version**，不是一坨 `.sql` 文件。
 *
 * 理由：打包后的应用里读不到源码目录里的 SQL 文件（asar 里路径会变），而
 * 迁移失败必须让应用停在可控状态。DDL 内联成字符串，谁在什么时候加了一版
 * 一目了然，也不依赖 drizzle-kit 的 journal 文件是否被打进包里。
 *
 * 规则：只追加，不修改已发布的版本；改表 = 新加一版。
 */
export type Migration = { version: number; name: string; sql: string }

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS beans (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  roaster TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  process TEXT NOT NULL DEFAULT '',
  roast_level TEXT NOT NULL DEFAULT 'medium',
  roast_date INTEGER,
  purchase_date INTEGER,
  open_date INTEGER,
  weight_g REAL NOT NULL DEFAULT 0,
  remaining_g REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  flavor_tags_raw TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  stock_counted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS beans_updated_at_idx ON beans (updated_at);

CREATE TABLE IF NOT EXISTS brews (
  id TEXT PRIMARY KEY NOT NULL,
  bean_id TEXT NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
  date INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  grinder TEXT NOT NULL DEFAULT '',
  grind_size TEXT NOT NULL DEFAULT '',
  water_temp REAL NOT NULL DEFAULT 0,
  coffee_g REAL NOT NULL DEFAULT 0,
  water_g REAL NOT NULL DEFAULT 0,
  time_seconds INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  acidity INTEGER NOT NULL DEFAULT 0,
  sweetness INTEGER NOT NULL DEFAULT 0,
  bitterness INTEGER NOT NULL DEFAULT 0,
  body INTEGER NOT NULL DEFAULT 0,
  aftertaste INTEGER NOT NULL DEFAULT 0,
  flavor_tags_raw TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  stock_deducted_g REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS brews_bean_idx ON brews (bean_id, date);

CREATE TABLE IF NOT EXISTS tastings (
  id TEXT PRIMARY KEY NOT NULL,
  bean_id TEXT NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
  brew_id TEXT,
  date INTEGER NOT NULL,
  day_after_roast INTEGER NOT NULL DEFAULT 0,
  flavor_tags_raw TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tastings_bean_idx ON tastings (bean_id, date);

CREATE TABLE IF NOT EXISTS phase_rules (
  id TEXT PRIMARY KEY NOT NULL,
  roast_level TEXT NOT NULL,
  rest_min_days INTEGER NOT NULL DEFAULT 2,
  rest_max_days INTEGER NOT NULL DEFAULT 5,
  peak_start_day INTEGER NOT NULL DEFAULT 5,
  peak_end_day INTEGER NOT NULL DEFAULT 21,
  decline_start_day INTEGER NOT NULL DEFAULT 21,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  bean_id TEXT NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  fire_date INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_bean_idx ON phase_reminders (bean_id);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY NOT NULL,
  carrier TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  url_string TEXT NOT NULL DEFAULT '',
  canonical_url TEXT,
  provider TEXT NOT NULL DEFAULT 'generic',
  platform_content_id TEXT,
  source_name TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  media_path TEXT,
  preview_path TEXT,
  thumbnail_url_string TEXT,
  metadata_status TEXT NOT NULL DEFAULT 'idle',
  repository_stars INTEGER,
  repository_forks INTEGER,
  repository_language TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_created_idx ON records (created_at);
CREATE INDEX IF NOT EXISTS records_carrier_idx ON records (carrier);

CREATE TABLE IF NOT EXISTS record_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS record_tags_name_idx ON record_tags (name);

CREATE TABLE IF NOT EXISTS record_tag_links (
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES record_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (record_id, tag_id)
);

CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canvas_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 240,
  height REAL NOT NULL DEFAULT 180,
  z_index INTEGER NOT NULL DEFAULT 0,
  annotation TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_canvas_idx ON canvas_nodes (canvas_id);
CREATE INDEX IF NOT EXISTS nodes_record_idx ON canvas_nodes (record_id);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_canvas_record_idx ON canvas_nodes (canvas_id, record_id);

CREATE TABLE IF NOT EXISTS canvas_strokes (
  id TEXT PRIMARY KEY NOT NULL,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  tool_type TEXT NOT NULL DEFAULT 'pen',
  points TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT '#3b2b22',
  width REAL NOT NULL DEFAULT 2,
  opacity REAL NOT NULL DEFAULT 1,
  z_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS strokes_canvas_idx ON canvas_strokes (canvas_id);

CREATE TABLE IF NOT EXISTS sync_meta (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  origin_device_id TEXT NOT NULL,
  modified_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS sync_meta_rev_idx ON sync_meta (revision);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_entity_idx ON change_log (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  public_key TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_token_idx ON devices (token_hash);

CREATE TABLE IF NOT EXISTS local_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`

const SYNC_ALIGN_SQL = `
-- 002：对齐 iOS 真实模型（Phase 2），全部为追加变更，不改历史列。
ALTER TABLE beans ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canvases ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN content_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN link_page INTEGER NOT NULL DEFAULT 1;
ALTER TABLE records ADD COLUMN repository_issues INTEGER;
ALTER TABLE records ADD COLUMN repository_license TEXT;
ALTER TABLE devices ADD COLUMN last_sync_at INTEGER;

-- 每实体同步基线：内容指纹（SHA-256），Brew/Tasting 没有 updatedAt，靠它判变更。
CREATE TABLE IF NOT EXISTS sync_baseline (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- 两端同 UUID 不同内容：先落冲突表，绝不静默覆盖。
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_fingerprint TEXT NOT NULL,
  remote_fingerprint TEXT NOT NULL,
  remote_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_conflicts_entity_idx ON sync_conflicts (entity_type, entity_id);
`

const CONFLICT_DELETE_OP_SQL = `
-- 003：冲突记录区分「远端更新」与「远端删除」（§6.2 删除冲突保护）。
-- 旧行按默认 'upsert' 读取，语义不变。
ALTER TABLE sync_conflicts ADD COLUMN remote_operation TEXT NOT NULL DEFAULT 'upsert';
CREATE INDEX IF NOT EXISTS sync_conflicts_dedup_idx
  ON sync_conflicts (entity_type, entity_id, remote_fingerprint, remote_operation);
`

const REJECTED_REMOTE_SQL = `
-- 004：「保留电脑版本」裁决的持久化（§7）。记录被用户明确拒绝的远端指纹，
-- 相同远端内容的重复推送直接 skipped（iOS 端基线随之收敛，不再重发、不再
-- 重复产生冲突）；远端内容真实变化（新指纹）时正常重新参与合并。
CREATE TABLE IF NOT EXISTS sync_rejected (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, fingerprint)
);
`

const RESOLVER_METADATA_SQL = `
-- 005：Desktop 本地派生元数据独立成表（Phase 3.1）。
--
-- 为什么必须分表：records 表的 source_name / author_name / summary /
-- thumbnail_url_string / metadata_status / repository_* / canonical_url /
-- platform_content_id 都参与 iOS ↔ Desktop 的 record 指纹（两端逐字段镜像）。
-- Desktop 的 Resolver 一旦写这些列，本地指纹就会偏离 iOS 的指纹，下一次
-- 相同内容的推送被误判成「桌面端自己改过」→ 假冲突；iOS 删除时也会被
-- 误判成删除冲突。
--
-- 分表后所有权清晰：records 表 = iOS 同步数据 + 桌面用户编辑（进指纹）；
-- record_metadata = Desktop 单方抓取的展示信息（不进指纹）。
--
-- url_string 记录「这条元数据是为哪个 URL 抓的」：URL 变了整行作废，
-- 旧封面不可能挂到新链接上。record_id 是主键 + 级联删除，记录没了它也没了。
CREATE TABLE IF NOT EXISTS record_metadata (
  record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  url_string TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'generic',
  content_id TEXT,
  canonical_url TEXT,
  title TEXT,
  description TEXT,
  thumbnail_url TEXT,
  source_name TEXT,
  author_name TEXT,
  repository_language TEXT,
  repository_stars INTEGER,
  repository_forks INTEGER,
  repository_license TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  error_message TEXT,
  fetched_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS record_metadata_url_idx ON record_metadata(url_string);
`

/** 画布便签：独立于 Records 的自由想法（title/body/颜色/位置/尺寸）。 */
const CANVAS_NOTES_SQL = `
CREATE TABLE IF NOT EXISTS canvas_notes (
  id TEXT PRIMARY KEY NOT NULL,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#f6f2df',
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 220,
  height REAL NOT NULL DEFAULT 180,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_canvas_idx ON canvas_notes (canvas_id);
`

/** MCP 接入（授权客户端 / 写审计 / 幂等）。token 只存哈希，审计不存正文。 */
const MCP_ACCESS_SQL = `
CREATE TABLE IF NOT EXISTS mcp_clients (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_clients_token_idx ON mcp_clients (token_hash);

CREATE TABLE IF NOT EXISTS mcp_operation_log (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  success INTEGER NOT NULL,
  error_code TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_oplog_client_idx ON mcp_operation_log (client_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_idempotency (
  client_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, idempotency_key)
);
`

// MARK: - Work Context（migration 008）

const WORK_CONTEXT_SQL = `
CREATE TABLE IF NOT EXISTS work_contexts (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS work_contexts_status_idx ON work_contexts (status);
CREATE INDEX IF NOT EXISTS work_contexts_last_activity_idx ON work_contexts (last_activity_at);

CREATE TABLE IF NOT EXISTS work_context_resources (
  id TEXT PRIMARY KEY NOT NULL,
  work_context_id TEXT NOT NULL REFERENCES work_contexts(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reference',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (work_context_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS work_context_resources_context_idx ON work_context_resources (work_context_id);
`

export const migrations: Migration[] = [
  { version: 1, name: 'init', sql: INIT_SQL },
  { version: 2, name: 'sync-align-ios', sql: SYNC_ALIGN_SQL },
  { version: 3, name: 'conflict-delete-operation', sql: CONFLICT_DELETE_OP_SQL },
  { version: 4, name: 'rejected-remote-fingerprints', sql: REJECTED_REMOTE_SQL },
  { version: 5, name: 'resolver-metadata-separation', sql: RESOLVER_METADATA_SQL },
  { version: 6, name: 'canvas-notes', sql: CANVAS_NOTES_SQL },
  { version: 7, name: 'mcp-access', sql: MCP_ACCESS_SQL },
  { version: 8, name: 'work-contexts', sql: WORK_CONTEXT_SQL }
]

/**
 * 逐版执行，每版一个事务。失败时**不吞异常**：调用方（`openDatabase`）会把
 * 应用停在「数据库不可用」状态，而不是继续用一个半迁移的库。
 */
export function migrate(sqlite: Database): void {
  const current = Number(sqlite.pragma('user_version', { simple: true }) ?? 0)
  for (const migration of migrations) {
    if (migration.version <= current) continue
    sqlite.exec('BEGIN')
    try {
      sqlite.exec(migration.sql)
      sqlite.pragma(`user_version = ${migration.version}`)
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`
      )
    }
  }
}


