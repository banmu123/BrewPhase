import type { McpServer } from '@modelcontextprotocol/server'
import { TOOL_DEFINITIONS } from '../../shared/mcp/tool-schemas'
import type { BridgeClient } from '../bridge-client'
import { respond } from './respond'

/**
 * Canvas 工具：读取 + 受控写入（创建画布、添加记录节点、便签增改、节点备注）。
 *
 * 摆放位置由 BrewPhase 计算（AI 不提供坐标）；删除类操作不开放。
 */
export function registerCanvasTools(server: McpServer, bridge: BridgeClient): void {
  const read = { readOnlyHint: true } as const
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const

  server.registerTool(
    'list_canvases',
    { description: TOOL_DEFINITIONS.list_canvases.description, inputSchema: TOOL_DEFINITIONS.list_canvases.input, annotations: read },
    async (args) => respond(bridge, 'list_canvases', args)
  )

  server.registerTool(
    'get_canvas',
    { description: TOOL_DEFINITIONS.get_canvas.description, inputSchema: TOOL_DEFINITIONS.get_canvas.input, annotations: read },
    async (args) => respond(bridge, 'get_canvas', args)
  )

  server.registerTool(
    'create_canvas',
    { description: TOOL_DEFINITIONS.create_canvas.description, inputSchema: TOOL_DEFINITIONS.create_canvas.input, annotations: write },
    async (args) => respond(bridge, 'create_canvas', args)
  )

  server.registerTool(
    'add_record_to_canvas',
    { description: TOOL_DEFINITIONS.add_record_to_canvas.description, inputSchema: TOOL_DEFINITIONS.add_record_to_canvas.input, annotations: write },
    async (args) => respond(bridge, 'add_record_to_canvas', args)
  )

  server.registerTool(
    'create_canvas_note',
    { description: TOOL_DEFINITIONS.create_canvas_note.description, inputSchema: TOOL_DEFINITIONS.create_canvas_note.input, annotations: write },
    async (args) => respond(bridge, 'create_canvas_note', args)
  )

  server.registerTool(
    'update_canvas_note',
    { description: TOOL_DEFINITIONS.update_canvas_note.description, inputSchema: TOOL_DEFINITIONS.update_canvas_note.input, annotations: write },
    async (args) => respond(bridge, 'update_canvas_note', args)
  )

  server.registerTool(
    'annotate_canvas_node',
    { description: TOOL_DEFINITIONS.annotate_canvas_node.description, inputSchema: TOOL_DEFINITIONS.annotate_canvas_node.input, annotations: write },
    async (args) => respond(bridge, 'annotate_canvas_node', args)
  )
}
