import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * 本地 SQLite 的 Drizzle 定义。**只镜像 iOS 的语义，不复制它的物理格式**：
 * 桌面端有自己的库，UUID 用 TEXT、时间用 epoch 毫秒、标签用 iOS 同款
 * `\u001F` 分隔串（这样同步时一个字段就能原样对上，不必做语义转换）。
 *
 * `sync_meta` / `change_log` 是为增量同步预留的写入日志：每次写操作都必须
 * 落一条 change log，否则「两端各自改过什么」永远查不出来。
 */

export const beans = sqliteTable(
  'beans',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    roaster: text('roaster').notNull().default(''),
    origin: text('origin').notNull().default(''),
    process: text('process').notNull().default(''),
    roastLevel: text('roast_level').notNull().default('medium'),
    roastDate: integer('roast_date'),
    purchaseDate: integer('purchase_date'),
    openDate: integer('open_date'),
    weightG: real('weight_g').notNull().default(0),
    remainingG: real('remaining_g').notNull().default(0),
    price: real('price').notNull().default(0),
    channel: text('channel').notNull().default(''),
    imagePath: text('image_path'),
    /** iOS `flavorTagsRaw`：以 `\u001F` 分隔。 */
    flavorTagsRaw: text('flavor_tags_raw').notNull().default(''),
    notes: text('notes').notNull().default(''),
    status: text('status').notNull().default('active'),
    isSample: integer('is_sample', { mode: 'boolean' }).notNull().default(false),
    stockCountedAt: integer('stock_counted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('beans_updated_at_idx').on(table.updatedAt)]
)

export const brews = sqliteTable(
  'brews',
  {
    id: text('id').primaryKey(),
    beanId: text('bean_id')
      .notNull()
      .references(() => beans.id, { onDelete: 'cascade' }),
    date: integer('date').notNull(),
    method: text('method').notNull().default(''),
    grinder: text('grinder').notNull().default(''),
    grindSize: text('grind_size').notNull().default(''),
    waterTemp: real('water_temp').notNull().default(0),
    coffeeG: real('coffee_g').notNull().default(0),
    waterG: real('water_g').notNull().default(0),
    timeSeconds: integer('time_seconds').notNull().default(0),
    score: integer('score').notNull().default(0),
    acidity: integer('acidity').notNull().default(0),
    sweetness: integer('sweetness').notNull().default(0),
    bitterness: integer('bitterness').notNull().default(0),
    body: integer('body').notNull().default(0),
    aftertaste: integer('aftertaste').notNull().default(0),
    flavorTagsRaw: text('flavor_tags_raw').notNull().default(''),
    notes: text('notes').notNull().default(''),
    /** 实际扣掉的克数；null = 旧数据，删除时按 coffeeG 退。 */
    stockDeductedG: real('stock_deducted_g'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('brews_bean_idx').on(table.beanId, table.date)]
)

export const tastings = sqliteTable(
  'tastings',
  {
    id: text('id').primaryKey(),
    beanId: text('bean_id')
      .notNull()
      .references(() => beans.id, { onDelete: 'cascade' }),
    /** 由哪次冲煮生成（镜像记录）；手动记录为 null。 */
    brewId: text('brew_id'),
    date: integer('date').notNull(),
    dayAfterRoast: integer('day_after_roast').notNull().default(0),
    flavorTagsRaw: text('flavor_tags_raw').notNull().default(''),
    score: integer('score').notNull().default(0),
    notes: text('notes').notNull().default(''),
    source: text('source').notNull().default('manual'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('tastings_bean_idx').on(table.beanId, table.date)]
)

export const phaseRules = sqliteTable('phase_rules', {
  id: text('id').primaryKey(),
  roastLevel: text('roast_level').notNull(),
  restMinDays: integer('rest_min_days').notNull().default(2),
  restMaxDays: integer('rest_max_days').notNull().default(5),
  peakStartDay: integer('peak_start_day').notNull().default(5),
  peakEndDay: integer('peak_end_day').notNull().default(21),
  declineStartDay: integer('decline_start_day').notNull().default(21),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at').notNull()
})

/** 只同步提醒**意图**：哪包豆、什么时机、什么时候响。系统通知标识属于设备本地。 */
export const phaseReminders = sqliteTable(
  'phase_reminders',
  {
    id: text('id').primaryKey(),
    beanId: text('bean_id')
      .notNull()
      .references(() => beans.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fireDate: integer('fire_date').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('reminders_bean_idx').on(table.beanId)]
)

export const records = sqliteTable(
  'records',
  {
    id: text('id').primaryKey(),
    carrier: text('carrier').notNull(),
    title: text('title').notNull().default(''),
    note: text('note').notNull().default(''),
    urlString: text('url_string').notNull().default(''),
    canonicalUrl: text('canonical_url'),
    provider: text('provider').notNull().default('generic'),
    platformContentId: text('platform_content_id'),
    sourceName: text('source_name').notNull().default(''),
    authorName: text('author_name').notNull().default(''),
    summary: text('summary').notNull().default(''),
    mediaPath: text('media_path'),
    previewPath: text('preview_path'),
    thumbnailUrlString: text('thumbnail_url_string'),
    metadataStatus: text('metadata_status').notNull().default('idle'),
    contentKind: text('content_kind').notNull().default(''),
    linkPage: integer('link_page').notNull().default(1),
    repositoryStars: integer('repository_stars'),
    repositoryForks: integer('repository_forks'),
    repositoryIssues: integer('repository_issues'),
    repositoryLicense: text('repository_license'),
    repositoryLanguage: text('repository_language'),
    isSample: integer('is_sample', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('records_created_idx').on(table.createdAt), index('records_carrier_idx').on(table.carrier)]
)


/**
 * Desktop 本地派生元数据（Phase 3.1）——**不进同步指纹**。
 *
 * records 表里同名的那些列属于 iOS 同步数据（iOS 自己的抓取结果）或桌面用户
 * 编辑，参与 iOS ↔ Desktop 的 fingerprint；这里存的是 Desktop 单方抓取、
 * 只用于展示的信息。两者在 `toRecordItem()` 里按「iOS/用户优先，本地派生补空」
 * 组装。
 */
export const recordMetadata = sqliteTable('record_metadata', {
  recordId: text('record_id')
    .primaryKey()
    .references(() => records.id, { onDelete: 'cascade' }),
  /** 抓取时的 URL：与 records.url_string 不一致即整行作废 */
  urlString: text('url_string').notNull().default(''),
  provider: text('provider').notNull().default('generic'),
  contentId: text('content_id'),
  canonicalUrl: text('canonical_url'),
  title: text('title'),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  sourceName: text('source_name'),
  authorName: text('author_name'),
  repositoryLanguage: text('repository_language'),
  repositoryStars: integer('repository_stars'),
  repositoryForks: integer('repository_forks'),
  repositoryLicense: text('repository_license'),
  status: text('status').notNull().default('idle'),
  errorMessage: text('error_message'),
  fetchedAt: integer('fetched_at').notNull().default(0)
})

export const recordTags = sqliteTable(
  'record_tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [uniqueIndex('record_tags_name_idx').on(table.name)]
)

/** 多对多关系表：一条记录可以有多个标签，一个标签可以挂多条记录。 */
export const recordTagLinks = sqliteTable(
  'record_tag_links',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => recordTags.id, { onDelete: 'cascade' })
  },
  (table) => [primaryKey({ columns: [table.recordId, table.tagId] })]
)

export const canvases = sqliteTable('canvases', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  note: text('note').notNull().default(''),
  isSample: integer('is_sample', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const canvasNodes = sqliteTable(
  'canvas_nodes',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    positionX: real('position_x').notNull().default(0),
    positionY: real('position_y').notNull().default(0),
    width: real('width').notNull().default(240),
    height: real('height').notNull().default(180),
    zIndex: integer('z_index').notNull().default(0),
    annotation: text('annotation').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('nodes_canvas_idx').on(table.canvasId),
    index('nodes_record_idx').on(table.recordId),
    uniqueIndex('nodes_canvas_record_idx').on(table.canvasId, table.recordId)
  ]
)

/**
 * 手绘笔迹：点集是世界坐标 `[x0,y0,x1,y1,…]` 的 JSON。
 * Phase 1 只建表与结构，编辑工具在 Phase 4——iOS 端**还没有**对应渲染，
 * 不要对外声称两端都能看到笔迹。
 */
export const canvasStrokes = sqliteTable(
  'canvas_strokes',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    toolType: text('tool_type').notNull().default('pen'),
    points: text('points').notNull().default('[]'),
    color: text('color').notNull().default('#3b2b22'),
    width: real('width').notNull().default(2),
    opacity: real('opacity').notNull().default(1),
    zIndex: integer('z_index').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('strokes_canvas_idx').on(table.canvasId)]
)

/** 同步元数据：每条可同步实体一行。 */
export const syncMeta = sqliteTable(
  'sync_meta',
  {
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    revision: integer('revision').notNull().default(1),
    originDeviceId: text('origin_device_id').notNull(),
    modifiedAt: integer('modified_at').notNull(),
    operationId: text('operation_id').notNull(),
    deletedAt: integer('deleted_at')
  },
  (table) => [primaryKey({ columns: [table.entityType, table.entityId] }), index('sync_meta_rev_idx').on(table.revision)]
)

/** 写入日志：增量同步就靠它，一张表改一次留一条。 */
export const changeLog = sqliteTable(
  'change_log',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    operation: text('operation').notNull(),
    revision: integer('revision').notNull(),
    payload: text('payload'),
    deviceId: text('device_id').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('change_log_entity_idx').on(table.entityType, table.entityId)]
)

/** 已配对设备。token 只存哈希，原文只在配对响应里出现一次。 */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    publicKey: text('public_key').notNull().default(''),
    tokenHash: text('token_hash').notNull(),
    pairedAt: integer('paired_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    lastSyncAt: integer('last_sync_at'),
    revokedAt: integer('revoked_at')
  },
  (table) => [uniqueIndex('devices_token_idx').on(table.tokenHash)]
)

/** 本地键值：deviceId、迁移记录等。 */
export const localState = sqliteTable('local_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

export const syncBaseline = sqliteTable('sync_baseline', {
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  syncedAt: integer('synced_at').notNull()
}, (table) => [primaryKey({ columns: [table.entityType, table.entityId] })])

export const syncConflicts = sqliteTable('sync_conflicts', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  localFingerprint: text('local_fingerprint').notNull(),
  remoteFingerprint: text('remote_fingerprint').notNull(),
  remotePayload: text('remote_payload').notNull(),
  createdAt: integer('created_at').notNull()
})

export const schema = {
  beans,
  brews,
  tastings,
  phaseRules,
  phaseReminders,
  records,
  recordMetadata,
  recordTags,
  recordTagLinks,
  canvases,
  canvasNodes,
  canvasStrokes,
  syncMeta,
  devices,
  syncBaseline,
  syncConflicts,
  changeLog,
  localState
}

