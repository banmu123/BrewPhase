import { z } from 'zod'

/**
 * Personal Direction V0.1（migration 9）：现状 → 方向 → 阶段。
 *
 * 三层的关系是「我在哪 / 想去哪 / 这一段怎么走」：
 * - CurrentState 描述用户此刻的真实状态，每次确认生成一个新版本，旧版归档，
 *   所以「我去年怎么描述自己」可查，而不是被覆盖掉。
 * - Direction 是用户自己定义的长期方向。它不需要被量化——无法量化的目标
 *   不折算成分数。
 * - StageGoal 是把方向切成可验证的一段，完成标准必须能被观察。
 *
 * **草稿与确认分离**是本模块的硬规则：
 * - 用户亲手填的（Renderer 经 IPC）直接落 confirmed / active；
 * - Agent 经 MCP 写入的一律是 draft / proposed，且 Agent **没有任何通道**
 *   能把它改成 confirmed——确认动作只存在于应用界面里。
 *   这样「AI 整理出的内容必须经过用户确认」是结构上做不到绕过，而不是口头约定。
 *
 * 与 Work Context 一样是 Desktop 本地数据：不进 change_log，不进 iOS 同步。
 */

// MARK: - 状态与来源

export const CURRENT_STATE_STATUSES = ['draft', 'confirmed', 'archived'] as const
export type CurrentStateStatus = (typeof CURRENT_STATE_STATUSES)[number]
export const currentStateStatusSchema = z.enum(CURRENT_STATE_STATUSES)

export const DIRECTION_STATUSES = ['proposed', 'active', 'paused', 'achieved', 'dropped'] as const
export type DirectionStatus = (typeof DIRECTION_STATUSES)[number]
export const directionStatusSchema = z.enum(DIRECTION_STATUSES)

export const STAGE_GOAL_STATUSES = ['proposed', 'active', 'paused', 'completed', 'revised'] as const
export type StageGoalStatus = (typeof STAGE_GOAL_STATUSES)[number]
export const stageGoalStatusSchema = z.enum(STAGE_GOAL_STATUSES)

/** 谁写下的：用户亲手填的还是 Agent 提议的。用于来源追溯（§10）。 */
export const DIRECTION_SOURCES = ['user', 'agent'] as const
export type DirectionSource = (typeof DIRECTION_SOURCES)[number]
export const directionSourceSchema = z.enum(DIRECTION_SOURCES)

const uuid = z.string().uuid()

// MARK: - Current State（我的现状）

/**
 * 现状不要求填满：六个分区都可以是空串，`summary` 也可以只写一句话。
 * 一个只写了「最近在做一个自己的产品，时间不多」的现状，仍然是有用的现状。
 */
