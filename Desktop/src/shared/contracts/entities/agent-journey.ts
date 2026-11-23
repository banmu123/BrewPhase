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
/**
 * 仓库相对路径校验（R6-4.2.1 §5）。
 *
 * 返回 `null` 表示合法，否则返回**具体**拒绝原因——错误信息要能直接指导
 * 调用方改参数，而不是一句 `invalid path`。
 *
 * 合法：`Desktop/src/main/...`、`src/components/X.tsx`、`.github/workflows/ci.yml`
 * 拒绝：绝对路径、Windows 盘符、UNC、`..` 穿越、反斜杠、NUL、空片段。
 *
 * **不硬编码任何前缀**：Journey 可能记录别的仓库的相对路径。
 */
export function repoRelativePathError(raw: string): string | null {
  if (raw.length === 0) return 'path is empty'
  if (raw.includes('\u0000')) return 'path contains a NUL character'
  if (raw.includes('\\')) return "use POSIX '/' separators, not backslashes"
  if (raw.startsWith('/')) return 'path must be repository-relative, not absolute'
  if (/^[A-Za-z]:/.test(raw)) return 'Windows drive letters are not allowed'
  if (raw.startsWith('//')) return 'UNC paths are not allowed'

  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '') return 'path contains an empty segment (leading, trailing or doubled "/")'
    if (segment === '.' || segment === '..') {
      return "path must not contain '.' or '..' segments"
    }
  }
  return null
}

/** 测试 / 配置文件：允许省略修改前后行为（§6.4 的合理兼容）。 */
export function isLikelyTestOrConfigPath(filePath: string): boolean {
  const path = filePath.toLowerCase()
  if (/(^|\/)(tests?|__tests__|spec|__specs__)(\/|$)/.test(path)) return true
  if (/\.(test|spec)\.[a-z0-9]+$/.test(path)) return true
  return /\.(json|ya?ml|toml|ini|cfg|conf|lock|snap|md|markdown|editorconfig|gitignore)$/.test(path)
}

/** 非空且非纯空白：`"   "` 不算「填了」（§3.5 禁止空字符串占位）。 */
function requiredText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
}

export const journeyChangeSchema = z
  .object({
    /** 仓库相对路径（§11：优先相对路径，不存机器绝对路径）。 */
    file_path: z
      .string()
      .max(400)
      .superRefine((value, ctx) => {
        if (value.trim().length === 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'file_path must not be empty or whitespace-only'
          })
          return
        }
        // 把**具体**拒绝原因（绝对路径 / 盘符 / `..` / 反斜杠…）原样带回，
        // 调用方照着改就行，不用猜是哪条规则。
        const reason = repoRelativePathError(value.trim())
        if (reason) ctx.addIssue({ code: 'custom', message: reason })
      }),
    change_type: z.enum(['created', 'modified', 'deleted', 'renamed']),
    /** `renamed` 用它表达旧路径（§6.2 的最小必要扩展，不存 diff）。 */
    previous_file_path: z
      .string()
      .max(400)
      .superRefine((value, ctx) => {
        const reason = repoRelativePathError(value.trim())
        if (reason) ctx.addIssue({ code: 'custom', message: reason })
      })
      .optional(),
    symbols: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
    change_summary: requiredText(600),
    before_behavior: z.string().max(500).optional(),
    after_behavior: z.string().max(500).optional(),
    /**
     * 为什么改在这里：模块职责、上下游、设计边界。
     * 12 字下限只是**占位符闸门**（挡掉「改这里」「需要修改」），
     * 不是质量评分——真实理由通常远长于此。
     */
    why_this_location: z
      .string()
      .max(600)
      .refine((value) => value.trim().length >= 12, {
        message:
          'why_this_location must be at least 12 characters — say what this module owns and why the change belongs here, not "this file needed changing"'
      }),
    line_range: z
      .object({
        /** 源码行号从 1 开始：`{start:0,end:0}` 不是有效定位。 */
        start: z.number().int().min(1),
        end: z.number().int().min(1)
      })
      .strict()
      .refine((value) => value.end >= value.start, {
        message: 'line_range.end must be greater than or equal to line_range.start'
      })
      .optional()
  })
  .strict()
  .superRefine((change, ctx) => {
    // ── §6.2 按 change_type 的信息完整性 ──
    if (change.change_type === 'renamed') {
      if (!change.previous_file_path) {
        ctx.addIssue({
          code: 'custom',
          path: ['previous_file_path'],
          message: 'renamed requires previous_file_path (the path before the rename)'
        })
      } else if (change.previous_file_path.trim() === change.file_path.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['previous_file_path'],
          message: 'previous_file_path must differ from file_path for a rename'
        })
      }
    } else if (change.previous_file_path !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['previous_file_path'],
        message: `previous_file_path is only valid for change_type "renamed" (got "${change.change_type}")`
      })
    }

    const before = change.before_behavior !== undefined && change.before_behavior.trim().length > 0
    const after = change.after_behavior !== undefined && change.after_behavior.trim().length > 0

    if (change.change_type === 'created' && !after) {
      ctx.addIssue({
        code: 'custom',
        path: ['after_behavior'],
        message: 'created requires after_behavior — say what the new file does'
      })
    }
    if (change.change_type === 'deleted' && !before) {
      ctx.addIssue({
        code: 'custom',
        path: ['before_behavior'],
        message: 'deleted requires before_behavior — say what the file was responsible for'
      })
    }
    if (change.change_type === 'modified' && !isLikelyTestOrConfigPath(change.file_path)) {
      // 纯测试 / 纯配置的修改允许省略前后行为（§6.4 的兼容），源码不允许。
      if (!before || !after) {
        ctx.addIssue({
          code: 'custom',
          path: [before ? 'after_behavior' : 'before_behavior'],
          message:
            'modified requires both before_behavior and after_behavior for source files — describe what changed; use limitations if you genuinely cannot tell'
        })
      }
    }
    // 无论哪一类：给了一个就必须给另一个，半截对照读不出差异
    if (before !== after) {
      ctx.addIssue({
        code: 'custom',
        path: [before ? 'after_behavior' : 'before_behavior'],
        message: 'before_behavior and after_behavior must be provided together'
      })
    }
  })
