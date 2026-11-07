import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import type { RecordDraft, RecordItem, RecordQuery, RecordTag } from '../../../shared/contracts'
import type { Db } from '../client'
import type { ResolvedLinkMetadata } from '../../metadata/metadata-normalizer'
import { parseLink } from '../../../shared/link-parser'
import { records, recordTagLinks, recordTags } from '../schema'
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
    conditions.push(
      or(
        like(records.title, pattern),
        like(records.note, pattern),
        like(records.sourceName, pattern),
        like(records.authorName, pattern),
        like(records.summary, pattern),
        like(records.urlString, pattern)
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
  return rows.map((row) => toRecordItem(row, tagsByRecord.get(row.id) ?? []))
}

export function getRecord(db: Db, id: string): RecordItem | null {
  const row = db.select().from(records).where(eq(records.id, id)).get()
  if (!row) return null
  const tags = tagsForRecords(db, [id]).get(id) ?? []
  return toRecordItem(row, tags)
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
        // 链接的元数据由保存后的异步解析补全；非法 URL 直接 failed。
        metadataStatus: initialLinkStatus(draft.carrier, draft.urlString),
        createdAt: at,
        updatedAt: at
      })
      .run()
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
        metadataStatus: urlChanged
          ? initialLinkStatus(draft.carrier, draft.urlString)
          : (previous?.metadataStatus ?? 'idle'),
        mediaPath: draft.mediaPath,
        previewPath: draft.previewPath,
        updatedAt: at
      })
      .where(eq(records.id, id))
      .run()
    replaceTags(scoped, id, draft.tagIds)
    recordChange(scoped, { deviceId, entityType: 'record', entityId: id, operation: 'update' })
  })

  return getRecord(db, id)!
}

/**
 * 写入自动解析的元数据（§五：元数据只是展示信息）。
 * - `title/summary/sourceName/authorName` **只在为空时补**——用户手写的内容永远优先；
 * - 封面/仓库统计/内容 ID 是平台事实，直接写；
 * - 刷新失败但本地已有成功结果：保留 `ok` 状态与旧数据，不清空。
 */
/** 已有成功抓取结果的状态：ok（桌面）/ resolved、partial（iOS 同步原值）。 */
const METADATA_HAS_CONTENT: readonly string[] = ['ok', 'resolved', 'partial']

export function applyResolvedMetadata(
  db: Db,
  deviceId: string,
  id: string,
  expectedUrl: string,
  resolved: ResolvedLinkMetadata
): RecordItem | null {
  const row = db.select().from(records).where(eq(records.id, id)).get()
  // 记录已删除 → 丢弃结果，不留孤儿数据（§第三轮 3）
  if (!row) return null
  // 抓取期间载体/URL 变了 → 旧结果作废：不能拿旧链接的封面盖新链接
  if (row.carrier !== 'link' || row.urlString !== expectedUrl) return null
  const at = Date.now()
  // 刷新失败时**保留上一次的真实状态**：ok/resolved/partial 都代表「库里已有
  // 成功抓到的内容」，把 partial 悄悄升成 ok 等于对用户撒谎（§第四轮 三）。
  // 从未成功过（idle/pending/failed）才落到 failed；本次成功一律记 ok。
  const nextStatus =
    resolved.status === 'success'
      ? 'ok'
      : METADATA_HAS_CONTENT.includes(row.metadataStatus)
        ? row.metadataStatus
        : 'failed'

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    const result = scoped
      .update(records)
      .set({
        provider: resolved.provider,
        platformContentId: resolved.contentId ?? row.platformContentId,
        canonicalUrl: resolved.canonicalUrl || row.canonicalUrl,
        thumbnailUrlString: resolved.thumbnailUrl ?? row.thumbnailUrlString,
        title: row.title.trim() ? row.title : (resolved.title ?? row.title),
        summary: row.summary.trim() ? row.summary : (resolved.description ?? row.summary),
        sourceName: row.sourceName.trim() ? row.sourceName : (resolved.sourceName ?? row.sourceName),
        authorName: row.authorName.trim() ? row.authorName : (resolved.authorName ?? row.authorName),
        repositoryLanguage: resolved.repositoryLanguage ?? row.repositoryLanguage,
        repositoryStars: resolved.repositoryStars ?? row.repositoryStars,
        repositoryForks: resolved.repositoryForks ?? row.repositoryForks,
        repositoryLicense: resolved.repositoryLicense ?? row.repositoryLicense,
        metadataStatus: nextStatus,
        updatedAt: at
      })
      // WHERE 里同时带上 URL 与载体一致性：检查与写入之间没有竞态窗口，
      // 写入那一刻记录必须仍是「链接载体 + 同一 URL」（§第四轮 四）。
      .where(and(eq(records.id, id), eq(records.urlString, expectedUrl), eq(records.carrier, 'link')))
      .run()
    if (result.changes > 0) {
      recordChange(scoped, { deviceId, entityType: 'record', entityId: id, operation: 'update' })
    }
  })
  return getRecord(db, id)
}

/**
 * 链接记录的初始元数据状态：非链接载体 idle；链接且 URL 合法 pending；
 * **URL 非法直接 failed**——没人会去解析它，pending 会永远挂着（§第三轮 5）。
 */
function initialLinkStatus(carrier: string, urlString: string): 'idle' | 'pending' | 'failed' {
  if (carrier !== 'link' || !urlString.trim()) return 'idle'
  return parseLink(urlString).valid ? 'pending' : 'failed'
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

function toRecordItem(row: RecordRow, tagIds: string[]): RecordItem {
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
    metadataStatus: row.metadataStatus as RecordItem['metadataStatus'],
    repositoryStars: row.repositoryStars,
    repositoryForks: row.repositoryForks,
    repositoryLanguage: row.repositoryLanguage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tagIds
  }
}
