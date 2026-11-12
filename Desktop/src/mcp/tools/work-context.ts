import type { McpServer } from '@modelcontextprotocol/server'
import type { BridgeClient } from '../bridge-client'
import { respond } from './respond'
import { TOOL_DEFINITIONS } from '../../shared/mcp/tool-schemas'

/**
 * Work Context 工具：持续工作上下文的读取与写入。
 *
 * 与 records/canvas 工具一致：这里不实现任何业务逻辑，只把参数转发给
 * Bridge，由 Main 做校验、scope 检查、审计与幂等。
 */
export function registerWorkContextTools(server: McpServer, bridge: BridgeClient): void {
  const read = { readOnlyHint: true } as const
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const

  server.registerTool(
    'list_work_contexts',
    {
      description: TOOL_DEFINITIONS.list_work_contexts.description,
      inputSchema: TOOL_DEFINITIONS.list_work_contexts.input,
      annotations: read
    },
    async (args) => respond(bridge, 'list_work_contexts', args)
  )

  server.registerTool(
    'get_work_context',
    {
      description: TOOL_DEFINITIONS.get_work_context.description,
      inputSchema: TOOL_DEFINITIONS.get_work_context.input,
      annotations: read
    },
    async (args) => respond(bridge, 'get_work_context', args)
  )

  server.registerTool(
    'create_work_context',
    {
      description: TOOL_DEFINITIONS.create_work_context.description,
      inputSchema: TOOL_DEFINITIONS.create_work_context.input,
      annotations: write
    },
    async (args) => respond(bridge, 'create_work_context', args)
  )

  server.registerTool(
    'update_work_context',
    {
      description: TOOL_DEFINITIONS.update_work_context.description,
      inputSchema: TOOL_DEFINITIONS.update_work_context.input,
      annotations: write
    },
    async (args) => respond(bridge, 'update_work_context', args)
  )

  server.registerTool(
    'link_work_context_resource',
    {
      description: TOOL_DEFINITIONS.link_work_context_resource.description,
      inputSchema: TOOL_DEFINITIONS.link_work_context_resource.input,
      annotations: write
    },
    async (args) => respond(bridge, 'link_work_context_resource', args)
  )
}
