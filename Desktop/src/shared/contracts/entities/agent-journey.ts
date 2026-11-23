import { z } from 'zod'

/**
 * Agent Journey 的 **Renderer 侧契约**（R6-4.1）。
 *
 * 与 MCP 工具入参（`shared/mcp/tool-schemas.ts` 的 snake_case）是两套东西：
 * 这里是本机 Renderer ↔ 主进程之间的 IPC DTO，字段命名跟随既有 canvas 契约
 * （`snake_case`），由 `validation/ipc.ts` 的 zod schema 在边界上校验。
 *
 * **local-first**：这些类型对应的数据全在 Desktop 本地库，
 * 不进 iOS 同步、`change_log` 或 Cloud。
 */

export const JOURNEY_LINK_TYPES = [
  'references',
  'supports',
  'produces',
  'validates',
  'related_to'
] as const
export const journeyLinkTypeSchema = z.enum(JOURNEY_LINK_TYPES)
export type JourneyLinkType = z.infer<typeof journeyLinkTypeSchema>

/** Records 页的 Journey 卡片：一条完整执行记录，不拆成普通 Record。 */
export const journeyCardSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  goal: z.string(),
  status: z.string(),
  source_client_id: z.string(),
  source_agent: z.string(),
  model: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  completed_at: z.number().int().nullable(),
  event_count: z.number().int(),
  link_count: z.number().int(),
  note_count: z.number().int(),
  summary: z.string()
})
export type JourneyCard = z.infer<typeof journeyCardSchema>

// ================================================================
// 结构化执行详情（R6-4.2）—— `metadata.journey_detail_v1`
//
// 为什么不新建字段：`metadata` 早就存在、早就递归脱敏、早就受长度预算
// 约束，而且**旧客户端已经在用**。新增顶层字段要动 MCP 契约、IPC 契约、
// Repository 与迁移；把版本化结构放进 metadata 的命名空间里，旧数据一个
// 字节都不用改，未来 `journey_detail_v2` 还能与 v1 共存。
//
// 三条硬规则：
// 1. **`.strict()`** —— 多写一个字段直接拒绝，AI 不能靠自由组合 JSON
//    绕开校验；
// 2. **逐字段长度上限 + 数组条数上限** —— 单个字段吃不掉整个预算；
// 3. **整包预算**在 `sanitize.ts` 的 `JOURNEY_METADATA_MAX`，
//    超限**拒绝**而不是截断（截断会留下解析不了的坏 JSON）。
// ================================================================

/** metadata 里结构化详情的命名空间键。 */
export const JOURNEY_DETAIL_KEY = 'journey_detail_v1'

/** 单个文件的修改记录。`symbols` / `line_range` 不确定时留空——**不许猜**。 */
export const journeyChangeSchema = z
  .object({
    /** 仓库相对路径（§11：优先相对路径，不存机器绝对路径）。 */
    file_path: z.string().min(1).max(400),
    change_type: z.enum(['created', 'modified', 'deleted', 'renamed']),
    symbols: z.array(z.string().min(1).max(200)).max(12).optional(),
    change_summary: z.string().min(1).max(600),
    before_behavior: z.string().max(500).optional(),
    after_behavior: z.string().max(500).optional(),
    /** 为什么改在这里：模块职责、上下游、设计边界。 */
    why_this_location: z.string().min(1).max(600),
    line_range: z
      .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
      .strict()
      .optional()
  })
  .strict()
export type JourneyChange = z.infer<typeof journeyChangeSchema>

export const journeyDecisionDetailSchema = z
  .object({
    selected_approach: z.string().min(1).max(600),
    rationale: z.string().min(1).max(600),
    alternatives: z
      .array(
        z
          .object({
            approach: z.string().min(1).max(400),
            reason_not_selected: z.string().min(1).max(400)
          })
          .strict()
      )
      .max(6)
      .optional(),
    tradeoffs: z.array(z.string().min(1).max(300)).max(6).optional()
  })
  .strict()
export type JourneyDecisionDetail = z.infer<typeof journeyDecisionDetailSchema>

export const journeyObservationDetailSchema = z
  .object({
    finding: z.string().min(1).max(600),
    impact: z.string().max(500).optional(),
    /** 信息来源：日志、测试输出、报错文本……不是「我觉得」。 */
    source: z.string().max(400).optional()
  })
  .strict()
export type JourneyObservationDetail = z.infer<typeof journeyObservationDetailSchema>

export const journeyVerificationDetailSchema = z
  .object({
    command: z.string().max(400).optional(),
    target: z.string().min(1).max(400),
    /** `not_run` / `skipped` 与 `passed` 平级——未执行绝不能写成通过。 */
    result: z.enum(['passed', 'failed', 'not_run', 'skipped']),
    exit_code: z.number().int().min(-255).max(65_535).optional(),
    summary: z.string().min(1).max(600),
    /** 可追溯引用（commit / 测试报告 / 文件），有才填。 */
    evidence_reference: z.string().max(400).optional()
  })
  .strict()
export type JourneyVerificationDetail = z.infer<typeof journeyVerificationDetailSchema>

export const journeyReferenceSchema = z
  .object({
    kind: z.enum(['commit', 'diff', 'test', 'file', 'record', 'url']),
    value: z.string().min(1).max(400),
    label: z.string().max(200).optional()
  })
  .strict()
export type JourneyReference = z.infer<typeof journeyReferenceSchema>

