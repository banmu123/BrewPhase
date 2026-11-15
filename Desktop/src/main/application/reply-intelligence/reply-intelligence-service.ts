import { randomUUID } from 'node:crypto'
import { clipboard } from 'electron'
import type { Db } from '../../database/client'
import {
  deleteDraft,
  deleteReply,
  deleteSegment,
  insertDraft,
  insertReply,
  insertSegments,
  listDrafts,
  listReplies,
  selectDraft,
  selectReply,
  selectSegment,
  selectSegments,
  updateDraft,
  updateSegment,
  type ActionDraftRow,
  type CapturedReplyRow,
  type ReplySegmentRow
} from '../../database/repositories/reply-intelligence'
import { LocalWorkspaceService } from '../local-workspace/local-workspace-service'
import { ApplicationError } from '../errors'
import { type AIAdapterRegistry } from '../../ai-chat/adapters/registry'
import { createDefaultRegistry } from '../../ai-chat/adapters/platform-catalog'
import {
  ACTION_DRAFT_LIMIT,
  REPLY_RAW_MAX_CHARS,
  type ActionDraft,
  type ActionDraftPayload,
  type ActionRiskLevel,
  type CapturedReply,
  type ParsedSegment,
  type ReplyCaptureMethod,
  type ReplyDetail,
  type ReplySegment
} from '../../../shared/contracts/reply-intelligence'
import { extractDraftCandidates, hasRiskyCommand, parseReply } from './reply-parser'

/**
 * ReplyIntelligenceService：AI 回复导入 / 分类 / 操作草稿（Phase 2）。
 *
 * 来源合规（规格 §三/§九）：只有两条用户主动路径——
 * - `captureFromClipboard`：用户点了「从剪贴板导入」，主进程读取**一次**；
 * - `captureFromPaste`：用户在输入区粘贴后确认。
 * 没有轮询、没有监听、没有 DOM 提取、没有自动发送到任何云端模型。
 *
 * 平台识别复用 Adapter Registry（严格主机名匹配）；工作区关联复用
 * LocalWorkspaceService 的卡片绑定。数据只进本地库（migration 13）。
 *
 * 风险（规格 §八）：解析出的命令 / Patch / 路径只是**候选文本**；草稿
 * status 恒 'draft'、requiresApproval 恒 true——本阶段没有执行通道。
 */

export class ReplyIntelligenceError extends ApplicationError {
  constructor(
    code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PERMISSION_DENIED',
    message: string
  ) {
    super(code, message)
    this.name = 'ReplyIntelligenceError'
  }
}

export type ReplySource = { url: string; title: string } | null

const REPLY_LIST_LIMIT = 100

export class ReplyIntelligenceService {
  private readonly registry: AIAdapterRegistry

  constructor(
    private readonly db: Db,
    private readonly events: { emit: (domain: 'replyIntelligence') => void },
    private readonly workspaces: LocalWorkspaceService,
    private readonly resolveTab: (tabId: string) => ReplySource,
    registry?: AIAdapterRegistry
  ) {
    this.registry = registry ?? createDefaultRegistry()
  }

  // MARK: - 导入

  /** 从剪贴板导入：用户点击按钮触发的**一次性**读取。 */
  async captureFromClipboard(tabId: string): Promise<ReplyDetail> {
    const text = await clipboard.readText()
    if (!text || text.trim() === '') {
      throw new ReplyIntelligenceError('VALIDATION_ERROR', '剪贴板里没有文本内容')
    }
    return this.capture(tabId, 'clipboard_import', text)
  }

  /** 手动粘贴导入：用户在输入区确认后调用。 */
  captureFromPaste(tabId: string, content: string): ReplyDetail {
    return this.capture(tabId, 'manual_paste', content)
  }

