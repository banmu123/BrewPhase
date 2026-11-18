import { eq } from 'drizzle-orm'
import { TOOL_DEFINITIONS, type ToolName } from '../../shared/mcp/tool-schemas'
import type { AuthenticatedClient, McpClientService } from '../application/authorization/permission-service'
import { ApplicationError as AppError } from '../application/errors'
import { createShape, type HandlerResult } from '../application/mcp-tools/handlers'
import { executeTool, messageOf } from '../application/mcp-tools/tool-executor'
import type { ToolServices } from '../application/mcp-tools/tool-services'
import type { Db } from '../database/client'
import { recordTags } from '../database/schema'
import { digestParams, lookupIdempotency, recordIdempotency, writeAudit } from './audit-log'
import { BRIDGE_PROTOCOL_VERSION, type BridgeRequest, type BridgeResponse } from './bridge-contract'

/**
 * Bridge 请求路由：认证 → 权限 → 参数校验 → 幂等 → Service → 审计 → 响应。
 *
 * 所有检查都在 Main 完成（MCP 进程的校验只是第一道）。错误统一成
 * `{ code, message }`，不向客户端泄漏 SQL / 堆栈 / 路径。
 *
 * Phase 1.1A：工具白名单、scope、Zod 与 Handler 调用已抽到
 * `application/mcp-tools/`（`executeTool`）。**本文件仍是 Local 的全部策略所在**：
 * 线协议版本、`tools.call` 方法、MCP Client Token 认证、持久幂等表、审计规则、
 * `sync_status` 标记——这些都不属于共享执行层，也不会被 Remote 复用。
 */

export type RouterContext = ToolServices & {
  db: Db
  clients: McpClientService
}

/** 写工具的幂等键字段（create 类才有；update 类靠乐观锁，无幂等键）。 */
const IDEMPOTENT_TOOLS: ReadonlySet<ToolName> = new Set([
  'create_record',
  'create_canvas',
  'add_record_to_canvas',
  'create_canvas_note',
  'create_work_context',
  'link_work_context_resource'
])

export function routeBridgeRequest(ctx: RouterContext, request: BridgeRequest): BridgeResponse {
  const requestId = String(request.requestId ?? '')

  if (request.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return fail(requestId, 'BRIDGE_PROTOCOL_MISMATCH', `bridge protocol ${BRIDGE_PROTOCOL_VERSION} required`)
  }
  if (request.method !== 'tools.call') {
    return fail(requestId, 'VALIDATION_ERROR', `unsupported method: ${String(request.method)}`)
  }
  // 工具名在认证之前先判一次：未知工具不该因为 token 无效而变成另一种错误
  // （抽取前就是这个顺序，CB-1/CB-4 依赖它）。executeTool 内部还会再判一次，
  // 那是共享层的结构保证，不是重复逻辑。
  if (typeof request.tool !== 'string' || !(request.tool in TOOL_DEFINITIONS)) {
    return fail(requestId, 'VALIDATION_ERROR', `unknown tool: ${String(request.tool)}`)
  }

  let client: AuthenticatedClient
  try {
    client = ctx.clients.authenticate(String(request.token ?? ''))
  } catch (error) {
    return fail(requestId, 'UNAUTHORIZED', messageOf(error))
  }

  const outcome = executeTool(request.tool, request.params ?? {}, {
    services: ctx,
    scopes: client.scopes,
    // Local 的幂等表：必须是「Zod 已通过、Handler 未执行」的那一刻，
    // 且摘要要用解析后的参数——所以由执行层的 replay 钩子接入。
    replay: ({ toolName, params }) => replayFromIdempotency(ctx, client.id, toolName, params)
  })

  if (!outcome.ok) {
    // 写工具的失败要记账（CB-5/CB-7）。`replay` 阶段的记账由幂等逻辑自己决定：
    // 冲突记一行、重放失效不记——与抽取前逐字一致，所以这里跳过。
    if (outcome.definition?.write && outcome.stage !== 'replay' && outcome.toolName) {
      writeAudit(ctx.db, {
        clientId: client.id,
        toolName: outcome.toolName,
        success: false,
        errorCode: outcome.code,
        idempotencyKey: outcome.params ? idempotencyKeyOf(outcome.toolName, outcome.params) : null
      })
    }
    return fail(requestId, outcome.code, outcome.message)
  }

  const { definition, toolName, params } = outcome

  // 幂等重放：不重复执行、不重复记账、不再写幂等表（抽取前就是早返回）。
  if (outcome.replayed) {
    return {
      requestId,
      success: true,
      data: {
        ...(outcome.data as Record<string, unknown>),
        replayed: true,
        sync_status: 'desktop_local_only'
      }
    }
  }

  const idempotencyKey = definition.write ? idempotencyKeyOf(toolName, params) : null
  if (definition.write) {
    if (idempotencyKey) {
      recordIdempotency(ctx.db, {
        clientId: client.id,
        key: idempotencyKey,
        requestDigest: digestParams(params),
        toolName,
        entityType: outcome.entityType ?? null,
        entityId: outcome.entityId ?? null
      })
    }
    writeAudit(ctx.db, {
      clientId: client.id,
      toolName,
      entityType: outcome.entityType ?? null,
      entityId: outcome.entityId ?? null,
      success: true,
      idempotencyKey
    })
  }
  const data = definition.write
    ? { ...(outcome.data as Record<string, unknown>), sync_status: 'desktop_local_only' }
    : outcome.data
  return { requestId, success: true, data }
}

/** 幂等键只在声明了该字段的写工具上存在；其余工具一律 null。 */
function idempotencyKeyOf(toolName: ToolName, params: Record<string, unknown>): string | null {
  if (!IDEMPOTENT_TOOLS.has(toolName)) return null
  const key = params.idempotency_key
  return typeof key === 'string' ? key : null
}

/**
 * 幂等表的短路逻辑（Local 专属）。
 *
 * - 未命中 → `undefined`，继续执行 Handler。
 * - 命中且摘要相同 → 回放当前实体（**按同一形状**），不重复执行。
 * - 命中但摘要不同 → 先记审计再抛 `IDEMPOTENCY_KEY_REUSE`；执行层会把它映射成
 *   同一错误码，且因为阶段是 `replay`，外层不会重复记账。
 */
function replayFromIdempotency(
  ctx: RouterContext,
  clientId: string,
  toolName: ToolName,
  params: Record<string, unknown>
): HandlerResult | undefined {
  const key = idempotencyKeyOf(toolName, params)
  if (!key) return undefined

  const existing = lookupIdempotency(ctx.db, clientId, key)
  if (!existing) return undefined

  if (existing.requestDigest !== digestParams(params)) {
    writeAudit(ctx.db, {
      clientId,
      toolName,
      success: false,
      errorCode: 'IDEMPOTENCY_KEY_REUSE',
      idempotencyKey: key
    })
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSE',
      'this idempotency_key was already used with different params'
    )
  }

  return {
    data: replayIdempotent(ctx, existing.toolName, existing.entityType, existing.entityId)
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
    case 'workContext':
      return createShape(
        'create_work_context',
        ctx.workContexts.get(entityId).context as unknown as Record<string, unknown>
      )
    case 'workContextResource':
      return createShape('link_work_context_resource', {
        resource: ctx.workContexts.resourceForMcp(entityId),
        created: false
      })
    default:
      throw new AppError('INTERNAL_ERROR', `cannot replay ${toolName}: unknown entity type ${String(entityType)}`)
  }
}

function fail(requestId: string, code: string, message: string): BridgeResponse {
  return { requestId, success: false, error: { code, message } }
}
