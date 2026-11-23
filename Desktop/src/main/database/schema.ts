import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'

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

export const canvasNotes = sqliteTable(
  'canvas_notes',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    color: text('color').notNull().default('#f6f2df'),
    positionX: real('position_x').notNull().default(0),
    positionY: real('position_y').notNull().default(0),
    width: real('width').notNull().default(220),
    height: real('height').notNull().default(180),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('notes_canvas_idx').on(table.canvasId)]
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

// MARK: - MCP 接入（migration 007）

/**
 * MCP 客户端授权。只存 token 的 SHA-256；明文只在创建响应里出现一次。
 * `scopes` 是 JSON 数组字符串（如 `["records:read","canvas:write"]`），
 * 写入前用 `MCP_SCOPES` 校验，未知 scope 直接拒绝。
 */
export const mcpClients = sqliteTable(
  'mcp_clients',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at')
  },
  (table) => [uniqueIndex('mcp_clients_token_idx').on(table.tokenHash)]
)

/**
 * MCP 写调用审计。**不记**请求参数原文、记录正文、token、文件路径。
 * 撤销客户端不删除历史（client_id 只是文本引用，无外键）。
 */
export const mcpOperationLog = sqliteTable(
  'mcp_operation_log',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    toolName: text('tool_name').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    success: integer('success', { mode: 'boolean' }).notNull(),
    errorCode: text('error_code'),
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('mcp_oplog_client_idx').on(table.clientId, table.createdAt)]
)

/**
 * 幂等键：(client_id, idempotency_key) 唯一。
 * 只存请求摘要（sha256 规范化参数）——不存完整私人正文。
 * 同键同摘要 → 返回原实体；同键不同摘要 → IDEMPOTENCY_KEY_REUSE。
 */
export const mcpIdempotency = sqliteTable(
  'mcp_idempotency',
  {
    clientId: text('client_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    toolName: text('tool_name').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.clientId, table.idempotencyKey] })]
)

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
  canvasNotes,
  syncMeta,
  devices,
  syncBaseline,
  syncConflicts,
  changeLog,
  localState,
  mcpClients,
  mcpOperationLog,
  mcpIdempotency
}


// MARK: - Work Context（migration 008）

/**
 * 持续工作上下文：只存元信息（目标 / 进度 / 下一步），业务内容通过
 * work_context_resources 引用现有实体 ID。不进 change_log / iOS 同步。
 */
export const workContexts = sqliteTable(
  'work_contexts',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    goal: text('goal').notNull().default(''),
    summary: text('summary').notNull().default(''),
    nextStep: text('next_step').notNull().default(''),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastActivityAt: integer('last_activity_at').notNull()
  },
  (table) => [
    index('work_contexts_status_idx').on(table.status),
    index('work_contexts_last_activity_idx').on(table.lastActivityAt)
  ]
)

/**
 * 上下文 ↔ 资源关联：record / canvas 存实体 ID，url 存规范化 HTTP(S) 地址。
 * UNIQUE 约束保证同一上下文不重复关联同一资源；Record/Canvas 被删除后
 * 由 Service 在读取时清理失效关联（prune-on-read）。
 */
