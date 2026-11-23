import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpScope } from '@shared/contracts/mcp'
import { platformSupportsBridge } from '../../src/main/mcp-bridge/bridge-contract'
import { TOOL_NAMES } from '../../src/shared/mcp/tool-schemas'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import { AgentJourneyService } from '../../src/main/application/agent-journey/agent-journey-service'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import { BridgeServer } from '../../src/main/mcp-bridge/bridge-server'
import { bridgePaths } from '../../src/main/mcp-bridge/bridge-contract'
import { agentJourneyEdges } from '../../src/main/database/schema'
import type { RouterContext } from '../../src/main/mcp-bridge/request-router'

/**
 * MCP 协议测试：**真实 spawn** `out/mcp/stdio.mjs`，用官方 SDK Client 通过
 * STDIO 走 initialize → tools/list → tools/call。
 *
 * 这里验证的是协议层事实：工具发现、schema 广告、结构化结果、错误结果、
 * stdout 不被日志污染。业务真链已在 mcp.test.ts / mcp-bridge 测试里覆盖。
 *
 * 前置：先 `pnpm mcp:build`（CI/本地跑测试前构建一次）。
 */
const ENTRY = join(__dirname, '../../out/mcp/stdio.mjs')
const ALL_SCOPES: McpScope[] = [
  'records:read',
  'records:create',
  'records:update',
  'tags:read',
  'tags:create',
  'coffee:read',
  'canvas:read',
  'canvas:write',
  // Agent Journey（R6-2 / R6-2.1）：原有 8 项一个不少，只追加。
  'agent_journey:read',
  'agent_journey:write'
]

/** 六个 Journey 工具——必须逐个出现在 tools/list 里，不能只比总数。 */
const JOURNEY_TOOLS = [
  'start_agent_journey',
  'append_agent_journey_event',
  'update_agent_journey_event',
  'update_agent_journey_status',
  'list_agent_journeys',
  'get_agent_journey'
] as const

