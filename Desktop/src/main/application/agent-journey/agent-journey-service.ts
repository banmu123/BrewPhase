import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ApplicationError } from '../errors'
import type { ApplicationEvents } from '../events/application-events'
import type { Db } from '../../database/client'
import type { McpErrorCode } from '../../../shared/contracts/mcp'
import { selectWorkContext } from '../../database/repositories/work-contexts'
import { records } from '../../database/schema'
import {
  countLinksForJourney,
  countNotesForJourney,
  createLink,
  createNote,
  isJourneyLinkType,
  listLinksForJourney,
  listNotesForJourney,
  removeLink,
  removeNote,
  updateNote
} from '../../database/repositories/agent-journey-supplements'
import {
  AGENT_JOURNEY_CAPTURE_MODES,
  AGENT_JOURNEY_EDGE_TYPES,
  AGENT_JOURNEY_EVENT_TYPES,
  AGENT_JOURNEY_EXECUTION_EVENT_TYPES,
  AGENT_JOURNEY_STATEMENT_EVENT_TYPES,
  AGENT_JOURNEY_TERMINAL_STATUSES,
  countJourneys,
  eventJourneyId,
  insertEdge,
  insertEvent,
  insertJourney,
  nextSequence,
  selectEdges,
  selectEvent,
  selectEvents,
  selectJourney,
  selectJourneys,
  updateEventStatus as updateEventStatusRow,
  updateJourney,
  updateJourneyUnchecked,
  type AgentJourney,
  type AgentJourneyCaptureMode,
  type AgentJourneyEdge,
  type AgentJourneyEdgeType,
  type AgentJourneyEvent,
  type AgentJourneyEventType,
  type AgentJourneyEventStatus,
  type AgentJourneyRole,
  type AgentJourneyStatus
} from '../../database/repositories/agent-journeys'
import { lookupIdempotency, recordIdempotency } from '../../database/repositories/mcp-idempotency'
import { JOURNEY_METADATA_MAX, JOURNEY_TEXT_LIMITS, redactDeep, sanitizeJourneyContent } from './sanitize'

/**
 * AgentJourneyService：一次 Agent 任务执行历程的应用服务（R6-1）。
 *
 * ## 边界
 *
 * - 校验、状态机、脱敏、事务与幂等都在这里；**MCP 进程与 Renderer 都没有
 *   数据库权限**，它们只能通过（R6-2 的）工具或 IPC 走到这里；
 * - **不在本类里做认证**：调用者身份由入口构造好之后按值传入
 *   （`AgentJourneyCallContext`），本类只校验「有没有」，不猜「是谁」；
 * - **查询是纯读**：不推进状态、不跑超时清理、不发事件（§19.1）。
 *
 * ## 幂等（§19.2）
 *
 * `mcp_idempotency` 是 MCP 请求级重放的主要记录；`agent_journey_events`
 * 上的 `UNIQUE(journey_id, source_client_id, idempotency_key)` 只是**事件级
 * 唯一性兜底**，不构成第二套重放逻辑。两者在**同一个事务**里写，
 * 因此不存在「业务已写、幂等没写」的崩溃窗口。
 *
 * `requestDigest` 由调用方传入（R6-2 来自 `executeTool` 经 Zod 解析后的
 * 完整参数），**本类不重新拼接摘要**——用残缺的业务字段重算会得到一个
 * 与路由层永远对不上的值，重放就废了。
 */

// MARK: - 可信调用上下文

/**
 * 一次写调用的**可信**上下文。
 *
 * `actor.clientId` 只能由认证后的入口构造（R6-2 由 `ToolExecutionContext` 构造）。
 * **业务入参里没有 `source_client_id`**——请求体传了也会被忽略，因为字段压根
 * 不存在于输入类型里。`source_agent` / `model` 是客户端自报元数据，永不参与身份判定。
 *
 * R6-1 **不实现 `ToolExecutionContext`**，也**不使用全局变量**保存当前 Client：
 * Main 是多客户端、多请求的长期进程，全局可变身份会并发串号。
 */
export type AgentJourneyCallContext = {
  actor: { kind: 'mcp_client'; clientId: string }
  idempotency: { key: string; toolName: string; requestDigest: string }
}

/**
 * 两个幂等操作各自的工具名。
 *
 * **一个方法只认一个工具名**：`AgentJourneyCallContext.idempotency.toolName`
 * 不能只校验「非空」——否则调用方可以把 `append_agent_journey_event` 的上下文
 * 传给 `createJourney()`，幂等记录的 `tool_name` 就会与真实操作对不上，
 * 之后的重放会把一个工具的结果当成另一个工具的成功结果。
 */
export const START_AGENT_JOURNEY_TOOL = 'start_agent_journey'
export const APPEND_AGENT_JOURNEY_EVENT_TOOL = 'append_agent_journey_event'

