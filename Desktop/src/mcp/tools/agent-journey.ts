import type { McpServer } from '@modelcontextprotocol/server'
import type { BridgeClient } from '../bridge-client'
import { respond } from './respond'
import { TOOL_DEFINITIONS } from '../../shared/mcp/tool-schemas'

/**
 * Agent Journey 工具（R6-2）：创建 / 追加 / 更新 / 查询任务历程。
 *
 * 与其它分组一致：这里**不实现任何业务逻辑**，只把参数转发给 Bridge，
 * 由 Main 做认证、scope 检查、Zod 二次校验、幂等与审计。
 *
 * 因此 `source_client_id` 从来不出现在入参里——身份由 Main 在
 * `authenticate()` 之后构造的 `ToolExecutionContext` 提供，请求体伪造不了。
 *
 * 分组与 scope：
 * - 读：`agent_journey:read`（`list_agent_journeys` / `get_agent_journey`）
 * - 写：`agent_journey:write`（其余四个，均带 `idempotency_key` 或乐观锁）
 *
 * **Local only**：Remote 的 `REMOTE_TOOLS` 是写死的只读白名单，这六个工具
 * 不在其内；即使误配，Handler 侧的 `requireLocalContext` 也会再挡一次。
 */
export function registerAgentJourneyTools(server: McpServer, bridge: BridgeClient): void {
  const read = { readOnlyHint: true } as const
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const

  server.registerTool(
    'start_agent_journey',
    {
      description: TOOL_DEFINITIONS.start_agent_journey.description,
      inputSchema: TOOL_DEFINITIONS.start_agent_journey.input,
      annotations: write
    },
    async (args) => respond(bridge, 'start_agent_journey', args)
  )

  server.registerTool(
    'append_agent_journey_event',
    {
      description: TOOL_DEFINITIONS.append_agent_journey_event.description,
      inputSchema: TOOL_DEFINITIONS.append_agent_journey_event.input,
      annotations: write
    },
    async (args) => respond(bridge, 'append_agent_journey_event', args)
  )

  server.registerTool(
    'update_agent_journey_event',
    {
      description: TOOL_DEFINITIONS.update_agent_journey_event.description,
      inputSchema: TOOL_DEFINITIONS.update_agent_journey_event.input,
      annotations: write
    },
    async (args) => respond(bridge, 'update_agent_journey_event', args)
  )

  server.registerTool(
    'update_agent_journey_status',
    {
      description: TOOL_DEFINITIONS.update_agent_journey_status.description,
      inputSchema: TOOL_DEFINITIONS.update_agent_journey_status.input,
      annotations: write
    },
    async (args) => respond(bridge, 'update_agent_journey_status', args)
  )

  server.registerTool(
    'list_agent_journeys',
    {
      description: TOOL_DEFINITIONS.list_agent_journeys.description,
      inputSchema: TOOL_DEFINITIONS.list_agent_journeys.input,
      annotations: read
    },
    async (args) => respond(bridge, 'list_agent_journeys', args)
  )

  server.registerTool(
    'get_agent_journey',
    {
      description: TOOL_DEFINITIONS.get_agent_journey.description,
      inputSchema: TOOL_DEFINITIONS.get_agent_journey.input,
      annotations: read
    },
    async (args) => respond(bridge, 'get_agent_journey', args)
  )
}
