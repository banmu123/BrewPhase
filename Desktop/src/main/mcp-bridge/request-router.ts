import { eq } from 'drizzle-orm'
import type { McpScope } from '../../shared/contracts/mcp'
import { TOOL_DEFINITIONS, type ToolName } from '../../shared/mcp/tool-schemas'
import type { AuthenticatedClient, McpClientService } from '../application/authorization/permission-service'
import type { CanvasService } from '../application/canvas/canvas-service'
import type { CoffeeService } from '../application/coffee/coffee-service'
import type { ApplicationError } from '../application/errors'
import { ApplicationError as AppError, isApplicationError } from '../application/errors'
import type { RecordService } from '../application/records/record-service'
import type { Db } from '../database/client'
import { recordTags } from '../database/schema'
import { digestParams, lookupIdempotency, recordIdempotency, writeAudit } from './audit-log'
import { BRIDGE_PROTOCOL_VERSION, type BridgeRequest, type BridgeResponse } from './bridge-contract'

/**
 * Bridge 请求路由：认证 → 权限 → 参数校验 → 幂等 → Service → 审计 → 响应。
 *
 * 所有检查都在 Main 完成（MCP 进程的校验只是第一道）。错误统一成
 * `{ code, message }`，不向客户端泄漏 SQL / 堆栈 / 路径。
 */

export type RouterContext = {
  db: Db
  clients: McpClientService
  records: RecordService
  coffee: CoffeeService
  canvas: CanvasService
}

type HandlerResult = {
  data: unknown
  entityType?: string
  entityId?: string
}

type ToolHandler = (ctx: RouterContext, params: Record<string, unknown>) => HandlerResult

