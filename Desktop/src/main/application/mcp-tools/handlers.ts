import { isLocalToolContext, type ToolExecutionContext } from '../../../shared/contracts/mcp'
import type { WorkContextStatus } from '../../../shared/contracts/work-context'
import { type ToolName } from '../../../shared/mcp/tool-schemas'
import type {
  AgentJourney,
  AgentJourneyEdge,
  AgentJourneyEvent,
  AgentJourneyEventType,
  AgentJourneyEventStatus,
  AgentJourneyStatus
} from '../../database/repositories/agent-journeys'
// `digestParams` 是**纯函数**（sha256 规范化 JSON），从 Repository 层取用不给
// Handler 任何 `db` 句柄、也不让它碰 SQL——Handler 仍然只调 Service。
// 必须与 `replayFromIdempotency` 用同一个实现，否则重放永远对不上摘要。
import { digestParams } from '../../database/repositories/mcp-idempotency'
import { ApplicationError } from '../errors'
import type { WorkContextService } from '../work-context/work-context-service'
import type { AgentJourneyCallContext } from '../agent-journey/agent-journey-service'
import {
  JOURNEY_DETAIL_KEY,
  type JourneyDetailV1
} from '../../../shared/contracts/entities/agent-journey'
import type { ToolServices } from './tool-services'

/**
 * 33 个工具的实现。**从 `mcp-bridge/request-router.ts` 原样搬移**
 * （Phase 1.1A）：每一行仍是 `services.x.y(...)`，没有业务逻辑改动。
 *
 * 边界：这里只有「参数 → Service 调用 → 结果形状」。认证、scope、Zod、
 * 幂等、审计、协议版本全部在调用方——因此同一个 Handler 既能被 Local
 * Bridge 用，也能被 Remote 入口用，而两边各自守自己的授权。
 *
 * 第三个参数 `context` 是**认证之后**构造的可信调用者上下文（R6-2）。
 * 既有 27 个 Handler 不用它（TypeScript 允许实现少于形参个数），只有
 * Agent Journey 这类需要记录「是谁提交的」才读它——**绝不允许从 `params`
 * 里找身份，也不允许从全局变量里读「当前 client」**。
 */

export type HandlerResult = {
  data: unknown
  entityType?: string
  entityId?: string
}

export type ToolHandler = (
  services: ToolServices,
  params: Record<string, unknown>,
  context: ToolExecutionContext
) => HandlerResult

