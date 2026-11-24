import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db, type DatabaseHandle } from '../../src/main/database/client'
import { migrate, migrations } from '../../src/main/database/migrations'
import { schema } from '../../src/main/database/schema'
import {
  insertJourney,
  selectJourney,
  selectJourneys,
  type AgentJourneyEventStatus,
  type AgentJourneyEventType
} from '../../src/main/database/repositories/agent-journeys'
import { digestParams } from '../../src/main/database/repositories/mcp-idempotency'
import {
  AgentJourneyError,
  AgentJourneyService,
  type AgentJourneyCallContext
} from '../../src/main/application/agent-journey/agent-journey-service'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { journeyDetailSchema } from '../../src/shared/contracts/entities/agent-journey'
import { agentJourneyDto } from '../../src/main/application/mcp-tools/handlers'

/**
 * Journey ↔ Local Workspace 绑定（R6-4.3.1）的真实 SQLite 集成测试。
 *
 * **不 mock Repository / Service**：Migration 升级、外键 SET NULL、事务内的
 * 生命周期判定、幂等与 DTO 一致性都只有在真库上才测得出来。每个用例独立
 * 临时目录，不碰真实用户数据。
 *
 * 覆盖规格 §四 与 §六 的数据层 / MCP / 绑定生命周期三组要求。
 */

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

const CLIENT_A = 'client-aaaaaaaa-0000-4000-8000-000000000001'

let dir = ''
let handle: DatabaseHandle
let events: ApplicationEvents
let workspaces: LocalWorkspaceService
let service: AgentJourneyService
let projectRoot = ''
let emitted: string[] = []
let keySeq = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-journey-workspace-'))
  handle = openDatabase(join(dir, 'test.db'))
  events = new ApplicationEvents()
  workspaces = new LocalWorkspaceService(handle.db, events)
  service = new AgentJourneyService(handle.db, events, workspaces)
  projectRoot = join(dir, 'project')
  mkdirSync(projectRoot, { recursive: true })
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
  toolName: string,
  params: Record<string, unknown>,
  key?: string
): AgentJourneyCallContext {
  return {
    actor: { kind: 'mcp_client', clientId: CLIENT_A },
    idempotency: {
      key: key ?? `start:${randomUUID()}`,
      toolName,
      requestDigest: digestParams(params)
    }
  }
}

function createJourney(input: Record<string, unknown> = {}) {
  const params = { title: 'fix pairing bug', ...input }
  return service.createJourney(ctx('start_agent_journey', params), {
    title: 'fix pairing bug',
    ...input
  } as Parameters<AgentJourneyService['createJourney']>[1])
}

/** 登记一个真实存在的工作区（真实目录 + realpath 规范化）。 */
function registerWorkspace(name = 'BrewPhase'): string {
  return workspaces.add(projectRoot, name).id
}

function append(
  journeyId: string,
  input: {
    eventType: AgentJourneyEventType
    status?: AgentJourneyEventStatus
    title: string
  }
) {
  const params = { journeyId, ...input }
  return service.appendEvent(ctx('append_agent_journey_event', params), {
    journeyId,
    ...input
  } as Parameters<AgentJourneyService['appendEvent']>[1])
}

function expectJourneyError(run: () => unknown, code: string): void {
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

// MARK: - 数据层：Migration 15 → 16

describe('Migration 16：journey-workspace-binding', () => {
  it('只追加一版，1–15 的序号与名字原样保留', () => {
    expect(migrations.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
    ])
    expect(migrations[14]).toMatchObject({ version: 15, name: 'canvas-journey-fusion' })
    expect(migrations[15]).toMatchObject({ version: 16, name: 'journey-workspace-binding' })
  })

  it('旧库升级：已有 Journey 不丢，workspace_id 为 NULL，索引存在', () => {
    const file = join(dir, 'migrate.db')
    const { sqlite, db } = openAtVersion(file, 15)
    const legacyId = 'dddddddd-0000-4000-8000-000000000001'
    sqlite
      .prepare(
        `insert into agent_journeys (id, title, goal, status, source_client_id, created_at, updated_at)
         values (?, ?, '', 'created', ?, ?, ?)`
      )
      .run(legacyId, 'legacy journey', CLIENT_A, 1, 1)
    expect(
      sqlite.prepare(`select name from sqlite_master where name = 'agent_journeys_workspace_idx'`).get()
    ).toBeUndefined()

    migrate(sqlite)

    const row = sqlite.prepare('select workspace_id from agent_journeys where id = ?').get(legacyId) as {
      workspace_id: string | null
    }
    expect(row.workspace_id).toBeNull()
    expect(
      sqlite.prepare(`select name from sqlite_master where name = 'agent_journeys_workspace_idx'`).get()
    ).toBeDefined()
    // 升级后的行能被当前 schema 读出来。
    expect(selectJourney(db as unknown as Db, legacyId)?.title).toBe('legacy journey')
    sqlite.close()
  })

  it('外键：删除 Local Workspace 只解除关联，Journey 仍在', () => {
    const workspaceId = registerWorkspace('ToDelete')
    const journey = createJourney({ workspaceId }).journey
    expect(journey.workspaceId).toBe(workspaceId)

    workspaces.remove(workspaceId)

    const after = selectJourney(handle.db, journey.id)
    expect(after, '删工作区绝不许连带删 Journey').not.toBeNull()
    expect(after?.workspaceId).toBeNull()
    expect(selectJourneys(handle.db, {})).toHaveLength(1)
  })
})

