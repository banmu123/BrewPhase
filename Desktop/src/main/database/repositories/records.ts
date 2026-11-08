import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import type {
  LocalRecordMetadata,
  RecordDraft,
  RecordItem,
  RecordQuery,
  RecordTag
} from '../../../shared/contracts'
import type { Db } from '../client'
import type { ResolvedLinkMetadata } from '../../metadata/metadata-normalizer'
import { parseLink } from '../../../shared/link-parser'
import { recordMetadata, records, recordTagLinks, recordTags } from '../schema'
import { recordChange } from './sync-log'

/**
 * 资料库读写。标签是多对多关系表（`record_tag_links`），写记录时先写关系、
 * 再读回来——标签数组只是契约层的视图，不是存储形态。
 */

export function listRecords(db: Db, query: RecordQuery): RecordItem[] {
  const conditions = []

  if (query.carrier) conditions.push(eq(records.carrier, query.carrier))
  if (query.search.trim()) {
    const pattern = `%${query.search.trim()}%`
    // 本地派生元数据也参与搜索，但**只有当它的 url_string 与记录当前 URL 一致**
    // 时才算数（URL 变了旧封面/旧标题不能被搜到）。用 EXISTS 而不是 JOIN：
    // 后者在关系不唯一时会让同一条记录出现多行，分页也跟着错。
    conditions.push(
      or(
        like(records.title, pattern),
        like(records.note, pattern),
        like(records.sourceName, pattern),
        like(records.authorName, pattern),
        like(records.summary, pattern),
        like(records.urlString, pattern),
        sql`exists (
          select 1 from ${recordMetadata}
          where ${recordMetadata.recordId} = ${records.id}
            and ${recordMetadata.urlString} = ${records.urlString}
            and (
              ${recordMetadata.title} like ${pattern}
              or ${recordMetadata.description} like ${pattern}
              or ${recordMetadata.sourceName} like ${pattern}
              or ${recordMetadata.authorName} like ${pattern}
            )
        )`
      )
    )
  }
  if (query.tagId) {
    conditions.push(
      sql`exists (select 1 from ${recordTagLinks} where ${recordTagLinks.recordId} = ${records.id} and ${recordTagLinks.tagId} = ${query.tagId})`
    )
  }

  // drizzle 的构建顺序是 where → orderBy → limit → offset；顺序反了类型就不通过。
  const rows = db
    .select()
    .from(records)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(records.createdAt))
    .limit(query.limit)
    .offset(query.offset)
    .all()
  const tagsByRecord = tagsForRecords(db, rows.map((row) => row.id))
  const metaByRecord = metadataForRecords(db, rows.map((row) => row.id))
  return rows.map((row) => toRecordItem(row, tagsByRecord.get(row.id) ?? [], metaByRecord.get(row.id) ?? null))
}

export function getRecord(db: Db, id: string): RecordItem | null {
  const row = db.select().from(records).where(eq(records.id, id)).get()
  if (!row) return null
  const tags = tagsForRecords(db, [id]).get(id) ?? []
  return toRecordItem(row, tags, metadataForRecords(db, [id]).get(id) ?? null)
}

export function createRecord(db: Db, deviceId: string, draft: RecordDraft): RecordItem {
  const id = crypto.randomUUID()
  const at = Date.now()

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .insert(records)
      .values({
        id,
        carrier: draft.carrier,
        title: draft.title,
        note: draft.note,
        urlString: draft.urlString,
        canonicalUrl: draft.canonicalURL,
        provider: draft.provider,
        platformContentId: draft.platformContentID,
        sourceName: draft.sourceName,
        authorName: draft.authorName,
        summary: draft.summary,
        mediaPath: draft.mediaPath,
        previewPath: draft.previewPath,
        createdAt: at,
        updatedAt: at
      })
      .run()
    // 抓取状态属于 Desktop 单方派生数据，写独立表（不进同步指纹）
    seedLocalMetadata(scoped, id, draft.carrier, draft.urlString, draft.provider)
    replaceTags(scoped, id, draft.tagIds)
    recordChange(scoped, { deviceId, entityType: 'record', entityId: id, operation: 'create' })
  })

  return getRecord(db, id)!
}

