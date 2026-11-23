import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db, type DatabaseHandle } from '../../src/main/database/client'
import { migrate, migrations } from '../../src/main/database/migrations'
import {
  agentJourneyEdges,
  agentJourneyEvents,
  agentJourneyLayouts,
  agentJourneys,
  mcpClients,
  mcpIdempotency,
  schema,
  workContexts
} from '../../src/main/database/schema'
import { insertWorkContext, selectWorkContext } from '../../src/main/database/repositories/work-contexts'
import {
  digestParams,
  lookupIdempotency
} from '../../src/main/database/repositories/mcp-idempotency'
import {
  selectEvent,
  selectEvents,
  selectJourney,
  type AgentJourneyEventStatus
} from '../../src/main/database/repositories/agent-journeys'
import {
  AgentJourneyError,
  AgentJourneyService,
  type AgentJourneyCallContext
} from '../../src/main/application/agent-journey/agent-journey-service'
import type { AgentJourney } from '../../src/main/database/repositories/agent-journeys'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { McpClientService } from '../../src/main/application/authorization/permission-service'

/**
 * Agent Journey 持久化的真实 SQLite 集成测试（R6-1 §七）。
 *
 * **不 mock Repository**：事务原子性、外键级联、唯一索引、乐观锁都只有在
 * 真库上才测得出来。每个用例用独立临时目录，不碰真实用户数据。
 *
 * 覆盖任务清单 1–24、26、29、30（25/27/28 在 `agent-journey-sanitize.test.ts`）。
 */

const CLIENT_A = 'client-aaaaaaaa-0000-4000-8000-000000000001'
const CLIENT_B = 'client-bbbbbbbb-0000-4000-8000-000000000002'

let dir = ''
let handle: DatabaseHandle
let events: ApplicationEvents
let service: AgentJourneyService
let emitted: string[] = []
let keySeq = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-agent-journey-'))
  handle = openDatabase(join(dir, 'test.db'))
  events = new ApplicationEvents()
  service = new AgentJourneyService(handle.db, events)
  emitted = []
  events.onChanged((domain) => emitted.push(domain))
  keySeq = 0
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

// MARK: - 辅助

function ctx(
  clientId: string,
  toolName: string,
  params: Record<string, unknown>,
  key?: string
): AgentJourneyCallContext {
  return {
    actor: { kind: 'mcp_client', clientId },
    idempotency: {
      key: key ?? `${toolName.startsWith('start') ? 'start' : 'evt'}:${randomUUID()}`,
      toolName,
      requestDigest: digestParams(params)
    }
  }
}

/** 直接返回 Journey 实体；需要 `created/replayed` 的用例自己调 service。 */
function createJourney(
  overrides: Record<string, unknown> = {},
  clientId = CLIENT_A
): AgentJourney {
  const params = { title: 'fix pairing bug', ...overrides }
  const result = service.createJourney(ctx(clientId, 'start_agent_journey', params), {
    title: 'fix pairing bug',
    ...overrides
  } as Parameters<AgentJourneyService['createJourney']>[1])
  return result.journey
}

function append(
  journeyId: string,
  input: Record<string, unknown>,
  clientId = CLIENT_A,
  key?: string
): ReturnType<AgentJourneyService['appendEvent']> {
  const params = { journeyId, ...input }
  return service.appendEvent(ctx(clientId, 'append_agent_journey_event', params, key), {
    journeyId,
    ...input
  } as Parameters<AgentJourneyService['appendEvent']>[1])
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare(`select name from sqlite_master where type='table' and name = ?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

/** 把库开到指定版本（只跑 ≤ version 的迁移），用于验证 13 → 14。 */
function openAtVersion(file: string, version: number): { sqlite: Database.Database; db: Db } {
  const sqlite = new Database(file)
  sqlite.pragma('foreign_keys = ON')
  for (const migration of migrations) {
    if (migration.version > version) break
    sqlite.exec('BEGIN')
    sqlite.exec(migration.sql)
    sqlite.pragma(`user_version = ${migration.version}`)
    sqlite.exec('COMMIT')
  }
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

function expectAgentJourneyError(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error, `expected AgentJourneyError, got ${String(error)}`).toBeInstanceOf(
      AgentJourneyError
    )
    expect((error as AgentJourneyError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code} but nothing was thrown`)
}

function eventCount(journeyId: string): number {
  return selectEvents(handle.db, journeyId).length
}

// MARK: - 数据库：Migration 13 → 14（任务 1–7）

