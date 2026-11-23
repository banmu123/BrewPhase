import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { digestParams } from '../../src/main/database/repositories/mcp-idempotency'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import {
  agentJourneyEvents,
  agentJourneys,
  mcpIdempotency,
  mcpOperationLog
} from '../../src/main/database/schema'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import type { McpScope, ToolExecutionContext } from '../../src/shared/contracts/mcp'
import { REMOTE_TOOLS } from '../../src/shared/contracts/remote'
import { TOOL_NAMES } from '../../src/shared/mcp/tool-schemas'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import { AgentJourneyService } from '../../src/main/application/agent-journey/agent-journey-service'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { executeTool } from '../../src/main/application/mcp-tools/tool-executor'
import { BridgeServer } from '../../src/main/mcp-bridge/bridge-server'
import { bridgePaths } from '../../src/main/mcp-bridge/bridge-contract'
import { BridgeClient } from '../../src/mcp/bridge-client'
import { readFileSync, readdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'

/**
 * Agent Journey 的 **真实 Local Bridge** 集成测试（R6-2 §十一 C–F）。
 *
 * 与 `mcp-work-context.integration.test.ts` 同一套夹具：真实 `BridgeServer` +
 * 真实 Token 认证 + 真实 scope 校验 + 真实幂等/审计 + 真实 SQLite。
 * **不直接调 Service**——这一组要证明的是「Codex / WorkBuddy 走 stdio →
 * Bridge → Main」这条链本身是对的。
 */

let dir = ''
let handle: DatabaseHandle
let server: BridgeServer
let events: ApplicationEvents
let ctx: ConstructorParameters<typeof BridgeServer>[1]

const JOURNEY_READ: McpScope[] = ['agent_journey:read']
const JOURNEY_WRITE_ONLY: McpScope[] = ['agent_journey:write']
const JOURNEY_ALL: McpScope[] = ['agent_journey:read', 'agent_journey:write']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-journey-bridge-'))
  handle = openDatabase(join(dir, 'test.db'))
  events = new ApplicationEvents()
  ctx = {
    db: handle.db,
    clients: new McpClientService(handle.db),
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events),
    agentJourneys: new AgentJourneyService(handle.db, events)
  }
  server = new BridgeServer(bridgePaths(dir), ctx, '0.1.0-test')
  return server.start()
})