// stdio 进程通过 Local Bridge 访问数据，Bridge 与上面的 socket 测试同一
// 个产品边界：V1 仅 darwin/linux，Windows 上整个跳过。
describe.skipIf(!platformSupportsBridge())('MCP 协议面 — 真实 stdio，仅 darwin/linux', () => {
  let dir: string
  let handle: DatabaseHandle
  let ctx: RouterContext
  let server: BridgeServer
  let token: string
  let client: Client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brewphase-mcp-protocol-'))
    handle = openDatabase(join(dir, 'test.db'))
    const events = new ApplicationEvents()
    ctx = {
      db: handle.db,
      clients: new McpClientService(handle.db),
      records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
      coffee: new CoffeeService(handle.db),
      canvas: new CanvasService(handle.db, handle.deviceId, events),
      workContexts: new WorkContextService(handle.db, events),

      personalDirection: new PersonalDirectionService(handle.db, events),
      agentJourneys: new AgentJourneyService(handle.db, events),
    }
    server = new BridgeServer(bridgePaths(dir), ctx, '0.1.0-test')
    await server.start()

    token = ctx.clients.create({ name: 'Protocol Test', scopes: ALL_SCOPES }).token
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: {
        ...process.env,
        BREWPHASE_MCP_TOKEN: token,
        BREWPHASE_MCP_USER_DATA_DIR: dir
      },
      stderr: 'pipe'
    })
    client = new Client({ name: 'brewphase-test-client', version: '1.0.0' })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client.close().catch(() => undefined)
    await server.stop()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // 每个用例开始前确保 token 仍然有效（个别用例会撤销）
    const existing = ctx.clients.list().find((item) => item.name === 'Protocol Test' && item.revokedAt === null)
    if (!existing) {
      token = ctx.clients.create({ name: 'Protocol Test', scopes: ALL_SCOPES }).token
    }
  })

  describe('MCP 协议面', () => {
    it('initialize 后列出的工具数量与 TOOL_DEFINITIONS 一致，且每个都有描述与 inputSchema', async () => {
      const tools = await client.listTools()
      // 不写死数字：工具集随功能增长，硬编码只会让每次新增都改一次测试。
      expect(tools.tools).toHaveLength(TOOL_NAMES.length)
      for (const tool of tools.tools) {
        expect(tool.description ?? '').not.toBe('')
        expect(tool.inputSchema).toBeTruthy()
      }
      const names = tools.tools.map((tool) => tool.name)
      expect(names).toContain('create_record')
      expect(names).toContain('get_coffee_summary')
      expect(names).toContain('create_canvas_note')
      // 明确不存在的危险工具
      expect(names).not.toContain('execute_sql')
      expect(names).not.toContain('delete_record')
    })

    it('六个 Agent Journey 工具逐个被发现，且有非空 description 与 inputSchema', async () => {
      const tools = await client.listTools()
      const names = tools.tools.map((tool) => tool.name)
      for (const name of JOURNEY_TOOLS) {
        expect(names, `${name} 未出现在 tools/list`).toContain(name)
      }
      for (const tool of tools.tools.filter((item) =>
        (JOURNEY_TOOLS as readonly string[]).includes(item.name)
      )) {
        expect((tool.description ?? '').trim().length, `${tool.name} 描述为空`).toBeGreaterThan(0)
        expect(tool.inputSchema, `${tool.name} 缺 inputSchema`).toBeTruthy()
        const schema = tool.inputSchema as { properties?: Record<string, unknown> }
        expect(
          Object.keys(schema.properties ?? {}).length,
          `${tool.name} 的 inputSchema 没有任何入参`
        ).toBeGreaterThan(0)
      }
    })

    /**
     * R6-2.1 的核心回归：**真实 STDIO 全链**（官方 SDK → stdio.mjs →
     * BridgeClient → BridgeServer → Main → AgentJourneyService → SQLite）。
     *
     * 重点是 C 步——用 MCP 对外的 snake_case 提交 `edges`，断言它真的落库成
     * `from_event_id → to_event_id` 的关系。只断言「调用没报错」是不够的：
     * 映射写错时 Service 会拿不到目标事件，边根本建不出来。
     */
    it('A→F：真实 STDIO 完成 创建 → 计划 → 带边执行 → 状态推进 → 查询', async () => {
      const protocolClient = ctx.clients
        .list()
        .find((item) => item.name === 'Protocol Test' && item.revokedAt === null)
      expect(protocolClient, '夹具必须有一个有效的 Protocol Test 客户端').toBeTruthy()
      const clientId = protocolClient!.id

      // ── A. 创建 Journey ─────────────────────────────────────────────
      const started = await client.callTool({
        name: 'start_agent_journey',
        arguments: {
          title: '定位并修复 Remote MCP 配对竞态',
          goal: '让 register 的并发守卫在 await 之前生效',
          idempotency_key: `start-${Date.now()}-stdio`
        }
      })
      expect(started.isError, JSON.stringify(started.content)).toBeFalsy()
      const created = started.structuredContent as {
        journey: { id: string; status: string; source_client_id: string }
        created: boolean
        sync_status: string
      }
      expect(created.created).toBe(true)
      expect(created.journey.status).toBe('created')
      expect(created.sync_status).toBe('desktop_local_only')
      expect(created.journey.source_client_id, '身份必须来自认证后的 MCP Client').toBe(clientId)
      const journeyId = created.journey.id

      // ── B. Plan（不传 status → 陈述类由 Service 默认 completed）──────
      const planned = await client.callTool({
        name: 'append_agent_journey_event',
        arguments: {
          journey_id: journeyId,
          event_type: 'plan',
          title: '先在 Handler 边界补齐字段映射',
          idempotency_key: `evt-${Date.now()}-plan`
        }
      })
      expect(planned.isError, JSON.stringify(planned.content)).toBeFalsy()
      const planData = planned.structuredContent as {
        event: { id: string; sequence: number; role: string; status: string; source_client_id: string }
        sync_status: string
      }
      expect(planData.event.sequence).toBe(1)
      expect(planData.event.role).toBe('agent')
      expect(planData.event.status, '陈述类默认 completed').toBe('completed')
      expect(planData.event.source_client_id).toBe(clientId)
      expect(planData.sync_status).toBe('desktop_local_only')
      const planEventId = planData.event.id

      // ── C. Execution + **snake_case 的 edges**（本阶段最重要的回归）──
      const executed = await client.callTool({
        name: 'append_agent_journey_event',
        arguments: {
          journey_id: journeyId,
          event_type: 'execution',
          title: '把 to_event_id 显式映射成 toEventId',
          idempotency_key: `evt-${Date.now()}-exec`,
          edges: [{ to_event_id: planEventId, relationship_type: 'depends_on' }]
        }
      })
      expect(executed.isError, JSON.stringify(executed.content)).toBeFalsy()
      const execData = executed.structuredContent as {
        event: { id: string; sequence: number; status: string; updated_at: number }
        edges: Array<{ from_event_id: string; to_event_id: string; relationship_type: string }>
      }
      expect(execData.event.sequence).toBe(2)
      expect(execData.event.status, '执行类默认 planned').toBe('planned')
      expect(execData.edges, '边必须真的写进去').toHaveLength(1)
      expect(execData.edges[0]).toMatchObject({
        from_event_id: execData.event.id,
        to_event_id: planEventId,
        relationship_type: 'depends_on'
      })

      const detailAfterEdge = await client.callTool({
        name: 'get_agent_journey',
        arguments: { journey_id: journeyId }
      })
      const detailData = detailAfterEdge.structuredContent as {
        journey: { status: string; updated_at: number }
        events: Array<{ id: string; sequence: number; event_type: string }>
        edges: Array<{ from_event_id: string; to_event_id: string; relationship_type: string }>
      }
      expect(detailData.events.map((event) => event.sequence)).toEqual([1, 2])
      expect(detailData.edges).toHaveLength(1)
      expect(detailData.edges[0]).toMatchObject({
        from_event_id: execData.event.id,
        to_event_id: planEventId,
        relationship_type: 'depends_on'
      })
      // events 按 sequence 升序；edges 是关系，不是时间线
      const sequences = detailData.events.map((event) => event.sequence)
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
      expect(detailData.journey.status, '首个事件把 created 推进到 running').toBe('running')

      // ── D. 推进 Event 状态 + 乐观锁 ────────────────────────────────
      const running = await client.callTool({
        name: 'update_agent_journey_event',
        arguments: {
          event_id: execData.event.id,
          status: 'running',
          expected_updated_at: execData.event.updated_at
        }
      })
      expect(running.isError, JSON.stringify(running.content)).toBeFalsy()
      const runningData = running.structuredContent as { event: { status: string; updated_at: number } }
      expect(runningData.event.status).toBe('running')
      expect(runningData.event.updated_at).toBeGreaterThan(execData.event.updated_at)

      const stale = await client.callTool({
        name: 'update_agent_journey_event',
        arguments: {
          event_id: execData.event.id,
          status: 'completed',
          expected_updated_at: execData.event.updated_at
        }
      })
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale.content)).toContain('STALE_RECORD')

      // ── E. 推进 Journey 状态（用 C 读到的版本号）────────────────────
      const paused = await client.callTool({
        name: 'update_agent_journey_status',
        arguments: {
          journey_id: journeyId,
          status: 'paused',
          expected_updated_at: detailData.journey.updated_at
        }
      })
      expect(paused.isError, JSON.stringify(paused.content)).toBeFalsy()
      const pausedData = paused.structuredContent as {
        journey: { status: string; updated_at: number }
      }
      expect(pausedData.journey.status).toBe('paused')
      expect(pausedData.journey.updated_at).toBeGreaterThan(detailData.journey.updated_at)

      const resumed = await client.callTool({
        name: 'update_agent_journey_status',
        arguments: {
          journey_id: journeyId,
          status: 'running',
          expected_updated_at: pausedData.journey.updated_at
        }
      })
      expect(resumed.isError, JSON.stringify(resumed.content)).toBeFalsy()
      expect(
        (resumed.structuredContent as { journey: { status: string } }).journey.status
      ).toBe('running')

      // ── F. 查询 ────────────────────────────────────────────────────
      const listed = await client.callTool({
        name: 'list_agent_journeys',
        arguments: { status: 'running' }
      })
      expect(listed.isError, JSON.stringify(listed.content)).toBeFalsy()
      const listData = listed.structuredContent as {
        journeys: Array<{ id: string }>
        total: number
      }
      expect(listData.journeys.map((item) => item.id)).toContain(journeyId)
      expect(listData.total).toBeGreaterThanOrEqual(1)

      const finalDetail = await client.callTool({
        name: 'get_agent_journey',
        arguments: { journey_id: journeyId }
      })
      const finalData = finalDetail.structuredContent as {
        journey: { status: string; source_client_id: string }
        events: Array<{ sequence: number; event_type: string }>
        edges: Array<{ relationship_type: string }>
      }
      expect(finalData.journey.status).toBe('running')
      expect(finalData.journey.source_client_id).toBe(clientId)
      expect(finalData.events.map((event) => event.event_type)).toEqual(['plan', 'execution'])
      expect(finalData.edges).toHaveLength(1)

      // 直接查 SQLite，不只信返回值
      const edgeRows = handle.db
        .select()
        .from(agentJourneyEdges)
        .all()
        .filter((row) => row.journeyId === journeyId)
      expect(edgeRows).toHaveLength(1)
      expect(edgeRows[0]).toMatchObject({
        fromEventId: execData.event.id,
        toEventId: planEventId,
        relationshipType: 'depends_on'
      })
    })

    it('tools/call 走完整链路：create_record → get_record 读回同一实体', async () => {
      const created = await client.callTool({
        name: 'create_record',
        arguments: {
          carrier: 'text',
          title: '协议测试记录',
          note: 'stdio 真链',
          idempotency_key: `proto-${Date.now()}`
        }
      })
      expect(created.isError).toBeFalsy()
      const createdData = created.structuredContent as { record_id: string; sync_status: string }
      expect(createdData.sync_status).toBe('desktop_local_only')

      const fetched = await client.callTool({
        name: 'get_record',
        arguments: { record_id: createdData.record_id }
      })
      const fetchedData = fetched.structuredContent as { title: string; note: string }
      expect(fetchedData.title).toBe('协议测试记录')
      expect(fetchedData.note).toBe('stdio 真链')
    })

    it('schema 校验由 SDK 拦截：越界参数返回 isError（handler 不执行）', async () => {
      const result = await client.callTool({
        name: 'search_records',
        arguments: { limit: 999 }
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(text).toMatch(/validation/i)
    })

    it('业务错误以结构化错误码返回（NOT_FOUND / STALE_RECORD）', async () => {
      const missing = await client.callTool({
        name: 'get_record',
        arguments: { record_id: '00000000-0000-4000-8000-000000000000' }
      })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing.content)).toContain('NOT_FOUND')
    })

    it('撤销后同一进程的下一次调用 → UNAUTHORIZED（Main 每请求查库）', async () => {
      const victim = ctx.clients.create({ name: 'Revoked Agent', scopes: ALL_SCOPES })
      // 用第二个 stdio 进程 + 该 token 建立独立连接
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        env: {
          ...process.env,
          BREWPHASE_MCP_TOKEN: victim.token,
          BREWPHASE_MCP_USER_DATA_DIR: dir
        },
        stderr: 'pipe'
      })
      const other = new Client({ name: 'revoked-test', version: '1.0.0' })
      await other.connect(transport)
      const before = await other.callTool({ name: 'search_records', arguments: {} })
      expect(before.isError).toBeFalsy()

      ctx.clients.revoke(victim.id)
      const after = await other.callTool({ name: 'search_records', arguments: {} })
      expect(after.isError).toBe(true)
      expect(JSON.stringify(after.content)).toContain('UNAUTHORIZED')
      await other.close()
    }, 20_000)
  })
})