describe('Migration 13 → 14', () => {
  it('1/3: 升级到 14 并创建四张表，旧数据不受影响（任务 2）', () => {
    const file = join(dir, 'migrate.db')
    const { sqlite, db } = openAtVersion(file, 13)
    const now = Date.now()
    const clientId = randomUUID()

    // 迁移前写入的旧实体（migration 13 已建的表）
    const wcBefore = insertWorkContext(db, {
      title: '旧上下文',
      goal: '',
      summary: '',
      nextStep: '',
      now
    })
    db.insert(mcpClients)
      .values({ id: clientId, name: 'old-client', tokenHash: 'x', scopes: '[]', createdAt: now })
      .run()

    expect(Number(sqlite.pragma('user_version', { simple: true }))).toBe(13)
    expect(tableExists(sqlite, 'agent_journeys')).toBe(false)

    migrate(sqlite)

    expect(Number(sqlite.pragma('user_version', { simple: true }))).toBe(14)
    for (const name of [
      'agent_journeys',
      'agent_journey_events',
      'agent_journey_edges',
      'agent_journey_layouts'
    ]) {
      expect(tableExists(sqlite, name), name).toBe(true)
    }

    // 任务 2：旧实体原样保留
    const wcAfter = selectWorkContext(db, wcBefore.id)
    expect(wcAfter?.title).toBe('旧上下文')
    expect(db.select().from(mcpClients).where(eq(mcpClients.id, clientId)).get()).toBeTruthy()

    // 任务 6 的前提：Journey 表对 source_client_id 没有外键
    const row = sqlite
      .prepare(`select sql from sqlite_master where name = 'agent_journeys'`)
      .get() as { sql?: string } | undefined
    const ddl = String(row?.sql ?? '')
    expect(ddl).not.toMatch(/REFERENCES\s+mcp_clients/i)
    sqlite.close()
  })

  it('6: 删除 MCP Client 不会带走 Journey 的 source_client_id', () => {
    const clients = new McpClientService(handle.db)
    const created = clients.create({ name: 'to-delete', scopes: ['records:read'] })
    const journey = createJourney({}, created.id)

    handle.db.delete(mcpClients).where(eq(mcpClients.id, created.id)).run()

    const row = selectJourney(handle.db, journey.id)
    expect(row, '撤销客户端绝不能删除个人历史资产').not.toBeNull()
    expect(row?.sourceClientId).toBe(created.id)
    expect(handle.db.select().from(mcpClients).where(eq(mcpClients.id, created.id)).get()).toBeUndefined()
  })

  it('4/5: Journey 删除级联 events/edges/layouts；删 Work Context 只解除引用', () => {
    const now = Date.now()
    const wcRow = insertWorkContext(handle.db, {
      title: '项目 X',
      goal: '',
      summary: '',
      nextStep: '',
      now
    })
    const journey = createJourney({ workContextId: wcRow.id })
    const first = append(journey.id, { eventType: 'plan', title: '先改状态机' })
    const second = append(journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: '改代码',
      edges: [{ toEventId: first.event.id, relationshipType: 'depends_on' as const }]
    })
    handle.db
      .insert(agentJourneyLayouts)
      .values({
        id: randomUUID(),
        journeyId: journey.id,
        eventId: first.event.id,
        positionX: 10,
        positionY: 20,
        width: 240,
        height: 140,
        zIndex: 0,
        collapsed: false,
        updatedAt: now
      })
      .run()
    expect(eventCount(journey.id)).toBe(2)

    // 5: 删 Work Context → Journey 保留，引用置空
    handle.db.delete(workContexts).where(eq(workContexts.id, wcRow.id)).run()
    const kept = selectJourney(handle.db, journey.id)
    expect(kept, '删项目不能连带删个人历史').not.toBeNull()
    expect(kept?.workContextId).toBeNull()
    expect(eventCount(journey.id)).toBe(2)

    // 4: 删 Journey → 三张关联表全部级联
    handle.db.delete(agentJourneys).where(eq(agentJourneys.id, journey.id)).run()
    expect(selectJourney(handle.db, journey.id)).toBeNull()
    expect(eventCount(journey.id)).toBe(0)
    expect(handle.db.select().from(agentJourneyEdges).all()).toHaveLength(0)
    expect(handle.db.select().from(agentJourneyLayouts).all()).toHaveLength(0)
    expect(second.event.sequence).toBe(2)
  })

  it('4b: 删父事件 → 子事件 parent 置空；删被引用事件 → Edge 级联', () => {
    const journey = createJourney()
    const plan = append(journey.id, { eventType: 'plan', title: '计划' })
    const revision = append(journey.id, {
      eventType: 'revision',
      title: '改成方案 B',
      parentEventId: plan.event.id
    })
    const execution = append(journey.id, { eventType: 'execution', status: 'planned', title: '执行' })
    append(journey.id, {
      eventType: 'observation',
      title: '观察',
      edges: [{ toEventId: execution.event.id, relationshipType: 'revises' as const }]
    })

    // parent → SET NULL
    handle.db
      .delete(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, plan.event.id))
      .run()
    expect(selectEvent(handle.db, revision.event.id)?.parentEventId).toBeNull()
    expect(selectEvent(handle.db, revision.event.id)?.title).toBe('改成方案 B')

    // edge 两端 → CASCADE
    expect(handle.db.select().from(agentJourneyEdges).all()).toHaveLength(1)
    handle.db
      .delete(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, execution.event.id))
      .run()
    expect(handle.db.select().from(agentJourneyEdges).all()).toHaveLength(0)
  })

  it('7: 四个唯一索引都生效（重号 sequence / 重复幂等键 / 重复边 / 重复布局）', () => {
    const journey = createJourney()
    const a = append(journey.id, { eventType: 'plan', title: 'A' })
    const b = append(journey.id, { eventType: 'observation', title: 'B' })

    const baseEvent = {
      journeyId: journey.id,
      eventType: 'plan',
      role: 'agent',
      status: 'completed',
      evidenceLevel: 'agent_reported',
      title: 'dup',
      summary: '',
      content: '',
      reason: '',
      sourceClientId: CLIENT_A,
      sourceAgent: '',
      model: '',
      attemptId: null,
      parentEventId: null,
      occurredAt: Date.now(),
      receivedAt: Date.now(),
      updatedAt: Date.now(),
      metadata: null
    }

    // (journey_id, sequence)
    expect(() =>
      handle.db
        .insert(agentJourneyEvents)
        .values({ ...baseEvent, id: randomUUID(), sequence: a.event.sequence, idempotencyKey: 'k1' })
        .run()
    ).toThrow()

    // (journey_id, source_client_id, idempotency_key)
    expect(() =>
      handle.db
        .insert(agentJourneyEvents)
        .values({ ...baseEvent, id: randomUUID(), sequence: 99, idempotencyKey: a.event.idempotencyKey })
        .run()
    ).toThrow()

    // edge 防重复：先建一条，再插同键的第二条必须失败
    const edgeValues = {
      id: randomUUID(),
      journeyId: journey.id,
      fromEventId: b.event.id,
      toEventId: a.event.id,
      relationshipType: 'depends_on' as const,
      createdAt: Date.now()
    }
    handle.db.insert(agentJourneyEdges).values(edgeValues).run()
    expect(() =>
      handle.db.insert(agentJourneyEdges).values({ ...edgeValues, id: randomUUID() }).run()
    ).toThrow()
    append(journey.id, {
      eventType: 'observation',
      title: 'ref',
      edges: [{ toEventId: b.event.id, relationshipType: 'depends_on' as const }]
    })
    const ref = selectEvents(handle.db, journey.id).find((e) => e.title === 'ref')!
    expect(() =>
      handle.db
        .insert(agentJourneyEdges)
        .values({
          id: randomUUID(),
          journeyId: journey.id,
          fromEventId: ref.id,
          toEventId: b.event.id,
          relationshipType: 'depends_on',
          createdAt: Date.now()
        })
        .run()
    ).toThrow()

    // layout (journey_id, event_id)
    const layoutValues = {
      journeyId: journey.id,
      eventId: a.event.id,
      positionX: 0,
      positionY: 0,
      width: 240,
      height: 140,
      zIndex: 0,
      collapsed: false,
      updatedAt: Date.now()
    }
    handle.db.insert(agentJourneyLayouts).values({ id: randomUUID(), ...layoutValues }).run()
    expect(() =>
      handle.db.insert(agentJourneyLayouts).values({ id: randomUUID(), ...layoutValues }).run()
    ).toThrow()
  })
})