afterEach(async () => {
  await server.stop()
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeClient(name: string, scopes: McpScope[]): { id: string; client: BridgeClient } {
  const created = ctx.clients.create({ name, scopes })
  return { id: created.id, client: new BridgeClient(dir, created.token) }
}

function snapshotDatabase(): string {
  return JSON.stringify({
    journeys: handle.db.select().from(agentJourneys).all(),
    events: handle.db.select().from(agentJourneyEvents).all()
  })
}

function idempotencyRows(key: string) {
  return handle.db
    .select()
    .from(mcpIdempotency)
    .where(eq(mcpIdempotency.idempotencyKey, key))
    .all()
}

function auditRows(toolName: string) {
  return handle.db.select().from(mcpOperationLog).all().filter((row) => row.toolName === toolName)
}

// MARK: - C. 调用者身份安全

describe('C. 调用者身份来自认证，不来自请求体', () => {
  it('18: Client A 创建 Journey，source_client_id = A', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const started = (await a.client.call('start_agent_journey', {
      title: '排查设备配对',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string; source_client_id: string; source_agent: string } }

    expect(started.journey.source_client_id).toBe(a.id)
  })

  it('19/20: Client B 追加事件，且无法把身份伪装成 A', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const b = makeClient('WorkBuddy', JOURNEY_ALL)

    const started = (await a.client.call('start_agent_journey', {
      title: '跨客户端',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string } }

    // 手动注入 source_client_id / client_id：schema 里根本没有这两个字段，
    // Zod 按默认策略**剥离**未知键；即使没剥掉，Handler 也只从 context 取身份。
    // 关键断言是「落库身份仍是 B」，不是「调用被拒」。
    const injected = (await b.client.call('append_agent_journey_event', {
      journey_id: started.journey.id,
      event_type: 'decision',
      title: 'B 试图冒充 A',
      source_client_id: a.id,
      client_id: a.id,
      idempotency_key: `evt:${randomUUID()}`
    })) as { event: { source_client_id: string } }
    expect(injected.event.source_client_id, '注入不得覆盖可信身份').toBe(b.id)

    const appended = (await b.client.call('append_agent_journey_event', {
      journey_id: started.journey.id,
      event_type: 'plan',
      title: 'B 的计划',
      idempotency_key: `evt:${randomUUID()}`
    })) as { event: { id: string; source_client_id: string } }

    expect(appended.event.source_client_id).toBe(b.id)
    expect(appended.event.source_client_id).not.toBe(a.id)

    // 两条事件（注入的 + 正常的）都必须记在 B 名下——注入没有让任何一条跑到 A 头上。
    const rows = handle.db.select().from(agentJourneyEvents).all()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.sourceClientId))).toEqual(new Set([b.id]))
  })

  it('22: source_agent / model 只是自报信息，不参与身份判定', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const started = (await a.client.call('start_agent_journey', {
      title: '自报元数据',
      source_agent: 'codex-cli',
      model: 'gpt-5',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { source_client_id: string; source_agent: string; model: string } }

    expect(started.journey.source_agent).toBe('codex-cli')
    expect(started.journey.model).toBe('gpt-5')
    // 身份仍然是认证出来的 clientId，自报字段改不动它。
    expect(started.journey.source_client_id).toBe(a.id)
  })

  it('23: Remote 上下文不能调用 Journey Handler（Local-only 硬限制）', () => {
    const remoteContext: ToolExecutionContext = {
      channel: 'remote',
      actor: {
        kind: 'remote_grant',
        clientId: 'grant-client-0000-4000-8000-000000000009',
        grantCtx: 'grant_ctx_test'
      }
    }
    const outcome = executeTool(
      'start_agent_journey',
      { title: '不该成功', idempotency_key: `start:${randomUUID()}` },
      { services: ctx, scopes: JOURNEY_ALL, context: remoteContext }
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.stage).toBe('handler')
      expect(outcome.code).toBe('PERMISSION_DENIED')
    }
    // 读工具同样只走本机（Remote 白名单里根本没有它们）
    const readOutcome = executeTool('list_agent_journeys', {}, {
      services: ctx,
      scopes: JOURNEY_READ,
      context: remoteContext
    })
    expect(readOutcome.ok).toBe(false)
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(0)
  })

  it('A6/A7: 源码里没有全局「当前 clientId」，且两个 executeTool 调用点都传了 context', () => {
    const mainSrc = joinPath(process.cwd(), 'src', 'main')
    const offenders: string[] = []
    const walk = (dirPath: string): void => {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const full = joinPath(dirPath, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(full, 'utf8')
          // 可变的全局身份：`let currentClientId` / `globalThis.xxx = clientId` 之类
          if (/(?:let|var)\s+currentClientId\b/.test(source)) offenders.push(full)
          if (/globalThis\.[A-Za-z]*[Cc]lient[Ii]d\s*=/.test(source)) offenders.push(full)
        }
      }
    }
    walk(mainSrc)
    expect(offenders, '不允许用全局变量保存当前调用者').toEqual([])

    // 类型上 context 是必填的（ExecuteToolOptions），这里再钉一次两个生产调用点。
    for (const file of ['src/main/mcp-bridge/request-router.ts', 'src/main/remote/request-handler.ts']) {
      const source = readFileSync(joinPath(process.cwd(), file), 'utf8')
      const calls = source.match(/executeTool\(/g) ?? []
      expect(calls, `${file} 应有 executeTool 调用`).toHaveLength(1)
      expect(source, `${file} 必须传 context`).toMatch(/context[,\n]/)
    }
  })
})

// MARK: - D. 幂等