  private capture(tabId: string, method: ReplyCaptureMethod, rawText: string): ReplyDetail {
    const content = rawText.trim()
    if (!content) {
      throw new ReplyIntelligenceError('VALIDATION_ERROR', '回复内容为空')
    }
    if (content.length > REPLY_RAW_MAX_CHARS) {
      throw new ReplyIntelligenceError(
        'VALIDATION_ERROR',
        `回复超过长度上限（${Math.round(REPLY_RAW_MAX_CHARS / 10_000)} 万字符）`
      )
    }

    const source = this.resolveTab(tabId)
    const provider = source ? this.registry.resolve(source.url) : null
    const binding = this.workspaces.binding(tabId)
    const now = Date.now()

    const reply: CapturedReplyRow = {
      id: randomUUID(),
      providerId: provider?.descriptor.id ?? '',
      providerName: provider?.descriptor.displayName ?? '',
      sourceUrl: source?.url ?? '',
      sourceTitle: source?.title ?? '',
      tabId,
      workspaceId: binding.workspace?.id ?? null,
      captureMethod: method,
      rawContent: content,
      capturedAt: now,
      createdAt: now
    }
    const parsed = parseReply(content)
    insertReply(this.db, reply)
    insertSegments(
      this.db,
      parsed.map((segment) => this.toSegmentRow(reply.id, segment))
    )
    this.events.emit('replyIntelligence')
    return { reply: this.toReplyDto(reply), segments: this.toSegmentDtos(selectSegments(this.db, reply.id)) }
  }

  // MARK: - 查询

  list(limit: number): CapturedReply[] {
    return listReplies(this.db, Math.min(Math.max(1, limit), REPLY_LIST_LIMIT)).map((row) =>
      this.toReplyDto(row)
    )
  }

  detail(id: string): ReplyDetail {
    const reply = selectReply(this.db, id)
    if (!reply) throw new ReplyIntelligenceError('NOT_FOUND', `reply ${id} does not exist`)
    return { reply: this.toReplyDto(reply), segments: this.toSegmentDtos(selectSegments(this.db, id)) }
  }

  remove(id: string): void {
    // FK ON DELETE CASCADE：segments 与 drafts 随回复一起删除。
    if (!deleteReply(this.db, id)) {
      throw new ReplyIntelligenceError('NOT_FOUND', `reply ${id} does not exist`)
    }
    this.events.emit('replyIntelligence')
  }

  // MARK: - 分段编辑

  /** 用户改分类 / 内容：user_edited 置真，解析器永不再覆盖。 */
  updateSegment(id: string, categories: ReplySegment['categories'], content?: string): ReplySegment {
    const row = selectSegment(this.db, id)
    if (!row) throw new ReplyIntelligenceError('NOT_FOUND', `segment ${id} does not exist`)
    const updated = updateSegment(
      this.db,
      id,
      { categories: JSON.stringify(categories), content, userEdited: true }
    )
    this.events.emit('replyIntelligence')
    return this.toSegmentDto(updated!)
  }

  removeSegment(id: string): void {
    if (!deleteSegment(this.db, id)) {
      throw new ReplyIntelligenceError('NOT_FOUND', `segment ${id} does not exist`)
    }
    this.events.emit('replyIntelligence')
  }

  // MARK: - 操作草稿