// MARK: - Repository 与 DTO 映射

describe('Repository / DTO：workspace_id 全链路同名同值', () => {
  it('insertJourney → selectJourney → selectJourneys 往返一致', () => {
    const workspaceId = registerWorkspace()
    const withWorkspace = insertJourney(handle.db, {
      title: 'with workspace',
      goal: '',
      status: 'created',
      sourceClientId: CLIENT_A,
      sourceAgent: '',
      model: '',
      workContextId: null,
      workspaceId,
      captureMode: 'workflow_summary',
      now: Date.now()
    })
    const without = insertJourney(handle.db, {
      title: 'without workspace',
      goal: '',
      status: 'created',
      sourceClientId: CLIENT_A,
      sourceAgent: '',
      model: '',
      workContextId: null,
      captureMode: 'workflow_summary',
      now: Date.now()
    })

    expect(selectJourney(handle.db, withWorkspace.id)?.workspaceId).toBe(workspaceId)
    expect(selectJourney(handle.db, without.id)?.workspaceId).toBeNull()
    const listed = selectJourneys(handle.db, {})
    expect(listed.find((item) => item.id === withWorkspace.id)?.workspaceId).toBe(workspaceId)
    expect(listed.find((item) => item.id === without.id)?.workspaceId).toBeNull()
  })

  it('IPC 卡片与详情带 workspace_id，且能被 journeyDetailSchema 解析', () => {
    const workspaceId = registerWorkspace()
    const journeyId = createJourney({ workspaceId }).journey.id

    const card = service.listForRecords().journeys.find((item) => item.id === journeyId)
    expect(card?.workspace_id).toBe(workspaceId)

    const detail = service.getDetailForRenderer(journeyId)
    expect(detail.journey.workspace_id).toBe(workspaceId)
    expect(() => journeyDetailSchema.parse(detail)).not.toThrow()

    const unbound = createJourney().journey.id
    const unboundDetail = service.getDetailForRenderer(unbound)
    expect(unboundDetail.journey.workspace_id).toBeNull()
    expect(() => journeyDetailSchema.parse(unboundDetail)).not.toThrow()
  })

  it('MCP DTO（agentJourneyDto）与 IPC 卡片字段一致', () => {
    const workspaceId = registerWorkspace()
    const journeyId = createJourney({ workspaceId }).journey.id
    const entity = selectJourney(handle.db, journeyId)
    expect(entity).not.toBeNull()

    const dto = agentJourneyDto(entity!)
    expect(dto.workspace_id).toBe(workspaceId)
    // 与 IPC 侧同名同值——两端不许一个 snake 一个 camel。
    const card = service.getDetailForRenderer(journeyId).journey
    expect(dto.workspace_id).toBe(card.workspace_id)

    const unbound = agentJourneyDto(selectJourney(handle.db, createJourney().journey.id)!)
    expect(unbound.workspace_id).toBeNull()
  })
})

// MARK: - MCP 创建：workspace_id 校验