// MARK: - Event：顺序、幂等、事务（任务 8–14）

describe('Event 顺序与幂等', () => {
  it('8/9: sequence 从 1 递增，且数据库兜底拒绝重号', () => {
    const journey = createJourney()
    expect(append(journey.id, { eventType: 'plan', title: 'p' }).sequence).toBe(1)
    expect(append(journey.id, { eventType: 'observation', title: 'o' }).sequence).toBe(2)
    expect(append(journey.id, { eventType: 'outcome', title: 'done' }).sequence).toBe(3)
    expect(eventCount(journey.id)).toBe(3)

    // 「并发」在单写者 SQLite 上退化为「两条都算过 MAX」——UNIQUE 是最后防线。
    expect(() =>
      handle.db
        .insert(agentJourneyEvents)
        .values({
          id: randomUUID(),
          journeyId: journey.id,
          sequence: 3,
          eventType: 'plan',
          role: 'agent',
          status: 'completed',
          evidenceLevel: 'agent_reported',
          title: 'dup',
          summary: '',
          content: '',
          reason: '',
          sourceClientId: CLIENT_A,
          sourceAgent: '',
          model: '',
          attemptId: null,
          parentEventId: null,
          idempotencyKey: 'evt:dup',
          occurredAt: Date.now(),
          receivedAt: Date.now(),
          updatedAt: Date.now(),
          metadata: null
        })
        .run()
    ).toThrow()
    expect(eventCount(journey.id)).toBe(3)
  })

  it('10: 相同 idempotency key + 相同参数 → 回放，不产生重复事件', () => {
    const journey = createJourney()
    const params = { journeyId: journey.id, eventType: 'plan', title: '先改状态机' }
    const key = `evt:${randomUUID()}`

    const first = append(journey.id, { eventType: 'plan', title: '先改状态机' }, CLIENT_A, key)
    const second = append(journey.id, { eventType: 'plan', title: '先改状态机' }, CLIENT_A, key)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.event.id).toBe(first.event.id)
    expect(eventCount(journey.id)).toBe(1)
    // 摘要与路由层同源（digestParams of the parsed params）
    expect(lookupIdempotency(handle.db, CLIENT_A, key)?.requestDigest).toBe(digestParams(params))
  })

  it('11: 相同 key、不同参数 → IDEMPOTENCY_KEY_REUSE，且不写入新事件', () => {
    const journey = createJourney()
    const key = `evt:${randomUUID()}`
    append(journey.id, { eventType: 'plan', title: '原计划' }, CLIENT_A, key)
    const before = eventCount(journey.id)

    expectAgentJourneyError(
      () => append(journey.id, { eventType: 'plan', title: '被改过的参数' }, CLIENT_A, key),
      'IDEMPOTENCY_KEY_REUSE'
    )
    expect(eventCount(journey.id)).toBe(before)
  })

  it('10b: 不同客户端用同一个 key 互不影响', () => {
    const journey = createJourney()
    const key = 'evt:shared-key'
    const a = append(journey.id, { eventType: 'plan', title: 'A 的计划' }, CLIENT_A, key)
    const b = append(journey.id, { eventType: 'plan', title: 'B 的计划' }, CLIENT_B, key)
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(a.event.id).not.toBe(b.event.id)
    expect(eventCount(journey.id)).toBe(2)
    expect(b.event.sourceClientId).toBe(CLIENT_B)
  })

  it('12: 事务中途失败 → Event、Edge、幂等记录全部回滚', () => {
    const journey = createJourney()
    const plan = append(journey.id, { eventType: 'plan', title: '基线' })
    const before = eventCount(journey.id)
    const eventsBefore = handle.db.select().from(agentJourneyEvents).all().length
    const idemRowsBefore = handle.db.select().from(mcpIdempotency).all().length
    expect(lookupIdempotency(handle.db, CLIENT_A, 'evt:rollback')).toBeNull()

    // 边在事件插入**之后**校验：此时事件已写入，非法边必须把它一起回滚。
    expectAgentJourneyError(
      () =>
        append(
          journey.id,
          {
            eventType: 'execution',
            status: 'planned',
            title: '会回滚的执行',
            edges: [{ toEventId: randomUUID(), relationshipType: 'retries' as const }]
          },
          CLIENT_A,
          'evt:rollback'
        ),
      'NOT_FOUND'
    )

    expect(eventCount(journey.id)).toBe(before)
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(eventsBefore)
    expect(handle.db.select().from(agentJourneyEdges).all()).toHaveLength(0)
    expect(handle.db.select().from(mcpIdempotency).all()).toHaveLength(idemRowsBefore)
    expect(lookupIdempotency(handle.db, CLIENT_A, 'evt:rollback')).toBeNull()
    expect(plan.event.sequence).toBe(1)
  })

  it('13: 跨 Journey 的 Edge 被拒绝（且不留下半截事件）', () => {
    const one = createJourney({ title: 'Journey One' })
    const two = createJourney({ title: 'Journey Two' })
    const foreign = append(two.id, { eventType: 'plan', title: '别人的计划' })
    const before = eventCount(one.id)

    expectAgentJourneyError(
      () =>
        append(one.id, {
          eventType: 'observation',
          title: '越权引用',
          edges: [{ toEventId: foreign.event.id, relationshipType: 'depends_on' as const }]
        }),
      'VALIDATION_ERROR'
    )
    expect(eventCount(one.id)).toBe(before)
    expect(handle.db.select().from(agentJourneyEdges).all()).toHaveLength(0)
  })

  it('14: 跨 Journey 的 parent_event_id 被拒绝', () => {
    const one = createJourney({ title: 'J1' })
    const two = createJourney({ title: 'J2' })
    const foreign = append(two.id, { eventType: 'plan', title: '别人' })
    const before = eventCount(one.id)

    expectAgentJourneyError(
      () =>
        append(one.id, {
          eventType: 'revision',
          title: '引用别人的计划',
          parentEventId: foreign.event.id
        }),
      'VALIDATION_ERROR'
    )
    expect(eventCount(one.id)).toBe(before)
  })
})