export function updateRecord(db: Db, deviceId: string, id: string, draft: RecordDraft): RecordItem {
  const at = Date.now()
  const previous = db.select().from(records).where(eq(records.id, id)).get()
  // URL 变了：旧链接的自动元数据（封面/摘要/作者/仓库统计/内容 ID）一律失效，
  // 否则新链接会顶着旧封面。标题是用户可编辑字段，不在这里清。
  const urlChanged = Boolean(previous && previous.urlString !== draft.urlString)

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .update(records)
      .set({
        carrier: draft.carrier,
        title: draft.title,
        note: draft.note,
        urlString: draft.urlString,
        provider: draft.provider,
        canonicalUrl: urlChanged ? draft.canonicalURL : (previous?.canonicalUrl ?? draft.canonicalURL),
        platformContentId: urlChanged ? draft.platformContentID : (previous?.platformContentId ?? draft.platformContentID),
        sourceName: urlChanged ? '' : draft.sourceName,
        authorName: urlChanged ? '' : draft.authorName,
        summary: urlChanged ? '' : draft.summary,
        thumbnailUrlString: urlChanged ? null : previous?.thumbnailUrlString ?? null,
        repositoryLanguage: urlChanged ? null : previous?.repositoryLanguage ?? null,
        repositoryStars: urlChanged ? null : previous?.repositoryStars ?? null,
        repositoryForks: urlChanged ? null : previous?.repositoryForks ?? null,
        repositoryLicense: urlChanged ? null : previous?.repositoryLicense ?? null,
        // 状态归 record_metadata 管；records 的这一列只保留 iOS 同步值，
        // URL 变了它就没有意义了（旧 URL 的状态不能挂在新链接上）。
        metadataStatus: urlChanged ? 'idle' : (previous?.metadataStatus ?? 'idle'),
        mediaPath: draft.mediaPath,
        previewPath: draft.previewPath,
        updatedAt: at
      })
      .where(eq(records.id, id))
      .run()
    if (draft.carrier !== 'link') {
      // 不再是链接 → 本地派生元数据整体失效
      scoped.delete(recordMetadata).where(eq(recordMetadata.recordId, id)).run()
    } else if (urlChanged) {
      // 旧 URL 的封面/摘要/作者/统计一律作废（§URL 变更生命周期）
      scoped.delete(recordMetadata).where(eq(recordMetadata.recordId, id)).run()
      seedLocalMetadata(scoped, id, draft.carrier, draft.urlString, draft.provider)
    }
    replaceTags(scoped, id, draft.tagIds)
    recordChange(scoped, { deviceId, entityType: 'record', entityId: id, operation: 'update' })
  })

  return getRecord(db, id)!
}

/**
 * 写入 Desktop 自动解析的元数据（Phase 3.1）。
 *
 * **只写 `record_metadata`，绝不碰 records 的同步列**。records 里的
 * source_name / author_name / summary / thumbnail_url_string / metadata_status /
 * repository_* / canonical_url / platform_content_id 参与 iOS ↔ Desktop 的
 * record 指纹；Resolver 一旦改它们，下一次相同内容的 iOS 推送就会被误判成
 * 「桌面端自己改过」→ 假冲突，iOS 删除也会变成假删除冲突。
 *
 * 抓取结果做「非空合并」：刷新失败（resolved 全是 null）时保留上一次的成功数据，
 * 状态按 `METADATA_HAS_CONTENT` 语义保留，不把 partial 升级成 ok。
 */
/** 已有成功抓取结果的状态：ok / resolved、partial（iOS 原值经归一后也可能是这几个）。 */
const METADATA_HAS_CONTENT: readonly string[] = ['ok', 'resolved', 'partial']

export function applyResolvedMetadata(
  db: Db,
  deviceId: string,
  id: string,
  expectedUrl: string,
  resolved: ResolvedLinkMetadata
): RecordItem | null {
  const at = Date.now()
  let written = false

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    // 记录已删除 / 载体变了 / URL 变了 → 旧结果作废（读与写在同一个事务里，
    // better-sqlite3 同步执行，中间没有任何可插入的窗口）。
    const row = scoped.select().from(records).where(eq(records.id, id)).get()
    if (!row || row.carrier !== 'link' || row.urlString !== expectedUrl) return

    const previous = scoped.select().from(recordMetadata).where(eq(recordMetadata.recordId, id)).get()
    const keep = previous && previous.urlString === expectedUrl ? previous : null
    const previousStatus = keep?.status ?? 'idle'
    const status =
      resolved.status === 'success'
        ? 'ok'
        : METADATA_HAS_CONTENT.includes(previousStatus)
          ? previousStatus
          : 'failed'

    const values = {
      recordId: id,
      urlString: expectedUrl,
      provider: resolved.provider || keep?.provider || 'generic',
      contentId: resolved.contentId ?? keep?.contentId ?? null,
      canonicalUrl: resolved.canonicalUrl || keep?.canonicalUrl || null,
      title: resolved.title ?? keep?.title ?? null,
      description: resolved.description ?? keep?.description ?? null,
      thumbnailUrl: resolved.thumbnailUrl ?? keep?.thumbnailUrl ?? null,
      sourceName: resolved.sourceName ?? keep?.sourceName ?? null,
      authorName: resolved.authorName ?? keep?.authorName ?? null,
      repositoryLanguage: resolved.repositoryLanguage ?? keep?.repositoryLanguage ?? null,
      repositoryStars: resolved.repositoryStars ?? keep?.repositoryStars ?? null,
      repositoryForks: resolved.repositoryForks ?? keep?.repositoryForks ?? null,
      repositoryLicense: resolved.repositoryLicense ?? keep?.repositoryLicense ?? null,
      status,
      errorMessage: resolved.errorMessage ?? null,
      fetchedAt: at
    }
    const { recordId: _recordId, ...update } = values
    scoped
      .insert(recordMetadata)
      .values(values)
      .onConflictDoUpdate({ target: recordMetadata.recordId, set: update })
      .run()
    written = true
    // 注意：这里**不写 change_log**——records 行没有变化，同步指纹也不该变。
    void deviceId
  })

  return written ? getRecord(db, id) : null
}