/** 幂等键只在 start / append 上存在；更新类操作靠乐观锁。 */
export const AGENT_JOURNEY_IDEMPOTENT_OPS = [
  START_AGENT_JOURNEY_TOOL,
  APPEND_AGENT_JOURNEY_EVENT_TOOL
] as const

export class AgentJourneyError extends ApplicationError {
  constructor(code: McpErrorCode, message: string) {
    super(code, message)
    this.name = 'AgentJourneyError'
  }
}

// MARK: - 输入 / 输出

export type CreateJourneyInput = {
  title: string
  goal?: string
  workContextId?: string | null
  sourceAgent?: string
  model?: string
  captureMode?: AgentJourneyCaptureMode
  now?: number
}

export type CreateJourneyResult = {
  journey: AgentJourney
  created: boolean
  replayed: boolean
}

export type AppendEventInput = {
  journeyId: string
  eventType: AgentJourneyEventType
  status?: AgentJourneyEventStatus
  evidenceLevel?: string
  role?: AgentJourneyRole
  title: string
  summary?: string
  content?: string
  reason?: string
  attemptId?: string | null
  parentEventId?: string | null
  edges?: Array<{ toEventId: string; relationshipType: AgentJourneyEdgeType }>
  sourceAgent?: string
  model?: string
  occurredAt?: number
  metadata?: Record<string, unknown> | null
  /** 只接受 `'completed'`，且必须配合 `eventType='outcome'`。 */
  journeyStatus?: string
  now?: number
}

export type AppendEventResult = {
  event: AgentJourneyEvent
  edges: AgentJourneyEdge[]
  sequence: number
  journey: AgentJourney
  created: boolean
  replayed: boolean
}

export type JourneyListResult = {
  journeys: AgentJourney[]
  total: number
}

export type JourneyDetail = {
  journey: AgentJourney
  events: AgentJourneyEvent[]
  edges: AgentJourneyEdge[]
}

export type EventListOptions = {
  eventTypes?: readonly AgentJourneyEventType[]
  sinceSequence?: number
  limit?: number
}

// MARK: - 状态机常量

/** 执行类事件允许的推进（§19.5）。终态为空数组 = 不可逆。 */
const EXECUTION_TRANSITIONS: Record<AgentJourneyEventStatus, readonly AgentJourneyEventStatus[]> = {
  planned: ['running', 'skipped', 'cancelled'],
  running: ['completed', 'failed', 'skipped', 'cancelled'],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: []
}

/**
 * Journey 允许的目标状态（`updateJourneyStatus`）。
 *
 * `abandoned` **不在其中**：R6-1 不实现超时维护机制（§19.1），它是不可达状态；
 * `completed` 只能由 Outcome 事件在同一事务里推进。
 */
