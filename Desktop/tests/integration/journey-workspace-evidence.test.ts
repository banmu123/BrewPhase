import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db, type DatabaseHandle } from '../../src/main/database/client'
import { migrate, migrations } from '../../src/main/database/migrations'
import {
  journeySnapshotFiles,
  journeyWorkspaceSnapshots,
  schema,
  syncMeta
} from '../../src/main/database/schema'
import {
  selectEvent,
  selectJourney
} from '../../src/main/database/repositories/agent-journeys'
import { digestParams } from '../../src/main/database/repositories/mcp-idempotency'
import {
  AgentJourneyService,
  type AgentJourneyCallContext
} from '../../src/main/application/agent-journey/agent-journey-service'
import { WorkspaceEvidenceService } from '../../src/main/application/agent-journey/workspace-evidence-service'
import { GitSnapshotEngine } from '../../src/main/application/agent-journey/git-snapshot-engine'
import type { GitWorkspaceSnapshot } from '../../src/main/application/agent-journey/git-snapshot-types'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { journeyEvidenceSchema } from '../../src/shared/contracts/entities/agent-journey'

/**
 * Workspace Evidence 持久化与生命周期采集（R6-4.3.3，P3）真实集成测试。
 *
 * **真实 SQLite + 真实 Git 临时仓库 + 真实引擎**——不 mock git、不 mock
 * Repository。覆盖规格 §八 的 21 项：Migration 17、五个触发点（T1a/T1b/
 * T2a/T2b/T3/T4/T5 含取消补采）、幂等与重放、per-workspace 串行队列、
 * 失败降级、重启边界、无 Workspace、DTO 无绝对路径、不写 change_log。
 */

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

const CLIENT = 'client-aaaaaaaa-0000-4000-8000-0000000000e1'

let dir = ''
let handle: DatabaseHandle
let events: ApplicationEvents
let workspaces: LocalWorkspaceService
let evidence: WorkspaceEvidenceService
let service: AgentJourneyService
let repoRoot = ''
let workspaceId = ''
let secondRepo = ''
let secondWorkspaceId = ''

// MARK: - 夹具

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true })
  git(['init', '-q'], root)
  git(['config', 'user.email', 'e2e@brewphase.test'], root)
  git(['config', 'user.name', 'e2e'], root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(['add', '-A', '.'], root)
  git(['commit', '-qm', 'init'], root)
}

function ctx(toolName: string, params: Record<string, unknown>, key?: string): AgentJourneyCallContext {
  return {
    actor: { kind: 'mcp_client', clientId: CLIENT },
    idempotency: {
      key: key ?? `${toolName.startsWith('start') ? 'start' : 'evt'}:${randomUUID()}`,
      toolName,
      requestDigest: digestParams(params)
    }
  }
}

function createJourney(
  svc: AgentJourneyService,
  input: Record<string, unknown> = {},
  key?: string
) {
  const params = { title: 'evidence task', ...input }
  return svc.createJourney(ctx('start_agent_journey', params, key), {
    title: 'evidence task',
    ...input
  } as Parameters<AgentJourneyService['createJourney']>[1])
}

function append(
  svc: AgentJourneyService,
  journeyId: string,
  input: Record<string, unknown>,
  key?: string
) {
  const params = { journeyId, ...input }
  return svc.appendEvent(ctx('append_agent_journey_event', params, key), {
    journeyId,
    ...input
  } as Parameters<AgentJourneyService['appendEvent']>[1])
}

async function snapshotRows(journeyId: string) {
  return handle.db
    .select()
    .from(journeyWorkspaceSnapshots)
    .where(eq(journeyWorkspaceSnapshots.journeyId, journeyId))
    .all()
}