// MARK: - Event：状态与不可变（任务 15–18）

describe('Event 状态机与不可变性', () => {
  it('17: 执行类事件 planned → running → completed，且 planned 不能直跳 completed', () => {
    const journey = createJourney()
    const created = append(journey.id, { eventType: 'verification', status: 'planned', title: '跑测试' })
    expect(created.event.status).toBe('planned')

    // planned → completed 不在允许的推进表里（必须经过 running）。
    // 必须在事件**仍是 planned** 时尝试，否则测的是 running → completed。
    expectAgentJourneyError(
      () =>
        service.updateEventStatus({
          eventId: created.event.id,
          status: 'completed',
          expectedUpdatedAt: created.event.updatedAt
        }),
      'VALIDATION_ERROR'
    )

    const running = service.updateEventStatus({
      eventId: created.event.id,
      status: 'running',
      expectedUpdatedAt: created.event.updatedAt
    })
    expect(running.status).toBe('running')

    // 乐观锁：用**确定过期**的 updatedAt 推进 → STALE_RECORD。
    // （在 running 状态下尝试，推进规则合法，失败只能来自锁；用 -1 保证
    //   不会因为同毫秒写入而意外命中。）
    expectAgentJourneyError(
      () =>
        service.updateEventStatus({
          eventId: created.event.id,
          status: 'completed',
          expectedUpdatedAt: created.event.updatedAt - 1
        }),
      'STALE_RECORD'
    )

    const done = service.updateEventStatus({
      eventId: created.event.id,
      status: 'completed',
      expectedUpdatedAt: running.updatedAt
    })
    expect(done.status).toBe('completed')

    // 终态优先于乐观锁判定：completed 之后任何改动都是 VALIDATION_ERROR
    expectAgentJourneyError(
      () =>
        service.updateEventStatus({
          eventId: created.event.id,
          status: 'failed',
          expectedUpdatedAt: done.updatedAt
        }),
      'VALIDATION_ERROR'
    )
    expect(selectEvent(handle.db, created.event.id)?.status).toBe('completed')
  })

  it('15: 终态事件不允许再修改', () => {
    const journey = createJourney()
    const plan = append(journey.id, { eventType: 'plan', title: '计划' })
    for (const status of ['completed', 'failed', 'skipped', 'cancelled'] as AgentJourneyEventStatus[]) {
      expectAgentJourneyError(
        () => service.updateEventStatus({ eventId: plan.event.id, status, expectedUpdatedAt: plan.event.updatedAt }),
        'VALIDATION_ERROR'
      )
    }

    const exec = append(journey.id, { eventType: 'execution', status: 'running', title: '跑' })
    const failed = service.updateEventStatus({
      eventId: exec.event.id,
      status: 'failed',
      expectedUpdatedAt: exec.event.updatedAt
    })
    expect(failed.status).toBe('failed')
    expectAgentJourneyError(
      () =>
        service.updateEventStatus({
          eventId: exec.event.id,
          status: 'completed',
          expectedUpdatedAt: failed.updatedAt
        }),
      'VALIDATION_ERROR'
    )
  })

  it('16: 事实字段不可通过更新接口改写', () => {
    const journey = createJourney()
    const exec = append(journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: '原始标题',
      summary: '原始摘要',
      content: '原始正文'
    })

    // 调用方硬塞正文字段（TS 已挡住，这里验证运行时也改不动）
    const hacked = service.updateEventStatus({
      eventId: exec.event.id,
      status: 'running',
      expectedUpdatedAt: exec.event.updatedAt,
      title: '被改的标题',
      content: '被改的正文',
      summary: '被改的摘要',
      evidenceLevel: 'tool_result',
      sourceClientId: CLIENT_B
    } as Parameters<AgentJourneyService['updateEventStatus']>[0])

    expect(hacked.status).toBe('running')
    expect(hacked.title).toBe('原始标题')
    expect(hacked.content).toBe('原始正文')
    expect(hacked.summary).toBe('原始摘要')
    expect(hacked.evidenceLevel).toBe('agent_reported')
    expect(hacked.sourceClientId).toBe(CLIENT_A)
  })

  it('18: 陈述类事件创建即 completed，且不能使用不符合类型的状态', () => {
    const journey = createJourney()
    // 陈述类默认 completed
    expect(append(journey.id, { eventType: 'decision', title: '选 A' }).event.status).toBe('completed')

    for (const status of ['planned', 'running', 'failed'] as AgentJourneyEventStatus[]) {
      expectAgentJourneyError(
        () => append(journey.id, { eventType: 'plan', title: '计划', status }),
        'VALIDATION_ERROR'
      )
      expectAgentJourneyError(
        () => append(journey.id, { eventType: 'observation', title: '观察', status }),
        'VALIDATION_ERROR'
      )
    }

    // 执行类不能一上来就 completed（「宣布做完」≠「做完了」）
    expectAgentJourneyError(
      () => append(journey.id, { eventType: 'execution', status: 'completed', title: '直接完成' }),
      'VALIDATION_ERROR'
    )
    // 用户注释必须是 user 角色
    expectAgentJourneyError(
      () => append(journey.id, { eventType: 'user_annotation', role: 'agent', title: '我的补充' }),
      'VALIDATION_ERROR'
    )
    // v1 只接受 agent_reported
    expectAgentJourneyError(
      () =>
        append(journey.id, {
          eventType: 'observation',
          title: '工具结果',
          evidenceLevel: 'tool_result'
        }),
      'VALIDATION_ERROR'
    )
    expect(append(journey.id, { eventType: 'user_annotation', title: '我的补充' }).event.role).toBe(
      'user'
    )
  })
})