export const workContextResources = sqliteTable(
  'work_context_resources',
  {
    id: text('id').primaryKey(),
    workContextId: text('work_context_id')
      .notNull()
      .references(() => workContexts.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    role: text('role').notNull().default('reference'),
    note: text('note').notNull().default(''),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('work_context_resources_context_idx').on(table.workContextId),
    uniqueIndex('work_context_resources_unique_idx').on(
      table.workContextId,
      table.resourceType,
      table.resourceId
    )
  ]
)

// MARK: - Personal Direction（migration 9）
//
// 三层：现状 → 方向 → 阶段。与 Work Context 同为 Desktop 本地数据，
// 不进 change_log / iOS 同步。

/**
 * 我的现状。**每次确认生成一个新版本**，旧的 confirmed 转 archived——
 * 「我去年怎么描述自己」因此可查，不被覆盖。同一时刻最多一条 confirmed。
 */
export const currentStates = sqliteTable(
  'current_states',
  {
    id: text('id').primaryKey(),
    summary: text('summary').notNull().default(''),
    workStatus: text('work_status').notNull().default(''),
    capabilities: text('capabilities').notNull().default(''),
    ongoing: text('ongoing').notNull().default(''),
    capacity: text('capacity').notNull().default(''),
    constraints: text('constraints').notNull().default(''),
    other: text('other').notNull().default(''),
    /** draft | confirmed | archived */
    status: text('status').notNull().default('draft'),
    /** user | agent —— 来源可追溯，Agent 写的永远是 draft */
    source: text('source').notNull().default('user'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('current_states_status_idx').on(table.status, table.updatedAt)]
)

/** 长期方向：用户自己定义的「希望成为的样子」，不折算成分数。 */
export const directions = sqliteTable(
  'directions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    motivation: text('motivation').notNull().default(''),
    timeHorizon: text('time_horizon').notNull().default(''),
    /** JSON 字符串数组：可观察的结果。 */
    outcomes: text('outcomes').notNull().default('[]'),
    constraints: text('constraints').notNull().default(''),
    /** proposed | active | paused | achieved | dropped */
    status: text('status').notNull().default('proposed'),
    source: text('source').notNull().default('user'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('directions_status_idx').on(table.status, table.updatedAt)]
)

/**
 * 阶段目标：把方向切成可验证的一段。
 * 同一方向同一时刻只保留一个 active——「当前阶段」是单数，其余自动转 paused，
 * 阶段序列因此不会被多个「当前」撕开。
 */
export const stageGoals = sqliteTable(
  'stage_goals',
  {
    id: text('id').primaryKey(),
    directionId: text('direction_id')
      .notNull()
      .references(() => directions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    goal: text('goal').notNull().default(''),
    expectedOutcome: text('expected_outcome').notNull().default(''),
    completionCriteria: text('completion_criteria').notNull().default(''),
    timeHorizon: text('time_horizon').notNull().default(''),
    obstacles: text('obstacles').notNull().default(''),
    /** 关联的持续工作；Work Context 被删时置空而不是连带删阶段。 */
    workContextId: text('work_context_id').references(() => workContexts.id, {
      onDelete: 'set null'
    }),
    /** proposed | active | paused | completed | revised */
    status: text('status').notNull().default('proposed'),
    source: text('source').notNull().default('user'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('stage_goals_direction_idx').on(table.directionId, table.sortOrder),
    index('stage_goals_status_idx').on(table.status)
  ]
)

/**
 * Multi-AI 讨论（AI Workspace Phase 1）。
 *
 * 一次「同时提问」是一个 conversation：用户问题一条、每个平台回答各一条。
 * 只记录页面真实显示出来的内容与执行状态——不存 Cookie、不存凭据、
 * 不存任何能拿到登录态的东西。provider 标来源，账号标识留空位给多账号阶段。
 */
export const aiConversations = sqliteTable(
  'ai_conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    /** 发起时的问题文本；也是 UI 列表的主显示。 */
    prompt: text('prompt').notNull(),
    /** participating 平台，如 'chatgpt,claude'——列表页不用 join 就能标来源。 */
    providers: text('providers').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('ai_conversations_created_idx').on(table.createdAt)]
)

export const aiMessages = sqliteTable(
  'ai_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    /** chatgpt | claude | user */
    provider: text('provider').notNull(),
    /** 预留给同一平台多账号；本阶段恒为空串。 */
    accountId: text('account_id').notNull().default(''),
    /** user | assistant */
    role: text('role').notNull(),
    content: text('content').notNull().default(''),
    /** completed | failed | timeout | cancelled | empty —— 回答落库时的执行结果 */
    status: text('status').notNull().default('completed'),
    /** 失败原因等；不存凭据。 */
    metadata: text('metadata').notNull().default(''),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('ai_messages_conversation_idx').on(table.conversationId, table.createdAt)]
)

/**
 * 圆桌自由布局（Phase 4.2 workspace，migration 11）：每个成员面板在圆桌
 * 工作区里的位置 / 尺寸 / 层级。坐标是工作区局部坐标，恢复时按工作区
 * 尺寸 clamp。tabId 唯一身份；圆桌关闭布局保留，标签关闭时清理对应行。
 */
export const roundtablePanels = sqliteTable(
  'roundtable_panels',
  {
    roundtableId: text('roundtable_id').notNull(),
    tabId: text('tab_id').notNull(),
    url: text('url').notNull().default(''),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    zIndex: integer('z_index').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.roundtableId, table.tabId] })]
)

// MARK: - AI Card Workspace Bridge（migration 12）

/**
 * 本地工作区授权登记（AI Card Workspace Bridge，Phase 1）。**只进本地库**：
 * 不进 change_log、不进 iOS 同步。「授权」只是登记——删除登记绝不删除
 * 真实文件夹，也绝不授予渲染层任意文件系统访问。
 */
export const localWorkspaces = sqliteTable(
  'local_workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** realpath 规范化后的绝对路径；唯一索引是重复登记的 DB 层兜底。 */
    absolutePath: text('absolute_path').notNull(),
    platform: text('platform').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('local_workspaces_path_idx').on(table.absolutePath)]
)

/**
 * 卡片绑定：tabId → workspaceId。**刻意不设 ON DELETE CASCADE**：删除
 * 工作区授权后绑定行保留成悬空引用，卡片读到 join 不上的绑定就显示
 * 「绑定失效」（规格 §5.6），而不是悄悄回到未绑定。
 */