/** 每个工具的 Main 侧实现。参数已在 route 里过 Zod，这里直接取强类型字段。 */
const HANDLERS: Record<ToolName, ToolHandler> = {
  search_records: (ctx, params) => ({
    data: ctx.records.searchForMcp({
      search: params.search as string | undefined,
      carrier: params.carrier as 'link' | 'image' | 'video' | 'text' | undefined,
      tagId: params.tag_id as string | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  get_record: (ctx, params) => ({ data: ctx.records.getForMcp(params.record_id as string) }),

  list_record_tags: (ctx) => ({
    data: {
      items: ctx.records.listTags().map((tag) => ({
        id: tag.id,
        name: tag.name,
        created_at: tag.createdAt
      }))
    }
  }),

  create_record: (ctx, params) => {
    const record = ctx.records.createForMcp({
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

  update_record: (ctx, params) => {
    const patch = params.patch as { title?: string; note?: string; url?: string; tag_ids?: string[] }
    const record = ctx.records.updateForMcp({
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

  create_tag: (ctx, params) => {
    const tag = ctx.records.createTagForMcp(params.name as string)
    return {
      data: { tag_id: tag.id, name: tag.name, created_at: tag.createdAt },
      entityType: 'tag',
      entityId: tag.id
    }
  },

  list_beans: (ctx, params) => ({
    data: ctx.coffee.listBeansForMcp({
      status: params.status as 'active' | 'finished' | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  get_bean: (ctx, params) => ({ data: ctx.coffee.getBeanForMcp(params.bean_id as string) }),

  list_brews: (ctx, params) => ({
    data: ctx.coffee.listBrewsForMcp({
      beanId: params.bean_id as string | undefined,
      sinceMs: params.since_ms as number | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  list_tastings: (ctx, params) => ({
    data: ctx.coffee.listTastingsForMcp({
      beanId: params.bean_id as string | undefined,
      sinceMs: params.since_ms as number | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined
    })
  }),

  get_coffee_summary: (ctx) => ({ data: ctx.coffee.summaryForMcp() }),

  list_canvases: (ctx) => ({ data: ctx.canvas.listForMcp() }),

  get_canvas: (ctx, params) => ({ data: ctx.canvas.getForMcp(params.canvas_id as string) }),

  create_canvas: (ctx, params) => {
    const canvas = ctx.canvas.createForMcp({
      name: params.name as string,
      note: params.note as string | undefined
    })
    return {
      data: createShape('create_canvas', { id: canvas.id, name: canvas.name, created_at: canvas.created_at, updated_at: canvas.updated_at }),
      entityType: 'canvas',
      entityId: canvas.id
    }
  },

  add_record_to_canvas: (ctx, params) => {
    const result = ctx.canvas.addRecordForMcp({
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

  create_canvas_note: (ctx, params) => {
    const note = ctx.canvas.createNoteForMcp({
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

  update_canvas_note: (ctx, params) => {
    const note = ctx.canvas.updateNoteForMcp({
      noteId: params.note_id as string,
      expectedUpdatedAt: params.expected_updated_at as number,
      title: params.title as string | undefined,
      body: params.body as string | undefined,
      color: params.color as string | undefined
    })
    return { data: note, entityType: 'canvasNote', entityId: note.id }
  },

  annotate_canvas_node: (ctx, params) => {
    const node = ctx.canvas.annotateNodeForMcp({
      nodeId: params.node_id as string,
      annotation: params.annotation as string
    })
    return { data: node, entityType: 'canvasNode', entityId: node.id }
  }
}

/** 写工具的幂等键字段（create 类才有；update 类靠乐观锁，无幂等键）。 */
const IDEMPOTENT_TOOLS: ReadonlySet<ToolName> = new Set([
  'create_record',
  'create_canvas',
  'add_record_to_canvas',
  'create_canvas_note'
])

export function routeBridgeRequest(ctx: RouterContext, request: BridgeRequest): BridgeResponse {
  const requestId = String(request.requestId ?? '')

  if (request.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return fail(requestId, 'BRIDGE_PROTOCOL_MISMATCH', `bridge protocol ${BRIDGE_PROTOCOL_VERSION} required`)
  }
  if (request.method !== 'tools.call') {
    return fail(requestId, 'VALIDATION_ERROR', `unsupported method: ${String(request.method)}`)
  }
  if (typeof request.tool !== 'string' || !(request.tool in TOOL_DEFINITIONS)) {
    return fail(requestId, 'VALIDATION_ERROR', `unknown tool: ${String(request.tool)}`)
  }
  const toolName = request.tool as ToolName
  const definition = TOOL_DEFINITIONS[toolName]

  let client: AuthenticatedClient
  try {
    client = ctx.clients.authenticate(String(request.token ?? ''))
  } catch (error) {
    return fail(requestId, 'UNAUTHORIZED', messageOf(error))
  }
  if (!client.scopes.includes(definition.scope as McpScope)) {
    // 权限失败也是写尝试：必须进审计（不许「失败就无声无息」）。
    if (definition.write) {
      writeAudit(ctx.db, {
        clientId: client.id,
        toolName,
        success: false,
        errorCode: 'PERMISSION_DENIED'
      })
    }
    return fail(requestId, 'PERMISSION_DENIED', `client is not granted ${definition.scope}`)
  }

  const parsed = definition.input.safeParse(request.params ?? {})
  if (!parsed.success) {
    // 参数校验失败的写调用同样进审计：已认证 + 有 scope，只差参数。
    // 不记录参数原文，不进入 Service。
    if (definition.write) {
      writeAudit(ctx.db, {
        clientId: client.id,
        toolName,
        success: false,
        errorCode: 'VALIDATION_ERROR'
      })
    }
    const first = parsed.error.issues[0]
    return fail(requestId, 'VALIDATION_ERROR', first ? `${first.path.join('.') || 'params'}: ${first.message}` : 'invalid params')
  }
  const params = parsed.data as Record<string, unknown>
  const idempotencyKey = IDEMPOTENT_TOOLS.has(toolName) ? (params.idempotency_key as string) : null

  if (idempotencyKey) {
    const existing = lookupIdempotency(ctx.db, client.id, idempotencyKey)
    if (existing) {
      if (existing.requestDigest !== digestParams(params)) {
        writeAudit(ctx.db, {
          clientId: client.id,
          toolName,
          success: false,
          errorCode: 'IDEMPOTENCY_KEY_REUSE',
          idempotencyKey
        })
        return fail(requestId, 'IDEMPOTENCY_KEY_REUSE', 'this idempotency_key was already used with different params')
      }
      try {
        const data = replayIdempotent(ctx, existing.toolName, existing.entityType, existing.entityId)
        return { requestId, success: true, data: { ...(data as Record<string, unknown>), replayed: true, sync_status: 'desktop_local_only' } }
      } catch (error) {
        return fail(requestId, errorCodeOf(error), messageOf(error))
      }
    }
  }

  try {
    const result = HANDLERS[toolName](ctx, params)
    if (definition.write) {
      if (idempotencyKey) {
        recordIdempotency(ctx.db, {
          clientId: client.id,
          key: idempotencyKey,
          requestDigest: digestParams(params),
          toolName,
          entityType: result.entityType ?? null,
          entityId: result.entityId ?? null
        })
      }
      writeAudit(ctx.db, {
        clientId: client.id,
        toolName,
        entityType: result.entityType ?? null,
        entityId: result.entityId ?? null,
        success: true,
        idempotencyKey
      })
    }
    const data = definition.write
      ? { ...(result.data as Record<string, unknown>), sync_status: 'desktop_local_only' }
      : result.data
    return { requestId, success: true, data }
  } catch (error) {
    const code = errorCodeOf(error)
    if (definition.write) {
      writeAudit(ctx.db, {
        clientId: client.id,
        toolName,
        success: false,
        errorCode: code,
        idempotencyKey
      })
    }
    return fail(requestId, code, messageOf(error))
  }
}

/** 同 key 同摘要：不重复执行，重新读出当前实体并按**同一形状**返回。 */
function replayIdempotent(
  ctx: RouterContext,
  toolName: string,
  entityType: string | null,
  entityId: string | null
): unknown {
  if (!entityId) throw new AppError('INTERNAL_ERROR', 'idempotency record has no entity id')
  switch (entityType) {
    case 'record':
      return createShape('create_record', ctx.records.getForMcp(entityId) as unknown as Record<string, unknown>)
    case 'tag': {
      const row = ctx.db.select().from(recordTags).where(eq(recordTags.id, entityId)).get()
      if (!row) throw new AppError('NOT_FOUND', `tag ${entityId} no longer exists`)
      return { tag_id: row.id, name: row.name, created_at: row.createdAt }
    }
    case 'canvas':
      return createShape('create_canvas', ctx.canvas.getCanvasBase(entityId) as unknown as Record<string, unknown>)
    case 'canvasNode':
      return createShape('add_record_to_canvas', { node: ctx.canvas.getNodeForMcp(entityId), created: false })
    case 'canvasNote':
      return createShape('create_canvas_note', ctx.canvas.getNoteForMcp(entityId) as unknown as Record<string, unknown>)
    default:
      throw new AppError('INTERNAL_ERROR', `cannot replay ${toolName}: unknown entity type ${String(entityType)}`)
  }
}

/**
 * create 类工具的响应形状：**首次执行与幂等重放共用这一个构造函数**。
 * 两边形状不一致时，AI 会在「重试」时拿到一个它没见过的结构。
 */
function createShape(toolName: ToolName, entity: Record<string, unknown>): Record<string, unknown> {
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
    default:
      return entity
  }
}

function fail(requestId: string, code: string, message: string): BridgeResponse {
  return { requestId, success: false, error: { code, message } }
}

function errorCodeOf(error: unknown): string {
  return isApplicationError(error) ? (error as ApplicationError).code : 'INTERNAL_ERROR'
}

/**
 * 错误信息只对**明确的业务错误**（ApplicationError）透传。
 * 其余异常可能携带 SQL、数据库路径、系统绝对路径或堆栈——一律换成通用文案，
 * 原文只进 Main 的日志（`[ipc]`/`[mcp-bridge]` 的 console.error），不回给 AI。
 */
function messageOf(error: unknown): string {
  if (isApplicationError(error)) return (error as Error).message
  return 'An unexpected error occurred while processing the request.'
}