// MARK: - Journey 生命周期（任务 19–24）

describe('Journey 生命周期', () => {
  it('19: created → running ⇄ paused → failed → running → cancelled', () => {
    const journey = createJourney()
    expect(journey.status).toBe('created')
    expect(journey.startedAt).toBeNull()

    const running = service.updateJourneyStatus({
      journeyId: journey.id,
      status: 'running',
      expectedUpdatedAt: journey.updatedAt
    })
    expect(running.status).toBe('running')
    expect(running.startedAt).not.toBeNull()

    const paused = service.updateJourneyStatus({
      journeyId: running.id,
      status: 'paused',
      expectedUpdatedAt: running.updatedAt
    })
    expect(paused.status).toBe('paused')

    const resumed = service.updateJourneyStatus({
      journeyId: paused.id,
      status: 'running',
      expectedUpdatedAt: paused.updatedAt
    })
    expect(resumed.status).toBe('running')

    const failed = service.updateJourneyStatus({
      journeyId: resumed.id,
      status: 'failed',
      expectedUpdatedAt: resumed.updatedAt
    })
    expect(failed.status).toBe('failed')

    const back = service.updateJourneyStatus({
      journeyId: failed.id,
      status: 'running',
      expectedUpdatedAt: failed.updatedAt
    })
    expect(back.status).toBe('running')

    const cancelled = service.updateJourneyStatus({
      journeyId: back.id,
      status: 'cancelled',
      expectedUpdatedAt: back.updatedAt
    })
    expect(cancelled.status).toBe('cancelled')

    // 乐观锁
    expectAgentJourneyError(
      () =>
        service.updateJourneyStatus({
          journeyId: cancelled.id,
          status: 'running',
          expectedUpdatedAt: back.updatedAt
        }),
      'VALIDATION_ERROR'
    )
  })

  it('19b: 不允许的转移被拒绝（paused → failed、failed → paused、→ abandoned）', () => {
    const journey = createJourney()
    const running = service.updateJourneyStatus({
      journeyId: journey.id,
      status: 'running',
      expectedUpdatedAt: journey.updatedAt
    })
    const paused = service.updateJourneyStatus({
      journeyId: running.id,
      status: 'paused',
      expectedUpdatedAt: running.updatedAt
    })
    expectAgentJourneyError(
      () =>
        service.updateJourneyStatus({
          journeyId: paused.id,
          status: 'failed',
          expectedUpdatedAt: paused.updatedAt
        }),
      'VALIDATION_ERROR'
    )
    // abandoned 是 R6-1 不可达状态（无超时维护机制）
    expectAgentJourneyError(
      () =>
        service.updateJourneyStatus({
          journeyId: paused.id,
          status: 'abandoned',
          expectedUpdatedAt: paused.updatedAt
        }),
      'VALIDATION_ERROR'
    )
  })

  it('20: Outcome 插入与 Journey completed 在同一事务', () => {
    const journey = createJourney()
    append(journey.id, { eventType: 'plan', title: '计划' })
    const done = append(journey.id, {
      eventType: 'outcome',
      title: '修好了',
      journeyStatus: 'completed'
    })

    expect(done.event.eventType).toBe('outcome')
    expect(done.event.status).toBe('completed')
    expect(done.journey.status).toBe('completed')
    expect(done.journey.completedAt).not.toBeNull()
    // 同一次调用里读到的就是完成态（同一事务的返回值）
    expect(selectJourney(handle.db, journey.id)?.status).toBe('completed')
    expect(handle.db.select().from(agentJourneys).all()).toHaveLength(1)
  })

  it('20b: journey_status 只能配合 outcome，且不能给终态 Journey 用', () => {
    const journey = createJourney()
    expectAgentJourneyError(
      () => append(journey.id, { eventType: 'plan', title: 'p', journeyStatus: 'completed' }),
      'VALIDATION_ERROR'
    )
    expectAgentJourneyError(
      () =>
        append(journey.id, { eventType: 'outcome', title: 'o', journeyStatus: 'failed' as string }),
      'VALIDATION_ERROR'
    )
    // 完成之后再补一个 outcome 也必须拒绝
    append(journey.id, { eventType: 'outcome', title: 'done', journeyStatus: 'completed' })
    expectAgentJourneyError(
      () => append(journey.id, { eventType: 'outcome', title: 'again' }),
      'VALIDATION_ERROR'
    )
  })

  it('21/23: completed / cancelled 不可逆，且不接受新事件', () => {
    const done = createJourney({ title: '已完成' })
    append(done.id, { eventType: 'outcome', title: '完事', journeyStatus: 'completed' })
    expectAgentJourneyError(
      () =>
        service.updateJourneyStatus({
          journeyId: done.id,
          status: 'running',
          expectedUpdatedAt: done.updatedAt
        }),
      'VALIDATION_ERROR'
    )
    expectAgentJourneyError(
      () => append(done.id, { eventType: 'plan', title: '还想加' }),
      'VALIDATION_ERROR'
    )

    const cancelled = createJourney({ title: '已取消' })
    const running = service.updateJourneyStatus({
      journeyId: cancelled.id,
      status: 'running',
      expectedUpdatedAt: cancelled.updatedAt
    })
    service.updateJourneyStatus({
      journeyId: running.id,
      status: 'cancelled',
      expectedUpdatedAt: running.updatedAt
    })
    expectAgentJourneyError(
      () =>
        service.updateJourneyStatus({
          journeyId: running.id,
          status: 'running',
          expectedUpdatedAt: running.updatedAt
        }),
      'VALIDATION_ERROR'
    )
    expectAgentJourneyError(
      () => append(running.id, { eventType: 'plan', title: '还想加' }),
      'VALIDATION_ERROR'
    )
  })

  it('22: 取消不会删除失败记录，只把未收尾的执行事件标成 cancelled', () => {
    const journey = createJourney()
    const plan = append(journey.id, { eventType: 'plan', title: '原计划' })

    const failedExec = append(journey.id, { eventType: 'execution', status: 'running', title: '跑挂了' })
    service.updateEventStatus({
      eventId: failedExec.event.id,
      status: 'failed',
      expectedUpdatedAt: failedExec.event.updatedAt
    })
    const openExec = append(journey.id, { eventType: 'execution', status: 'planned', title: '还没跑' })
    const openVerif = append(journey.id, { eventType: 'verification', status: 'running', title: '验证中' })
    const observation = append(journey.id, { eventType: 'observation', title: '观察' })

    // 首个事件已把 created 自动推进到 running（同一事务）。
    const current = selectJourney(handle.db, journey.id)!
    expect(current.status).toBe('running')
    const cancelled = service.updateJourneyStatus({
      journeyId: current.id,
      status: 'cancelled',
      expectedUpdatedAt: current.updatedAt
    })
    expect(cancelled.status).toBe('cancelled')

    const events = selectEvents(handle.db, journey.id)
    // 历史一条不少
    expect(events).toHaveLength(5)
    expect(events.find((e) => e.id === plan.event.id)?.status).toBe('completed')
    // 失败记录必须原样保留
    expect(events.find((e) => e.id === failedExec.event.id)?.status).toBe('failed')
    // 未收尾的执行类被收敛为 cancelled，而不是被删除
    expect(events.find((e) => e.id === openExec.event.id)?.status).toBe('cancelled')
    expect(events.find((e) => e.id === openVerif.event.id)?.status).toBe('cancelled')
    // 陈述类不受影响
    expect(events.find((e) => e.id === observation.event.id)?.status).toBe('completed')
  })

  it('24: list / get 是纯读——不改库、不发事件', () => {
    const journey = createJourney()
    append(journey.id, { eventType: 'plan', title: '计划' })
    append(journey.id, { eventType: 'execution', status: 'planned', title: '执行' })

    const snapshot = () =>
      JSON.stringify({
        journeys: handle.db.select().from(agentJourneys).all(),
        events: handle.db.select().from(agentJourneyEvents).all(),
        edges: handle.db.select().from(agentJourneyEdges).all()
      })
    const before = snapshot()
    const emittedBefore = emitted.length

    const list = service.listJourneys()
    const detail = service.getJourney(journey.id, { eventTypes: ['plan'] })

    expect(list.journeys).toHaveLength(1)
    expect(list.total).toBe(1)
    expect(detail.events).toHaveLength(1)
    expect(detail.events[0]!.eventType).toBe('plan')
    expect(detail.edges).toHaveLength(0)

    expect(snapshot(), '查询不得修改数据库').toBe(before)
    expect(emitted, '查询不得发领域事件').toHaveLength(emittedBefore)
    // 也不推进状态
    expect(selectJourney(handle.db, journey.id)?.status).toBe('running')
    expect(selectJourney(handle.db, journey.id)?.updatedAt).toBe(
      JSON.parse(before).journeys[0].updatedAt
    )
  })
})