describe('MCP 创建 Journey 的 workspace_id 校验', () => {
  it('合法 UUID → 创建成功并落库', () => {
    const workspaceId = registerWorkspace()
    const result = createJourney({ workspaceId })
    expect(result.created).toBe(true)
    expect(result.journey.workspaceId).toBe(workspaceId)
    expect(selectJourney(handle.db, result.journey.id)?.workspaceId).toBe(workspaceId)
  })

  it('未传 workspace_id → 不关联（旧客户端回归）', () => {
    const result = createJourney()
    expect(result.created).toBe(true)
    expect(result.journey.workspaceId).toBeNull()
  })

  it('不存在的 workspace → NOT_FOUND，且不写入任何 Journey', () => {
    const missing = randomUUID()
    const before = selectJourneys(handle.db, {}).length
    expectJourneyError(() => createJourney({ workspaceId: missing }), 'NOT_FOUND')
    expect(selectJourneys(handle.db, {})).toHaveLength(before)
  })

  it('路径字符串 → VALIDATION_ERROR（第二道防线；Zod 在 MCP 层已先拒）', () => {
    for (const path of [projectRoot, '/Users/me/repo', './repo', 'C:\\Users\\me']) {
      expectJourneyError(() => createJourney({ workspaceId: path }), 'VALIDATION_ERROR')
    }
  })

  it('文件夹失效（登记还在、目录没了）→ VALIDATION_ERROR，错误不含绝对路径', () => {
    const workspaceId = registerWorkspace('Ghost')
    rmSync(projectRoot, { recursive: true, force: true })
    try {
      createJourney({ workspaceId })
      throw new Error('expected VALIDATION_ERROR')
    } catch (error) {
      expect((error as AgentJourneyError).code).toBe('VALIDATION_ERROR')
      expect((error as Error).message).not.toContain(projectRoot)
      expect((error as Error).message).not.toContain(dir)
    }
    expect(selectJourneys(handle.db, {})).toHaveLength(0)
  })

  it('同幂等键重放返回同一条 Journey；换 workspace_id 则拒绝复用', () => {
    const workspaceId = registerWorkspace()
    const key = `start:${randomUUID()}`

    const first = service.createJourney(
      ctx('start_agent_journey', { title: 'a', workspace_id: workspaceId }, key),
      { title: 'a', workspaceId }
    )
    expect(first.created).toBe(true)

    // 同 key 同参数 → 回放同一条（不看工作区是否还在）。
    const replay = service.createJourney(
      ctx('start_agent_journey', { title: 'a', workspace_id: workspaceId }, key),
      { title: 'a', workspaceId }
    )
    expect(replay.created).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.journey.id).toBe(first.journey.id)

    // 同 key 不同 workspace_id → 摘要不同，绝不复用旧结果。
    expectJourneyError(
      () =>
        service.createJourney(
          ctx('start_agent_journey', { title: 'a', workspace_id: null }, key),
          { title: 'a', workspaceId: null }
        ),
      'IDEMPOTENCY_KEY_REUSE'
    )
    expect(selectJourneys(handle.db, {})).toHaveLength(1)
  })
})

// MARK: - 绑定生命周期

