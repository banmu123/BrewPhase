import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolName } from '../../src/shared/mcp/tool-schemas'
import {
  MCP_SCOPE_GROUPS,
  MCP_SCOPE_GROUP_KEYS,
  MCP_SCOPES,
  MCP_SCOPE_PRESETS
} from '../../src/shared/contracts/mcp'
import {
  AGENT_JOURNEY_EDGE_TYPES,
  AGENT_JOURNEY_EVENT_STATUSES,
  AGENT_JOURNEY_EVENT_TYPES,
  AGENT_JOURNEY_STATUSES
} from '../../src/main/database/repositories/agent-journeys'

/**
 * Agent Journey 的工具契约（R6-2 §十一 B）。
 *
 * 这里锁的是**形状**，不是行为：参数缺不缺、字段有没有被偷偷加回来、
 * Scope 对不对、枚举与领域层是否漂移。行为（身份、幂等、权限）由
 * `mcp-journey-bridge.test.ts` 走真实 Bridge 验证。
 *
 * 为什么值得单独锁：这些 schema 是 AI 看到的唯一说明书。多暴露一个
 * `source_client_id`，模型就会去填它；给 `status` 一个 `completed` 默认值，
 * 执行类事件就会被直接建成终态——两者都不会在类型层报错。
 */

const JOURNEY_TOOLS: ToolName[] = [
  'start_agent_journey',
  'append_agent_journey_event',
  'update_agent_journey_event',
  'update_agent_journey_status',
  'list_agent_journeys',
  'get_agent_journey'
]

function shapeOf(tool: ToolName): Record<string, z.ZodTypeAny> {
  return TOOL_DEFINITIONS[tool].input.shape
}

type ZodNode = {
  options?: readonly string[]
  shape?: Record<string, z.ZodTypeAny>
  _def?: { innerType?: unknown; element?: unknown }
}

/**
 * 剥掉 `optional` / `default` / `array` 包装，取出枚举的取值集合。
 *
 * 直接读 `.options` 只对裸 `z.enum` 成功——`status` 是 `.optional()` 包过的、
 * `event_types` 是数组包过的，都会得到 `undefined`。返回**可变**数组是因为
 * 调用方普遍要 `.sort()`，readonly 数组上没有这个方法。
 */
function enumOptions(schema: unknown): string[] {
  let node = schema as ZodNode | undefined
  for (let depth = 0; depth < 4 && node; depth += 1) {
    if (Array.isArray(node.options)) return [...node.options]
    node = (node._def?.innerType ?? node._def?.element) as ZodNode | undefined
  }
  throw new Error('expected a zod enum with .options')
}

/** 剥掉包装取出最内层 `z.object` 的 shape（数组 / optional 都适用）。 */
function unwrapObject(schema: unknown): Record<string, z.ZodTypeAny> {
  let node = schema as ZodNode | undefined
  for (let depth = 0; depth < 4 && node; depth += 1) {
    if (node.shape) return node.shape
    node = (node._def?.innerType ?? node._def?.element) as ZodNode | undefined
  }
  throw new Error('expected a zod object')
}

