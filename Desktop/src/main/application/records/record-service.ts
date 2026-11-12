import { inArray } from 'drizzle-orm'
import type {
  ImportImageResult,
  RecordDraft,
  RecordItem,
  RecordQuery,
  RecordTag
} from '../../../shared/contracts'
import {
  CHROME_MAX_DESCRIPTION,
  CHROME_MAX_SELECTED_TEXT,
  CHROME_MAX_TITLE,
  type ChromePagePayload
} from '../../../shared/contracts'
import { formatChromeCaptureNote } from '../../../shared/chrome-note'
import { parseLink } from '../../../shared/link-parser'
import type { Db } from '../../database/client'
import {
  createRecord,
  createTag,
  deleteRecord,
  getRecord,
  listRecords,
  listTags,
  updateRecord
} from '../../database/repositories/records'
import { recordTags } from '../../database/schema'
import type { ApplicationEvents } from '../events/application-events'
import { ApplicationError } from '../errors'

/**
 * 记录的业务入口：Renderer IPC 与 MCP Bridge 共用。
 *
 * 两条路径的区别只在「谁来组装 draft」：
 * - `*FromDraft`：renderer 已经用 parseLink 组好完整 draft（既有行为，原样透传）；
 * - `*ForMcp`：AI 只给 title/note/url/tag_ids，URL 规范化与载体规则在这里补齐。
 *
 * Repository 仍然拥有事务、change_log、本地元数据播种与标签关系写入——
 * 这里不复制任何一条。
 */

export type McpCreateRecordInput = {
  carrier: 'link' | 'text'
  title?: string
  note?: string
  url?: string
  tagIds?: string[]
}

export type McpUpdateRecordInput = {
  recordId: string
  expectedUpdatedAt: number
  patch: { title?: string; note?: string; url?: string; tagIds?: string[] }
}

/** MCP 返回的搜索页：不谎报 total，只给当前页与是否还有下一页。 */
export type McpRecordPage = {
  items: McpRecordDto[]
  limit: number
  offset: number
  has_more: boolean
}

/** MCP 的记录视图：snake_case；媒体只给布尔，标签只给 id（名字用 list_record_tags 查）。 */
export type McpRecordDto = {
  id: string
  carrier: string
  title: string
  note: string
  url: string | null
  canonical_url: string | null
  provider: string
  platform_content_id: string | null
  source_name: string
  author_name: string
  summary: string
  has_media: boolean
  metadata_status: string
  tag_ids: string[]
  metadata: {
    title: string | null
    description: string | null
    thumbnail_url: string | null
    source_name: string | null
    author_name: string | null
    repository_stars: number | null
    repository_forks: number | null
    repository_language: string | null
    repository_license: string | null
    status: string
  } | null
  created_at: number
  updated_at: number
}

const DEFAULT_PAGE = 20
const MAX_PAGE = 50
/** 列表里的正文截断得更短——搜索结果是索引，不是正文阅读器。 */
const LIST_NOTE_LIMIT = 400
const DETAIL_NOTE_LIMIT = 4_000