const JOURNEY_TRANSITIONS: Record<AgentJourneyStatus, readonly AgentJourneyStatus[]> = {
  created: ['running', 'cancelled'],
  running: ['paused', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  failed: ['running', 'cancelled'],
  abandoned: ['running', 'cancelled'],
  completed: [],
  cancelled: []
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGEST_RE = /^[0-9a-f]{64}$/

function isStatementEvent(type: AgentJourneyEventType): boolean {
  return AGENT_JOURNEY_STATEMENT_EVENT_TYPES.includes(type)
}

function isExecutionEvent(type: AgentJourneyEventType): boolean {
  return AGENT_JOURNEY_EXECUTION_EVENT_TYPES.includes(type)
}

function isTerminalStatus(status: AgentJourneyStatus): boolean {
  return AGENT_JOURNEY_TERMINAL_STATUSES.includes(status)
}

/** `role` 由 `event_type` 决定；调用方传了就必须一致（不允许把 plan 说成用户说的）。 */
function derivedRole(type: AgentJourneyEventType): AgentJourneyRole {
  return type === 'user_input' || type === 'user_annotation' ? 'user' : 'agent'
}

// MARK: - Service

export class AgentJourneyService {
  constructor(
    private readonly db: Db,
    private readonly events: ApplicationEvents
  ) {}

  // ---- 写：创建 Journey ----

  createJourney(ctx: AgentJourneyCallContext, input: CreateJourneyInput): CreateJourneyResult {
    const clientId = requireClientId(ctx)
    const idem = requireIdempotency(ctx)
    // 方法与工具名绑定：不一致时在**任何写入之前**拒绝，
    // 业务表与幂等表都不会留下痕迹。
    if (idem.toolName !== START_AGENT_JOURNEY_TOOL) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `createJourney requires toolName "${START_AGENT_JOURNEY_TOOL}" (got "${idem.toolName}")`
      )
    }
    const now = input.now ?? Date.now()

    const title = sanitizeJourneyContent(input.title ?? '', { max: JOURNEY_TEXT_LIMITS.title })
    if (title.trim().length === 0) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'title is required')
    }
    // goal 有独立上限（设计文档 §7.2 ≤2000），不是正文的 20000。
    const goal = sanitizeJourneyContent(input.goal ?? '', { max: JOURNEY_TEXT_LIMITS.goal })
    const sourceAgent = sanitizeJourneyContent(input.sourceAgent ?? '', {
      max: JOURNEY_TEXT_LIMITS.label
    })
    const model = sanitizeJourneyContent(input.model ?? '', { max: JOURNEY_TEXT_LIMITS.label })

    const captureMode = input.captureMode ?? 'workflow_summary'
    if (!AGENT_JOURNEY_CAPTURE_MODES.includes(captureMode)) {
      throw new AgentJourneyError('VALIDATION_ERROR', `unknown capture mode: ${String(captureMode)}`)
    }
    // R6-1 没有用户授权界面，因此只允许默认模式：非默认模式必须等用户显式授权
    // （设置页），不能由 Agent 自己把采集范围提上去。
    if (captureMode !== 'workflow_summary') {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `capture mode "${captureMode}" requires explicit user consent, which is not available yet`
      )
    }

    const workContextId = input.workContextId ?? null
    if (workContextId !== null && !UUID_RE.test(workContextId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'work_context_id must be a uuid')
    }
    // **Work Context 是否存在必须放到事务内的创建分支里查**（见下面的注释）。

    const outcome = this.db.transaction((tx): CreateJourneyResult => {
      const scoped = tx as unknown as Db

      // ---- 1) 先处理已有幂等记录（在任何外部状态校验之前）----
      const existing = lookupIdempotency(scoped, clientId, idem.key)
      if (existing) {
        // 工具身份也必须对得上：同一 Client 用同一个 key 调另一个工具时，
        // 绝不能把上一个工具的结果当成这次的成功结果。
        if (existing.toolName !== idem.toolName) {
          throw new AgentJourneyError(
            'IDEMPOTENCY_KEY_REUSE',
            'this idempotency_key was already used by a different tool'
          )
        }
        if (existing.requestDigest !== idem.requestDigest) {
          throw new AgentJourneyError(
            'IDEMPOTENCY_KEY_REUSE',
            'this idempotency_key was already used with different params'
          )
        }
        if (existing.entityType !== 'agentJourney' || !existing.entityId) {
          throw new AgentJourneyError('INTERNAL_ERROR', 'idempotency record has no journey id')
        }
        const replayed = selectJourney(scoped, existing.entityId)
        if (!replayed) {
          throw new AgentJourneyError('NOT_FOUND', 'the recorded journey no longer exists')
        }
        // 回放**不看** Work Context 是否还在：原始请求创建成功之后，
        // 用户可能已经删掉了那个上下文（`ON DELETE SET NULL` 保留了 Journey）。
        // 这时再用完全相同的请求重放，必须拿回原来那条 Journey，
        // 而不是在幂等检查之前先抛 NOT_FOUND。
        return { journey: replayed, created: false, replayed: true }
      }

      // ---- 2) 只有真正创建新 Journey 时才校验外部依赖 ----
      if (workContextId !== null && !selectWorkContext(scoped, workContextId)) {
        throw new AgentJourneyError('NOT_FOUND', `work context ${workContextId} does not exist`)
      }

      const journey = insertJourney(scoped, {
        title,
        goal,
        status: 'created',
        sourceClientId: clientId,
        sourceAgent,
        model,
        workContextId,
        captureMode,
        now
      })
      recordIdempotency(scoped, {
        clientId,
        key: idem.key,
        requestDigest: idem.requestDigest,
        toolName: idem.toolName,
        entityType: 'agentJourney',
        entityId: journey.id
      })
      return { journey, created: true, replayed: false }
    })

    // 事务提交之后才广播；回滚（异常）时根本走不到这里。
    if (outcome.created) this.events.emit('agentJourneys')
    return outcome
  }

  // ---- 写：追加事件 ----

  appendEvent(ctx: AgentJourneyCallContext, input: AppendEventInput): AppendEventResult {
    const clientId = requireClientId(ctx)
    const idem = requireIdempotency(ctx)
    // 同 createJourney：先绑工具名，再碰任何状态。
    if (idem.toolName !== APPEND_AGENT_JOURNEY_EVENT_TOOL) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `appendEvent requires toolName "${APPEND_AGENT_JOURNEY_EVENT_TOOL}" (got "${idem.toolName}")`
      )
    }
    const now = input.now ?? Date.now()

    if (!input.journeyId || !UUID_RE.test(input.journeyId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'journey_id must be a uuid')
    }
    const eventType = input.eventType
    if (!AGENT_JOURNEY_EVENT_TYPES.includes(eventType)) {
      throw new AgentJourneyError('VALIDATION_ERROR', `unknown event_type: ${String(eventType)}`)
    }

    const statement = isStatementEvent(eventType)
    const execution = isExecutionEvent(eventType)
    if (!statement && !execution) {
      throw new AgentJourneyError('VALIDATION_ERROR', `event_type ${eventType} has no kind rule`)
    }

    const evidenceLevel = input.evidenceLevel ?? 'agent_reported'
    if (evidenceLevel !== 'agent_reported') {
      // v1 没有运行时观察通道：放行这两个值等于把「我声称跑过」包装成
      // 「系统观察到它跑了」（§4.3 / §19.5）。
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `evidence_level "${evidenceLevel}" is not writable in this version; only agent_reported is`
      )
    }

    const expectedRole = derivedRole(eventType)
    const role = input.role ?? expectedRole
    if (role !== expectedRole) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `event_type ${eventType} must use role "${expectedRole}" (got "${role}")`
      )
    }

    const status = input.status ?? (statement ? 'completed' : 'planned')
    assertCreationStatus(eventType, status, statement)

    const title = sanitizeJourneyContent(input.title ?? '', { max: JOURNEY_TEXT_LIMITS.title })
    if (title.trim().length === 0) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'title is required')
    }
    const summary = sanitizeJourneyContent(input.summary ?? '', { max: JOURNEY_TEXT_LIMITS.summary })
    const content = sanitizeJourneyContent(input.content ?? '', { max: JOURNEY_TEXT_LIMITS.content })
    const reason = sanitizeJourneyContent(input.reason ?? '', { max: JOURNEY_TEXT_LIMITS.reason })
    const sourceAgent = sanitizeJourneyContent(input.sourceAgent ?? '', {
      max: JOURNEY_TEXT_LIMITS.label
    })
    const model = sanitizeJourneyContent(input.model ?? '', { max: JOURNEY_TEXT_LIMITS.label })
    const metadata = serializeMetadata(input.metadata)

    const parentEventId = input.parentEventId ?? null
    if (parentEventId !== null && !UUID_RE.test(parentEventId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'parent_event_id must be a uuid')
    }

    const journeyStatus = input.journeyStatus
    if (journeyStatus !== undefined) {
      if (journeyStatus !== 'completed') {
        throw new AgentJourneyError('VALIDATION_ERROR', 'journey_status only accepts "completed"')
      }
      if (eventType !== 'outcome') {
        throw new AgentJourneyError(
          'VALIDATION_ERROR',
          'journey_status is only allowed with event_type="outcome"'
        )
      }
    }

    const nowMs = now
    const outcome = this.db.transaction((tx): AppendEventResult => {
      const scoped = tx as unknown as Db

      // 1) 请求级幂等：同 key 同摘要回放，异摘要拒绝。
      const existing = lookupIdempotency(scoped, clientId, idem.key)
      if (existing) {
        // 工具身份必须一致：同 key 同摘要但来自另一个工具，也绝不能回放。
        if (existing.toolName !== idem.toolName) {
          throw new AgentJourneyError(
            'IDEMPOTENCY_KEY_REUSE',
            'this idempotency_key was already used by a different tool'
          )
        }
        if (existing.requestDigest !== idem.requestDigest) {
          throw new AgentJourneyError(
            'IDEMPOTENCY_KEY_REUSE',
            'this idempotency_key was already used with different params'
          )
        }
        if (existing.entityType !== 'agentJourneyEvent' || !existing.entityId) {
          throw new AgentJourneyError('INTERNAL_ERROR', 'idempotency record has no event id')
        }
        const replayed = selectEvent(scoped, existing.entityId)
        if (!replayed) {
          throw new AgentJourneyError('NOT_FOUND', 'the recorded event no longer exists')
        }
        const journey = selectJourney(scoped, replayed.journeyId)
        if (!journey) throw new AgentJourneyError('NOT_FOUND', 'the recorded journey no longer exists')
        return {
          event: replayed,
          edges: selectEdges(scoped, replayed.journeyId).filter((e) => e.fromEventId === replayed.id),
          sequence: replayed.sequence,
          journey,
          created: false,
          replayed: true
        }
      }

      // 2) Journey 必须存在，且仍在采集。
      const journey = selectJourney(scoped, input.journeyId)
      if (!journey) {
        throw new AgentJourneyError('NOT_FOUND', `journey ${input.journeyId} does not exist`)
      }
      if (isTerminalStatus(journey.status)) {
        throw new AgentJourneyError(
          'VALIDATION_ERROR',
          `journey is ${journey.status} and no longer accepts events`
        )
      }
      if (journey.status !== 'created' && journey.status !== 'running') {
        throw new AgentJourneyError(
          'VALIDATION_ERROR',
          `journey is ${journey.status}; resume it before appending events`
        )
      }

      // 3) parent_event_id：结构性归属，必须属于同一 Journey（且必然存在）。
      if (parentEventId !== null) {
        const parentJourney = eventJourneyId(scoped, parentEventId)
        if (!parentJourney) {
          throw new AgentJourneyError('NOT_FOUND', `parent event ${parentEventId} does not exist`)
        }
        if (parentJourney !== input.journeyId) {
          throw new AgentJourneyError(
            'VALIDATION_ERROR',
            'parent_event_id belongs to a different journey'
          )
        }
      }

      const sequence = nextSequence(scoped, input.journeyId)
      const eventId = randomUUID()

      // 4) 插入事件。事实字段已脱敏，落库即最终值。
      const event = insertEvent(scoped, {
        id: eventId,
        journeyId: input.journeyId,
        sequence,
        eventType,
        role,
        status,
        evidenceLevel: evidenceLevel as 'agent_reported',
        title,
        summary,
        content,
        reason,
        sourceClientId: clientId,
        sourceAgent,
        model,
        attemptId: input.attemptId ?? null,
        parentEventId,
        idempotencyKey: idem.key,
        occurredAt: input.occurredAt ?? nowMs,
        receivedAt: nowMs,
        metadata
      })

      // 5) Edge：**在事件插入之后**校验——这样任何一条非法边都会把第 4 步
      //    的插入一起回滚（事务原子性的可测点，测试 12）。
      const edges: AgentJourneyEdge[] = []
      for (const edge of input.edges ?? []) {
        if (!AGENT_JOURNEY_EDGE_TYPES.includes(edge.relationshipType)) {
          throw new AgentJourneyError(
            'VALIDATION_ERROR',
            `unknown relationship_type: ${String(edge.relationshipType)}`
          )
        }
        if (edge.toEventId === eventId) {
          throw new AgentJourneyError('VALIDATION_ERROR', 'an event cannot relate to itself')
        }
        const targetJourney = eventJourneyId(scoped, edge.toEventId)
        if (!targetJourney) {
          throw new AgentJourneyError('NOT_FOUND', `edge target ${edge.toEventId} does not exist`)
        }
        if (targetJourney !== input.journeyId) {
          throw new AgentJourneyError('VALIDATION_ERROR', 'edge target belongs to a different journey')
        }
        edges.push(
          insertEdge(scoped, {
            journeyId: input.journeyId,
            fromEventId: eventId,
            toEventId: edge.toEventId,
            relationshipType: edge.relationshipType,
            now: nowMs
          })
        )
      }

      // 6) Journey 状态：created → running（首个事件）；Outcome 原子完成。
      let current = journey
      if (current.status === 'created') {
        current = updateJourneyUnchecked(
          scoped,
          current.id,
          { status: 'running', startedAt: current.startedAt ?? nowMs },
          nowMs
        )
      }
      if (journeyStatus === 'completed') {
        current = updateJourneyUnchecked(
          scoped,
          current.id,
          { status: 'completed', completedAt: nowMs },
          nowMs
        )
      }

      // 7) 幂等记录：与业务写入同事务，杜绝「业务已写、幂等没写」的窗口。
      recordIdempotency(scoped, {
        clientId,
        key: idem.key,
        requestDigest: idem.requestDigest,
        toolName: idem.toolName,
        entityType: 'agentJourneyEvent',
        entityId: event.id
      })

      return { event, edges, sequence, journey: current, created: true, replayed: false }
    })

    if (outcome.created) this.events.emit('agentJourneys')
    return outcome
  }

  // ---- 写：推进事件状态 ----

  updateEventStatus(input: {
    eventId: string
    status: AgentJourneyEventStatus
    expectedUpdatedAt: number
    now?: number
  }): AgentJourneyEvent {
    if (!UUID_RE.test(input.eventId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'event_id must be a uuid')
    }
    const now = input.now ?? Date.now()
    const event = selectEvent(this.db, input.eventId)
    if (!event) throw new AgentJourneyError('NOT_FOUND', `event ${input.eventId} does not exist`)

    if (!isExecutionEvent(event.eventType)) {
      // 陈述类事件创建即 completed：正文与状态都不再可改（§19.5）。
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `event_type ${event.eventType} is a statement event; its status cannot be changed`
      )
    }
    const allowed = EXECUTION_TRANSITIONS[event.status]
    if (!allowed.includes(input.status)) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `illegal status transition ${event.status} → ${input.status}`
      )
    }

    const updated = updateEventStatusRow(this.db, {
      id: input.eventId,
      status: input.status,
      expectedUpdatedAt: input.expectedUpdatedAt,
      now
    })
    if (!updated) {
      throw new AgentJourneyError('STALE_RECORD', 'the event changed since it was read')
    }
    this.events.emit('agentJourneys')
    return updated
  }

  // ---- 写：推进 Journey 状态 ----

  updateJourneyStatus(input: {
    journeyId: string
    status: AgentJourneyStatus
    expectedUpdatedAt: number
    now?: number
  }): AgentJourney {
    if (!UUID_RE.test(input.journeyId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'journey_id must be a uuid')
    }
    const now = input.now ?? Date.now()
    const journey = selectJourney(this.db, input.journeyId)
    if (!journey) {
      throw new AgentJourneyError('NOT_FOUND', `journey ${input.journeyId} does not exist`)
    }
    if (isTerminalStatus(journey.status)) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `journey is ${journey.status}; this is a terminal state`
      )
    }
    const allowed = JOURNEY_TRANSITIONS[journey.status]
    if (!allowed.includes(input.status)) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `illegal journey transition ${journey.status} → ${input.status}`
      )
    }

    // 取消：把未收尾的执行事件标成 cancelled（**保留历史，绝不删除**）。
    // 与 Journey 状态更新放在同一个事务里。
    const updated = this.db.transaction((tx): AgentJourney => {
      const scoped = tx as unknown as Db
      if (input.status === 'cancelled') {
        for (const open of selectEvents(scoped, journey.id)) {
          if (!isExecutionEvent(open.eventType)) continue
          if (open.status !== 'planned' && open.status !== 'running') continue
          updateEventStatusRow(scoped, {
            id: open.id,
            status: 'cancelled',
            expectedUpdatedAt: open.updatedAt,
            now
          })
        }
      }
      const patch: { status: AgentJourneyStatus; startedAt?: number; completedAt?: number | null } = {
        status: input.status
      }
      if (input.status === 'running' && journey.startedAt === null) patch.startedAt = now
      if (input.status === 'completed') patch.completedAt = now

      const row = updateJourney(scoped, journey.id, input.expectedUpdatedAt, patch, now)
      if (!row) {
        throw new AgentJourneyError('STALE_RECORD', 'the journey changed since it was read')
      }
      return row
    })

    this.events.emit('agentJourneys')
    return updated
  }

  // ---- 读（纯读取：不改状态、不发事件） ----

  listJourneys(filter: {
    status?: AgentJourneyStatus
    workContextId?: string
    limit?: number
    offset?: number
  } = {}): JourneyListResult {
    const journeys = selectJourneys(this.db, filter)
    return { journeys, total: countJourneys(this.db, filter) }
  }

  getJourney(journeyId: string, options: EventListOptions = {}): JourneyDetail {
    if (!UUID_RE.test(journeyId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'journey_id must be a uuid')
    }
    const journey = selectJourney(this.db, journeyId)
    if (!journey) throw new AgentJourneyError('NOT_FOUND', `journey ${journeyId} does not exist`)
    return {
      journey,
      events: selectEvents(this.db, journeyId, options),
      edges: selectEdges(this.db, journeyId)
    }
  }

  // ================================================================
  // R6-4.1：Records / Canvas 融合（Renderer 侧）
  //
  // 这些方法**复用同一个 AgentJourneyService 实例**（main/index.ts:257 构造的
  // 那一个，也是 MCP Bridge 拿到的那一个）——不新建第二个 Service，否则
  // `app:changed` 会只有一半窗口收到。
  //
  // 与 MCP 写路径的差别：这里没有 MCP Client 身份，也不需要幂等键——
  // 调用方是本机 Renderer（已过 IPC 白名单 + zod 校验），语义是「用户在
  // 自己的机器上补一条笔记 / 建一条关系」，不是「Agent 提交一次执行事实」。
  // 因此**不写** `source_client_id`、不写 `mcp_idempotency`、不发审计。
  //
  // 铁律：本区域任何写入都**不触碰** `agent_journey_events` / `agent_journey_edges`
  // ——用户笔记与跨记录关系是独立持久化，Agent 原始执行记录一个字节都不改。
  // ================================================================

  /** Records 页的 Journey 卡片列表（含事件数、关联数、笔记数）。 */
  listForRecords(filter: { limit?: number; offset?: number; search?: string } = {}) {
    const journeys = selectJourneys(this.db, {
      limit: filter.limit ?? 100,
      offset: filter.offset ?? 0
    })
    const search = (filter.search ?? '').trim().toLowerCase()
    const cards = journeys.map((journey) => this.toRecordCard(journey))
    const visible = search
      ? cards.filter(
          (card) =>
            card.title.toLowerCase().includes(search) ||
            card.goal.toLowerCase().includes(search) ||
            card.source_agent.toLowerCase().includes(search)
        )
      : cards
    return { journeys: visible, total: visible.length }
  }

  /**
   * Journey 详情（Records 详情页 + Canvas Inspector 共用）：
   * 原始目标 + 全部事件（按 sequence 升序）+ 业务 Edge + 用户笔记 + 跨记录关系。
   *
   * **必须做 camelCase → snake_case 的 DTO 映射**：契约
   * （`shared/contracts/entities/agent-journey.ts`）是 snake_case，而 Repository
   * 返回的是领域对象（`eventId` / `occurredAt` / `createdAt`…）。直接透传
   * 编译器不会报错（IPC 的 invoke 返回值是宽松类型），但运行时
   * `note.event_id` 恒为 undefined——笔记与关系会「静默消失」。
   */
  getDetailForRenderer(journeyId: string) {
    const detail = this.getJourney(journeyId)
    const card = this.toRecordCard(detail.journey)
    return {
      journey: card,
      events: detail.events.map((event) => ({
        id: event.id,
        journey_id: event.journeyId,
        sequence: event.sequence,
        event_type: event.eventType,
        role: event.role,
        status: event.status,
        title: event.title,
        summary: event.summary,
        content: event.content,
        reason: event.reason,
        source_agent: event.sourceAgent,
        model: event.model,
        occurred_at: event.occurredAt,
        updated_at: event.updatedAt
      })),
      edges: detail.edges.map((edge) => ({
        id: edge.id,
        journey_id: edge.journeyId,
        from_event_id: edge.fromEventId,
        to_event_id: edge.toEventId,
        relationship_type: edge.relationshipType,
        created_at: edge.createdAt
      })),
      notes: listNotesForJourney(this.db, journeyId).map((note) => ({
        id: note.id,
        journey_id: note.journeyId,
        event_id: note.eventId,
        body: note.body,
        created_at: note.createdAt,
        updated_at: note.updatedAt
      })),
      links: listLinksForJourney(this.db, journeyId).map((link) => ({
        id: link.id,
        journey_id: link.journeyId,
        event_id: link.eventId,
        record_id: link.recordId,
        relationship_type: link.relationshipType,
        created_at: link.createdAt,
        updated_at: link.updatedAt
      }))
    }
  }

  /** Journey 级笔记。 */
  addJourneyNote(input: { journeyId: string; body: string }) {
    const body = this.assertNoteBody(input.body)
    this.requireJourney(input.journeyId)
    const note = createNote(this.db, {
      journeyId: input.journeyId,
      eventId: null,
      body,
      now: Date.now()
    })
    this.events.emit('agentJourneys')
    return note
  }

  /** Event 级笔记：事件必须存在且属于该 Journey。 */
  addEventNote(input: { journeyId: string; eventId: string; body: string }) {
    const body = this.assertNoteBody(input.body)
    this.requireEvent(input.journeyId, input.eventId)
    const note = createNote(this.db, {
      journeyId: input.journeyId,
      eventId: input.eventId,
      body,
      now: Date.now()
    })
    this.events.emit('agentJourneys')
    return note
  }

  /** 编辑笔记：只写 `agent_journey_notes`，Agent 原始事件不可达。 */
  updateJourneyNote(input: { id: string; body: string }) {
    const body = this.assertNoteBody(input.body)
    const note = updateNote(this.db, input.id, body, Date.now())
    if (!note) throw new AgentJourneyError('NOT_FOUND', `note ${input.id} does not exist`)
    this.events.emit('agentJourneys')
    return note
  }

  /** 删除笔记：只删笔记行，Journey 与事件原样保留。 */
  removeJourneyNote(id: string): { removed: boolean } {
    const result = removeNote(this.db, id)
    if (result.removed) this.events.emit('agentJourneys')
    return result
  }

  /**
   * 建立 Event ↔ Record 关系。
   *
   * 归属 Journey 领域：两端必须真实存在且 Event 属于该 Journey。
   * **不创建任何 Journey 事件或业务 Edge**——这是纯用户侧补充。
   */
  addRecordLink(input: {
    journeyId: string
    eventId: string
    recordId: string
    relationshipType: string
  }) {
    if (!isJourneyLinkType(input.relationshipType)) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `unknown relationship_type: ${input.relationshipType}`
      )
    }
    this.requireEvent(input.journeyId, input.eventId)
    const record = this.db
      .select({ id: records.id })
      .from(records)
      .where(eq(records.id, input.recordId))
      .get()
    if (!record) throw new AgentJourneyError('NOT_FOUND', `record ${input.recordId} does not exist`)

    const link = createLink(this.db, {
      journeyId: input.journeyId,
      eventId: input.eventId,
      recordId: input.recordId,
      relationshipType: input.relationshipType,
      now: Date.now()
    })
    this.events.emit('agentJourneys')
    return link
  }

  /** 删除关系：只删关系行，**原始 Record 与 Journey 事件都必须原样保留**。 */
  removeRecordLink(id: string): { removed: boolean } {
    const result = removeLink(this.db, id)
    if (result.removed) this.events.emit('agentJourneys')
    return result
  }

  /** 某条 Journey 的全部事件 ID（放进画布时要给每个事件建摆位行）。 */
  eventIdsFor(journeyId: string): string[] {
    return selectEvents(this.db, journeyId).map((event) => event.id)
  }

  // ---- 内部校验 ----

  private assertNoteBody(body: string): string {
    if (typeof body !== 'string') {
      throw new AgentJourneyError('VALIDATION_ERROR', 'body must be a string')
    }
    const trimmed = body.trim()
    if (trimmed.length === 0) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'body is required')
    }
    // 笔记同样走脱敏：用户贴日志时难免带出 token。
    return sanitizeJourneyContent(trimmed, { max: JOURNEY_TEXT_LIMITS.content })
  }

  private requireJourney(journeyId: string): AgentJourney {
    if (!UUID_RE.test(journeyId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'journey_id must be a uuid')
    }
    const journey = selectJourney(this.db, journeyId)
    if (!journey) throw new AgentJourneyError('NOT_FOUND', `journey ${journeyId} does not exist`)
    return journey
  }

  /** 事件必须存在**且属于给定 Journey**——防止跨 Journey 借用事件 ID。 */
  private requireEvent(journeyId: string, eventId: string): AgentJourneyEvent {
    this.requireJourney(journeyId)
    if (!UUID_RE.test(eventId)) {
      throw new AgentJourneyError('VALIDATION_ERROR', 'event_id must be a uuid')
    }
    const event = selectEvent(this.db, eventId)
    if (!event) throw new AgentJourneyError('NOT_FOUND', `event ${eventId} does not exist`)
    if (event.journeyId !== journeyId) {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `event ${eventId} does not belong to journey ${journeyId}`
      )
    }
    return event
  }

  private toRecordCard(journey: AgentJourney) {
    const events = selectEvents(this.db, journey.id)
    return {
      id: journey.id,
      title: journey.title,
      goal: journey.goal,
      status: journey.status,
      source_client_id: journey.sourceClientId,
      source_agent: journey.sourceAgent,
      model: journey.model,
      created_at: journey.createdAt,
      updated_at: journey.updatedAt,
      completed_at: journey.completedAt,
      event_count: events.length,
      link_count: countLinksForJourney(this.db, journey.id),
      note_count: countNotesForJourney(this.db, journey.id),
      /** 卡片上的执行摘要：取最后一个非空 summary，没有就退回 goal。 */
      summary:
        [...events].reverse().find((event) => event.summary.trim().length > 0)?.summary.trim() ??
        journey.goal
    }
  }
}

