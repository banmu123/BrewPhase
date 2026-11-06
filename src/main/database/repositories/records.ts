import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import type { RecordDraft, RecordItem, RecordQuery, RecordTag } from '../../../shared/contracts'
import type { Db } from '../client'
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
        provider: draft.provider,
        sourceName: draft.sourceName,
        authorName: draft.authorName,
        summary: draft.summary,
        mediaPath: draft.mediaPath,
        previewPath: draft.previewPath,
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
        sourceName: draft.sourceName,
        authorName: draft.authorName,
        summary: draft.summary,
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
