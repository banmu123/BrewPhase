import type { McpServer } from '@modelcontextprotocol/server'
import type { BridgeClient } from '../bridge-client'
import { respond } from './respond'
import { TOOL_DEFINITIONS } from '../../shared/mcp/tool-schemas'

/**
 * Personal Direction 工具：读全部上下文，写「提议」。
 *
 * 与其它工具一致：不实现任何业务逻辑，只把参数转发给 Bridge，由 Main 做
 * 校验、scope 检查、审计与幂等。
 *
 * 注意这里**没有** confirm / approve 之类的工具，也没有对应的 scope——
 * 用户确认只能发生在应用界面。少一个工具，就少一条「AI 自己把草稿转正」的路径。
 */
export function registerPersonalDirectionTools(server: McpServer, bridge: BridgeClient): void {
  const read = { readOnlyHint: true } as const
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const

  server.registerTool(
    'get_direction_overview',
    {
      description: TOOL_DEFINITIONS.get_direction_overview.description,
      inputSchema: TOOL_DEFINITIONS.get_direction_overview.input,
      annotations: read
    },
    async (args) => respond(bridge, 'get_direction_overview', args)
  )

  server.registerTool(
    'propose_current_state',
    {
      description: TOOL_DEFINITIONS.propose_current_state.description,
      inputSchema: TOOL_DEFINITIONS.propose_current_state.input,
      annotations: write
    },
    async (args) => respond(bridge, 'propose_current_state', args)
  )

  server.registerTool(
    'propose_direction',
    {
      description: TOOL_DEFINITIONS.propose_direction.description,
      inputSchema: TOOL_DEFINITIONS.propose_direction.input,
      annotations: write
    },
    async (args) => respond(bridge, 'propose_direction', args)
  )

  server.registerTool(
    'propose_stage_goal',
    {
      description: TOOL_DEFINITIONS.propose_stage_goal.description,
      inputSchema: TOOL_DEFINITIONS.propose_stage_goal.input,
      annotations: write
    },
    async (args) => respond(bridge, 'propose_stage_goal', args)
  )
}