describe('D. 幂等与重放', () => {
  it('24: 同 Client 同 key 同 digest，start 只产生一条 Journey', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const args = { title: '幂等 start', idempotency_key: `start:${randomUUID()}` }

    const first = (await a.client.call('start_agent_journey', args)) as {
      journey: { id: string }
      replayed?: boolean
    }
    const second = (await a.client.call('start_agent_journey', args)) as {
      journey: { id: string }
      replayed?: boolean
    }

    expect(second.journey.id).toBe(first.journey.id)
    expect(second.replayed).toBe(true)
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)

    // 29/30: 幂等记录指向正确实体，且重放与首次的键集一致
    const rows = idempotencyRows(args.idempotency_key)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entityType).toBe('agentJourney')
    expect(rows[0]!.entityId).toBe(first.journey.id)
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort())
  })

  it('25: 同 Client 同 key 同 digest，append 只产生一条 Event', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const started = (await a.client.call('start_agent_journey', {
      title: 'append 幂等',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string } }
    const args = {
      journey_id: started.journey.id,
      event_type: 'observation',
      title: '只该有一条',
      idempotency_key: `evt:${randomUUID()}`
    }

    const first = (await a.client.call('append_agent_journey_event', args)) as {
      event: { id: string; sequence: number }
      replayed?: boolean
    }
    const second = (await a.client.call('append_agent_journey_event', args)) as {
      event: { id: string; sequence: number }
      replayed?: boolean
    }

    expect(second.event.id).toBe(first.event.id)
    expect(second.event.sequence).toBe(first.event.sequence)
    expect(second.replayed).toBe(true)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(1)
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort())

    const rows = idempotencyRows(args.idempotency_key)
    expect(rows[0]!.entityType).toBe('agentJourneyEvent')
    expect(rows[0]!.entityId).toBe(first.event.id)
  })

  it('26: 同 key 不同 digest → IDEMPOTENCY_KEY_REUSE', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const key = `start:${randomUUID()}`
    await a.client.call('start_agent_journey', { title: '第一版', idempotency_key: key })

    await expect(
      a.client.call('start_agent_journey', { title: '被改过的参数', idempotency_key: key })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' })
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)
  })

  it('27: 同 Client 跨工具复用 key，即使参数摘要相同也必须拒绝', async () => {
    // `create_work_context` 与 `start_agent_journey` 都只要 `{title, idempotency_key}`
    // 就合法，于是两次调用经 Zod 解析后的参数**逐字相同 → digest 相同**。
    // 唯一差异是工具名——这正是必须先比 toolName 再比 digest 的原因。
    const cross = makeClient('跨工具', ['work_context:create', 'agent_journey:write'])
    const shared = { title: '跨工具同摘要', idempotency_key: `evt:${randomUUID()}` }

    await cross.client.call('create_work_context', shared)
    const stored = idempotencyRows(shared.idempotency_key)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.toolName).toBe('create_work_context')
    // 摘要确实与「{title, idempotency_key}」的规范化哈希一致 → 两次请求同摘要。
    expect(stored[0]!.requestDigest).toBe(digestParams(shared))

    await expect(cross.client.call('start_agent_journey', shared)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSE'
    })
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(0)

    // 反向：Journey 的 key 也不能被其它工具复用
    const journey = (await cross.client.call('start_agent_journey', {
      title: '反向宿主',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string } }
    const journeyKey = `evt:${randomUUID()}`
    await cross.client.call('append_agent_journey_event', {
      journey_id: journey.journey.id,
      event_type: 'plan',
      title: 'p',
      idempotency_key: journeyKey
    })
    await expect(
      cross.client.call('start_agent_journey', { title: '反向', idempotency_key: journeyKey })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' })
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(1)
  })

  it('28: 不同 Client 用同一个 key 互不干扰', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const b = makeClient('WorkBuddy', JOURNEY_ALL)
    const key = 'evt:shared-key-across-clients'
    const journey = (await a.client.call('start_agent_journey', {
      title: '共享 key 的宿主',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string } }

    const first = (await a.client.call('append_agent_journey_event', {
      journey_id: journey.journey.id,
      event_type: 'plan',
      title: 'A 写的',
      idempotency_key: key
    })) as { event: { id: string; source_client_id: string } }
    const second = (await b.client.call('append_agent_journey_event', {
      journey_id: journey.journey.id,
      event_type: 'plan',
      title: 'B 写的',
      idempotency_key: key
    })) as { event: { id: string; source_client_id: string } }

    expect(first.event.id).not.toBe(second.event.id)
    expect(first.event.source_client_id).toBe(a.id)
    expect(second.event.source_client_id).toBe(b.id)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(2)
  })

  it('31/32: 重放不重复发 app:changed，也不重复写审计', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const emitted: string[] = []
    const off = events.onChanged((domain) => emitted.push(domain))

    const args = { title: '重放不通知', idempotency_key: `start:${randomUUID()}` }
    await a.client.call('start_agent_journey', args)
    expect(emitted).toEqual(['agentJourneys'])
    const auditsAfterFirst = auditRows('start_agent_journey').length
    const emittedAfterFirst = emitted.length

    await a.client.call('start_agent_journey', args)
    expect(emitted, '重放不得再次广播').toHaveLength(emittedAfterFirst)
    expect(auditRows('start_agent_journey'), '重放不得重复记成功审计').toHaveLength(
      auditsAfterFirst
    )
    off()
  })

  it('33: 失败的事务不留下错误幂等记录', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const key = `evt:${randomUUID()}`

    // journey_id 指向不存在的 Journey → Service 在事务内抛 NOT_FOUND → 回滚
    await expect(
      a.client.call('append_agent_journey_event', {
        journey_id: randomUUID(),
        event_type: 'plan',
        title: '会失败',
        idempotency_key: key
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(idempotencyRows(key), '失败不得留下幂等记录').toHaveLength(0)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(0)
    // 失败要留审计（写工具的失败记账是既有约定）
    expect(auditRows('append_agent_journey_event').some((row) => !row.success)).toBe(true)
  })

  it('34: 路由层的事后写入不覆盖 Service 事务内记录的 entityType/entityId', async () => {
    const a = makeClient('Codex', JOURNEY_ALL)
    const key = `start:${randomUUID()}`
    const started = (await a.client.call('start_agent_journey', {
      title: '外层不覆盖',
      idempotency_key: key
    })) as { journey: { id: string } }

    const rows = idempotencyRows(key)
    expect(rows).toHaveLength(1)
    // Service 在事务里写的是 agentJourney + 真实 id；路由层 onConflictDoNothing
    // 之后仍必须是这两个值（否则重放会去读一个不存在的 entityType）。
    expect(rows[0]!.entityType).toBe('agentJourney')
    expect(rows[0]!.entityId).toBe(started.journey.id)
    expect(rows[0]!.toolName).toBe('start_agent_journey')
  })
})