// MARK: - 内部工具

function requireClientId(ctx: AgentJourneyCallContext): string {
  const clientId = ctx?.actor?.clientId
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    // 拿不到可信身份就拒绝写入：不允许匿名降级，更不允许伪造来源。
    throw new AgentJourneyError('UNAUTHORIZED', 'a trusted caller identity is required')
  }
  if (ctx.actor.kind !== 'mcp_client') {
    throw new AgentJourneyError('UNAUTHORIZED', `unsupported actor kind: ${String(ctx.actor.kind)}`)
  }
  return clientId
}

function requireIdempotency(ctx: AgentJourneyCallContext): {
  key: string
  toolName: string
  requestDigest: string
} {
  const idem = ctx?.idempotency
  if (!idem) throw new AgentJourneyError('VALIDATION_ERROR', 'idempotency context is required')
  if (typeof idem.key !== 'string' || idem.key.length === 0 || idem.key.length > 200) {
    throw new AgentJourneyError('VALIDATION_ERROR', 'idempotency key must be 1..200 characters')
  }
  if (typeof idem.toolName !== 'string' || idem.toolName.length === 0) {
    throw new AgentJourneyError('VALIDATION_ERROR', 'idempotency toolName is required')
  }
  if (typeof idem.requestDigest !== 'string' || !DIGEST_RE.test(idem.requestDigest)) {
    // 摘要必须来自 digestParams（executeTool 解析后的完整参数），
    // 不接受随手拼的字符串——否则与路由层永远对不上，重放会失效。
    throw new AgentJourneyError(
      'VALIDATION_ERROR',
      'requestDigest must be the sha256 of the parsed request params'
    )
  }
  return { key: idem.key, toolName: idem.toolName, requestDigest: idem.requestDigest }
}

