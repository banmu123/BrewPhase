import type { McpServer } from '@modelcontextprotocol/server'
import { TOOL_DEFINITIONS } from '../../shared/mcp/tool-schemas'
import type { BridgeClient } from '../bridge-client'
import { respond } from './respond'

/**
 * Coffee 工具：V1 全部只读。
 *
 * 库存扣减/退还只存在于 Repository 的冲煮写入路径（Renderer 与 iOS 同步）；
 * 这里没有 create_brew / update_bean / 任何写工具，也不允许 AI 触碰剩余量。
 */
export function registerCoffeeTools(server: McpServer, bridge: BridgeClient): void {
  const read = { readOnlyHint: true } as const

  server.registerTool(
    'list_beans',
    { description: TOOL_DEFINITIONS.list_beans.description, inputSchema: TOOL_DEFINITIONS.list_beans.input, annotations: read },
    async (args) => respond(bridge, 'list_beans', args)
  )

  server.registerTool(
    'get_bean',
    { description: TOOL_DEFINITIONS.get_bean.description, inputSchema: TOOL_DEFINITIONS.get_bean.input, annotations: read },
    async (args) => respond(bridge, 'get_bean', args)
  )

  server.registerTool(
    'list_brews',
    { description: TOOL_DEFINITIONS.list_brews.description, inputSchema: TOOL_DEFINITIONS.list_brews.input, annotations: read },
    async (args) => respond(bridge, 'list_brews', args)
  )

  server.registerTool(
    'list_tastings',
    { description: TOOL_DEFINITIONS.list_tastings.description, inputSchema: TOOL_DEFINITIONS.list_tastings.input, annotations: read },
    async (args) => respond(bridge, 'list_tastings', args)
  )

  server.registerTool(
    'get_coffee_summary',
    { description: TOOL_DEFINITIONS.get_coffee_summary.description, inputSchema: TOOL_DEFINITIONS.get_coffee_summary.input, annotations: read },
    async (args) => respond(bridge, 'get_coffee_summary', args)
  )
}