// MARK: - 隐私：落库即脱敏（任务 26）

describe('隐私：数据库里只有脱敏后的内容', () => {
  it('26: 常见凭证原值在数据库中完全不存在', () => {
    const journey = createJourney({
      title: '排查 token 泄漏',
      goal: 'password=Sup3rS3cretValue'
    })
    append(journey.id, {
      eventType: 'observation',
      title: '发现 POSTGRES_PASSWORD 明文',
      summary: 'BREWPHASE_MCP_TOKEN=bp_mcp_SuperSecretValue0001',
      content: [
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
        'cookie: sid=abcdef123456',
        'run as /Users/banmu/Brew/phase.db',
        'aws AKIAIOSFODNN7EXAMPLE'
      ].join('\n'),
      reason: 'api_key = sk_live_should_not_survive',
      metadata: { env: { POSTGRES_PASSWORD: 'raw-db-secret' } }
    })

    const dump = JSON.stringify({
      journeys: handle.db.select().from(agentJourneys).all(),
      events: handle.db.select().from(agentJourneyEvents).all()
    })

    for (const secret of [
      'Sup3rS3cretValue',
      'bp_mcp_SuperSecretValue0001',
      'eyJhbGciOiJIUzI1NiJ9',
      'abcdef123456',
      '/Users/banmu',
      'AKIAIOSFODNN7EXAMPLE',
      'sk_live_should_not_survive',
      'raw-db-secret'
    ]) {
      expect(dump, `库里残留了 ${secret}`).not.toContain(secret)
    }
    // 仍然可读
    expect(dump).toContain('排查 token 泄漏')
    expect(dump).toContain('/Users/<user>')
    expect(dump).toContain('[redacted]')
  })

  it('26b: 超长正文按上限落库（不靠导出时才截断）', () => {
    const journey = createJourney()
    const event = append(journey.id, {
      eventType: 'observation',
      title: '长输出',
      content: 'y'.repeat(30_000)
    })
    expect(event.event.content.length).toBeLessThanOrEqual(20_000)
    expect(event.event.content.endsWith('…[truncated]')).toBe(true)
    const raw = selectEvent(handle.db, event.event.id)
    expect(raw?.content.length).toBe(event.event.content.length)
  })
})

