import { z } from 'zod'

/**
 * AI Reply Intelligence（Phase 2）：用户主动交接的 AI 回复 → 本地解析 →
 * 分类分段 → 操作任务草稿。
 *
 * 三条合规铁律（规格 §八/§九）：
 * 1. 内容来源只有「用户复制 / 粘贴 + 明确导入」——没有任何后台监听、
 *    DOM 轮询或自动提取；剪贴板只在用户点击按钮时由主进程读取一次。
 * 2. 解析是**本地规则**，不调用外部模型、不调用 Shell、不写文件、不执行。
 * 3. 所有 ActionDraft 从 draft 起步、requiresApproval 恒 true——本阶段
 *    没有任何执行通道。
 *
 * 只进本地库，不进 change_log / iOS 同步。
 */

export const REPLY_CATEGORIES = [
  'key_point',
  'knowledge',
  'copywriting',
  'resource',
  'operation',
  'shell_command',
  'code_example',
  'patch',
  'follow_up',
  'warning'
] as const
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number]
export const replyCategorySchema = z.enum(REPLY_CATEGORIES)

export const REPLY_CAPTURE_METHODS = ['clipboard_import', 'manual_paste'] as const
export type ReplyCaptureMethod = (typeof REPLY_CAPTURE_METHODS)[number]
export const replyCaptureMethodSchema = z.enum(REPLY_CAPTURE_METHODS)

/** 原始回复上限（约 30 万字符，覆盖超长回复）；分段数上限。 */
export const REPLY_RAW_MAX_CHARS = 300_000
export const REPLY_MAX_SEGMENTS = 500
/** 草稿列表查询上限。 */
export const ACTION_DRAFT_LIMIT = 200

const uuid = z.string().uuid()

export const capturedReplySchema = z.object({
  id: uuid,
  /** 平台 Registry 按 URL 识别；未识别平台为空串（generic）。 */
  providerId: z.string().max(64),
  providerName: z.string().max(120),
  sourceUrl: z.string().max(2_048),
  sourceTitle: z.string().max(512),
  tabId: z.string().max(64),
  workspaceId: uuid.nullable(),
  captureMethod: replyCaptureMethodSchema,
  rawContent: z.string().min(1).max(REPLY_RAW_MAX_CHARS),
  capturedAt: z.number().int(),
  createdAt: z.number().int()
})
export type CapturedReply = z.infer<typeof capturedReplySchema>

export const replySegmentSchema = z.object({
  id: uuid,
  replyId: uuid,
  sequence: z.number().int().nonnegative(),
  /** 多标签：一段内容可以同时是 operation + shell_command。 */
  categories: z.array(replyCategorySchema).min(1).max(4),
  content: z.string().max(REPLY_RAW_MAX_CHARS),
  /** 指向 raw_content 的原文偏移——分类结果永远能回到原始上下文。 */
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  /** 0..1；低于 0.6 的候选 UI 显示「待确认」，不伪装成确定事实。 */
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
  userEdited: z.boolean()
})
export type ReplySegment = z.infer<typeof replySegmentSchema>

export const replyDetailSchema = z.object({
  reply: capturedReplySchema,
  segments: z.array(replySegmentSchema).max(REPLY_MAX_SEGMENTS)
})
export type ReplyDetail = z.infer<typeof replyDetailSchema>

/** 草稿的结构化 payload：解析器提取的命令 / 代码块 / 文件路径候选。 */
export const actionDraftPayloadSchema = z.object({
  commands: z.array(z.string().max(2_000)).max(20),
  codeBlocks: z
    .array(z.object({ language: z.string().max(40), content: z.string().max(20_000) }))
    .max(10),
  filePaths: z.array(z.string().max(1_024)).max(30),
  /** 提取的路径是否落在工作区之外（提示风险；不阻止保存草稿）。 */
  pathsOutsideWorkspace: z.boolean()
})
export type ActionDraftPayload = z.infer<typeof actionDraftPayloadSchema>
export const actionDraftPayloadJsonSchema = actionDraftPayloadSchema.default({
  commands: [],
  codeBlocks: [],
  filePaths: [],
  pathsOutsideWorkspace: false
})

export const ACTION_RISK_LEVELS = ['normal', 'caution'] as const
export type ActionRiskLevel = (typeof ACTION_RISK_LEVELS)[number]
export const actionRiskLevelSchema = z.enum(ACTION_RISK_LEVELS)

export const actionDraftSchema = z.object({
  id: uuid,
  replyId: uuid,
  segmentId: uuid.nullable(),
  workspaceId: uuid.nullable(),
  actionType: z.string().max(40),
  title: z.string().min(1).max(200),
  description: z.string().max(4_000),
  payload: actionDraftPayloadSchema,
  /** 相对工作区的目录；'' = 工作区根。绝不保存绝对路径。 */
  workingDirectory: z.string().max(1_024),
  riskLevel: actionRiskLevelSchema,
  /** 恒 true：本阶段没有执行通道，任何草稿都不会被自动执行。 */
  requiresApproval: z.literal(true),
  status: z.literal('draft'),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type ActionDraft = z.infer<typeof actionDraftSchema>

/** 解析器输出（capture 时落库前的中间形态）。 */
export const parsedSegmentSchema = z.object({
  sequence: z.number().int().nonnegative(),
  categories: z.array(replyCategorySchema).min(1).max(4),
  content: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500)
})
export type ParsedSegment = z.infer<typeof parsedSegmentSchema>