/**
 * 同步落库之后（或启动恢复）调用：保证 link 记录有对应的本地派生元数据行，
 * 并告诉调用方**这次是否需要真的去抓**。
 *
 * - 非 link / 没有 URL → 删掉派生行，返回 null；
 * - 没有行、或行的 url_string 与记录不一致（URL 变了）→ 重建为 pending，需要抓；
 * - 同一 URL 且 `pending` → 需要抓（上次没跑完，比如应用被关掉）；
 * - 同一 URL 且 `ok` / `failed` → 不自动重抓（失败后由用户手动刷新）。
 */
export function prepareLocalMetadata(
  db: Db,
  id: string
): { urlString: string; needsFetch: boolean } | null {
  const row = db.select().from(records).where(eq(records.id, id)).get()
  if (!row) return null
  // `trim()` 只用于判空：**存储与比较一律用 records 的原始值**——iOS 同步过来的
  // url_string 不能被改写，否则 record_metadata / 队列任务 / expectedUrl /
  // pendingMetadataJobs 之间会各自持有不同的字符串，元数据永远对不上。
  if (row.carrier !== 'link' || !row.urlString.trim()) {
    db.delete(recordMetadata).where(eq(recordMetadata.recordId, id)).run()
    return null
  }
  const urlString = row.urlString
  const existing = db.select().from(recordMetadata).where(eq(recordMetadata.recordId, id)).get()
  if (existing && existing.urlString === urlString) {
    return { urlString, needsFetch: existing.status === 'pending' }
  }

  const status = parseLink(urlString).valid ? 'pending' : 'failed'
  const values = {
    recordId: id,
    urlString,
    provider: row.provider,
    status,
    errorMessage: status === 'failed' ? '不是有效的网页地址' : null,
    fetchedAt: 0
  }
  const { recordId: _recordId, ...update } = values
  db.insert(recordMetadata)
    .values(values)
    .onConflictDoUpdate({ target: recordMetadata.recordId, set: update })
    .run()
  return { urlString, needsFetch: status === 'pending' }
}

/** 应用启动时要恢复的 pending 任务：URL 仍与记录一致，且仍是 link。 */
export function pendingMetadataJobs(db: Db): Array<{ recordId: string; urlString: string }> {
  return db
    .select({ recordId: recordMetadata.recordId, urlString: recordMetadata.urlString })
    .from(recordMetadata)
    .innerJoin(records, eq(records.id, recordMetadata.recordId))
    .where(
      and(
        eq(recordMetadata.status, 'pending'),
        eq(records.carrier, 'link'),
        eq(records.urlString, recordMetadata.urlString)
      )
    )
    .all()
}

/**
 * 新链接的初始抓取状态落 record_metadata：非链接载体没有这回事；
 * URL 非法直接 failed（没人会去解析它，pending 会永远挂着）。
 */
function seedLocalMetadata(
  db: Db,
  recordId: string,
  carrier: string,
  urlString: string,
  provider: string
): void {
  if (carrier !== 'link' || !urlString.trim()) return
  const status = parseLink(urlString).valid ? 'pending' : 'failed'
  db.insert(recordMetadata)
    .values({
      recordId,
      urlString,
      provider,
      status,
      errorMessage: status === 'failed' ? '不是有效的网页地址' : null,
      fetchedAt: 0
    })
    .onConflictDoUpdate({
      target: recordMetadata.recordId,
      set: { urlString, provider, status, errorMessage: status === 'failed' ? '不是有效的网页地址' : null }
    })
    .run()
}

/** 删记录：外键 ON DELETE CASCADE 会带走标签关系与引用它的画布节点。 */
export function deleteRecord(db: Db, deviceId: string, id: string): void {
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.delete(records).where(eq(records.id, id)).run()
    recordChange(scoped, { deviceId, entityType: 'record', entityId: id, operation: 'delete' })
  })
}

