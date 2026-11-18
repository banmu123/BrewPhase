import type { McpErrorCode, McpScope } from '../../../shared/contracts/mcp'
import { TOOL_DEFINITIONS, type ToolDefinition, type ToolName } from '../../../shared/mcp/tool-schemas'
import { type ApplicationError, isApplicationError } from '../errors'
import { TOOL_HANDLERS, type HandlerResult } from './handlers'
import type { ToolServices } from './tool-services'

/**
 * 共享工具执行入口。
 *
 * 把「一次工具调用」里**与入口无关**的部分收敛到这里，顺序固定、不可重排：
 *
 *   1. 工具名 ∈ TOOL_DEFINITIONS   → 白名单边界（未知工具在这一层就断）
 *   2. definition.scope ∈ scopes   → 授权边界（scope 由调用方核实后传入）
 *   3. definition.input.safeParse  → 参数边界（Zod，唯一一次）
 *   4. replay 钩子（可选）         → 调用方短路点（Local 幂等表；Remote 不传）
 *   5. TOOL_HANDLERS[tool]         → 业务
 *
 * **刻意不在这里做的事**（都属于调用方的授权/记账流程）：
 *
 * - 认证（谁在调用）。Local 是 `bp_mcp_*` Token，Remote 将来是设备 + grant。
 * - 幂等（同一次写是否重试）。它要读 db 且必须插在第 3 步与第 5 步之间，
 *   所以由 `replay` 钩子接入——共享层不认识幂等表，也不认识 `db`。
 * - 审计（记不记、记什么）。执行层只汇报「在哪一步、什么结果」，
 *   由调用方按自己的策略落库。Local 只记写工具，Remote 将只读也记。
 *
 * 第 2 步放在执行层内部是刻意的：这样「绕过 scope」在结构上不可能，
 * 而不是靠「两个入口都记得写一遍」。
 */

/** 失败发生在执行链的哪一步。调用方用它决定记账方式（例如幂等重放失败不重复记账）。 */
export type ExecuteToolStage = 'tool' | 'scope' | 'params' | 'replay' | 'handler'

/**
 * 第 4 步的短路钩子：参数已通过 Zod、Handler 尚未执行。
 *
 * 返回 `HandlerResult` 表示命中并回放（不再执行 Handler）；返回 `undefined`
 * 表示继续。抛出的异常会走与 Handler 相同的错误映射，阶段标为 `replay`。
 *
 * Local 用它接幂等表；Remote 不传（Remote 的去重在准入链，键是 `delivery_id`）。
 */
export type ToolReplayHook = (call: {
  toolName: ToolName
  definition: ToolDefinition
  params: Record<string, unknown>
}) => HandlerResult | undefined

export type ExecuteToolOptions = {
  services: ToolServices
  /**
   * 调用方**已核实**的授权集合。
   * Local：`mcp_clients.scopes`；Remote 将来：该 grant 的 `scopes ∩ 本地允许集`
   * （逐 grant，不是连接级）。
   */
  scopes: readonly McpScope[]
  replay?: ToolReplayHook
}

export type ExecuteToolSuccess = {
  ok: true
  toolName: ToolName
  definition: ToolDefinition
  /** Zod 解析后的参数——调用方后续记账（摘要、幂等键）必须用它，不能再用原始入参。 */
  params: Record<string, unknown>
  data: unknown
  entityType?: string
  entityId?: string
  /** true = 由 `replay` 钩子短路（幂等命中），Handler 没被执行。 */
  replayed: boolean
}

export type ExecuteToolFailure = {
  ok: false
  toolName: ToolName | null
  definition: ToolDefinition | null
  /** 仅在 Zod 通过后非 null；`scope`/`params` 阶段失败时为 null。 */
  params: Record<string, unknown> | null
  stage: ExecuteToolStage
  code: McpErrorCode
  message: string
}

export type ExecuteToolResult = ExecuteToolSuccess | ExecuteToolFailure

export function executeTool(
  tool: string,
  rawParams: unknown,
  options: ExecuteToolOptions
): ExecuteToolResult {
  // 1. 工具白名单
  if (typeof tool !== 'string' || !(tool in TOOL_DEFINITIONS)) {
    return {
      ok: false,
      toolName: null,
      definition: null,
      params: null,
      stage: 'tool',
      code: 'VALIDATION_ERROR',
      message: `unknown tool: ${String(tool)}`
    }
  }
  const toolName = tool as ToolName
  const definition = TOOL_DEFINITIONS[toolName]

  // 2. scope
  if (!options.scopes.includes(definition.scope)) {
    return {
      ok: false,
      toolName,
      definition,
      params: null,
      stage: 'scope',
      code: 'PERMISSION_DENIED',
      message: `client is not granted ${definition.scope}`
    }
  }

  // 3. 参数（唯一一次解析；后面的记账都基于解析结果）
  const parsed = definition.input.safeParse(rawParams ?? {})
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      toolName,
      definition,
      params: null,
      stage: 'params',
      code: 'VALIDATION_ERROR',
      message: first ? `${first.path.join('.') || 'params'}: ${first.message}` : 'invalid params'
    }
  }
  const params = parsed.data as Record<string, unknown>

  // 4. 调用方短路点
  if (options.replay) {
    let replayed: HandlerResult | undefined
    try {
      replayed = options.replay({ toolName, definition, params })
    } catch (error) {
      return {
        ok: false,
        toolName,
        definition,
        params,
        stage: 'replay',
        code: errorCodeOf(error),
        message: messageOf(error)
      }
    }
    if (replayed) {
      return {
        ok: true,
        toolName,
        definition,
        params,
        data: replayed.data,
        entityType: replayed.entityType,
        entityId: replayed.entityId,
        replayed: true
      }
    }
  }

  // 5. 业务
  try {
    const result = TOOL_HANDLERS[toolName](options.services, params)
    return {
      ok: true,
      toolName,
      definition,
      params,
      data: result.data,
      entityType: result.entityType,
      entityId: result.entityId,
      replayed: false
    }
  } catch (error) {
    return {
      ok: false,
      toolName,
      definition,
      params,
      stage: 'handler',
      code: errorCodeOf(error),
      message: messageOf(error)
    }
  }
}

export function errorCodeOf(error: unknown): McpErrorCode {
  return isApplicationError(error) ? (error as ApplicationError).code : 'INTERNAL_ERROR'
}

/**
 * 错误信息只对**明确的业务错误**（ApplicationError）透传。
 * 其余异常可能携带 SQL、数据库路径、系统绝对路径或堆栈——一律换成通用文案，
 * 原文只进 Main 的日志（`[ipc]`/`[mcp-bridge]` 的 console.error），不回给 AI。
 */
export function messageOf(error: unknown): string {
  if (isApplicationError(error)) return (error as Error).message
  return 'An unexpected error occurred while processing the request.'
}