export const journeyDetailV1Schema = z
  .object({
    version: z.literal(1),
    decision: journeyDecisionDetailSchema.optional(),
    changes: z.array(journeyChangeSchema).max(12).optional(),
    observations: z.array(journeyObservationDetailSchema).max(12).optional(),
    verification: z.array(journeyVerificationDetailSchema).max(12).optional(),
    references: z.array(journeyReferenceSchema).max(12).optional(),
    limitations: z.array(z.string().min(1).max(500)).max(8).optional()
  })
  .strict()
export type JourneyDetailV1 = z.infer<typeof journeyDetailV1Schema>

/** 事件里结构化详情的便捷读取：不存在 / 版本不认识 / 结构非法 → null。 */
export function parseJourneyDetail(metadata: unknown): JourneyDetailV1 | null {
  if (metadata === null || metadata === undefined || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>)[JOURNEY_DETAIL_KEY]
  if (raw === null || raw === undefined) return null
  const parsed = journeyDetailV1Schema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * 库里的 `metadata` JSON 串 → 对象。
 *
 * 只接受**普通对象**：旧数据里可能有数组或坏 JSON，直接透传会让 Renderer
 * 拿到无法预测的形状。坏 JSON 返回 null 而不是抛错——读路径不该被一条
 * 脏数据打断。
 */
export function parseJourneyMetadataJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export const journeyEventSchema = z.object({
  id: z.string().uuid(),
  journey_id: z.string().uuid(),
  sequence: z.number().int(),
  event_type: z.string(),
  role: z.string(),
  status: z.string(),
  title: z.string(),
  summary: z.string(),
  content: z.string(),
  reason: z.string(),
  source_agent: z.string(),
  model: z.string(),
  /**
   * 证据等级。**永远只有 `agent_reported`**（R6-4.2 §7）：Agent 自己提交的
   * 内容不能自称系统观察到的。留这个字段是为了让 UI 能明确标注来源，
   * 也是未来接入真实运行时证据时的扩展点。
   */
  evidence_level: z.string(),
  occurred_at: z.number().int(),
  updated_at: z.number().int(),
  /**
   * 原始 metadata（写入时已递归脱敏 + 受长度预算约束）。
   * 结构化详情在 `metadata.journey_detail_v1`，用 `parseJourneyDetail()` 取。
   */
  metadata: z.record(z.string(), z.unknown()).nullable()
})
export type JourneyEventDTO = z.infer<typeof journeyEventSchema>

export const journeyEdgeSchema = z.object({
  id: z.string().uuid(),
  journey_id: z.string().uuid(),
  from_event_id: z.string().uuid(),
  to_event_id: z.string().uuid(),
  relationship_type: z.string(),
  created_at: z.number().int()
})
export type JourneyEdgeDTO = z.infer<typeof journeyEdgeSchema>

/** 用户笔记：Journey 级（event_id null）或 Event 级。与 Agent 原始事件分离。 */
export const journeyNoteSchema = z.object({
  id: z.string().uuid(),
  journey_id: z.string().uuid(),
  event_id: z.string().uuid().nullable(),
  body: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int()
})
export type JourneyNote = z.infer<typeof journeyNoteSchema>

/** Event ↔ Record 的跨记录关系（用户建立，删除不影响任一端）。 */
export const journeyRecordLinkSchema = z.object({
  id: z.string().uuid(),
  journey_id: z.string().uuid(),
  event_id: z.string().uuid(),
  record_id: z.string().uuid(),
  relationship_type: journeyLinkTypeSchema,
  created_at: z.number().int(),
  updated_at: z.number().int()
})
export type JourneyRecordLink = z.infer<typeof journeyRecordLinkSchema>

export const journeyDetailSchema = z.object({
  journey: journeyCardSchema,
  events: z.array(journeyEventSchema),
  edges: z.array(journeyEdgeSchema),
  notes: z.array(journeyNoteSchema),
  links: z.array(journeyRecordLinkSchema)
})
export type JourneyDetail = z.infer<typeof journeyDetailSchema>

/** 画布上一条已放置的 Journey：分组摆位 + 内容 + 组内事件摆位。 */
export const canvasJourneyPlacementSchema = z.object({
  id: z.string().uuid(),
  canvas_id: z.string().uuid(),
  journey_id: z.string().uuid(),
  event_id: z.string().uuid().nullable(),
  position_x: z.number(),
  position_y: z.number(),
  width: z.number(),
  height: z.number(),
  z_index: z.number().int(),
  collapsed: z.boolean(),
  updated_at: z.number().int()
})
export type CanvasJourneyPlacement = z.infer<typeof canvasJourneyPlacementSchema>

export const canvasJourneySchema = z.object({
  placement: canvasJourneyPlacementSchema,
  journey: z.object({
    id: z.string().uuid(),
    title: z.string(),
    goal: z.string(),
    status: z.string(),
    source_agent: z.string(),
    model: z.string(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    completed_at: z.number().int().nullable()
  }).nullable(),
  events: z.array(journeyEventSchema),
  edges: z.array(journeyEdgeSchema),
  nodes: z.array(canvasJourneyPlacementSchema),
  /** 跨记录关系：渲染层按 event → record 逐条画线。 */
  links: z.array(journeyRecordLinkSchema)
})
export type CanvasJourney = z.infer<typeof canvasJourneySchema>