export type JourneyChange = z.infer<typeof journeyChangeSchema>

export const journeyDecisionDetailSchema = z
  .object({
    selected_approach: requiredText(600),
    rationale: requiredText(600),
    alternatives: z
      .array(
        z
          .object({
            approach: requiredText(400),
            reason_not_selected: requiredText(400)
          })
          .strict()
      )
      .max(6)
      .optional(),
    tradeoffs: z.array(requiredText(300)).max(6).optional()
  })
  .strict()
export type JourneyDecisionDetail = z.infer<typeof journeyDecisionDetailSchema>

export const journeyObservationDetailSchema = z
  .object({
    finding: requiredText(600),
    impact: z.string().max(500).optional(),
    /** 信息来源：日志、测试输出、报错文本……不是「我觉得」。 */
    source: z.string().max(400).optional()
  })
  .strict()
export type JourneyObservationDetail = z.infer<typeof journeyObservationDetailSchema>

export const journeyVerificationDetailSchema = z
  .object({
    command: z.string().max(400).optional(),
    target: requiredText(400),
    /** `not_run` / `skipped` 与 `passed` 平级——未执行绝不能写成通过。 */
    result: z.enum(['passed', 'failed', 'not_run', 'skipped']),
    exit_code: z.number().int().min(-255).max(65_535).optional(),
    summary: requiredText(600),
    /** 可追溯引用（commit / 测试报告 / 文件），有才填。 */
    evidence_reference: z.string().max(400).optional()
  })
  .strict()
  .superRefine((item, ctx) => {
    /*
     * §8：退出码与结果的**明显矛盾**才拦，不替 Agent 推断结果。
     *
     * - `not_run` 什么都没跑 → 不许带退出码（那是伪造的执行痕迹）；
     * - `passed` 却带非零退出码 → 自相矛盾；要表达「命令按预期非零」，
     *   就删掉 exit_code 并在 summary 里说明，而不是留一对矛盾的字段。
     *
     * 反向**不拦**：`failed` + 0、`skipped` + 0 都可能是特殊预期，
     * 由 Agent 在 summary 里解释——简单地把退出码当结果正是这里禁止的。
     */
    if (item.result === 'not_run' && item.exit_code !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['exit_code'],
        message:
          'not_run must not carry an exit_code — nothing was executed, so there is no real exit code to report'
      })
    }
    if (item.result === 'passed' && item.exit_code !== undefined && item.exit_code !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['exit_code'],
        message:
          'passed contradicts a non-zero exit_code — either use "failed", or drop exit_code and explain the expected non-zero code in summary'
      })
    }
  })
export type JourneyVerificationDetail = z.infer<typeof journeyVerificationDetailSchema>