export function recordMcpDto(item: RecordItem, noteLimit = DETAIL_NOTE_LIMIT): McpRecordDto {
  return {
    id: item.id,
    carrier: item.carrier,
    title: item.title,
    note: truncate(item.note, noteLimit),
    url: item.urlString || null,
    canonical_url: item.canonicalURL,
    provider: item.provider,
    platform_content_id: item.platformContentID,
    source_name: item.sourceName,
    author_name: item.authorName,
    summary: truncate(item.summary, noteLimit),
    has_media: Boolean(item.mediaPath || item.previewPath),
    metadata_status: item.metadataStatus,
    tag_ids: item.tagIds,
    metadata: item.metadata
      ? {
          title: item.metadata.title,
          description: item.metadata.description,
          thumbnail_url: item.metadata.thumbnailUrl,
          source_name: item.metadata.sourceName,
          author_name: item.metadata.authorName,
          repository_stars: item.metadata.repositoryStars,
          repository_forks: item.metadata.repositoryForks,
          repository_language: item.metadata.repositoryLanguage,
          repository_license: item.metadata.repositoryLicense,
          status: item.metadata.status
        }
      : null,
    created_at: item.createdAt,
    updated_at: item.updatedAt
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

export class RecordService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string,
    private readonly events: ApplicationEvents,
    /** 与同步落库后的补全共用同一条队列（main/index.ts 注入，接收 record id 列表）。 */
    private readonly scheduleMetadata: (recordIds: string[]) => void
  ) {}

  // MARK: - Renderer IPC 路径
  //
  // 这些方法**不发 app:changed**：Renderer 写入后自己刷新，再收到一次事件只会
  // 变成双重加载。事件只服务 MCP 写入（页面没有发起请求，需要被通知）。

  list(query: RecordQuery): RecordItem[] {
    return listRecords(this.db, query)
  }

  get(id: string): RecordItem | null {
    return getRecord(this.db, id)
  }

  listTags(): RecordTag[] {
    return listTags(this.db)
  }

  createFromDraft(draft: RecordDraft): RecordItem {
    return createRecord(this.db, this.deviceId, draft)
  }

  /**
   * Chrome Companion 的落库入口：**复用同一条 createRecord 链路**。
   *
   * 字段归属（第一版不改表结构）：
   * - `title`   ← 网页标题；
   * - `note`    ← 用户选中的文字（链接记录的备注位，天然是「我的摘录」）；
   * - `summary` ← `<meta name="description">` 的纯文本；
   * - URL 走 `parseLink`，canonical / provider / contentId 与手动新建链接一致。
   *
   * 写入来自主进程序列（Native Messaging），Renderer 不会发起，所以要广播
   * `records` 事件让列表自己刷新——与 MCP 写入的处理一致。
   */
  createFromChrome(payload: ChromePagePayload): RecordItem {
    const parsed = parseLink(payload.url)
    if (!parsed.valid) {
      throw new ApplicationError('VALIDATION_ERROR', 'url is not a valid http(s) link')
    }

    const draft: RecordDraft = {
      carrier: 'link',
      title: payload.title.trim().slice(0, CHROME_MAX_TITLE),
      note: payload.selectedText.trim().slice(0, CHROME_MAX_SELECTED_TEXT),
      urlString: payload.url,
      canonicalURL: parsed.canonicalUrl,
      platformContentID: parsed.contentId,
      provider: parsed.provider,
      sourceName: '',
      authorName: '',
      summary: payload.description.trim().slice(0, CHROME_MAX_DESCRIPTION),
      mediaPath: null,
      previewPath: null,
      tagIds: []
    }

    const record = createRecord(this.db, this.deviceId, draft)
    this.scheduleMetadata([record.id])
    this.events.emit('records')
    return record
  }

  /**
   * Chrome 图片 / 截图：媒体文件已经由 `media/store` 落盘，这里只创建记录。
   *
   * 写入失败时由调用方删除已生成的媒体文件（不能留下没有记录的孤儿文件）。
   * `note` 用统一格式区分「网页摘录 / 我的备注 / 来源」。
   */
  createImageFromChrome(input: {
    media: ImportImageResult
    title: string
    sourceUrl: string
    selectedText: string
    note: string
  }): RecordItem {
    const draft: RecordDraft = {
      carrier: 'image',
      title: input.title.trim().slice(0, CHROME_MAX_TITLE),
      note: formatChromeCaptureNote(input),
      urlString: input.sourceUrl,
      canonicalURL: null,
      platformContentID: null,
      provider: 'generic',
      sourceName: '',
      authorName: '',
      summary: '',
      mediaPath: input.media.fileName,
      previewPath: input.media.previewName,
      tagIds: []
    }

    const record = createRecord(this.db, this.deviceId, draft)
    this.events.emit('records')
    return record
  }

  updateFromDraft(id: string, draft: RecordDraft): RecordItem {
    return updateRecord(this.db, this.deviceId, id, draft)
  }

  delete(id: string): void {
    deleteRecord(this.db, this.deviceId, id)
  }

  createTagFromRenderer(name: string): RecordTag {
    return createTag(this.db, this.deviceId, name)
  }

  // MARK: - MCP 路径

  searchForMcp(input: {
    search?: string
    carrier?: 'link' | 'image' | 'video' | 'text'
    tagId?: string
    limit?: number
    offset?: number
  }): McpRecordPage {
    const limit = clampPage(input.limit, DEFAULT_PAGE, MAX_PAGE)
    const offset = input.offset ?? 0
    // 多取一条判断 has_more，不额外做 count 查询。
    const rows = listRecords(this.db, {
      search: input.search ?? '',
      carrier: input.carrier ?? null,
      tagId: input.tagId ?? null,
      limit: limit + 1,
      offset
    })
    const hasMore = rows.length > limit
    return {
      items: rows.slice(0, limit).map((item) => recordMcpDto(item, LIST_NOTE_LIMIT)),
      limit,
      offset,
      has_more: hasMore
    }
  }

  getForMcp(id: string): McpRecordDto {
    const record = getRecord(this.db, id)
    if (!record) throw new ApplicationError('NOT_FOUND', `record ${id} not found`)
    return recordMcpDto(record)
  }

  createForMcp(input: McpCreateRecordInput): McpRecordDto {
    const tagIds = this.requireTags(input.tagIds ?? [])
    const title = input.title?.trim() ?? ''
    const note = input.note ?? ''

    let draft: RecordDraft
    if (input.carrier === 'link') {
      const raw = (input.url ?? '').trim()
      if (!raw) throw new ApplicationError('VALIDATION_ERROR', 'carrier=link requires url')
      const parsed = parseLink(raw)
      if (!parsed.valid) throw new ApplicationError('VALIDATION_ERROR', 'url is not a valid http(s) link')
      draft = {
        carrier: 'link',
        title,
        note,
        urlString: raw,
        canonicalURL: parsed.canonicalUrl,
        platformContentID: parsed.contentId,
        provider: parsed.provider,
        sourceName: '',
        authorName: '',
        summary: '',
        mediaPath: null,
        previewPath: null,
        tagIds
      }
    } else {
      if ((input.url ?? '').trim()) {
        throw new ApplicationError('VALIDATION_ERROR', 'carrier=text does not accept url')
      }
      draft = {
        carrier: 'text',
        title,
        note,
        urlString: '',
        canonicalURL: null,
        platformContentID: null,
        provider: 'generic',
        sourceName: '',
        authorName: '',
        summary: '',
        mediaPath: null,
        previewPath: null,
        tagIds
      }
    }

    const record = createRecord(this.db, this.deviceId, draft)
    // 链接记录：进同一条本地元数据补全队列（与 renderer 手动刷新后的路径一致）。
    if (record.carrier === 'link') this.scheduleMetadata([record.id])
    this.events.emit('records')
    return recordMcpDto(record)
  }

  updateForMcp(input: McpUpdateRecordInput): McpRecordDto {
    const current = getRecord(this.db, input.recordId)
    if (!current) throw new ApplicationError('NOT_FOUND', `record ${input.recordId} not found`)
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new ApplicationError(
        'STALE_RECORD',
        `record changed since ${input.expectedUpdatedAt} (now ${current.updatedAt}); re-read and retry`
      )
    }

    const { patch } = input
    const tagIds = patch.tagIds ? this.requireTags(patch.tagIds) : current.tagIds
    const urlProvided = patch.url !== undefined
    const nextUrl = urlProvided ? patch.url!.trim() : current.urlString

    if (current.carrier === 'link') {
      if (urlProvided) {
        const parsed = parseLink(nextUrl)
        if (!parsed.valid) throw new ApplicationError('VALIDATION_ERROR', 'url is not a valid http(s) link')
      }
    } else if (urlProvided) {
      throw new ApplicationError('VALIDATION_ERROR', 'text records do not accept url')
    }

    const parsed = current.carrier === 'link' ? parseLink(nextUrl) : null
    const draft: RecordDraft = {
      carrier: current.carrier,
      title: patch.title !== undefined ? patch.title : current.title,
      note: patch.note !== undefined ? patch.note : current.note,
      urlString: current.carrier === 'link' ? nextUrl : '',
      canonicalURL: parsed?.valid ? parsed.canonicalUrl : current.canonicalURL,
      platformContentID: parsed?.valid ? parsed.contentId : current.platformContentID,
      provider: parsed?.valid ? parsed.provider : current.provider,
      sourceName: current.sourceName,
      authorName: current.authorName,
      summary: current.summary,
      // 媒体字段原样带过——MCP 永远不能改它们。
      mediaPath: current.mediaPath,
      previewPath: current.previewPath,
      tagIds
    }

    const record = updateRecord(this.db, this.deviceId, current.id, draft)
    if (urlProvided && current.carrier === 'link' && nextUrl !== current.urlString) {
      this.scheduleMetadata([record.id])
    }
    this.events.emit('records')
    return recordMcpDto(record)
  }

  createTagForMcp(name: string): RecordTag {
    const trimmed = name.trim()
    if (!trimmed) throw new ApplicationError('VALIDATION_ERROR', 'tag name must not be empty')
    if (trimmed.length > 40) throw new ApplicationError('VALIDATION_ERROR', 'tag name is limited to 40 characters')
    const tag = createTag(this.db, this.deviceId, trimmed)
    this.events.emit('records')
    return tag
  }

  /** 标签必须全部存在——外键会在事务里报 SQLITE_CONSTRAINT，那太晚也太丑。 */
  private requireTags(tagIds: string[]): string[] {
    const unique = [...new Set(tagIds)]
    if (unique.length === 0) return []
    const found = this.db
      .select({ id: recordTags.id })
      .from(recordTags)
      .where(inArray(recordTags.id, unique))
      .all()
    if (found.length !== unique.length) {
      const known = new Set(found.map((row) => row.id))
      const missing = unique.filter((id) => !known.has(id))
      throw new ApplicationError('NOT_FOUND', `unknown tag id(s): ${missing.join(', ')}`)
    }
    return unique
  }
}

function clampPage(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}
