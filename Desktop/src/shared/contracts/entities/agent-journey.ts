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
  occurred_at: z.number().int(),
  updated_at: z.number().int()
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