export const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  search_records: (services, params) => ({
    data: services.records.searchForMcp({
      search: params.search as string | undefined,
      carrier: params.carrier as 'link' | 'image' | 'video' | 'text' | undefined,
      tagId: params.tag_id as string | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  get_record: (services, params) => ({
    data: services.records.getForMcp(params.record_id as string)
  }),

  list_record_tags: (services) => ({
    data: {
      items: services.records.listTags().map((tag) => ({
        id: tag.id,
        name: tag.name,
        created_at: tag.createdAt
      }))
    }
  }),

  create_record: (services, params) => {
    const record = services.records.createForMcp({
      carrier: params.carrier as 'link' | 'text',
      title: params.title as string | undefined,
      note: params.note as string | undefined,
      url: params.url as string | undefined,
      tagIds: params.tag_ids as string[] | undefined
    })
    return {
      data: createShape('create_record', record as unknown as Record<string, unknown>),
      entityType: 'record',
      entityId: record.id
    }
  },

  update_record: (services, params) => {
    const patch = params.patch as { title?: string; note?: string; url?: string; tag_ids?: string[] }
    const record = services.records.updateForMcp({
      recordId: params.record_id as string,
      expectedUpdatedAt: params.expected_updated_at as number,
      patch: {
        title: patch.title,
        note: patch.note,
        url: patch.url,
        tagIds: patch.tag_ids
      }
    })
    return { data: record, entityType: 'record', entityId: record.id }
  },

  create_tag: (services, params) => {
    const tag = services.records.createTagForMcp(params.name as string)
    return {
      data: { tag_id: tag.id, name: tag.name, created_at: tag.createdAt },
      entityType: 'tag',
      entityId: tag.id
    }
  },

  list_beans: (services, params) => ({
    data: services.coffee.listBeansForMcp({
      status: params.status as 'active' | 'finished' | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  get_bean: (services, params) => ({ data: services.coffee.getBeanForMcp(params.bean_id as string) }),

  list_brews: (services, params) => ({
    data: services.coffee.listBrewsForMcp({
      beanId: params.bean_id as string | undefined,
      sinceMs: params.since_ms as number | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  list_tastings: (services, params) => ({
    data: services.coffee.listTastingsForMcp({
      beanId: params.bean_id as string | undefined,
      sinceMs: params.since_ms as number | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  get_coffee_summary: (services) => ({ data: services.coffee.summaryForMcp() }),

  list_canvases: (services) => ({ data: services.canvas.listForMcp() }),

  get_canvas: (services, params) => ({ data: services.canvas.getForMcp(params.canvas_id as string) }),

  create_canvas: (services, params) => {
    const canvas = services.canvas.createForMcp({
      name: params.name as string,
      note: params.note as string | undefined
    })
    return {
      data: createShape('create_canvas', {
        id: canvas.id,
        name: canvas.name,
        created_at: canvas.created_at,
        updated_at: canvas.updated_at
      }),
      entityType: 'canvas',
      entityId: canvas.id
    }
  },

  add_record_to_canvas: (services, params) => {
    const result = services.canvas.addRecordForMcp({
      canvasId: params.canvas_id as string,
      recordId: params.record_id as string,
      annotation: params.annotation as string | undefined
    })
    return {
      data: { node: result.node, created: result.created },
      entityType: 'canvasNode',
      entityId: result.node.id
    }
  },

  create_canvas_note: (services, params) => {
    const note = services.canvas.createNoteForMcp({
      canvasId: params.canvas_id as string,
      title: params.title as string,
      body: params.body as string,
      color: params.color as string | undefined
    })
    return {
      data: createShape('create_canvas_note', note),
      entityType: 'canvasNote',
      entityId: note.id
    }
  },

  update_canvas_note: (services, params) => {
    const note = services.canvas.updateNoteForMcp({
      noteId: params.note_id as string,
      expectedUpdatedAt: params.expected_updated_at as number,
      title: params.title as string | undefined,
      body: params.body as string | undefined,
      color: params.color as string | undefined
    })
    return { data: note, entityType: 'canvasNote', entityId: note.id }
  },

  annotate_canvas_node: (services, params) => {
    const node = services.canvas.annotateNodeForMcp({
      nodeId: params.node_id as string,
      annotation: params.annotation as string
    })
    return { data: node, entityType: 'canvasNode', entityId: node.id }
  },

  // MARK: - Work Context

  list_work_contexts: (services, params) => {
    const items = services.workContexts.list((params.status as WorkContextStatus | undefined) ?? null)
    const limit = (params.limit as number | undefined) ?? 20
    const offset = (params.offset as number | undefined) ?? 0
    return {
      data: {
        items: items
          .slice(offset, offset + limit)
          .map((context) => services.workContexts.summaryForMcp(context)),
        limit,
        offset,
        has_more: offset + limit < items.length
      }
    }
  },

  get_work_context: (services, params) => ({
    data: services.workContexts.getForMcp(params.context_id as string)
  }),

  create_work_context: (services, params) => {
    const context = services.workContexts.create({
      title: params.title as string,
      goal: params.goal as string | undefined,
      summary: params.summary as string | undefined,
      nextStep: params.next_step as string | undefined
    })
    return {
      data: createShape('create_work_context', context as unknown as Record<string, unknown>),
      entityType: 'workContext',
      entityId: context.id
    }
  },

  update_work_context: (services, params) => {
    const patch = (params.patch ?? {}) as Record<string, unknown>
    const context = services.workContexts.update(
      params.context_id as string,
      params.expected_updated_at as number,
      {
        ...(patch.title !== undefined ? { title: patch.title as string } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal as string } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary as string } : {}),
        ...(patch.next_step !== undefined ? { nextStep: patch.next_step as string } : {}),
        ...(patch.status !== undefined ? { status: patch.status as WorkContextStatus } : {})
      }
    )
    return {
      data: services.workContexts.getForMcp(context.id),
      entityType: 'workContext',
      entityId: context.id
    }
  },

  link_work_context_resource: (services, params) => {
    const result = services.workContexts.link({
      contextId: params.context_id as string,
      resourceType: params.resource_type as Parameters<WorkContextService['link']>[0]['resourceType'],
      resourceId: params.resource_id as string | undefined,
      url: params.url as string | undefined,
      role: params.role as Parameters<WorkContextService['link']>[0]['role'],
      note: params.note as string | undefined
    })
    return {
      data: createShape('link_work_context_resource', {
        resource: services.workContexts.resourceForMcp(result.resource.id),
        created: result.created
      }),
      entityType: 'workContextResource',
      entityId: result.resource.id
    }
  },

  // MARK: - Personal Direction
  //
  // 三个 propose 工具写进去的都是草稿。这里没有、也不会有 confirm——
  // Agent 拿不到那条路径，用户确认只发生在应用界面。

  get_direction_overview: (services, params) => ({
    data: services.personalDirection.overviewForMcp(params.include_state_history === true)
  }),

  propose_current_state: (services, params) => {
    const state = services.personalDirection.proposeCurrentState({
      summary: (params.summary as string | undefined) ?? '',
      workStatus: (params.work_status as string | undefined) ?? '',
      capabilities: (params.capabilities as string | undefined) ?? '',
      ongoing: (params.ongoing as string | undefined) ?? '',
      capacity: (params.capacity as string | undefined) ?? '',
      constraints: (params.constraints as string | undefined) ?? '',
      other: (params.other as string | undefined) ?? ''
    })
    return {
      data: {
        state_id: state.id,
        status: state.status,
        note: 'Draft only — the user must confirm it in BrewPhase before it becomes their current state.'
      }
    }
  },

  propose_direction: (services, params) => {
    const direction = services.personalDirection.proposeDirection({
      title: params.title as string,
      description: params.description as string | undefined,
      motivation: params.motivation as string | undefined,
      timeHorizon: params.time_horizon as string | undefined,
      outcomes: params.outcomes as string[] | undefined,
      constraints: params.constraints as string | undefined
    })
    return {
      data: {
        direction_id: direction.id,
        title: direction.title,
        status: direction.status,
        note: 'Proposal only — the user must confirm it in BrewPhase.'
      }
    }
  },

  propose_stage_goal: (services, params) => {
    const stage = services.personalDirection.proposeStage({
      directionId: params.direction_id as string,
      name: params.name as string,
      goal: params.goal as string | undefined,
      expectedOutcome: params.expected_outcome as string | undefined,
      completionCriteria: params.completion_criteria as string | undefined,
      timeHorizon: params.time_horizon as string | undefined,
      obstacles: params.obstacles as string | undefined,
      workContextId: (params.work_context_id as string | undefined) ?? null
    })
    return {
      data: {
        stage_id: stage.id,
        direction_id: stage.directionId,
        status: stage.status,
        note: 'Proposal only — the user must confirm it in BrewPhase.'
      }
    }
  },

  // MARK: - Agent Journey（R6-2，Local MCP only）

  start_agent_journey: (services, params, context) => {
    const call = journeyCallContext(context, 'start_agent_journey', params)
    const result = services.agentJourneys.createJourney(call, {
      title: params.title as string,
      goal: params.goal as string | undefined,
      workContextId: (params.work_context_id as string | undefined) ?? null,
      // R6-4.3.1：snake_case → camelCase 在这一处映射（与 edges 同一惯例）。
      // 未传 = null = 不关联，与旧版本行为逐字节一致。
      workspaceId: (params.workspace_id as string | undefined) ?? null,
      sourceAgent: params.source_agent as string | undefined,
      model: params.model as string | undefined
    })
    return {
      data: startAgentJourneyData(result.journey, result.created),
      entityType: 'agentJourney',
      entityId: result.journey.id
    }
  },

  append_agent_journey_event: (services, params, context) => {
    const call = journeyCallContext(context, 'append_agent_journey_event', params)
    // **在 Handler 边界做 snake_case → camelCase 映射**。
    //
    // MCP 对外契约是 snake_case（`tool-schemas.ts` 不改），Service 的领域输入
    // 是 camelCase（`AppendEventInput` 不改）——两者之间只有这一处需要转换。
    // 之前这里是一句 `params.edges as Array<{toEventId …}>`，断言只骗过编译器：
    // 运行时字段仍是 `to_event_id` / `relationship_type`，Service 读到的是
    // `undefined`，于是一条边都建不出来（并连带把整个 append 回滚掉）。
    // 断言只描述**进来的**形状（Zod 已校验过 uuid + 枚举），字段名靠显式 map。
    const incomingEdges = params.edges as
      | Array<{
          to_event_id: string
          relationship_type: AgentJourneyEdge['relationshipType']
        }>
      | undefined

    const result = services.agentJourneys.appendEvent(call, {
      journeyId: params.journey_id as string,
      eventType: params.event_type as AgentJourneyEventType,
      status: params.status as AgentJourneyEventStatus | undefined,
      title: params.title as string,
      summary: params.summary as string | undefined,
      content: params.content as string | undefined,
      reason: params.reason as string | undefined,
      attemptId: (params.attempt_id as string | undefined) ?? null,
      parentEventId: (params.parent_event_id as string | undefined) ?? null,
      // 未传 `edges` 时保持 undefined（`?.map` 不会造出空数组），
      // 非法目标 / 跨 Journey / 自关联仍由 Service 在事务内校验并整体回滚。
      edges: incomingEdges?.map((edge) => ({
        toEventId: edge.to_event_id,
        relationshipType: edge.relationship_type
      })),
      sourceAgent: params.source_agent as string | undefined,
      model: params.model as string | undefined,
      occurredAt: params.occurred_at as number | undefined,
      // `details` 是 R6-4.2 的结构化执行详情，落库位置固定在
      // `metadata.journey_detail_v1`；`metadata` 的其它键原样保留（旧用法）。
      // 两边都给了 → 明确拒绝，不静默覆盖，避免调用方以为自己写进去的内容丢了。
      metadata: mergeJourneyDetail(
        (params.metadata as Record<string, unknown> | undefined) ?? null,
        // 断言只描述**进来的**形状：`details` 已由 tool schema 的
        // `journeyDetailV1Schema`（.strict()）校验过。
        params.details as JourneyDetailV1 | undefined
      ),
      journeyStatus: params.journey_status as string | undefined
    })
    return {
      data: appendAgentJourneyEventData(result, result.created),
      entityType: 'agentJourneyEvent',
      entityId: result.event.id
    }
  },

  update_agent_journey_event: (services, params, context) => {
    requireLocalContext(context, 'update_agent_journey_event')
    const event = services.agentJourneys.updateEventStatus({
      eventId: params.event_id as string,
      status: params.status as AgentJourneyEventStatus,
      expectedUpdatedAt: params.expected_updated_at as number
    })
    return {
      data: { event: agentJourneyEventDto(event) },
      entityType: 'agentJourneyEvent',
      entityId: event.id
    }
  },

  update_agent_journey_status: (services, params, context) => {
    requireLocalContext(context, 'update_agent_journey_status')
    const journey = services.agentJourneys.updateJourneyStatus({
      journeyId: params.journey_id as string,
      status: params.status as AgentJourneyStatus,
      expectedUpdatedAt: params.expected_updated_at as number
    })
    return {
      data: { journey: agentJourneyDto(journey) },
      entityType: 'agentJourney',
      entityId: journey.id
    }
  },

  list_agent_journeys: (services, params, context) => {
    requireLocalContext(context, 'list_agent_journeys')
    const result = services.agentJourneys.listJourneys({
      status: params.status as AgentJourneyStatus | undefined,
      workContextId: params.work_context_id as string | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
    return {
      data: listAgentJourneysData(result)
    }
  },

  get_agent_journey: (services, params, context) => {
    requireLocalContext(context, 'get_agent_journey')
    const detail = services.agentJourneys.getJourney(params.journey_id as string, {
      eventTypes: params.event_types as AgentJourneyEventType[] | undefined,
      sinceSequence: params.since_sequence as number | undefined,
      limit: params.limit as number | undefined
    })
    return {
      data: getAgentJourneyData(detail)
    }
  }
}

/**
 * create 类工具的响应形状：**首次执行与幂等重放共用这一个构造函数**。
 * 两边形状不一致时，AI 会在「重试」时拿到一个它没见过的结构。
 */
export function createShape(toolName: ToolName, entity: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'create_record':
      return {
        record_id: entity.id,
        title: entity.title,
        carrier: entity.carrier,
        created_at: entity.created_at,
        updated_at: entity.updated_at
      }
    case 'create_canvas':
      return {
        canvas_id: entity.id,
        name: entity.name,
        created_at: entity.created_at,
        updated_at: entity.updated_at
      }
    case 'create_canvas_note':
      return {
        note_id: entity.id,
        title: entity.title,
        canvas_id: entity.canvas_id,
        created_at: entity.created_at,
        updated_at: entity.updated_at
      }
    case 'add_record_to_canvas':
      return { node: entity.node, created: entity.created ?? false }
    case 'create_work_context':
      return {
        context_id: entity.id,
        title: entity.title,
        status: entity.status,
        created_at: entity.created_at,
        updated_at: entity.updated_at
      }
    case 'link_work_context_resource':
      return { resource: entity.resource, created: entity.created ?? false }
    default:
      return entity
  }
}

// MARK: - Agent Journey：可信上下文与 DTO

/**
 * 收窄成 Local 身份。
 *
 * **不用类型断言**：`isLocalToolContext` 是类型守卫，Remote 身份在这里被挡下。
 * 即使哪天 Remote 白名单因为配置错误混进了 Journey 工具，这条也会把它拒掉——
 * Journey 写入永远只走本机 Bridge。
 */
function requireLocalContext(
  context: ToolExecutionContext,
  toolName: string
): Extract<ToolExecutionContext, { channel: 'local' }> {
  if (!isLocalToolContext(context)) {
    throw new ApplicationError(
      'PERMISSION_DENIED',
      `${toolName} is only available through the local MCP bridge`
    )
  }
  return context
}

/**
 * 把可信上下文 + 幂等参数组装成 `AgentJourneyCallContext`。
 *
 * - `clientId` **只**来自 `context.actor.clientId`（认证后的值）；
 * - `requestDigest` 用与路由层**同一个** `digestParams(params)`，而 `params`
 *   正是 `executeTool` 经 Zod 解析后的完整入参（含 `idempotency_key`）——
 *   用残缺字段重算会得到一个与 `replayFromIdempotency` 永远对不上的摘要。
 */
function journeyCallContext(
  context: ToolExecutionContext,
  toolName: 'start_agent_journey' | 'append_agent_journey_event',
  params: Record<string, unknown>
): AgentJourneyCallContext {
  const local = requireLocalContext(context, toolName)
  const key = params.idempotency_key
  if (typeof key !== 'string' || key.length === 0) {
    throw new ApplicationError('VALIDATION_ERROR', 'idempotency_key is required')
  }
  return {
    actor: { kind: 'mcp_client', clientId: local.actor.clientId },
    idempotency: { key, toolName, requestDigest: digestParams(params) }
  }
}

/** `details` → `metadata.journey_detail_v1`；与 metadata 里已有的同名键冲突时报错。 */
function mergeJourneyDetail(
  metadata: Record<string, unknown> | null,
  details: JourneyDetailV1 | undefined
): Record<string, unknown> | null {
  if (!details) return metadata
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, JOURNEY_DETAIL_KEY)) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `pass either "details" or "metadata.${JOURNEY_DETAIL_KEY}", not both`
    )
  }
  return { ...(metadata ?? {}), [JOURNEY_DETAIL_KEY]: details }
}

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** Journey → snake_case DTO。**保留真实数据，不做任何二次摘要化。** */
export function agentJourneyDto(journey: AgentJourney): Record<string, unknown> {
  return {
    id: journey.id,
    title: journey.title,
    goal: journey.goal,
    status: journey.status,
    source_client_id: journey.sourceClientId,
    source_agent: journey.sourceAgent,
    model: journey.model,
    work_context_id: journey.workContextId,
    /** R6-4.3.1：与 IPC 详情的 `workspace_id` 同名同值——两端不许漂移。 */
    workspace_id: journey.workspaceId,
    created_at: journey.createdAt,
    started_at: journey.startedAt,
    updated_at: journey.updatedAt,
    completed_at: journey.completedAt,
    capture_mode: journey.captureMode,
    schema_version: journey.schemaVersion
  }
}

/** Event → snake_case DTO。`metadata` 由库里的 JSON 串还原成对象。 */
export function agentJourneyEventDto(event: AgentJourneyEvent): Record<string, unknown> {
  return {
    id: event.id,
    journey_id: event.journeyId,
    sequence: event.sequence,
    event_type: event.eventType,
    role: event.role,
    status: event.status,
    evidence_level: event.evidenceLevel,
    title: event.title,
    summary: event.summary,
    content: event.content,
    reason: event.reason,
    source_client_id: event.sourceClientId,
    source_agent: event.sourceAgent,
    model: event.model,
    attempt_id: event.attemptId,
    parent_event_id: event.parentEventId,
    occurred_at: event.occurredAt,
    received_at: event.receivedAt,
    updated_at: event.updatedAt,
    metadata: parseJsonOrNull(event.metadata)
  }
}

/** Edge → snake_case DTO。关系不是时间线，顺序永远由 `sequence` 给。 */
export function agentJourneyEdgeDto(edge: AgentJourneyEdge): Record<string, unknown> {
  return {
    id: edge.id,
    journey_id: edge.journeyId,
    from_event_id: edge.fromEventId,
    to_event_id: edge.toEventId,
    relationship_type: edge.relationshipType,
    created_at: edge.createdAt
  }
}

/**
 * **首次执行与幂等重放共用**的响应构造（与 `createShape` 同一理由：
 * 两边形状不一致时，AI 会在「重试」时拿到一个没见过的结构）。
 *
 * `replayed` 恒由这里给 `false`，路由层重放时会覆盖成 `true`——
 * 于是两条路径的**键集完全一致**。
 */
export function startAgentJourneyData(
  journey: AgentJourney,
  created: boolean
): Record<string, unknown> {
  return { journey: agentJourneyDto(journey), created, replayed: false }
}

export type AppendAgentJourneyEventResult = {
  event: AgentJourneyEvent
  edges: AgentJourneyEdge[]
  sequence: number
  journey: AgentJourney
}

export function appendAgentJourneyEventData(
  result: AppendAgentJourneyEventResult,
  created: boolean
): Record<string, unknown> {
  return {
    event: agentJourneyEventDto(result.event),
    edges: result.edges.map(agentJourneyEdgeDto),
    sequence: result.sequence,
    journey: agentJourneyDto(result.journey),
    created,
    replayed: false
  }
}

export function listAgentJourneysData(result: {
  journeys: AgentJourney[]
  total: number
}): Record<string, unknown> {
  return { journeys: result.journeys.map(agentJourneyDto), total: result.total }
}

export function getAgentJourneyData(detail: {
  journey: AgentJourney
  events: AgentJourneyEvent[]
  edges: AgentJourneyEdge[]
}): Record<string, unknown> {
  return {
    journey: agentJourneyDto(detail.journey),
    events: detail.events.map(agentJourneyEventDto),
    edges: detail.edges.map(agentJourneyEdgeDto)
  }
}