  /** 从分段（或整条回复）创建操作草稿：来源关系与工作区绑定一并保存。 */
  createDraft(input: { replyId: string; segmentId?: string | null }): ActionDraft {
    const reply = selectReply(this.db, input.replyId)
    if (!reply) throw new ReplyIntelligenceError('NOT_FOUND', `reply ${input.replyId} does not exist`)
    let segment: ReplySegmentRow | null = null
    if (input.segmentId) {
      segment = selectSegment(this.db, input.segmentId)
      if (!segment || segment.replyId !== input.replyId) {
        throw new ReplyIntelligenceError('VALIDATION_ERROR', '分段不属于这条回复')
      }
    }

    const content = segment?.content ?? reply.rawContent
    const categories: string[] = segment ? this.parseCategories(segment.categories) : []
    const candidates = extractDraftCandidates(content)
    const payload = this.buildPayload(reply.workspaceId, candidates)
    const title =
      (segment?.content ?? reply.rawContent)
        .split('\n')
        .map((line) => line.replace(/^[#>\-*\s`]+/, '').trim())
        .find((line) => line.length > 0)
        ?.slice(0, 120) ?? '未命名操作'
    const actionType = this.pickActionType(categories)

    const draft: ActionDraftRow = {
      id: randomUUID(),
      replyId: reply.id,
      segmentId: segment?.id ?? null,
      // 创建时的来源绑定：之后切换卡片工作区不会静默改写历史草稿。
      workspaceId: reply.workspaceId,
      actionType,
      title: title || '未命名操作',
      description: content.slice(0, 2_000),
      payload: JSON.stringify(payload),
      workingDirectory: '',
      riskLevel: hasRiskyCommand(content) ? 'caution' : 'normal',
      requiresApproval: true,
      status: 'draft',
      createdAt: now2(),
      updatedAt: now2()
    }
    insertDraft(this.db, draft)
    this.events.emit('replyIntelligence')
    return this.toDraftDto(draft)
  }

  updateDraft(
    id: string,
    patch: {
      title?: string
      description?: string
      workingDirectory?: string
      riskLevel?: ActionRiskLevel
    }
  ): ActionDraft {
    const row = selectDraft(this.db, id)
    if (!row) throw new ReplyIntelligenceError('NOT_FOUND', `draft ${id} does not exist`)
    // 工作目录只存相对路径：剥掉工作区根前缀（不阻止保存，防御性归一）。
    let workingDirectory = patch.workingDirectory
    if (workingDirectory !== undefined && row.workspaceId) {
      workingDirectory = relativize(workingDirectory, row.workspaceId, this.workspaces)
    }
    const updated = updateDraft(
      this.db,
      id,
      {
        ...(patch.title !== undefined ? { title: patch.title.slice(0, 200) } : {}),
        ...(patch.description !== undefined ? { description: patch.description.slice(0, 4_000) } : {}),
        ...(workingDirectory !== undefined ? { workingDirectory } : {}),
        ...(patch.riskLevel !== undefined ? { riskLevel: patch.riskLevel } : {})
      },
      now2()
    )
    this.events.emit('replyIntelligence')
    return this.toDraftDto(updated!)
  }

  removeDraft(id: string): void {
    if (!deleteDraft(this.db, id)) {
      throw new ReplyIntelligenceError('NOT_FOUND', `draft ${id} does not exist`)
    }
    this.events.emit('replyIntelligence')
  }

  listDrafts(replyId: string | null, limit: number): ActionDraft[] {
    return listDrafts(this.db, replyId, Math.min(Math.max(1, limit), ACTION_DRAFT_LIMIT)).map((row) =>
      this.toDraftDto(row)
    )
  }

  // MARK: - 内部

  private buildPayload(
    workspaceId: string | null,
    candidates: ReturnType<typeof extractDraftCandidates>
  ): ActionDraftPayload {
    let outside = false
    let filePaths = candidates.filePaths
    if (workspaceId && filePaths.length > 0) {
      try {
        const root = this.workspaces.resolveRoot(workspaceId)
        filePaths = filePaths.map((path) => {
          const normalized = path.replace(/\\/g, '/')
          const rootNorm = root.replace(/\\/g, '/')
          if (normalized.toLowerCase().startsWith(rootNorm.toLowerCase())) {
            return normalized.slice(rootNorm.length).replace(/^\/+/, '')
          }
          outside = true
          return path
        })
      } catch {
        // 工作区已失效：路径保持原样并标记 outside。
        outside = true
      }
    } else if (filePaths.length > 0) {
      outside = true
    }
    return {
      commands: candidates.commands,
      codeBlocks: candidates.codeBlocks,
      filePaths,
      pathsOutsideWorkspace: outside
    }
  }

  private pickActionType(categories: string[]): string {
    for (const priority of ['shell_command', 'patch', 'operation', 'code_example']) {
      if (categories.includes(priority)) return priority
    }
    return categories[0] ?? 'operation'
  }

  private parseCategories(json: string): string[] {
    try {
      const parsed = JSON.parse(json)
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  private toSegmentRow(replyId: string, segment: ParsedSegment): ReplySegmentRow {
    return {
      id: randomUUID(),
      replyId,
      sequence: segment.sequence,
      categories: JSON.stringify(segment.categories),
      content: segment.content,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      confidence: segment.confidence,
      reason: segment.reason,
      userEdited: false
    }
  }

  private toReplyDto(row: CapturedReplyRow): CapturedReply {
    return {
      id: row.id,
      providerId: row.providerId,
      providerName: row.providerName,
      sourceUrl: row.sourceUrl,
      sourceTitle: row.sourceTitle,
      tabId: row.tabId,
      workspaceId: row.workspaceId,
      captureMethod: row.captureMethod === 'clipboard_import' ? 'clipboard_import' : 'manual_paste',
      rawContent: row.rawContent,
      capturedAt: row.capturedAt,
      createdAt: row.createdAt
    }
  }

  private toSegmentDtos(rows: ReplySegmentRow[]): ReplySegment[] {
    return rows.map((row) => this.toSegmentDto(row))
  }

  private toSegmentDto(row: ReplySegmentRow): ReplySegment {
    return {
      id: row.id,
      replyId: row.replyId,
      sequence: row.sequence,
      categories: this.parseCategories(row.categories) as ReplySegment['categories'],
      content: row.content,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
      confidence: row.confidence,
      reason: row.reason,
      userEdited: row.userEdited
    }
  }

  private toDraftDto(row: ActionDraftRow): ActionDraft {
    let payload: ActionDraftPayload
    try {
      const parsed = actionPayloadFromJson(row.payload)
      payload = parsed
    } catch {
      payload = { commands: [], codeBlocks: [], filePaths: [], pathsOutsideWorkspace: false }
    }
    return {
      id: row.id,
      replyId: row.replyId,
      segmentId: row.segmentId,
      workspaceId: row.workspaceId,
      actionType: row.actionType,
      title: row.title,
      description: row.description,
      payload,
      workingDirectory: row.workingDirectory,
      riskLevel: row.riskLevel === 'caution' ? 'caution' : 'normal',
      requiresApproval: true,
      status: 'draft',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }
}

function actionPayloadFromJson(json: string): ActionDraftPayload {
  const raw = JSON.parse(json) as Partial<ActionDraftPayload>
  return {
    commands: Array.isArray(raw.commands) ? raw.commands.slice(0, 20) : [],
    codeBlocks: Array.isArray(raw.codeBlocks) ? raw.codeBlocks.slice(0, 10) : [],
    filePaths: Array.isArray(raw.filePaths) ? raw.filePaths.slice(0, 30) : [],
    pathsOutsideWorkspace: raw.pathsOutsideWorkspace === true
  }
}

function now2(): number {
  return Date.now()
}

/** 草稿工作目录只存相对路径；绝对路径若在工作区内则剥前缀，否则原样。 */
function relativize(
  path: string,
  workspaceId: string,
  workspaces: { resolveRoot(workspaceId: string): string }
): string {
  const trimmed = path.trim()
  if (!trimmed || !/[\\/]/.test(trimmed)) return trimmed
  try {
    const root = workspaces.resolveRoot(workspaceId)
    const normalized = trimmed.replace(/\\/g, '/')
    const rootNorm = root.replace(/\\/g, '/')
    if (normalized.toLowerCase().startsWith(rootNorm.toLowerCase())) {
      return normalized.slice(rootNorm.length).replace(/^\/+/, '')
    }
    return normalized
  } catch {
    // 工作区已失效：保持原样（不猜相对路径）。
    return trimmed
  }
}
