import {
  REMOTE_TOOLS,
  REMOTE_TOOL_SCOPES,
  type RemoteErrorCode,
  type RemoteScope,
  type RemoteToolName,
  toolsForScopes
} from '../../shared/contracts/remote'
import type { McpErrorCode, McpScope } from '../../shared/contracts/mcp'
import { TOOL_DEFINITIONS, type ToolName } from '../../shared/mcp/tool-schemas'

/**
 * Remote 的权限面：把「Cloud 说给了什么」收敛成「本机实际允许什么」。
 *
 * 三条纪律：
 *
 * 1. **工具面是常量，不是并集**。`REMOTE_TOOLS` 写死 8 个；Cloud 传再多
 *    `allowed_tools` 也只能做**交集**，不能扩张。
 * 2. **scope 逐 grant 算**，绝不合并成连接级——同一设备上两个 MCP Client
 *    各自的授权必须互相隔离。
 * 3. **Local 错误码在这里翻译成 Remote 码**。共享执行层返回的是 Local 码
 *    （`VALIDATION_ERROR` / `PERMISSION_DENIED`），协议只认 19 个 Remote 码，
 *    不许透传。
 */

/**
 * 本地允许集：本机愿意授出的远程 scope 上限。
 *
 * 第一版与 `REMOTE_SCOPES` 相同——留这个常量是为了将来「用户只想给
 * records，不想给 canvas」时有个落点，而不必改协议。
 */
export const LOCAL_ALLOWED_REMOTE_SCOPES: readonly RemoteScope[] = [
  'records:read',
  'tags:read',
  'coffee:read',
  'canvas:read'
]

/** `grant.scopes ∩ REMOTE_SCOPES ∩ 本地允许集`。顺序按 `REMOTE_SCOPES`。 */
export function effectiveScopes(grantScopes: readonly RemoteScope[]): RemoteScope[] {
  const granted = new Set(grantScopes)
  return LOCAL_ALLOWED_REMOTE_SCOPES.filter((scope) => granted.has(scope))
}

/** `REMOTE_TOOLS ∩ allowedTools(Cloud) ∩ toolsForScopes(effective)`。 */
export function effectiveTools(
  scopes: readonly RemoteScope[],
  allowedTools: readonly string[] | null
): RemoteToolName[] {
  const allowed = allowedTools ? new Set(allowedTools) : null
  const byScope = new Set(toolsForScopes(scopes))
  return REMOTE_TOOLS.filter((tool) => byScope.has(tool) && (allowed === null || allowed.has(tool)))
}

/** 工具所需的远程 scope；未知工具返回 null。 */
export function scopeForTool(tool: string): RemoteScope | null {
  if (!(REMOTE_TOOLS as readonly string[]).includes(tool)) return null
  return REMOTE_TOOL_SCOPES[tool as RemoteToolName]
}

/** 该工具是否属于远程面（在 `REMOTE_TOOLS` 常量内）。 */
export function isRemoteTool(tool: string): tool is RemoteToolName {
  return (REMOTE_TOOLS as readonly string[]).includes(tool)
}

/**
 * Local → Remote 错误码映射（架构设计 §6.8.1 唯一权威）。
 *
 * `stage` 来自 `executeTool` 的返回值；同一 Local 码在不同阶段有不同含义
 * （例如 `VALIDATION_ERROR` 在 `tool` 阶段是「不许用这工具」，在 `params`
 * 阶段才是「参数不对」）。
 */
export function toRemoteErrorCode(
  localCode: McpErrorCode,
  stage: 'tool' | 'scope' | 'params' | 'replay' | 'handler'
): RemoteErrorCode {
  if (stage === 'tool') return 'TOOL_NOT_ALLOWED'
  if (stage === 'scope') return 'SCOPE_DENIED'
  if (stage === 'params') return 'INVALID_ARGUMENTS'
  if (stage === 'replay') return 'INTERNAL_ERROR'

  // handler 阶段：只放行白名单，其余折成 INTERNAL_ERROR，不外泄内部语义。
  switch (localCode) {
    case 'NOT_FOUND':
      return 'NOT_FOUND'
    case 'VALIDATION_ERROR':
      // 业务层也可能抛 VALIDATION_ERROR（例如 link 记录缺 url）。
      return 'INVALID_ARGUMENTS'
    case 'STALE_RECORD':
      // 远程 8 个工具全只读，本不该出现；真出现说明内部有 bug，
      // 报「不存在」比报「版本冲突」泄漏更少。
      return 'NOT_FOUND'
    default:
      return 'INTERNAL_ERROR'
  }
}

/** 远程错误码的可重试性（写进 `res.error.retryable`）。 */
export function isRetryableRemoteError(code: RemoteErrorCode): boolean {
  return code === 'DEVICE_OFFLINE' || code === 'DEVICE_BUSY' || code === 'REQUEST_TIMEOUT' || code === 'INTERNAL_ERROR'
}

/**
 * 结构断言：`REMOTE_TOOL_SCOPES` 必须与 `TOOL_DEFINITIONS` 的 scope 一致。
 *
 * 这不是运行时检查，而是给测试用的——一旦有人改了 `tool-schemas.ts` 的 scope
 * 而忘了同步远程映射，测试立刻红。
 */
export function remoteToolScopeMismatches(): Array<{ tool: string; remote: string; local: string }> {
  const out: Array<{ tool: string; remote: string; local: string }> = []
  for (const tool of REMOTE_TOOLS) {
    const local = TOOL_DEFINITIONS[tool as ToolName].scope as McpScope
    const remote = REMOTE_TOOL_SCOPES[tool]
    if (local !== remote) out.push({ tool, remote, local })
  }
  return out
}
