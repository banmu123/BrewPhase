import { z } from 'zod'
import type { McpScope } from '../contracts/mcp'
import { journeyDetailV1Schema } from '../contracts/entities/agent-journey'

/**
 * MCP 工具清单的**唯一事实来源**。
 *
 * - MCP STDIO Server 用 `TOOL_DEFINITIONS` 注册工具（描述 + 参数 schema）；
 * - Main 的 Bridge 路由用同一份 schema 做第二次校验（MCP 进程不可信）；
 * - 工具 → scope 映射也在这里，权限检查在 Main 执行。
 *
 * 参数命名面向 AI：snake_case、单位明确的毫秒、UUID。内部实体字段的
 * camelCase 映射只发生在 Application Service 里。
 */

const uuid = z.string().uuid()
const idempotencyKey = z.string().min(1).max(200)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)

const recordPage = {
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional()
}

const coffeePage = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional()
}

export type ToolDefinition = {
  /** Main 端执行前必须命中的 scope。 */
  scope: McpScope
  /** 是否写操作——写操作进审计表，并且要求幂等键（若 schema 含该字段）。 */
  write: boolean
  description: string
  input: z.ZodObject<z.ZodRawShape>
}

export const TOOL_DEFINITIONS = {
  search_records: {
    scope: 'records:read',
    write: false,
    description:
      'Search the user\'s BrewPhase records (articles, links, images, videos, text notes). ' +
      'Matches title, body, note, source/author/summary, URL, and desktop-fetched metadata. ' +
      'Returns summaries; use get_record for full content.',
    input: z.object({
      search: z.string().max(200).optional().describe('Free-text query matched against record fields'),
      carrier: z.enum(['link', 'image', 'video', 'text']).optional().describe('Filter by record carrier type'),
      tag_id: uuid.optional().describe('Only records carrying this tag id'),
      ...recordPage
    })
  },

  get_record: {
    scope: 'records:read',
    write: false,
    description: 'Read one record in full: title, body, note, URL, provider, tags, metadata, timestamps.',
    input: z.object({ record_id: uuid })
  },

  list_record_tags: {
    scope: 'tags:read',
    write: false,
    description: 'List all record tags with their ids, so records can be filtered or tagged by id.',
    input: z.object({})
  },

  create_record: {
    scope: 'records:create',
    write: true,
    description:
      'Create a text or link record. For links the platform (YouTube/Bilibili/X/GitHub/generic) is detected ' +
      'by BrewPhase — do not provide provider or canonical fields. Media upload is not supported in V1.',
    input: z.object({
      carrier: z.enum(['link', 'text']),
      title: z.string().max(500).optional(),
      note: z.string().max(20_000).optional().describe('Free-form body / personal note'),
      url: z.string().max(2_000).optional().describe('Required for carrier=link, must be a valid http(s) URL'),
      tag_ids: z.array(uuid).max(20).optional(),
      idempotency_key: idempotencyKey.describe('Stable key so a retried create does not duplicate the record')
    })
  },

  update_record: {
    scope: 'records:update',
    write: true,
    description:
      'Update title/note/url/tags of an existing record. Requires expected_updated_at (epoch ms) read from ' +
      'get_record; a mismatch returns STALE_RECORD — re-read, then retry. Cannot change carrier or media.',
    input: z.object({
      record_id: uuid,
      expected_updated_at: z.number().int(),
      patch: z
        .object({
          title: z.string().max(500).optional().describe('Empty string clears the title'),
          note: z.string().max(20_000).optional().describe('Empty string clears the note'),
          url: z.string().max(2_000).optional().describe('New URL; old fetched metadata is invalidated'),
          tag_ids: z.array(uuid).max(20).optional().describe('Replaces the full tag set')
        })
        .refine((value) => Object.keys(value).length > 0, { message: 'patch must contain at least one field' })
    })
  },

  create_tag: {
    scope: 'tags:create',
    write: true,
    description: 'Create a tag (1–40 chars). An existing tag with the same name is returned instead of duplicated.',
    input: z.object({ name: z.string().trim().min(1).max(40) })
  },

  // MARK: - Work Context（持续工作上下文）

  list_work_contexts: {
    scope: 'work_context:read',
    write: false,
    description:
      'List work contexts (persisted working context: goal / progress / next step). ' +
      'Defaults to most-recently-active first. Use this to resume ongoing work.',
    input: z.object({
      status: z.enum(['active', 'paused', 'completed']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional()
    })
  },

  get_work_context: {
    scope: 'work_context:read',
    write: false,
    description:
      'Read one work context: goal, progress summary, next step, status and every linked ' +
      'resource (record / canvas / url with role and label). Use it to restore working context.',
    input: z.object({ context_id: uuid })
  },

  create_work_context: {
    scope: 'work_context:create',
    write: true,
    description:
      'Create a work context for an ongoing task. Title is required; goal / summary / ' +
      'next_step are optional and can be filled in later via update_work_context.',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      goal: z.string().max(2_000).optional(),
      summary: z.string().max(4_000).optional(),
      next_step: z.string().max(2_000).optional(),
      idempotency_key: idempotencyKey
    })
  },

  update_work_context: {
    scope: 'work_context:update',
    write: true,
    description:
      'Update title / goal / summary / next_step / status of a work context. Only provided ' +
      'fields change. Requires expected_updated_at (epoch ms) from get_work_context; ' +
      'a mismatch returns STALE_RECORD — re-read, then retry.',
    input: z.object({
      context_id: uuid,
      expected_updated_at: z.number().int(),
      patch: z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          goal: z.string().max(2_000).optional(),
          summary: z.string().max(4_000).optional(),
          next_step: z.string().max(2_000).optional(),
          status: z.enum(['active', 'paused', 'completed']).optional()
        })
        .refine((value) => Object.keys(value).length > 0, { message: 'patch must contain at least one field' })
    })
  },

  link_work_context_resource: {
    scope: 'work_context:link',
    write: true,
    description:
      'Link an existing resource (record / canvas) or an http(s) URL to a work context. ' +
      'Roles: source / output / reference. Linking the same resource twice is idempotent ' +
      '(no duplicate). Record / canvas content is never copied into the context.',
    input: z.object({
      context_id: uuid,
      resource_type: z.enum(['record', 'canvas', 'url']),
      resource_id: uuid.optional(),
      url: z.string().max(2_000).optional(),
      role: z.enum(['source', 'output', 'reference']).optional(),
      note: z.string().max(500).optional(),
      idempotency_key: idempotencyKey
    })
  },

  list_beans: {
    scope: 'coffee:read',
    write: false,
    description:
      'List coffee beans with stock, roast level and roast date. days_since_roast is derived from roast_date; ' +
      'null when the roast date is unknown (never invented).',
    input: z.object({
      status: z.enum(['active', 'finished']).optional(),
      ...coffeePage
    })
  },

  get_bean: {
    scope: 'coffee:read',
    write: false,
    description: 'Read one bean with its brew/tasting counts and recent brews.',
    input: z.object({ bean_id: uuid })
  },

  list_brews: {
    scope: 'coffee:read',
    write: false,
    description: 'List brews (recipe parameters, scores, flavor tags). Read-only in V1.',
    input: z.object({
      bean_id: uuid.optional(),
      since_ms: z.number().int().optional().describe('Only brews at or after this epoch-millisecond timestamp'),
      ...coffeePage
    })
  },

  list_tastings: {
    scope: 'coffee:read',
    write: false,
    description: 'List tastings. Read-only in V1.',
    input: z.object({
      bean_id: uuid.optional(),
      since_ms: z.number().int().optional(),
      ...coffeePage
    })
  },

  get_coffee_summary: {
    scope: 'coffee:read',
    write: false,
    description: 'Aggregate overview: bean/brew/tasting counts, brews in the last 30 days, average tasting score.',
    input: z.object({})
  },

  list_canvases: {
    scope: 'canvas:read',
    write: false,
    description: 'List canvases with node and note counts.',
    input: z.object({})
  },

  get_canvas: {
    scope: 'canvas:read',
    write: false,
    description:
      'Read one canvas: record nodes (with record summaries and positions), notes, and stroke metadata ' +
      '(no point data, no file paths).',
    input: z.object({ canvas_id: uuid })
  },

  create_canvas: {
    scope: 'canvas:write',
    write: true,
    description: 'Create an empty canvas.',
    input: z.object({
      name: z.string().trim().min(1).max(120),
      note: z.string().max(2_000).optional(),
      idempotency_key: idempotencyKey
    })
  },

  add_record_to_canvas: {
    scope: 'canvas:write',
    write: true,
    description:
      'Place an existing record on a canvas. BrewPhase computes the initial position. Adding the same record ' +
      'to the same canvas again returns the existing node instead of duplicating it.',
    input: z.object({
      canvas_id: uuid,
      record_id: uuid,
      annotation: z.string().max(2_000).optional(),
      idempotency_key: idempotencyKey
    })
  },

  create_canvas_note: {
    scope: 'canvas:write',
    write: true,
    description:
      'Create a sticky note on a canvas. BrewPhase picks a free position — do not provide coordinates.',
    input: z.object({
      canvas_id: uuid,
      title: z.string().trim().min(1).max(200),
      body: z.string().max(10_000),
      color: color.optional().describe('Hex like #f6f2df'),
      idempotency_key: idempotencyKey
    })
  },

  update_canvas_note: {
    scope: 'canvas:write',
    write: true,
    description:
      'Update a note\'s title/body/color. Requires expected_updated_at (epoch ms) from get_canvas; ' +
      'a mismatch returns STALE_RECORD.',
    input: z.object({
      note_id: uuid,
      expected_updated_at: z.number().int(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(10_000).optional(),
      color: color.optional()
    })
  },

  annotate_canvas_node: {
    scope: 'canvas:write',
    write: true,
    description: 'Set the annotation (short note) on a canvas node.',
    input: z.object({
      node_id: uuid,
      annotation: z.string().max(2_000)
    })
  },

  // MARK: - Personal Direction
  //
  // 只有 read 与 propose：Agent 能读全部上下文、能写「提议」，但**没有**
  // confirm 类工具。确认只发生在应用界面里——这是结构保证，不是约定。

  get_direction_overview: {
    scope: 'direction:read',
    write: false,
    description:
      'Read the user personal direction: the confirmed current state, their long-term ' +
      'directions, stage goals, and how many proposals are waiting for confirmation. ' +
      'Call this first — never assume what the user is working on or what they want.',
    input: z.object({
      /** 现状的历史版本（已归档）只在需要回顾变化时要。 */
      include_state_history: z.boolean().optional()
    })
  },

  propose_current_state: {
    scope: 'direction:propose',
    write: true,
    description:
      'Propose a description of the user current state, based on what they actually told you. ' +
      'This writes a DRAFT: it does not replace the confirmed state, and it becomes official ' +
      'only after the user confirms it in the app. Re-proposing replaces the previous draft. ' +
      'Leave fields empty rather than inventing details.',
    input: z.object({
      summary: z.string().max(4_000).optional(),
      work_status: z.string().max(2_000).optional(),
      capabilities: z.string().max(2_000).optional(),
      ongoing: z.string().max(2_000).optional(),
      capacity: z.string().max(2_000).optional(),
      constraints: z.string().max(2_000).optional(),
      other: z.string().max(2_000).optional()
    })
  },

  propose_direction: {
    scope: 'direction:propose',
    write: true,
    description:
      'Propose a long-term direction the user described in their own words. ' +
      'Creates a proposal the user must confirm; it never becomes their direction automatically. ' +
      'Write the direction as the user expressed it — do not quantify it or turn it into a score.',
    input: z.object({
      title: z.string().trim().min(1).max(120),
      description: z.string().max(4_000).optional(),
      motivation: z.string().max(2_000).optional(),
      time_horizon: z.string().max(200).optional(),
      outcomes: z.array(z.string().max(300)).max(20).optional(),
      constraints: z.string().max(2_000).optional()
    })
  },

  propose_stage_goal: {
    scope: 'direction:propose',
    write: true,
    description:
      'Propose one verifiable stage toward an existing direction. Creates a proposal the user ' +
      'must confirm. `completion_criteria` should be something observable; if the user has not ' +
      'said how they would know it is done, leave it empty instead of inventing a threshold.',
    input: z.object({
      direction_id: uuid,
      name: z.string().trim().min(1).max(120),
      goal: z.string().max(2_000).optional(),
      expected_outcome: z.string().max(2_000).optional(),
      completion_criteria: z.string().max(2_000).optional(),
      time_horizon: z.string().max(200).optional(),
      obstacles: z.string().max(2_000).optional(),
      work_context_id: uuid.optional()
    })
  },

  // MARK: - Agent Journey（R6-2，Local MCP only）

  /**
   * 六个 Journey 工具的共同约定：
   * - **入参里没有 `source_client_id` / `role` / `evidence_level` / `capture_mode`**：
   *   身份取自认证后的 `ToolExecutionContext`，role 与 evidence 由 Service 按
   *   `event_type` 推导，采集模式只有用户能在设置里改。请求体给不了这些字段，
   *   就不可能伪造来源。
   * - 写操作带 `idempotency_key`（`start:<uuid>` / `evt:<uuid>`），update 类靠
   *   `expected_updated_at` 乐观锁。
   * - 全部 **Local-only**：Remote 的白名单是写死的只读 8 项，见 §五。
   */
  start_agent_journey: {
    scope: 'agent_journey:write',
    write: true,
    description:
      'Start recording an Agent Journey: one concrete task this agent is about to work on, ' +
      'kept as a personal asset the user can read, relate and reuse later. Creates the journey ' +
      'in `created` state with the caller identity taken from authentication, never from this ' +
      'payload. Only do this for work worth keeping (a real debugging/analysis/build task); ' +
      'skip it for one-off questions, translation or formatting. Reuse `idempotency_key` on retry.',
    input: z.object({
      title: z.string().trim().min(1).max(200),
      goal: z.string().max(2_000).optional(),
      work_context_id: uuid.optional(),
      source_agent: z.string().max(120).optional(),
      model: z.string().max(120).optional(),
      idempotency_key: idempotencyKey
    })
  },

  append_agent_journey_event: {
    scope: 'agent_journey:write',
    write: true,
    description:
      'Append one significant step to an Agent Journey (plan, decision, execution, observation, ' +
      'revision, verification, outcome, user annotation). Submit milestones, not every message. ' +
      '`status` is optional and has NO default here: the server decides — statement events are ' +
      'completed on creation, while execution/verification start as `planned` and must be ' +
      'advanced with update_agent_journey_event. Never claim a test passed without running it; ' +
      'record the failure and revise instead of overwriting history. Appending an `outcome` with ' +
      '`journey_status: "completed"` finishes the journey in the same transaction. ' +
      'Pass `details` for anything another developer must be able to inspect later: which files ' +
      'changed and why that location, which approach was chosen and which were rejected, what was ' +
      'actually observed, and which commands really ran with what result. `details` is optional ' +
      'and strictly validated — unknown fields are rejected, so do not invent keys. Omit what you ' +
      'do not know rather than guessing; `verification.result` must be `not_run` for anything you ' +
      'did not execute.',
    input: z.object({
      journey_id: uuid,
      event_type: z.enum([
        'user_input',
        'plan',
        'decision',
        'execution',
        'observation',
        'revision',
        'verification',
        'outcome',
        'user_annotation'
      ]),
      // 可选且**不设默认值**：默认由 Service 按 event_type 决定。
      status: z.enum(['planned', 'running', 'completed', 'failed', 'skipped', 'cancelled']).optional(),
      title: z.string().trim().min(1).max(200),
      summary: z.string().max(2_000).optional(),
      content: z.string().max(20_000).optional(),
      reason: z.string().max(2_000).optional(),
      attempt_id: uuid.optional(),
      parent_event_id: uuid.optional(),
      edges: z
        .array(
          z.object({
            to_event_id: uuid,
            relationship_type: z.enum(['depends_on', 'branch_from', 'revises', 'retries'])
          })
        )
        .max(8)
        .optional(),
      source_agent: z.string().max(120).optional(),
      model: z.string().max(120).optional(),
      occurred_at: z.number().int().optional(),
      /**
       * 结构化执行详情（R6-4.2）。可选——**旧客户端一个参数都不用加**。
       *
       * 存进 `metadata.journey_detail_v1`（命名空间让 v1/v2 可共存，
       * 也让 `metadata` 的旧用法原样保留）。`.strict()`：多写一个字段直接
       * 拒绝；字段长度与数组条数都有上限；整包受 `JOURNEY_METADATA_MAX`
       * 约束，超限**拒绝**而不是截断。
       */
      details: journeyDetailV1Schema.optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      journey_status: z.literal('completed').optional(),
      idempotency_key: idempotencyKey
    })
  },

  update_agent_journey_event: {
    scope: 'agent_journey:write',
    write: true,
    description:
      'Advance the status of an execution or verification event (planned -> running -> completed ' +
      '| failed, plus skipped/cancelled exits). Statement events are immutable and cannot be ' +
      'updated. Only `status` is accepted — content fields are deliberately absent so history ' +
      'cannot be rewritten; to correct something, append a `revision` event instead. Requires ' +
      '`expected_updated_at` (optimistic lock).',
    input: z.object({
      event_id: uuid,
      status: z.enum(['planned', 'running', 'completed', 'failed', 'skipped', 'cancelled']),
      expected_updated_at: z.number().int()
    })
  },

  update_agent_journey_status: {
    scope: 'agent_journey:write',
    write: true,
    description:
      'Change the lifecycle state of a journey: running, paused (stop collecting), failed, or ' +
      'cancelled (also marks open execution events cancelled, keeping history). `completed` is ' +
      'not accepted here — only an `outcome` event finishes a journey, in the same transaction. ' +
      'Cancelled and completed are irreversible. Requires `expected_updated_at`.',
    input: z.object({
      journey_id: uuid,
      status: z.enum(['running', 'paused', 'failed', 'cancelled']),
      expected_updated_at: z.number().int()
    })
  },

  list_agent_journeys: {
    scope: 'agent_journey:read',
    write: false,
    description:
      'List recorded Agent Journeys, newest first. Pure read: it never changes journey state, ' +
      'never sweeps timeouts and never writes anything. Use with get_agent_journey to read one.',
    input: z.object({
      status: z
        .enum(['created', 'running', 'paused', 'failed', 'completed', 'cancelled', 'abandoned'])
        .optional(),
      work_context_id: uuid.optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional()
    })
  },

  get_agent_journey: {
    scope: 'agent_journey:read',
    write: false,
    description:
      'Read one Agent Journey with its events (ascending by `sequence` — the only ordering ' +
      'truth) and its edges. Filter by `event_types`/`since_sequence` for large journeys. Note ' +
      'that edges are relationships, not the timeline: after filtering, an edge may point to an ' +
      'event that is not in `events`. Layout is not returned in this version.',
    input: z.object({
      journey_id: uuid,
      event_types: z
        .array(
          z.enum([
            'user_input',
            'plan',
            'decision',
            'execution',
            'observation',
            'revision',
            'verification',
            'outcome',
            'user_annotation'
          ])
        )
        .max(9)
        .optional(),
      since_sequence: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional()
    })
  }
} satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof TOOL_DEFINITIONS

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[]

export function toolScope(tool: string): McpScope | null {
  return tool in TOOL_DEFINITIONS ? TOOL_DEFINITIONS[tool as ToolName].scope : null
}