describe('绑定 / 换绑 / 解绑的生命周期', () => {
  it('created 状态可绑定，且相同工作区重复绑定是幂等的', () => {
    const workspaceId = registerWorkspace()
    const journeyId = createJourney().journey.id
    emitted.length = 0

    const first = service.bindWorkspace(journeyId, workspaceId)
    expect(first.workspace_id).toBe(workspaceId)
    expect(emitted).toContain('agentJourneys')
    const afterFirst = selectJourney(handle.db, journeyId)!

    // 幂等：不写库、不 bump updated_at、不再广播。
    emitted.length = 0
    const second = service.bindWorkspace(journeyId, workspaceId)
    expect(second.workspace_id).toBe(workspaceId)
    expect(selectJourney(handle.db, journeyId)!.updatedAt).toBe(afterFirst.updatedAt)
    expect(emitted).not.toContain('agentJourneys')
  })

  it('换绑到另一个工作区、解绑（null）都只改列，不删 Journey', () => {
    const workspaceA = registerWorkspace('A')
    mkdirSync(join(dir, 'second'), { recursive: true })
    const workspaceB = workspaces.add(join(dir, 'second'), 'B').id
    const journeyId = createJourney({ workspaceId: workspaceA }).journey.id

    expect(service.bindWorkspace(journeyId, workspaceB).workspace_id).toBe(workspaceB)
    expect(service.bindWorkspace(journeyId, null).workspace_id).toBeNull()
    expect(selectJourney(handle.db, journeyId), '解绑绝不删 Journey').not.toBeNull()
    expect(selectJourneys(handle.db, {})).toHaveLength(1)
  })

  it('绑定不存在的 Journey → NOT_FOUND', () => {
    expectJourneyError(() => service.bindWorkspace(randomUUID(), null), 'NOT_FOUND')
  })

  it('绑定不存在 / 失效的工作区 → 拒绝，且 Journey 保持原样', () => {
    const journeyId = createJourney().journey.id
    expectJourneyError(() => service.bindWorkspace(journeyId, randomUUID()), 'NOT_FOUND')

    const workspaceId = registerWorkspace('Ghost')
    rmSync(projectRoot, { recursive: true, force: true })
    expectJourneyError(() => service.bindWorkspace(journeyId, workspaceId), 'VALIDATION_ERROR')
    expect(selectJourney(handle.db, journeyId)!.workspaceId).toBeNull()
  })

  it('执行事件仍为 planned 时可以换绑', () => {
    const workspaceA = registerWorkspace('A')
    mkdirSync(join(dir, 'second'), { recursive: true })
    const workspaceB = workspaces.add(join(dir, 'second'), 'B').id
    const journeyId = createJourney({ workspaceId: workspaceA }).journey.id
    append(journeyId, { eventType: 'execution', status: 'planned', title: 'start' })

    expect(service.bindWorkspace(journeyId, workspaceB).workspace_id).toBe(workspaceB)
  })

  it('执行事件进入 running / 终态后拒绝换绑与解绑', () => {
    const workspaceA = registerWorkspace('A')
    const journeyId = createJourney({ workspaceId: workspaceA }).journey.id
    append(journeyId, { eventType: 'execution', status: 'running', title: 'work' })

    expectJourneyError(() => service.bindWorkspace(journeyId, null), 'VALIDATION_ERROR')
    expectJourneyError(() => service.bindWorkspace(journeyId, randomUUID()), 'VALIDATION_ERROR')
    expect(selectJourney(handle.db, journeyId)!.workspaceId).toBe(workspaceA)
  })

  it('plan 事件把 Journey 推成 running 后仍可改——判据是执行事件不是 status', () => {
    const workspaceA = registerWorkspace('A')
    const journeyId = createJourney({ workspaceId: workspaceA }).journey.id
    append(journeyId, { eventType: 'plan', title: 'plan' })
    expect(selectJourney(handle.db, journeyId)!.status).toBe('running')

    expect(service.bindWorkspace(journeyId, null).workspace_id).toBeNull()
  })

  it('终态 Journey（completed / cancelled / failed）拒绝重新建立关联', () => {
    const workspaceId = registerWorkspace('Finished')
    for (const status of ['completed', 'cancelled', 'failed'] as const) {
      const journeyId = insertJourney(handle.db, {
        title: `finished ${status}`,
        goal: '',
        status,
        sourceClientId: CLIENT_A,
        sourceAgent: '',
        model: '',
        workContextId: null,
        captureMode: 'workflow_summary',
        now: Date.now()
      }).id
      expectJourneyError(
        () => service.bindWorkspace(journeyId, workspaceId),
        'VALIDATION_ERROR'
      )
      expect(selectJourney(handle.db, journeyId)!.workspaceId).toBeNull()
    }
  })

  it('未注入授权实现时失败关闭：任何 workspace 引用都被显式拒绝', () => {
    const bare = new AgentJourneyService(handle.db, events)
    const journeyId = createJourney().journey.id
    expectJourneyError(() => bare.bindWorkspace(journeyId, randomUUID()), 'VALIDATION_ERROR')
    // 解绑不涉及工作区校验，仍然可用（null 不需要授权）。
    expect(bare.bindWorkspace(journeyId, null).workspace_id).toBeNull()
  })
})

// MARK: - 装配层

describe('生产装配层确实注入了授权实现', () => {
  it('main/index.ts 把 LocalWorkspaceService 注入 AgentJourneyService', () => {
    const source = readFileSync('src/main/index.ts', 'utf8')
    const calls = source.match(/new AgentJourneyService\([^)]*\)/g) ?? []
    // 生产装配有且只有一处，且第三个参数是真实注入的 localWorkspaceService——
    // 这是「失败关闭」不变成「生产环境永远拒绝」的唯一保证。
    expect(calls).toEqual(['new AgentJourneyService(db.db, events, localWorkspaceService)'])
  })
})