describe('工具定义（B 组）', () => {
  it('8/9: 六个工具的名称、scope 与 write 属性正确，总数 27 → 33', () => {
    expect(TOOL_NAMES).toHaveLength(33)
    for (const tool of JOURNEY_TOOLS) {
      expect(TOOL_NAMES, `${tool} 未注册`).toContain(tool)
    }
    expect(TOOL_DEFINITIONS.start_agent_journey).toMatchObject({
      scope: 'agent_journey:write',
      write: true
    })
    expect(TOOL_DEFINITIONS.append_agent_journey_event).toMatchObject({
      scope: 'agent_journey:write',
      write: true
    })
    expect(TOOL_DEFINITIONS.update_agent_journey_event).toMatchObject({
      scope: 'agent_journey:write',
      write: true
    })
    expect(TOOL_DEFINITIONS.update_agent_journey_status).toMatchObject({
      scope: 'agent_journey:write',
      write: true
    })
    expect(TOOL_DEFINITIONS.list_agent_journeys).toMatchObject({
      scope: 'agent_journey:read',
      write: false
    })
    expect(TOOL_DEFINITIONS.get_agent_journey).toMatchObject({
      scope: 'agent_journey:read',
      write: false
    })
  })

  it('10/11: start 与 append 都把 idempotency_key 设为必填', () => {
    for (const tool of ['start_agent_journey', 'append_agent_journey_event'] as const) {
      const key = shapeOf(tool).idempotency_key
      expect(key, `${tool} 缺 idempotency_key`).toBeDefined()
      // 必填 = 没有 optional/default 包裹：缺失时 Zod 必须报错。
      expect(key!.safeParse(undefined).success, `${tool} 的 idempotency_key 不该可缺`).toBe(false)
      expect(key!.safeParse('').success, '空串也必须被拒').toBe(false)
      expect(key!.safeParse('x'.repeat(201)).success, '超长必须被拒').toBe(false)
      expect(key!.safeParse('evt:00000000-0000-4000-8000-000000000000').success).toBe(true)
    }
    // update 类不带幂等键——它们靠乐观锁。
    expect(shapeOf('update_agent_journey_event').idempotency_key).toBeUndefined()
    expect(shapeOf('update_agent_journey_status').idempotency_key).toBeUndefined()
  })

  it('R6-4.3.1: start 的 workspace_id 可选、只收 UUID、路径一律被拒', () => {
    const shape = shapeOf('start_agent_journey')
    expect(shape.workspace_id, 'start_agent_journey 缺 workspace_id').toBeDefined()
    // 可省略：不传 = 不关联，与旧客户端行为逐字节一致。
    expect(shape.workspace_id!.safeParse(undefined).success).toBe(true)
    expect(shape.workspace_id!.safeParse(crypto.randomUUID()).success).toBe(true)
    // 绝对路径 / 目录字符串在 schema 层就死掉——参数拿不到目录访问权。
    for (const path of [
      '/Users/me/project',
      'C:\\Users\\me\\repo',
      './repo',
      'project/',
      '/etc'
    ]) {
      expect(shape.workspace_id!.safeParse(path).success, path).toBe(false)
    }
    // 整包：不带 workspace_id 的旧请求仍然合法。
    expect(
      TOOL_DEFINITIONS.start_agent_journey.input.safeParse({
        title: 'fix bug',
        idempotency_key: 'evt:00000000-0000-4000-8000-000000000000'
      }).success
    ).toBe(true)
    // 带 workspace_id 的新请求也合法（形状，不是存在性——存在性由 Service 校验）。
    expect(
      TOOL_DEFINITIONS.start_agent_journey.input.safeParse({
        title: 'fix bug',
        workspace_id: crypto.randomUUID(),
        idempotency_key: 'evt:00000000-0000-4000-8000-000000000000'
      }).success
    ).toBe(true)
    // 其它 Journey 工具不接受 workspace_id（只有创建时能关联）。
    expect(shapeOf('append_agent_journey_event').workspace_id).toBeUndefined()
    expect(shapeOf('get_agent_journey').workspace_id).toBeUndefined()
  })

  it('12: Event status 可选且没有通用 default', () => {
    const status = shapeOf('append_agent_journey_event').status
    expect(status).toBeDefined()
    const def = (status as unknown as { _def: Record<string, unknown> })._def
    // ZodOptional 只有 type/innerType；ZodDefault 才带 defaultValue。
    expect('defaultValue' in def, 'status 不能带 default——默认由 Service 按 event_type 决定').toBe(
      false
    )
    // 可选：省略时合法（由 Service 决定陈述类 completed / 执行类 planned）。
    expect(status!.safeParse(undefined).success).toBe(true)
    // 但值域仍是那6 种。
    expect([...enumOptions(status)].sort()).toEqual([...AGENT_JOURNEY_EVENT_STATUSES].sort())
  })

  it('13/14/15: role、evidence_level、source_client_id 都不在入参里', () => {
    const shape = shapeOf('append_agent_journey_event')
    for (const forbidden of ['role', 'evidence_level', 'source_client_id', 'client_id', 'capture_mode']) {
      expect(shape[forbidden], `${forbidden} 不该暴露给 MCP`).toBeUndefined()
    }
    const startShape = shapeOf('start_agent_journey')
    for (const forbidden of ['source_client_id', 'client_id', 'capture_mode', 'evidence_level']) {
      expect(startShape[forbidden], `start_agent_journey 不该暴露 ${forbidden}`).toBeUndefined()
    }
  })

  it('16: update status 不含 abandoned / completed / reason', () => {
    const status = shapeOf('update_agent_journey_status').status
    const options = enumOptions(status)
    expect(options).not.toContain('abandoned')
    expect(options).not.toContain('completed')
    expect(options.sort()).toEqual(['cancelled', 'failed', 'paused', 'running'])
    expect(shapeOf('update_agent_journey_status').reason).toBeUndefined()

    // update_agent_journey_event 同样不能改写事实字段
    const eventShape = shapeOf('update_agent_journey_event')
    for (const forbidden of ['title', 'summary', 'content', 'reason', 'evidence_level', 'metadata']) {
      expect(eventShape[forbidden], `${forbidden} 不该出现在状态推进里`).toBeUndefined()
    }
  })

  it('17: get 不包含未实现的 include_layout', () => {
    const shape = shapeOf('get_agent_journey')
    expect(shape.include_layout).toBeUndefined()
    expect(Object.keys(shape).sort()).toEqual([
      'event_types',
      'journey_id',
      'limit',
      'since_sequence'
    ])
    expect(shapeOf('list_agent_journeys').include_layout).toBeUndefined()
  })
})

