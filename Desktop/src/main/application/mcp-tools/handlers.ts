import type { WorkContextStatus } from '../../../shared/contracts/work-context'
import { type ToolName } from '../../../shared/mcp/tool-schemas'
import type { WorkContextService } from '../work-context/work-context-service'
import type { ToolServices } from './tool-services'

/**
 * 27 个工具的实现。**从 `mcp-bridge/request-router.ts` 原样搬移**
 * （Phase 1.1A）：每一行仍是 `services.x.y(...)`，没有业务逻辑改动。
 *
 * 边界：这里只有「参数 → Service 调用 → 结果形状」。认证、scope、Zod、
 * 幂等、审计、协议版本全部在调用方——因此同一个 Handler 既能被 Local
 * Bridge 用，也能被将来的 Remote 入口用，而两边各自守自己的授权。
 */

export type HandlerResult = {
  data: unknown
  entityType?: string
  entityId?: string
}

export type ToolHandler = (services: ToolServices, params: Record<string, unknown>) => HandlerResult

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
