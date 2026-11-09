import type { McpServer } from '@modelcontextprotocol/server'
import { TOOL_DEFINITIONS } from '../../shared/mcp/tool-schemas'
import type { BridgeClient } from '../bridge-client'
import { respond } from './respond'

/**
 * Records 工具：搜索 / 读取 / 创建 / 更新 / 标签。
 *
 * 参数 schema 直接取 `TOOL_DEFINITIONS`（与 Main 校验共用同一份事实）；
 * 这里不实现任何业务逻辑，只转发给 Bridge。
 */
export function registerRecordTools(server: McpServer, bridge: BridgeClient): void {
  const read = { readOnlyHint: true } as const
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const

  server.registerTool(
    'search_records',
    { description: TOOL_DEFINITIONS.search_records.description, inputSchema: TOOL_DEFINITIONS.search_records.input, annotations: read },
    async (args) => respond(bridge, 'search_records', args)
  )

  server.registerTool(
    'get_record',
    { description: TOOL_DEFINITIONS.get_record.description, inputSchema: TOOL_DEFINITIONS.get_record.input, annotations: read },
    async (args) => respond(bridge, 'get_record', args)
  )

  server.registerTool(
    'list_record_tags',
    { description: TOOL_DEFINITIONS.list_record_tags.description, inputSchema: TOOL_DEFINITIONS.list_record_tags.input, annotations: read },
    async (args) => respond(bridge, 'list_record_tags', args)
  )

  server.registerTool(
    'create_record',
    { description: TOOL_DEFINITIONS.create_record.description, inputSchema: TOOL_DEFINITIONS.create_record.input, annotations: write },
    async (args) => respond(bridge, 'create_record', args)
  )

  server.registerTool(
    'update_record',
    { description: TOOL_DEFINITIONS.update_record.description, inputSchema: TOOL_DEFINITIONS.update_record.input, annotations: write },
    async (args) => respond(bridge, 'update_record', args)
  )

  server.registerTool(
    'create_tag',
    { description: TOOL_DEFINITIONS.create_tag.description, inputSchema: TOOL_DEFINITIONS.create_tag.input, annotations: write },
    async (args) => respond(bridge, 'create_tag', args)
  )
}