function assertCreationStatus(
  eventType: AgentJourneyEventType,
  status: AgentJourneyEventStatus,
  statement: boolean
): void {
  if (statement) {
    if (status !== 'completed') {
      throw new AgentJourneyError(
        'VALIDATION_ERROR',
        `event_type ${eventType} is a statement event and must be created as completed`
      )
    }
    return
  }
  if (status !== 'planned' && status !== 'running') {
    // 「宣布做完了」和「做完了」必须是两次独立写入，后者带自己的乐观锁。
    throw new AgentJourneyError(
      'VALIDATION_ERROR',
      `event_type ${eventType} must be created as planned or running (got ${status})`
    )
  }
}

function serializeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (metadata === null || metadata === undefined) return null
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new AgentJourneyError('VALIDATION_ERROR', 'metadata must be an object')
  }
  // 递归脱敏叶子字符串后再序列化：直接对整段 JSON 跑正则会吃掉成对引号。
  const json = JSON.stringify(redactDeep(metadata))
  if (json === undefined) throw new AgentJourneyError('VALIDATION_ERROR', 'metadata is not serializable')
  if (json.length > JOURNEY_METADATA_MAX) {
    throw new AgentJourneyError('VALIDATION_ERROR', `metadata exceeds ${JOURNEY_METADATA_MAX} chars`)
  }
  return json
}