// MARK: - E. 权限

describe('E. Scope 权限', () => {
  it('35: 没有 agent_journey:read 无法查询', async () => {
    const writer = makeClient('只有写', JOURNEY_WRITE_ONLY)
    await expect(writer.client.call('list_agent_journeys', {})).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })
    await expect(
      writer.client.call('get_agent_journey', { journey_id: randomUUID() })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('36: 没有 agent_journey:write 无法写入', async () => {
    const reader = makeClient('只有读', JOURNEY_READ)
    await expect(
      reader.client.call('start_agent_journey', { title: 'x', idempotency_key: `start:${randomUUID()}` })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

    const host = makeClient('宿主', JOURNEY_ALL)
    const journey = (await host.client.call('start_agent_journey', {
      title: '宿主',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string } }
    await expect(
      reader.client.call('append_agent_journey_event', {
        journey_id: journey.journey.id,
        event_type: 'plan',
        title: 'x',
        idempotency_key: `evt:${randomUUID()}`
      })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(0)
  })

  it('37: 只读权限下 list/get 不修改数据库', async () => {
    const host = makeClient('宿主', JOURNEY_ALL)
    const journey = (await host.client.call('start_agent_journey', {
      title: '只读观察',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string } }
    await host.client.call('append_agent_journey_event', {
      journey_id: journey.journey.id,
      event_type: 'plan',
      title: 'p',
      idempotency_key: `evt:${randomUUID()}`
    })

    const reader = makeClient('只读', JOURNEY_READ)
    const before = snapshotDatabase()
    const emitted: string[] = []
    const off = events.onChanged((domain) => emitted.push(domain))

    await reader.client.call('list_agent_journeys', {})
    await reader.client.call('get_agent_journey', { journey_id: journey.journey.id })

    expect(snapshotDatabase(), '纯读不得改库').toBe(before)
    expect(emitted, '纯读不得广播').toHaveLength(0)
    off()
  })

  it('38: 撤销客户端后立即拒绝', async () => {
    const created = ctx.clients.create({ name: '将撤销', scopes: JOURNEY_ALL })
    const client = new BridgeClient(dir, created.token)
    await client.call('start_agent_journey', { title: '撤销前', idempotency_key: `start:${randomUUID()}` })

    ctx.clients.revoke(created.id)
    await expect(
      client.call('start_agent_journey', { title: '撤销后', idempotency_key: `start:${randomUUID()}` })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(client.call('list_agent_journeys', {})).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
    // 撤销前创建的那条仍然在（撤销客户端不删除个人历史）
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)
  })

  it('39: Remote 白名单里没有任何 Journey 工具', () => {
    const journeyTools = TOOL_NAMES.filter((name) => name.includes('agent_journey'))
    expect(journeyTools).toHaveLength(6)
    for (const tool of journeyTools) {
      expect(REMOTE_TOOLS, `${tool} 绝不能进 Remote 面`).not.toContain(tool)
    }
    expect(REMOTE_TOOLS).toHaveLength(8)
  })
})

// MARK: - F. 真实端到端调用

describe('F. 真实 Local MCP 端到端', () => {
  it('两个客户端完成 start → append → 推进 → 查询的完整链路', async () => {
    const codex = makeClient('Codex', JOURNEY_ALL)
    const workbuddy = makeClient('WorkBuddy', JOURNEY_ALL)

    // 1) Codex 创建
    const started = (await codex.client.call('start_agent_journey', {
      title: '帮我分析设备配对问题并修复',
      goal: '定位 R5 阶段的并发领取竞态',
      source_agent: 'codex-cli',
      model: 'gpt-5',
      idempotency_key: `start:${randomUUID()}`
    })) as { journey: { id: string; status: string; source_client_id: string } }
    expect(started.journey.status).toBe('created')
    expect(started.journey.source_client_id).toBe(codex.id)

    // 2) WorkBuddy 追加 plan
    const planned = (await workbuddy.client.call('append_agent_journey_event', {
      journey_id: started.journey.id,
      event_type: 'plan',
      title: '先加单飞锁',
      summary: 'register 的守卫在同步段，需要在 await 之前上锁',
      idempotency_key: `evt:${randomUUID()}`
    })) as {
      event: { id: string; sequence: number; role: string; status: string; source_client_id: string }
      journey: { status: string }
    }
    expect(planned.event.sequence).toBe(1)
    expect(planned.event.status).toBe('completed') // 陈述类创建即 completed
    expect(planned.event.role).toBe('agent')
    expect(planned.event.source_client_id).toBe(workbuddy.id)
    expect(planned.journey.status).toBe('running') // 首个事件把 created 推进到 running

    // 3) 推进 execution：planned → running → completed
    const exec = (await workbuddy.client.call('append_agent_journey_event', {
      journey_id: started.journey.id,
      event_type: 'execution',
      status: 'planned',
      title: '改 remote-service',
      idempotency_key: `evt:${randomUUID()}`
    })) as { event: { id: string; sequence: number; status: string; updated_at: number } }
    expect(exec.event.sequence).toBe(2)
    expect(exec.event.status).toBe('planned') // 执行类默认 planned，不被 completed 覆盖

    const running = (await workbuddy.client.call('update_agent_journey_event', {
      event_id: exec.event.id,
      status: 'running',
      expected_updated_at: exec.event.updated_at
    })) as { event: { status: string; updated_at: number } }
    expect(running.event.status).toBe('running')

    // 4) 推进 verification
    const verify = (await codex.client.call('append_agent_journey_event', {
      journey_id: started.journey.id,
      event_type: 'verification',
      status: 'running',
      title: '跑 vitest',
      idempotency_key: `evt:${randomUUID()}`
    })) as { event: { id: string; sequence: number; status: string; updated_at: number } }
    expect(verify.event.sequence).toBe(3)
    const verified = (await codex.client.call('update_agent_journey_event', {
      event_id: verify.event.id,
      status: 'completed',
      expected_updated_at: verify.event.updated_at
    })) as { event: { status: string } }
    expect(verified.event.status).toBe('completed')

    // 5) 查询：sequence 升序、身份保留
    const detail = (await codex.client.call('get_agent_journey', {
      journey_id: started.journey.id
    })) as {
      journey: { status: string; source_client_id: string }
      events: Array<{ sequence: number; source_client_id: string; event_type: string }>
      edges: unknown[]
    }
    expect(detail.events.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(detail.events[0]!.source_client_id).toBe(workbuddy.id)
    expect(detail.events[1]!.source_client_id).toBe(workbuddy.id)
    expect(detail.events[2]!.source_client_id).toBe(codex.id)
    expect(detail.journey.source_client_id).toBe(codex.id)

    // 6) Outcome 原子完成
    const outcome = (await codex.client.call('append_agent_journey_event', {
      journey_id: started.journey.id,
      event_type: 'outcome',
      title: '竞态已修复',
      journey_status: 'completed',
      idempotency_key: `evt:${randomUUID()}`
    })) as { journey: { status: string; completed_at: number | null }; event: { sequence: number } }
    expect(outcome.journey.status).toBe('completed')
    expect(outcome.journey.completed_at).not.toBeNull()
    expect(outcome.event.sequence).toBe(4)

    // 7) 最终库内容：1个 Journey、4 条事件，无多余数据
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(4)

    // 8) list 过滤
    const listed = (await codex.client.call('list_agent_journeys', { status: 'completed' })) as {
      journeys: Array<{ id: string }>
      total: number
    }
    expect(listed.total).toBe(1)
    expect(listed.journeys[0]!.id).toBe(started.journey.id)

    // 9) 终态不接受新事件，也不可重新打开
    await expect(
      codex.client.call('append_agent_journey_event', {
        journey_id: started.journey.id,
        event_type: 'plan',
        title: '还想加',
        idempotency_key: `evt:${randomUUID()}`
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    const current = (await codex.client.call('get_agent_journey', {
      journey_id: started.journey.id
    })) as { journey: { updated_at: number } }
    await expect(
      codex.client.call('update_agent_journey_status', {
        journey_id: started.journey.id,
        status: 'running',
        expected_updated_at: current.journey.updated_at
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('重复提交与跨工具 key 冲突在真实链路上都被挡住', async () => {
    const codex = makeClient('Codex', JOURNEY_ALL)
    const key = `start:${randomUUID()}`
    const args = { title: '重复提交', idempotency_key: key }

    const first = (await codex.client.call('start_agent_journey', args)) as {
      journey: { id: string }
      replayed?: boolean
    }
    const second = (await codex.client.call('start_agent_journey', args)) as {
      journey: { id: string }
      replayed?: boolean
    }
    expect(second.replayed).toBe(true)
    expect(second.journey.id).toBe(first.journey.id)
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)

    // 跨工具：同一个 key 换个工具调，也不许回放（工具名先于摘要判定）
    await expect(
      codex.client.call('append_agent_journey_event', {
        journey_id: first.journey.id,
        event_type: 'plan',
        ...args
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' })

    // 库里仍然是 1 条 Journey、0 条事件
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(0)
  })
})