// MARK: - 事件广播（任务 29、30）

describe('领域事件广播', () => {
  it('29: 成功提交之后才发出 agentJourneys', () => {
    expect(emitted).toHaveLength(0)

    const journey = createJourney()
    expect(emitted).toEqual(['agentJourneys'])

    emitted = []
    append(journey.id, { eventType: 'plan', title: '计划' })
    expect(emitted).toEqual(['agentJourneys'])

    // append 已把 Journey 从 created 推进到 running；用 paused ⇄ running
    // 验证「状态更新同样在提交后广播」。
    emitted = []
    const paused = service.updateJourneyStatus({
      journeyId: journey.id,
      status: 'paused',
      expectedUpdatedAt: selectJourney(handle.db, journey.id)!.updatedAt
    })
    expect(paused.status).toBe('paused')
    expect(emitted).toEqual(['agentJourneys'])

    emitted = []
    const running = service.updateJourneyStatus({
      journeyId: paused.id,
      status: 'running',
      expectedUpdatedAt: paused.updatedAt
    })
    expect(running.status).toBe('running')
    expect(emitted).toEqual(['agentJourneys'])

    emitted = []
    const exec = append(journey.id, { eventType: 'execution', status: 'planned', title: 'x' })
    expect(emitted).toEqual(['agentJourneys'])

    emitted = []
    service.updateEventStatus({
      eventId: exec.event.id,
      status: 'running',
      expectedUpdatedAt: exec.event.updatedAt
    })
    expect(emitted).toEqual(['agentJourneys'])

    // 幂等回放不是「成功创建」，不重复广播
    emitted = []
    const key = `start:${randomUUID()}`
    const params = { title: 'replay me' }
    service.createJourney(ctx(CLIENT_A, 'start_agent_journey', params, key), { title: 'replay me' })
    service.createJourney(ctx(CLIENT_A, 'start_agent_journey', params, key), { title: 'replay me' })
    expect(emitted).toEqual(['agentJourneys'])
  })

  it('30: 事务回滚时不发送任何通知', () => {
    const journey = createJourney()
    emitted = []

    expectAgentJourneyError(
      () =>
        append(journey.id, {
          eventType: 'execution',
          status: 'planned',
          title: '会回滚',
          edges: [{ toEventId: randomUUID(), relationshipType: 'retries' as const }]
        }),
      'NOT_FOUND'
    )
    expect(emitted, '回滚不得广播').toHaveLength(0)

    expectAgentJourneyError(
      () =>
        service.updateEventStatus({
          eventId: randomUUID(),
          status: 'running',
          expectedUpdatedAt: Date.now()
        }),
      'NOT_FOUND'
    )
    expect(emitted).toHaveLength(0)
  })
})