export const cardWorkspaceBindings = sqliteTable(
  'card_workspace_bindings',
  {
    tabId: text('tab_id').primaryKey(),
    /** 刻意无外键：删除授权后保留悬空引用，UI 显示「绑定失效」。 */
    workspaceId: text('workspace_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('card_workspace_bindings_workspace_idx').on(table.workspaceId)]
)

// MARK: - AI Reply Intelligence（migration 13）

/**
 * 用户主动交接的 AI 回复（Phase 2）。**只进本地库**：来源是「用户复制 /
 * 粘贴 + 明确导入」——没有后台监听、没有 DOM 轮询、没有自动提取。
 * workspace_id 刻意无外键：工作区删除后回复保留，草稿显示「待绑定」。
 */
export const capturedReplies = sqliteTable(
  'captured_replies',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull().default(''),
    providerName: text('provider_name').notNull().default(''),
    sourceUrl: text('source_url').notNull().default(''),
    sourceTitle: text('source_title').notNull().default(''),
    tabId: text('tab_id').notNull().default(''),
    workspaceId: text('workspace_id'),
    /** clipboard_import | manual_paste —— 都是用户明确触发。 */
    captureMethod: text('capture_method').notNull().default('manual_paste'),
    rawContent: text('raw_content').notNull(),
    capturedAt: integer('captured_at').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('captured_replies_captured_idx').on(table.capturedAt)]
)

/**
 * 解析分段：categories 是 JSON 字符串数组（多标签）。start/end_offset
 * 指向 raw_content 原文偏移——分类结果永远能回到原始上下文。
 * user_edited 后解析器永不再覆盖。
 */
export const replySegments = sqliteTable(
  'reply_segments',
  {
    id: text('id').primaryKey(),
    replyId: text('reply_id')
      .notNull()
      .references(() => capturedReplies.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    categories: text('categories').notNull().default('[]'),
    content: text('content').notNull(),
    startOffset: integer('start_offset').notNull().default(0),
    endOffset: integer('end_offset').notNull().default(0),
    confidence: real('confidence').notNull().default(0),
    reason: text('reason').notNull().default(''),
    userEdited: integer('user_edited', { mode: 'boolean' }).notNull().default(false)
  },
  (table) => [index('reply_segments_reply_idx').on(table.replyId, table.sequence)]
)

/**
 * 操作任务草稿：**只是草稿**——没有执行通道，status 从 draft 起步、
 * requires_approval 恒 true。payload 是 JSON（命令 / 代码块 / 文件路径候选）。
 */
export const actionDrafts = sqliteTable(
  'action_drafts',
  {
    id: text('id').primaryKey(),
    replyId: text('reply_id')
      .notNull()
      .references(() => capturedReplies.id, { onDelete: 'cascade' }),
    /** 段被删时置空（草稿保留），来源回复仍在。 */
    segmentId: text('segment_id').references(() => replySegments.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id'),
    actionType: text('action_type').notNull().default('operation'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    payload: text('payload').notNull().default('{}'),
    workingDirectory: text('working_directory').notNull().default(''),
    riskLevel: text('risk_level').notNull().default('normal'),
    requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull().default(true),
    status: text('status').notNull().default('draft'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('action_drafts_reply_idx').on(table.replyId)]
)

// MARK: - Agent Journey（migration 014）
//
// 一次 Agent 任务的执行历程。**Desktop 本地数据**：不进 change_log、不进 iOS
// 同步（与 Work Context / Personal Direction 同一惯例）。
//
// 三条与既有表不同的设计：
// 1. `source_client_id` **不设外键**——撤销/删除 MCP Client 绝不能连带删除
//    用户的历史资产（与 `mcp_operation_log.client_id` 同一取舍）。
// 2. `work_context_id` 用 `ON DELETE SET NULL`——删项目保留个人历史。
// 3. 事件顺序的唯一真相是 `sequence`；`occurred_at` 只是 Agent 声称的时间。

/**
 * 一次具体的 Agent 任务历程。一个 Work Context 可以关联多次 Journey，
 * Journey 也可以独立存在（`work_context_id` 可空）。
 */
export const agentJourneys = sqliteTable(
  'agent_journeys',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    goal: text('goal').notNull().default(''),
    /** created / running / paused / failed / completed / cancelled / abandoned */
    status: text('status').notNull().default('created'),
    /** `mcp_clients.id`，**无外键**：撤销客户端不删除个人历史。 */
    sourceClientId: text('source_client_id').notNull(),
    /** Agent 自报元数据，不参与任何身份判定。 */
    sourceAgent: text('source_agent').notNull().default(''),
    model: text('model').notNull().default(''),
    workContextId: text('work_context_id').references(() => workContexts.id, {
      onDelete: 'set null'
    }),
    createdAt: integer('created_at').notNull(),
    /** 首次进入 running 时写入；此前为 null。 */
    startedAt: integer('started_at'),
    updatedAt: integer('updated_at').notNull(),
    /** 只有显式完成时写入；completed_at 为 null 即未完成。 */
    completedAt: integer('completed_at'),
    /** workflow_summary（默认）/ conversation_capture / detailed_capture */
    captureMode: text('capture_mode').notNull().default('workflow_summary'),
    schemaVersion: integer('schema_version').notNull().default(1)
  },
  (table) => [
    index('agent_journeys_status_idx').on(table.status, table.updatedAt),
    index('agent_journeys_work_context_idx').on(table.workContextId),
    index('agent_journeys_source_client_idx').on(table.sourceClientId)
  ]
)

/**
 * 一次重要的过程记录。事实字段创建后不可覆盖（更新接口只接受 `status`）。
 *
 * `UNIQUE(journey_id, sequence)` 是顺序兜底；`UNIQUE(journey_id,
 * source_client_id, idempotency_key)` 是事件级重复提交兜底——两者都不承担
 * MCP 请求级重放职责（那是 `mcp_idempotency` 的事）。
 */
export const agentJourneyEvents = sqliteTable(
  'agent_journey_events',
  {
    id: text('id').primaryKey(),
    journeyId: text('journey_id')
      .notNull()
      .references(() => agentJourneys.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    role: text('role').notNull().default('agent'),
    status: text('status').notNull().default('completed'),
    /** v1 只接受 agent_reported。 */
    evidenceLevel: text('evidence_level').notNull().default('agent_reported'),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    content: text('content').notNull().default(''),
    reason: text('reason').notNull().default(''),
    sourceClientId: text('source_client_id').notNull(),
    sourceAgent: text('source_agent').notNull().default(''),
    model: text('model').notNull().default(''),
    attemptId: text('attempt_id'),
    /** 结构性父子归属；关联事件被删时置空（内容优先，链接可断）。 */
    parentEventId: text('parent_event_id').references(
      (): AnySQLiteColumn => agentJourneyEvents.id,
      { onDelete: 'set null' }
    ),
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: integer('occurred_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** 可选扩展，Zod `.strict()` + schema_version；不参与查询。 */
    metadata: text('metadata')
  },
  (table) => [
    uniqueIndex('agent_journey_events_seq_uidx').on(table.journeyId, table.sequence),
    uniqueIndex('agent_journey_events_idem_uidx').on(
      table.journeyId,
      table.sourceClientId,
      table.idempotencyKey
    ),
    index('agent_journey_events_type_idx').on(table.journeyId, table.eventType),
    index('agent_journey_events_attempt_idx').on(table.journeyId, table.attemptId)
  ]
)

/**
 * 事件间的**业务关系**（与 `parent_event_id` 的结构性归属不同，不互相镜像）。
 * 两端都属于同一 Journey 由 Service 校验，`journey_id` 参与唯一索引兜底。
 */
export const agentJourneyEdges = sqliteTable(
  'agent_journey_edges',
  {
    id: text('id').primaryKey(),
    journeyId: text('journey_id')
      .notNull()
      .references(() => agentJourneys.id, { onDelete: 'cascade' }),
    fromEventId: text('from_event_id')
      .notNull()
      .references(() => agentJourneyEvents.id, { onDelete: 'cascade' }),
    toEventId: text('to_event_id')
      .notNull()
      .references(() => agentJourneyEvents.id, { onDelete: 'cascade' }),
    /** depends_on / branch_from / revises / retries */
    relationshipType: text('relationship_type').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    uniqueIndex('agent_journey_edges_uidx').on(
      table.journeyId,
      table.fromEventId,
      table.toEventId,
      table.relationshipType
    ),
    index('agent_journey_edges_from_idx').on(table.fromEventId),
    index('agent_journey_edges_to_idx').on(table.toEventId)
  ]
)

/**
 * 节点摆位（**纯展示层**）：拖动只写这张表，永不改变 `sequence` 与业务 Edge。
 * 只存用户手动覆盖项，算法默认值不落库。
 */
export const agentJourneyLayouts = sqliteTable(
  'agent_journey_layouts',
  {
    id: text('id').primaryKey(),
    journeyId: text('journey_id')
      .notNull()
      .references(() => agentJourneys.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => agentJourneyEvents.id, { onDelete: 'cascade' }),
    positionX: real('position_x').notNull().default(0),
    positionY: real('position_y').notNull().default(0),
    width: real('width').notNull().default(240),
    height: real('height').notNull().default(140),
    zIndex: integer('z_index').notNull().default(0),
    collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('agent_journey_layouts_uidx').on(table.journeyId, table.eventId)]
)