describe('枚举与领域层不漂移', () => {
  it('append 的 event_type 与领域枚举逐项一致', () => {
    expect(enumOptions(shapeOf('append_agent_journey_event').event_type).sort()).toEqual(
      [...AGENT_JOURNEY_EVENT_TYPES].sort()
    )
    expect(enumOptions(shapeOf('get_agent_journey').event_types as unknown).sort()).toEqual(
      [...AGENT_JOURNEY_EVENT_TYPES].sort()
    )
  })

  it('edges 的 relationship_type 与领域枚举一致', () => {
    const edgesShape = unwrapObject(shapeOf('append_agent_journey_event').edges)
    expect(enumOptions(edgesShape.relationship_type).sort()).toEqual(
      [...AGENT_JOURNEY_EDGE_TYPES].sort()
    )
  })

  it('list 的 status 与 Journey 状态枚举一致（含不可达的 abandoned，仅供过滤）', () => {
    expect(enumOptions(shapeOf('list_agent_journeys').status).sort()).toEqual(
      [...AGENT_JOURNEY_STATUSES].sort()
    )
  })

  it('update 的 journey_status 只接受 completed，且必须配合 outcome', () => {
    const shape = shapeOf('append_agent_journey_event')
    const journeyStatus = shape.journey_status as { safeParse: (v: unknown) => { success: boolean } }
    expect(journeyStatus.safeParse('completed').success).toBe(true)
    expect(journeyStatus.safeParse('failed').success).toBe(false)
    // 只是个字面量，event_type 的组合校验在 Service（避免两处各写一套规则）
  })
})

describe('Scope 与分组（§六）', () => {
  it('MCP_SCOPES 从 14 增至 16，新增的两个都在分组里', () => {
    expect(MCP_SCOPES).toHaveLength(16)
    expect(MCP_SCOPES).toContain('agent_journey:read')
    expect(MCP_SCOPES).toContain('agent_journey:write')

    const group = MCP_SCOPE_GROUPS.find((item) => item.group === 'agentJourney')
    expect(group, '设置页按 MCP_SCOPE_GROUPS 渲染，漏了分组就无法授权').toBeDefined()
    expect([...group!.scopes].sort()).toEqual(['agent_journey:read', 'agent_journey:write'])
    // 分组键闭合联合：新分组必须同时进 MCP_SCOPE_GROUP_KEYS
    expect(MCP_SCOPE_GROUP_KEYS).toContain('agentJourney')

    // 每个 scope 都被某个分组覆盖（否则界面上永远勾不到）
    const covered = new Set(MCP_SCOPE_GROUPS.flatMap((item) => item.scopes))
    for (const scope of MCP_SCOPES) {
      expect(covered.has(scope), `${scope} 没有分组`).toBe(true)
    }
  })

  it('受限预设不因新增工具被悄悄扩大', () => {
    const byKey = new Map(MCP_SCOPE_PRESETS.map((item) => [item.key, item.scopes]))
    // fullAccess 用 [...MCP_SCOPES]，自动包含新权限 ✓
    expect([...byKey.get('fullAccess')!].sort()).toEqual([...MCP_SCOPES].sort())
    // 但三个受限预设一个都不该多出 Journey 权限——不能因为加了工具就
    // 扩大用户已有受限预设的授权承诺。
    for (const key of ['personalGrowthCollab', 'personalGrowth', 'recordsOnly'] as const) {
      const scopes = byKey.get(key)!
      expect(scopes, `${key} 不该自动获得 agent_journey 权限`).not.toContain('agent_journey:write')
      expect(scopes, `${key} 不该自动获得 agent_journey 权限`).not.toContain('agent_journey:read')
    }
  })

  it('六个工具的 description 都有内容，且不含身份字段提示', () => {
    for (const tool of JOURNEY_TOOLS) {
      const definition = TOOL_DEFINITIONS[tool]
      expect(definition.description.trim().length, `${tool} 缺描述`).toBeGreaterThan(20)
      expect(definition.description).not.toContain('source_client_id')
    }
  })
})