export const currentStateSchema = z.object({
  id: uuid,
  summary: z.string().max(4_000),
  /** 当前工作与职业状态。 */
  workStatus: z.string().max(2_000),
  /** 已有能力、经验和资源。 */
  capabilities: z.string().max(2_000),
  /** 当前正在推进的事情。 */
  ongoing: z.string().max(2_000),
  /** 可投入的时间与精力。 */
  capacity: z.string().max(2_000),
  /** 限制、困难和不满意的地方。 */
  constraints: z.string().max(2_000),
  /** 其他重要的生活或创作状态。 */
  other: z.string().max(2_000),
  status: currentStateStatusSchema,
  source: directionSourceSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type CurrentState = z.infer<typeof currentStateSchema>

/** 现状的六个分区，UI 按同一顺序渲染，不各自发明顺序。 */
export const CURRENT_STATE_FIELDS = [
  'workStatus',
  'capabilities',
  'ongoing',
  'capacity',
  'constraints',
  'other'
] as const
export type CurrentStateField = (typeof CURRENT_STATE_FIELDS)[number]

/** 用户可编辑的现状内容：只有文字，没有状态与时间戳。 */
export type CurrentStateDraft = {
  summary: string
} & Record<CurrentStateField, string>

// MARK: - Direction（我希望成为的样子）

export const directionSchema = z.object({
  id: uuid,
  title: z.string().max(120),
  description: z.string().max(4_000),
  motivation: z.string().max(2_000),
  /** 期望时间范围，自由文本（「今年内」「三到五年」），可以不填。 */
  timeHorizon: z.string().max(200),
  /** 能够观察和验证的结果；存 JSON 字符串数组。 */
  outcomes: z.array(z.string().max(300)).max(20),
  constraints: z.string().max(2_000),
  status: directionStatusSchema,
  source: directionSourceSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type Direction = z.infer<typeof directionSchema>

// MARK: - Stage Goal（当前阶段目标）

export const stageGoalSchema = z.object({
  id: uuid,
  directionId: uuid,
  name: z.string().max(120),
  goal: z.string().max(2_000),
  expectedOutcome: z.string().max(2_000),
  /** 完成标准或验证证据：这一条决定阶段能不能被判定为完成。 */
  completionCriteria: z.string().max(2_000),
  timeHorizon: z.string().max(200),
  obstacles: z.string().max(2_000),
  /** 指向已有 Work Context；具体工作服务于这一段。 */
  workContextId: z.string().uuid().nullable(),
  status: stageGoalStatusSchema,
  source: directionSourceSchema,
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type StageGoal = z.infer<typeof stageGoalSchema>

// MARK: - 写入参数
//
// IPC 与 MCP 两侧共用同一组校验：字段长度上限一致，用户手填与 Agent 提议
// 都不会写进一条超长文本把界面撑坏。

/** 现状六个分区 + 整体描述；全部可空——不要求一次填满。 */
export const currentStateDraftSchema = z.object({
  summary: z.string().max(4_000).default(''),
  workStatus: z.string().max(2_000).default(''),
  capabilities: z.string().max(2_000).default(''),
  ongoing: z.string().max(2_000).default(''),
  capacity: z.string().max(2_000).default(''),
  constraints: z.string().max(2_000).default(''),
  other: z.string().max(2_000).default('')
})

export const directionInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).default(''),
  motivation: z.string().max(2_000).default(''),
  timeHorizon: z.string().max(200).default(''),
  outcomes: z.array(z.string().max(300)).max(20).default([]),
  constraints: z.string().max(2_000).default('')
})

/** 局部更新：只传要改的字段，没传的保持原值。 */
export const directionPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4_000).optional(),
  motivation: z.string().max(2_000).optional(),
  timeHorizon: z.string().max(200).optional(),
  outcomes: z.array(z.string().max(300)).max(20).optional(),
  constraints: z.string().max(2_000).optional(),
  status: directionStatusSchema.optional()
})

export const stageGoalInputSchema = z.object({
  directionId: uuid,
  name: z.string().trim().min(1).max(120),
  goal: z.string().max(2_000).default(''),
  expectedOutcome: z.string().max(2_000).default(''),
  completionCriteria: z.string().max(2_000).default(''),
  timeHorizon: z.string().max(200).default(''),
  obstacles: z.string().max(2_000).default(''),
  workContextId: uuid.nullable().default(null)
})

export const stageGoalPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  goal: z.string().max(2_000).optional(),
  expectedOutcome: z.string().max(2_000).optional(),
  completionCriteria: z.string().max(2_000).optional(),
  timeHorizon: z.string().max(200).optional(),
  obstacles: z.string().max(2_000).optional(),
  workContextId: uuid.nullable().optional(),
  status: stageGoalStatusSchema.optional()
})

/** 待确认草稿的三类。确认与丢弃都按它分派。 */
export const PROPOSAL_KINDS = ['currentState', 'direction', 'stage'] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]
export const proposalKindSchema = z.enum(PROPOSAL_KINDS)

// 入参用 `z.input`：schema 里有 `.default()`，调用方可以省略这些字段，
// 由 zod 在边界上补齐——`z.infer` 会把它们当成必填，Renderer 那边就得多写一堆空串。
export type DirectionInput = z.input<typeof directionInputSchema>
export type DirectionPatch = z.infer<typeof directionPatchSchema>
export type StageGoalInput = z.input<typeof stageGoalInputSchema>
export type StageGoalPatch = z.infer<typeof stageGoalPatchSchema>

// MARK: - Studio 视图

/**
 * Studio Home 底部面板一次性要的全部数据。
 *
 * 一次取回而不是分三次：这三层永远要一起看（没有阶段的方框是空话），
 * 分开请求只会多出两次 loading 与三种中间态。
 */
export type PersonalDirectionOverview = {
  /** 当前生效的现状（status = confirmed），没写过就是 null。 */
  currentState: CurrentState | null
  /** 历史现状，新的在前；不含 currentState 本身。 */
  currentStateHistory: CurrentState[]
  /** 待用户确认的现状草稿（Agent 提议的）。 */
  currentStateDraft: CurrentState | null
  directions: Direction[]
  /** 待确认的方向提议与阶段提议，UI 用提示条呈现。 */
  proposalCount: number
  stages: StageGoal[]
}