export function listTags(db: Db): RecordTag[] {
  return db.select().from(recordTags).orderBy(recordTags.name).all().map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt
  }))
}

/** 标签按名字唯一：同名标签复用已有那条，不制造重复。 */
export function createTag(db: Db, deviceId: string, name: string): RecordTag {
  const trimmed = name.trim()
  const existing = db.select().from(recordTags).where(eq(recordTags.name, trimmed)).get()
  if (existing) return { id: existing.id, name: existing.name, createdAt: existing.createdAt }

  const id = crypto.randomUUID()
  const at = Date.now()
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.insert(recordTags).values({ id, name: trimmed, createdAt: at }).run()
    recordChange(scoped, { deviceId, entityType: 'recordTag', entityId: id, operation: 'create' })
  })
  return { id, name: trimmed, createdAt: at }
}

export function deleteTag(db: Db, deviceId: string, id: string): void {
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.delete(recordTags).where(eq(recordTags.id, id)).run()
    recordChange(scoped, { deviceId, entityType: 'recordTag', entityId: id, operation: 'delete' })
  })
}

function replaceTags(db: Db, recordId: string, tagIds: string[]): void {
  db.delete(recordTagLinks).where(eq(recordTagLinks.recordId, recordId)).run()
  const unique = [...new Set(tagIds)]
  if (unique.length === 0) return
  db.insert(recordTagLinks)
    .values(unique.map((tagId) => ({ recordId, tagId })))
    .run()
}

function tagsForRecords(db: Db, recordIds: string[]): Map<string, string[]> {
  if (recordIds.length === 0) return new Map()
  const rows = db
    .select({ recordId: recordTagLinks.recordId, tagId: recordTagLinks.tagId })
    .from(recordTagLinks)
    .where(inArray(recordTagLinks.recordId, recordIds))
    .all()
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const list = map.get(row.recordId) ?? []
    list.push(row.tagId)
    map.set(row.recordId, list)
  }
  return map
}

type RecordRow = typeof records.$inferSelect
type MetadataRow = typeof recordMetadata.$inferSelect

function metadataForRecords(db: Db, recordIds: string[]): Map<string, LocalRecordMetadata> {
  if (recordIds.length === 0) return new Map()
  const rows = db
    .select()
    .from(recordMetadata)
    .where(inArray(recordMetadata.recordId, recordIds))
    .all()
  return new Map(rows.map((row) => [row.recordId, toLocalMetadata(row)]))
}

function toLocalMetadata(row: MetadataRow): LocalRecordMetadata {
  return {
    recordId: row.recordId,
    urlString: row.urlString,
    provider: row.provider as LocalRecordMetadata['provider'],
    contentId: row.contentId ?? null,
    canonicalUrl: row.canonicalUrl ?? null,
    title: row.title ?? null,
    description: row.description ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    sourceName: row.sourceName ?? null,
    authorName: row.authorName ?? null,
    repositoryLanguage: row.repositoryLanguage ?? null,
    repositoryStars: row.repositoryStars ?? null,
    repositoryForks: row.repositoryForks ?? null,
    repositoryLicense: row.repositoryLicense ?? null,
    status: row.status as LocalRecordMetadata['status'],
    errorMessage: row.errorMessage ?? null,
    fetchedAt: row.fetchedAt
  }
}

/**
 * 行 → 契约。
 *
 * **展示语义**：`metadataStatus` 取「本地抓取状态优先，否则 iOS 同步来的值」；
 * 其余字段保持 records 的原始值不变，由渲染层按「记录优先、本地派生补空」组装
 * ——这样 iOS 同步来的值永远不会被本地抓取结果覆盖，指纹也不受影响。
 */
function toRecordItem(row: RecordRow, tagIds: string[], metadata: LocalRecordMetadata | null): RecordItem {
  const effectiveStatus =
    metadata && metadata.urlString === row.urlString ? metadata.status : null
  return {
    id: row.id,
    carrier: row.carrier as RecordItem['carrier'],
    title: row.title,
    note: row.note,
    urlString: row.urlString,
    canonicalURL: row.canonicalUrl,
    provider: row.provider as RecordItem['provider'],
    platformContentID: row.platformContentId,
    sourceName: row.sourceName,
    authorName: row.authorName,
    summary: row.summary,
    mediaPath: row.mediaPath,
    previewPath: row.previewPath,
    thumbnailURLString: row.thumbnailUrlString,
    metadataStatus: (effectiveStatus ?? row.metadataStatus) as RecordItem['metadataStatus'],
    metadata: metadata && metadata.urlString === row.urlString ? metadata : null,
    repositoryStars: row.repositoryStars,
    repositoryForks: row.repositoryForks,
    repositoryLanguage: row.repositoryLanguage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tagIds
  }
}