export const journeyReferenceSchema = z
  .object({
    kind: z.enum(['commit', 'diff', 'test', 'file', 'record', 'url']),
    value: requiredText(400),
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
    limitations: z
      .array(z.string().max(500))
      .max(8)
      .optional()
      .refine((items) => !items || items.every((item) => item.trim().length > 0), {
        message: 'limitations must not contain empty or whitespace-only entries'
      })
  })
  .strict()
  /*
   * §3：`{ version: 1 }` 不是有效详情。提交了 details 就必须有**实际内容**，
   * 空数组、只有空字符串的占位都不算——否则 UI 会渲染出一个「结构完整」
   * 却什么都没说的空壳。
   *
   * 注意：`details` 整体仍是 optional（旧客户端一个参数都不用加）；
   * 这条只约束「一旦提交就必须有料」。
   */
  .refine(
    (detail) =>
      Boolean(
        detail.decision ||
          (detail.changes && detail.changes.length > 0) ||
          (detail.observations && detail.observations.length > 0) ||
          (detail.verification && detail.verification.length > 0) ||
          (detail.references && detail.references.length > 0) ||
          (detail.limitations && detail.limitations.length > 0)
      ),
    {
      message:
        'details must contain at least one meaningful block (decision, changes, observations, verification, references or limitations) — version alone is not a detail, and empty arrays do not count'
    }
  )
  /*
   * §6.1：同一份详情里同一个文件只出现一次。多处修改写在一个条目里
   * （用 symbols 区分），否则「改了几个文件」这个数字就是假的。
   */
  .superRefine((detail, ctx) => {
    const seen = new Set<string>()
    detail.changes?.forEach((change, index) => {
      const normalized = change.file_path.trim()
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: 'custom',
          path: ['changes', index, 'file_path'],
          message: `duplicate file_path "${normalized}" — merge the edits into one entry and list the distinct symbols instead`
        })
      }
      seen.add(normalized)
    })
  })
export type JourneyDetailV1 = z.infer<typeof journeyDetailV1Schema>

/**
 * Event Type ↔ 结构化详情的**语义**校验（R6-4.2.1 §4）。
 *
 * 与 Zod 的分工：Zod 管「字段长什么样」，这里管「这个事件该不该有这块内容」
 * —— event_type 是 `details` 的同级参数，Zod 对象层拿不到彼此的语义关系。
 *
 * 纯函数、返回 `null` 表示通过，否则返回**包含事件类型 + 缺什么 + 为什么**
 * 的完整句子（§4.1：不许只回一句 `invalid details`）。
 *
 * 只在 `details` **存在**时调用：不传 details 的旧客户端不受任何约束。
 */
export function detailEventTypeError(eventType: string, detail: JourneyDetailV1): string | null {
  const has = (value: unknown): boolean =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null

  const prefix = `event_type "${eventType}" with journey_detail_v1`

  switch (eventType) {
    case 'decision':
      return has(detail.decision)
        ? null
        : `${prefix} requires a "decision" block (selected_approach, rationale, and ideally alternatives/tradeoffs)`

    case 'observation':
      return has(detail.observations)
        ? null
        : `${prefix} requires a non-empty "observations" block — record what you actually saw, its impact and where you read it from`

    case 'verification':
      return has(detail.verification)
        ? null
        : `${prefix} requires a non-empty "verification" block — record each command or test target with its real result`

    case 'execution':
      /*
       * 不把所有执行都当成改代码：调试、分析、不碰文件的任务用
       * observations / references / limitations 表达「做了什么、依据是什么」。
       * 但**必须**有其中一块——只有 version 的执行详情没有信息量。
       */
      return has(detail.changes) || has(detail.observations) || has(detail.references) || has(detail.limitations)
        ? null
        : `${prefix} needs evidence of what was executed: "changes" when files changed, otherwise "observations" (or "references"/"limitations") for analysis and debugging work`

    case 'revision':
      return has(detail.changes) || has(detail.observations) || has(detail.decision)
        ? null
        : `${prefix} requires the actual adjustment — "changes" for what moved, or "observations"/"decision" for why the old approach was wrong`

    case 'outcome':
      return has(detail.changes) ||
        has(detail.verification) ||
        has(detail.references) ||
        has(detail.limitations) ||
        has(detail.decision)
        ? null
        : `${prefix} requires at least one real result block: "changes" (what shipped), "verification", "references", "limitations" or "decision"`

    case 'user_input':
    case 'plan':
    case 'user_annotation':
      /*
       * 这三类是**陈述事件**：内容属于普通字段，不允许携带
       * `journey_detail_v1`（R6-4.2.2 §二）。
       *
       * - 没传 details → 根本不会走到这里（serializeMetadata 只在
       *   `metadata.journey_detail_v1` 存在时才调用本函数）；
       * - 传了 details（即使结构完全合法）→ 一律拒绝。
       *
       * 拒绝的理由是**语义不属**，不是结构错误：用户原话写 `user_input` 的
       * `summary/content`，展示过的计划写 `plan`，用户补充写 `user_annotation`。
       * 结构校验放行不等于这条事件该有这块内容。
       *
       * 本规则只看 `journey_detail_v1`；metadata 的其它键不受影响。
       */
      return `${prefix} is not accepted on event_type "${eventType}" — this event carries its content in the plain fields (${eventType === 'user_input' ? "the user's own words" : eventType === 'plan' ? 'the plan you showed the user' : "the user's note"}), so write it into summary/content/reason and remove \`details\``

    default:
      // 未知事件类型不在此处拦——事件类型本身由 Service 的枚举校验负责。
      return null
  }
}

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