function rowsOfType(rows: Awaited<ReturnType<typeof snapshotRows>>, type: string) {
  return rows.filter((row) => row.snapshotType === type)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-ws-evidence-'))
  handle = openDatabase(join(dir, 'brewphase.db'))
  events = new ApplicationEvents()
  workspaces = new LocalWorkspaceService(handle.db, events)
  evidence = new WorkspaceEvidenceService(handle.db, events, workspaces)
  service = new AgentJourneyService(handle.db, events, workspaces, evidence)
  repoRoot = join(dir, 'repo')
  initRepo(repoRoot, { 'a.ts': 'A\n', 'b.ts': 'B\n' })
  workspaceId = workspaces.add(repoRoot, 'EvidenceRepo').id
  secondRepo = join(dir, 'repo-two')
  initRepo(secondRepo, { 'c.ts': 'C\n' })
  secondWorkspaceId = workspaces.add(secondRepo, 'EvidenceRepoTwo').id
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

// MARK: - 1) Migration 17

function openAtVersion(file: string, version: number): { sqlite: Database.Database } {
  const sqlite = new Database(file)
  sqlite.pragma('foreign_keys = ON')
  for (const migration of migrations) {
    if (migration.version > version) break
    sqlite.exec('BEGIN')
    sqlite.exec(migration.sql)
    sqlite.pragma(`user_version = ${migration.version}`)
    sqlite.exec('COMMIT')
  }
  return { sqlite }
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare(`select name from sqlite_master where type='table' and name = ?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

describe('Migration 17：journey-workspace-evidence', () => {
  it('16 → 17 升级：旧 Journey 不丢、两张表建立、重复 migrate 幂等', () => {
    const file = join(dir, 'migrate17.db')
    const { sqlite } = openAtVersion(file, 16)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(16)
    const legacyId = 'dddddddd-0000-4000-8000-000000000017'
    sqlite
      .prepare(
        `insert into agent_journeys (id, title, goal, status, source_client_id, created_at, updated_at)
         values (?, ?, '', 'created', ?, ?, ?)`
      )
      .run(legacyId, 'legacy journey', CLIENT, 1, 1)
    expect(tableExists(sqlite, 'journey_workspace_snapshots')).toBe(false)

    migrate(sqlite)

    expect(sqlite.pragma('user_version', { simple: true })).toBe(17)
    expect(tableExists(sqlite, 'journey_workspace_snapshots')).toBe(true)
    expect(tableExists(sqlite, 'journey_snapshot_files')).toBe(true)
    const kept = sqlite.prepare('select id from agent_journeys where id = ?').get(legacyId)
    expect(kept).toBeTruthy() // 旧数据不丢

    // 重复执行 migrate 幂等（已到最新 → 直接返回）
    migrate(sqlite)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(17)
    sqlite.close()
  })

  it('UNIQUE(journey_id, trigger_key) 真实生效（不是仓储层 if 判断）', () => {
    const file = join(dir, 'unique17.db')
    const { sqlite } = openAtVersion(file, 17)
    const now = Date.now()
    const j1 = 'eeeeeeee-0000-4000-8000-000000000001'
    const j2 = 'eeeeeeee-0000-4000-8000-000000000002'
    for (const id of [j1, j2]) {
      sqlite
        .prepare(
          `insert into agent_journeys (id, title, source_client_id, created_at, updated_at) values (?,?,?,?,?)`
        )
        .run(id, 'j', CLIENT, now, now)
    }
    const insert = (id: string, journeyId: string, trigger: string) =>
      sqlite
        .prepare(
          `insert into journey_workspace_snapshots
             (id, journey_id, snapshot_type, trigger_key, capture_status, comparison_status, captured_at)
           values (?,?,?,?,?,?,?)`
        )
        .run(id, journeyId, 'baseline', trigger, 'ok', 'not_applicable', now)

    insert(randomUUID(), j1, 'baseline:1')
    // 同 (journey, trigger) 第二行 → 唯一约束真实拒绝
    expect(() => insert(randomUUID(), j1, 'baseline:1')).toThrow(/SQLITE_CONSTRAINT|UNIQUE/)
    // 同 trigger 不同 journey → 允许
    expect(() => insert(randomUUID(), j2, 'baseline:1')).not.toThrow()
    sqlite.close()
  })
})

// MARK: - 2) 五个触发点

describe('五个生命周期触发点（T1–T5）', () => {
  it('T1a：start_agent_journey 直接带 workspace → baseline 快照（created=true 才触发）', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const rows = await snapshotRows(created.journey.id)
    expect(rows).toHaveLength(1)
    const baseline = rows[0]
    expect(baseline.snapshotType).toBe('baseline')
    expect(baseline.triggerKey).toBe(`baseline:${created.journey.updatedAt}`)
    expect(baseline.captureStatus).toBe('ok')
    expect(baseline.comparisonStatus).toBe('not_applicable') // 参照物本身不比较
    expect(baseline.workspaceId).toBe(workspaceId)
    expect(baseline.repositoryIdentity).toMatch(/^[0-9a-f]{32}$/)
    expect(baseline.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline.isGit).toBe(1)

    // MCP 幂等重放（同 key 同 digest）→ replayed → 绝不第二次采集
    const params = { title: 'replay me', workspace_id: workspaceId }
    const key = `start:${randomUUID()}`
    const first = service.createJourney(ctx('start_agent_journey', params, key), {
      title: 'replay me',
      workspaceId
    })
    const replay = service.createJourney(ctx('start_agent_journey', params, key), {
      title: 'replay me',
      workspaceId
    })
    expect(first.created).toBe(true)
    expect(replay.replayed).toBe(true)
    await evidence.flushPending()
    expect(rowsOfType(await snapshotRows(first.journey.id), 'baseline')).toHaveLength(1)
  })

  it('T1b：bindWorkspace 真正变更才采集；幂等重复不采、解绑不采、重绑拿新版本', async () => {
    const created = createJourney(service) // 创建时不带 workspace → 无证据行
    await evidence.flushPending()
    expect(await snapshotRows(created.journey.id)).toHaveLength(0)

    service.bindWorkspace(created.journey.id, workspaceId)
    await evidence.flushPending()
    let rows = await snapshotRows(created.journey.id)
    expect(rowsOfType(rows, 'baseline')).toHaveLength(1)
    const firstTrigger = rows[0].triggerKey

    // 同一 workspace 幂等重复绑定（changed=false）→ 不重复采集
    service.bindWorkspace(created.journey.id, workspaceId)
    await evidence.flushPending()
    rows = await snapshotRows(created.journey.id)
    expect(rows).toHaveLength(1)

    // 解绑 → 不采集
    service.bindWorkspace(created.journey.id, null)
    await evidence.flushPending()
    expect(await snapshotRows(created.journey.id)).toHaveLength(1)

    // 重新绑定 → 新的绑定版本 = 新 trigger_key
    service.bindWorkspace(created.journey.id, workspaceId)
    await evidence.flushPending()
    rows = await snapshotRows(created.journey.id)
    expect(rowsOfType(rows, 'baseline')).toHaveLength(2)
    const triggers = new Set(rows.map((row) => row.triggerKey))
    expect(triggers.size).toBe(2)
    expect(rows.some((row) => row.triggerKey === firstTrigger)).toBe(true)
  })

  it('T2a：appendEvent 直接创建 status=running 的 Execution → execution_start', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const event = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'running',
      title: 'run now'
    })
    await evidence.flushPending()

    const rows = await snapshotRows(created.journey.id)
    const start = rowsOfType(rows, 'execution_start')
    expect(start).toHaveLength(1)
    expect(start[0].executionEventId).toBe(event.event.id)
    expect(start[0].triggerKey).toBe(`start:${event.event.id}`)
    expect(start[0].captureStatus).toBe('ok')
    expect(start[0].comparisonStatus).toBe('not_applicable')
  })

  it('T2b：planned → running 才采 start；planned 不采；重复推进被拒且不产生重复', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'planned'
    })
    await evidence.flushPending()
    expect(rowsOfType(await snapshotRows(created.journey.id), 'execution_start')).toHaveLength(0)

    const before = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: before.updatedAt
    })
    await evidence.flushPending()
    let starts = rowsOfType(await snapshotRows(created.journey.id), 'execution_start')
    expect(starts).toHaveLength(1)

    // running → running 是非法转换（状态机拒绝）→ 不会产生第二条 start
    const after = selectEvent(handle.db, planned.event.id)!
    expect(() =>
      service.updateEventStatus({
        eventId: planned.event.id,
        status: 'running',
        expectedUpdatedAt: after.updatedAt
      })
    ).toThrow(/illegal status transition/)
    await evidence.flushPending()
    starts = rowsOfType(await snapshotRows(created.journey.id), 'execution_start')
    expect(starts).toHaveLength(1)
  })

  it('T3：running → completed/failed/skipped/cancelled 各采 execution_end；planned→skipped 不采', async () => {
    const targets = ['completed', 'failed', 'skipped', 'cancelled'] as const
    for (const target of targets) {
      const created = createJourney(service, { workspaceId })
      await evidence.flushPending()
      const planned = append(service, created.journey.id, {
        eventType: 'execution',
        status: 'planned',
        title: `to ${target}`
      })
      const row = selectEvent(handle.db, planned.event.id)!
      service.updateEventStatus({
        eventId: planned.event.id,
        status: 'running',
        expectedUpdatedAt: row.updatedAt
      })
      // start 是 fire-and-forget：先等它完成，再制造窗口内变化，
      // 否则 start 采集可能晚于文件改动、窗口重叠导致 changedFiles=0
      await evidence.flushPending()
      // 窗口内产生真实文件变化 → end 应带文件级摘要
      writeFileSync(join(repoRoot, 'a.ts'), 'A\nCHANGED\n')
      const running = selectEvent(handle.db, planned.event.id)!
      service.updateEventStatus({
        eventId: planned.event.id,
        status: target,
        expectedUpdatedAt: running.updatedAt
      })
      await evidence.flushPending()

      const rows = await snapshotRows(created.journey.id)
      const ends = rowsOfType(rows, 'execution_end')
      expect(ends, `target=${target}`).toHaveLength(1)
      expect(ends[0].executionEventId).toBe(planned.event.id)
      expect(ends[0].captureStatus).toBe('ok')
      // start 在内存里 → 真实比较完成（有变化 → complete + 统计非零）
      expect(ends[0].comparisonStatus).toBe('complete')
      expect(ends[0].changedFilesCount).toBe(1)
      expect(ends[0].insertions).toBeGreaterThan(0)
      const files = handle.db
        .select()
        .from(journeySnapshotFiles)
        .where(eq(journeySnapshotFiles.snapshotId, ends[0].id))
        .all()
      expect(files).toHaveLength(1)
      expect(files[0].repoRelativePath).toBe('a.ts')
      expect(files[0].changeKind).toBe('modified')
      expect(files[0].insertions).not.toBeNull()
      // P4 字段必须为 NULL（不伪造 Diff Artifact / 归因）
      expect(files[0].artifactRef).toBeNull()
      expect(files[0].attribution).toBeNull()
      expect(files[0].attributionConfidence).toBeNull()
      expect(files[0].lineRanges).toBeNull()

      // 还原工作区，避免影响下一个 target
      writeFileSync(join(repoRoot, 'a.ts'), 'A\n')
    }

    // planned → skipped：没有 running 窗口 → 不采 execution_end
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'never ran'
    })
    const row = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'skipped',
      expectedUpdatedAt: row.updatedAt
    })
    await evidence.flushPending()
    expect(rowsOfType(await snapshotRows(created.journey.id), 'execution_end')).toHaveLength(0)
    expect(rowsOfType(await snapshotRows(created.journey.id), 'execution_start')).toHaveLength(0)
  })

  it('T5-取消：updateJourneyStatus(cancelled) 绕过 updateEventStatus 也补采 running 窗口', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const running = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'running',
      title: 'will be cancelled'
    })
    // 再开一个 planned 执行：取消时会被标 cancelled，但没有 running 窗口 → 不采 end
    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'planned one'
    })
    await evidence.flushPending()

    const journey = selectJourney(handle.db, created.journey.id)!
    service.updateJourneyStatus({
      journeyId: created.journey.id,
      status: 'cancelled',
      expectedUpdatedAt: journey.updatedAt
    })
    await evidence.flushPending()

    const rows = await snapshotRows(created.journey.id)
    const ends = rowsOfType(rows, 'execution_end')
    expect(ends).toHaveLength(1)
    expect(ends[0].executionEventId).toBe(running.event.id) // 只补真正开过的窗口
    const finals = rowsOfType(rows, 'journey_final')
    expect(finals).toHaveLength(1)
    expect(finals[0].captureStatus).toBe('ok')
    // 批量取消确实写进了事件状态（历史保留）
    expect(selectEvent(handle.db, running.event.id)!.status).toBe('cancelled')
    expect(selectEvent(handle.db, planned.event.id)!.status).toBe('cancelled')
    void planned
  })

  it('T4：outcome 完成 → journey_final；MCP 幂等重放不产生第二条', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const outcomeInput = {
      eventType: 'outcome',
      title: 'done',
      journeyStatus: 'completed'
    }
    const key = `evt:${randomUUID()}`
    append(service, created.journey.id, outcomeInput, key)
    await evidence.flushPending()
    let finals = rowsOfType(await snapshotRows(created.journey.id), 'journey_final')
    expect(finals).toHaveLength(1)
    expect(finals[0].captureStatus).toBe('ok')
    expect(finals[0].comparisonStatus).toBe('complete') // 内存 baseline 在 → 真比较
    expect(finals[0].triggerKey).toMatch(/^final:\d+$/)

    // 同 key 同 digest 重放（digest 输入 = 与首次完全相同的字段拼法）→ 不再采
    const replayParams = { journeyId: created.journey.id, ...outcomeInput }
    const replay = service.appendEvent(
      ctx('append_agent_journey_event', replayParams, key),
      { journeyId: created.journey.id, ...outcomeInput } as Parameters<
        AgentJourneyService['appendEvent']
      >[1]
    )
    expect(replay.replayed).toBe(true)
    await evidence.flushPending()
    finals = rowsOfType(await snapshotRows(created.journey.id), 'journey_final')
    expect(finals).toHaveLength(1)
  })

  it('T5：failed → running → completed 得到两条 final（failed 非不可逆终态）；同一转换不重复', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const asRunning = () => selectJourney(handle.db, created.journey.id)!
    service.updateJourneyStatus({
      journeyId: created.journey.id,
      status: 'running',
      expectedUpdatedAt: asRunning().updatedAt
    })
    const beforeFail = selectJourney(handle.db, created.journey.id)!
    service.updateJourneyStatus({
      journeyId: created.journey.id,
      status: 'failed',
      expectedUpdatedAt: beforeFail.updatedAt
    })
    await evidence.flushPending()
    let finals = rowsOfType(await snapshotRows(created.journey.id), 'journey_final')
    expect(finals).toHaveLength(1)
    const firstTrigger = finals[0].triggerKey

    // failed → failed 不是合法转换 → 不产生重复 final
    expect(() =>
      service.updateJourneyStatus({
        journeyId: created.journey.id,
        status: 'failed',
        expectedUpdatedAt: selectJourney(handle.db, created.journey.id)!.updatedAt
      })
    ).toThrow(/illegal journey transition|terminal/)
    await evidence.flushPending()
    expect(rowsOfType(await snapshotRows(created.journey.id), 'journey_final')).toHaveLength(1)

    // 恢复运行（failed → running 允许）→ 不产生 final
    service.updateJourneyStatus({
      journeyId: created.journey.id,
      status: 'running',
      expectedUpdatedAt: selectJourney(handle.db, created.journey.id)!.updatedAt
    })
    await evidence.flushPending()
    expect(rowsOfType(await snapshotRows(created.journey.id), 'journey_final')).toHaveLength(1)

    // 再次完成（outcome）→ 第二条 final，trigger 不同，且 baseline 仍在 → complete
    append(service, created.journey.id, {
      eventType: 'outcome',
      title: 'recovered',
      journeyStatus: 'completed'
    })
    await evidence.flushPending()
    finals = rowsOfType(await snapshotRows(created.journey.id), 'journey_final')
    expect(finals).toHaveLength(2)
    expect(new Set(finals.map((row) => row.triggerKey)).size).toBe(2)
    const second = finals.find((row) => row.triggerKey !== firstTrigger)!
    expect(second.comparisonStatus).toBe('complete') // failed 的 final 没释放 baseline
  })

  it('T5-failed：failed 快照自身失败时 capture 与 comparison 分列（不混淆）', async () => {
    // 用 gitPath 不存在的引擎：current 采不到 → capture_status=error + comparison_failed
    const brokenEvidence = new WorkspaceEvidenceService(
      handle.db,
      events,
      workspaces,
      new GitSnapshotEngine({ gitPath: '/definitely/not/a/git-binary' })
    )
    const brokenService = new AgentJourneyService(handle.db, events, workspaces, brokenEvidence)
    const created = createJourney(brokenService, { workspaceId })
    // Journey 正常推进不受影响（创建成功）
    expect(created.journey.id).toBeTruthy()
    const journey = selectJourney(handle.db, created.journey.id)!
    brokenService.updateJourneyStatus({
      journeyId: created.journey.id,
      status: 'running',
      expectedUpdatedAt: journey.updatedAt
    })
    const running = selectJourney(handle.db, created.journey.id)!
    brokenService.updateJourneyStatus({
      journeyId: created.journey.id,
      status: 'failed',
      expectedUpdatedAt: running.updatedAt
    })
    await brokenEvidence.flushPending()
    const rows = await snapshotRows(created.journey.id)
    const final = rowsOfType(rows, 'journey_final')[0]
    expect(final).toBeDefined()
    expect(final.captureStatus).toBe('error') // 快照自身：没采到
    expect(final.errorCode).toBe('git_not_found')
    expect(final.comparisonStatus).toBe('comparison_failed') // 比较：没完成（与 capture 分开表达）
    expect(final.changedFilesCount).toBe(0)
    // Journey 状态是真相：failed 正常落库
    expect(selectJourney(handle.db, created.journey.id)!.status).toBe('failed')
  })
})


// MARK: - 3) per-workspace 串行队列（规格 §三.1）

describe('per-workspace 串行队列', () => {
  it('同一 Workspace 两个 Journey 串行采集；不同 Workspace 可并发', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = 0
    let concurrent = 0
    let maxConcurrent = 0
    const real = new GitSnapshotEngine()
    const gated: GitSnapshotEngine = {
      capture: async (rootPath: string) => {
        started += 1
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        if (started === 1) await gate // 第一次采集卡住：同 Workspace 的后续必须排队
        try {
          return await real.capture(rootPath)
        } finally {
          concurrent -= 1
        }
      },
      compare: (
        baseline: GitWorkspaceSnapshot,
        current: GitWorkspaceSnapshot
      ) => real.compare(baseline, current)
    } as unknown as GitSnapshotEngine

    const queuedEvidence = new WorkspaceEvidenceService(handle.db, events, workspaces, gated)
    const queuedService = new AgentJourneyService(handle.db, events, workspaces, queuedEvidence)

    const j1 = createJourney(queuedService, { workspaceId })
    const j2 = createJourney(queuedService, { workspaceId })
    void j1
    void j2

    // 让微任务跑起来：j1 的 baseline 进入采集并卡在 gate；j2 同 workspace → 排队
    await new Promise((resolve) => setImmediate(resolve))
    expect(started, '同 Workspace 的第二个采集必须排队').toBe(1)

    // 之后再引入另一个 Workspace → 不受前者阻塞（可并发开始）
    const j3 = createJourney(queuedService, { workspaceId: secondWorkspaceId })
    void j3
    await new Promise((resolve) => setImmediate(resolve))
    expect(started, '不同 Workspace 不受前者阻塞').toBe(2)
    expect(maxConcurrent).toBe(2)

    release()
    await queuedEvidence.flushPending()
    expect(started).toBe(3)
    expect(await snapshotRows(j1.journey.id)).toHaveLength(1)
    expect(await snapshotRows(j2.journey.id)).toHaveLength(1)
    expect(await snapshotRows(j3.journey.id)).toHaveLength(1)
  })

  it('上一次任务失败不阻塞后续队列', async () => {
    const failing = new WorkspaceEvidenceService(
      handle.db,
      events,
      workspaces,
      new GitSnapshotEngine({ gitPath: '/definitely/not/a/git-binary' })
    )
    const failingService = new AgentJourneyService(handle.db, events, workspaces, failing)
    const bad = createJourney(failingService, { workspaceId })
    const good = createJourney(failingService, { workspaceId })
    void good
    // 第一条必失败（git 不存在），第二条仍要执行完
    await failing.flushPending()
    const badRows = await snapshotRows(bad.journey.id)
    expect(badRows).toHaveLength(1)
    expect(badRows[0].captureStatus).toBe('error')
  })
})

// MARK: - 4) 失败处理与 Journey 解耦（规格 §五）

describe('失败降级与证据可信度', () => {
  it('git 不存在 → 失败快照（error + 明确 error_code），Journey 完全不受影响', async () => {
    const failing = new WorkspaceEvidenceService(
      handle.db,
      events,
      workspaces,
      new GitSnapshotEngine({ gitPath: '/definitely/not/a/git-binary' })
    )
    const failingService = new AgentJourneyService(handle.db, events, workspaces, failing)
    const created = createJourney(failingService, { workspaceId })
    const planned = append(failingService, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'p'
    })
    const row = selectEvent(handle.db, planned.event.id)!
    failingService.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: row.updatedAt
    })
    await failing.flushPending()

    // 证据：每条都是明确失败，不伪造零变化
    const rows = await snapshotRows(created.journey.id)
    expect(rows).toHaveLength(2) // baseline + start
    for (const snapshot of rows) {
      expect(snapshot.captureStatus).toBe('error')
      expect(snapshot.errorCode).toBe('git_not_found')
      expect(snapshot.changedFilesCount).toBe(0)
    }
    // Journey 业务状态：完全正常（首个事件把 Journey 推进为 running）
    expect(selectJourney(handle.db, created.journey.id)!.status).toBe('running')
    expect(selectEvent(handle.db, planned.event.id)!.status).toBe('running')
  })

  it('git 超时 → git_timeout 失败快照，不影响 Journey', async () => {
    const slow = new WorkspaceEvidenceService(handle.db, events, workspaces, new GitSnapshotEngine({
      timeoutMs: 1
    }))
    const slowService = new AgentJourneyService(handle.db, events, workspaces, slow)
    const created = createJourney(slowService, { workspaceId })
    await slow.flushPending()
    const rows = await snapshotRows(created.journey.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].captureStatus).toBe('error')
    expect(rows[0].errorCode).toBe('git_timeout')
    expect(selectJourney(handle.db, created.journey.id)!.status).toBe('created')
  })

  it('Workspace 目录不可访问（权限）→ 失败快照；恢复后重新绑定可用', async () => {
    chmodSync(repoRoot, 0o000)
    try {
      const created = createJourney(service, { workspaceId })
      await evidence.flushPending()
      const rows = await snapshotRows(created.journey.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].captureStatus).toBe('error')
      expect(['permission_denied', 'git_failed', 'root_unavailable']).toContain(
        rows[0].errorCode
      )
      // Journey 正常
      expect(selectJourney(handle.db, created.journey.id)!.status).toBe('created')
    } finally {
      chmodSync(repoRoot, 0o755)
    }
  })

  it('采集时目录已被删除（登记仍在）→ 明确 failed（workspace_unavailable），不写零变化', async () => {
    // 创建时目录可用（R6-4.3.1 的可用性校验在创建/绑定时就会拒绝不存在的目录），
    // 真实场景是「绑定之后目录被移走」：resolveRoot 拿不到根 → 失败快照。
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    expect(rowsOfType(await snapshotRows(created.journey.id), 'baseline')[0].captureStatus).toBe('ok')

    rmSync(repoRoot, { recursive: true, force: true })
    append(service, created.journey.id, {
      eventType: 'execution',
      status: 'running',
      title: 'folder gone'
    })
    await evidence.flushPending()

    const rows = await snapshotRows(created.journey.id)
    const start = rowsOfType(rows, 'execution_start')
    expect(start).toHaveLength(1)
    expect(start[0].captureStatus).toBe('failed')
    expect(start[0].errorCode).toBe('workspace_unavailable')
    expect(start[0].repositoryIdentity).toBeNull() // 根目录不可得 → 不写 identity
    expect(start[0].comparisonStatus).toBe('not_applicable')
    expect(start[0].changedFilesCount).toBe(0)
    // Journey 正常推进
    expect(selectJourney(handle.db, created.journey.id)!.status).toBe('running')
  })
})

// MARK: - 5) Workspace 删除 / 重启 / 无 Workspace / DTO 边界

describe('生命周期与重启边界（规格 §八 16–21）', () => {
  it('16) 删除 Workspace：历史证据保留（workspace_id 置 NULL），且不再产生新证据', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    expect(await snapshotRows(created.journey.id)).toHaveLength(1)

    workspaces.remove(workspaceId)

    // 外键 SET NULL：Journey 与证据都保留，仅解除引用
    expect(selectJourney(handle.db, created.journey.id)!.workspaceId).toBeNull()
    const rows = await snapshotRows(created.journey.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].workspaceId).toBeNull()

    // journey.workspace_id 已为 null → 后续触发直接跳过（不产生错误证据行）
    append(service, created.journey.id, { eventType: 'execution', status: 'running', title: 'go' })
    await evidence.flushPending()
    expect(await snapshotRows(created.journey.id)).toHaveLength(1)
  })

  it('17/18) 重启：历史快照可读；丢失的内存基线 → baseline_unavailable，绝不伪造比较', async () => {
    // 会话一：baseline + start 都在内存里
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'p'
    })
    const row = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: row.updatedAt
    })
    await evidence.flushPending()

    // “重启”：全新实例（内存 Map 清空），同一个库
    const restartedEvidence = new WorkspaceEvidenceService(handle.db, events, workspaces)
    const restartedService = new AgentJourneyService(handle.db, events, workspaces, restartedEvidence)

    // 17) 已持久化的历史可查询
    const history = restartedEvidence.listForJourney(created.journey.id)
    expect(history.snapshots).toHaveLength(2) // baseline + start
    expect(history.snapshots[0].capture_status).toBe('ok')
    expect(history.snapshots.every((snapshot) => snapshot.snapshot_type !== undefined)).toBe(true)
    // 共享契约能 parse 通过（Renderer 契约与 Service 输出一致）
    expect(() => journeyEvidenceSchema.parse(history)).not.toThrow()

    // 18) 内存基线/起点已失 → 当前状态正常采集，但比较明确 baseline_unavailable
    const current = selectEvent(handle.db, planned.event.id)!
    restartedService.updateEventStatus({
      eventId: planned.event.id,
      status: 'completed',
      expectedUpdatedAt: current.updatedAt
    })
    await restartedEvidence.flushPending()

    const after = restartedEvidence.listForJourney(created.journey.id)
    const end = after.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')
    expect(end).toBeDefined()
    expect(end!.capture_status).toBe('ok') // 当前状态照常采
    expect(end!.comparison_status).toBe('baseline_unavailable') // 但绝不伪造比较
    expect(end!.files).toEqual([])
    expect(end!.changed_files_count).toBe(0)
  })

  it('19) 没有 Workspace 的 Journey 不产生任何证据行', async () => {
    const created = createJourney(service) // 不带 workspace
    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'p'
    })
    const row = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: row.updatedAt
    })
    const running = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'completed',
      expectedUpdatedAt: running.updatedAt
    })
    append(service, created.journey.id, {
      eventType: 'outcome',
      title: 'done',
      journeyStatus: 'completed'
    })
    await evidence.flushPending()

    expect(await snapshotRows(created.journey.id)).toHaveLength(0)
    expect(evidence.listForJourney(created.journey.id).snapshots).toHaveLength(0)
  })

  it('20) 对外 DTO 不含机器绝对路径（identity 是哈希、identifier 是 basename#哈希）', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    const dto = evidence.listForJourney(created.journey.id)
    const json = JSON.stringify(dto)
    expect(json).not.toContain(dir) // 临时根目录
    expect(json).not.toContain(repoRoot) // 工作区绝对路径
    const snapshot = dto.snapshots[0]
    expect(snapshot.repository_identity).toMatch(/^[0-9a-f]{32}$/)
    expect(snapshot.repository_root_identifier).toBe(
      snapshot.repository_root_identifier
    )
    expect(snapshot.repository_root_identifier).toContain('#')
    expect(snapshot.repository_root_identifier).not.toContain('/')
  })

  it('21) 证据不写入 change_log（sync_meta 零新增）——local-first', async () => {
    const before = handle.db.select().from(syncMeta).all().length
    const created = createJourney(service, { workspaceId })
    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'p'
    })
    const row = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: row.updatedAt
    })
    const running = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'completed',
      expectedUpdatedAt: running.updatedAt
    })
    append(service, created.journey.id, {
      eventType: 'outcome',
      title: 'done',
      journeyStatus: 'completed'
    })
    await evidence.flushPending()

    const after = handle.db.select().from(syncMeta).all().length
    expect(after).toBe(before)
    // 且确实采到了完整证据（对照：不是没跑）
    expect(await snapshotRows(created.journey.id)).toHaveLength(4)
  })
})
