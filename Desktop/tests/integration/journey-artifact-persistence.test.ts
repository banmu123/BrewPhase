import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { journeySnapshotFiles, journeyWorkspaceSnapshots } from '../../src/main/database/schema'
import { journeyArtifactBytes, insertSnapshotWithFiles } from '../../src/main/database/repositories/agent-journey-evidence'
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
import {
  GIT_DIFF_MAX_BYTES_PER_SNAPSHOT,
  type GitFileDiff,
  type GitWorkspaceSnapshot
} from '../../src/main/application/agent-journey/git-snapshot-types'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { journeyEvidenceSchema } from '../../src/shared/contracts/entities/agent-journey'
import type { EvidenceFileInsert } from '../../src/main/database/repositories/agent-journey-evidence'

/**
 * Diff Artifact 持久化与按需读取（R6-4.3.4，P4）真实集成测试。
 *
 * **真实 SQLite + 真实 Git 临时仓库**（容量与类型映射）+ **注入式 stub 引擎**
 * （Journey 级预算 / 并发 / 写入失败这类难以用真实 git 确定性构造的场景）——
 * 不 mock 仓储、不 mock codec。覆盖 §七：持久化与历史可读、七类 Artifact 映射、
 * 敏感硬排除与脱敏、三级容量（64 KB / 512 KB / 2 MB）、UTF-8 字节预算、
 * 并发不破预算、写入失败不伪装成功、按需 IPC 的归属与「不碰工作区/git」。
 */

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

const CLIENT = 'client-aaaaaaaa-0000-4000-8000-0000000000a4'
const JOURNEY_LIMIT = 2 * 1024 * 1024

let dir = ''
let handle: DatabaseHandle
let events: ApplicationEvents
let workspaces: LocalWorkspaceService
let evidence: WorkspaceEvidenceService
let service: AgentJourneyService
let repoRoot = ''
let workspaceId = ''

// MARK: - 夹具

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(root: string, files: Record<string, string | Buffer>): void {
  mkdirSync(root, { recursive: true })
  git(['init', '-q'], root)
  git(['config', 'user.email', 'e2e@brewphase.test'], root)
  git(['config', 'user.name', 'e2e'], root)
  git(['config', 'core.filemode', 'true'], root) // mode_only 依赖真实 mode 追踪
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
  const params = { title: 'artifact task', ...input }
  return svc.createJourney(ctx('start_agent_journey', params, key), {
    title: 'artifact task',
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

function rowsSync(journeyId: string) {
  return handle.db
    .select()
    .from(journeyWorkspaceSnapshots)
    .where(eq(journeyWorkspaceSnapshots.journeyId, journeyId))
    .all()
}

function fileRows(snapshotId: string) {
  return handle.db
    .select()
    .from(journeySnapshotFiles)
    .where(eq(journeySnapshotFiles.snapshotId, snapshotId))
    .all()
}

/** 一次完整执行窗口：planned → running（采 start）→ during() → completed（采 end）。 */
async function runWindow(
  svc: AgentJourneyService,
  ev: WorkspaceEvidenceService,
  journeyId: string,
  during: () => void
): Promise<void> {
  const planned = append(svc, journeyId, { eventType: 'execution', status: 'planned', title: 'step' })
  const before = selectEvent(handle.db, planned.event.id)!
  svc.updateEventStatus({
    eventId: planned.event.id,
    status: 'running',
    expectedUpdatedAt: before.updatedAt
  })
  await ev.flushPending() // start 先落，再制造窗口内变化
  during()
  const running = selectEvent(handle.db, planned.event.id)!
  svc.updateEventStatus({
    eventId: planned.event.id,
    status: 'completed',
    expectedUpdatedAt: running.updatedAt
  })
  await ev.flushPending()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-artifact-'))
  handle = openDatabase(join(dir, 'brewphase.db'))
  events = new ApplicationEvents()
  workspaces = new LocalWorkspaceService(handle.db, events)
  evidence = new WorkspaceEvidenceService(handle.db, events, workspaces)
  service = new AgentJourneyService(handle.db, events, workspaces, evidence)
  repoRoot = join(dir, 'repo')
  initRepo(repoRoot, { 'a.ts': 'A\n', 'b.ts': 'B\n' })
  workspaceId = workspaces.add(repoRoot, 'ArtifactRepo').id
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

// MARK: - stub 引擎（容量 / 并发 / 失败场景的确定性构造）

function stubSnapshot(): GitWorkspaceSnapshot {
  return {
    capture_status: 'ok',
    error_code: null,
    captured_at: Date.now(),
    repository_identity: 'f'.repeat(32),
    repository_root_identifier: 'stub#ffffff',
    branch: 'main',
    head_sha: 'stub-head',
    tree_sha: '1'.repeat(40),
    index_state_hash: '2'.repeat(64),
    worktree_state_hash: '3'.repeat(64),
    is_git: true,
    is_worktree: true,
    is_submodule: false,
    has_unborn_head: false,
    counts: { tracked: 2, staged: 0, unstaged: 1, untracked: 0, ignored: 0, conflicted: 0 },
    files: [],
    head_tree: { status: 'ok', error_code: null, entries: [], malformed_records: 0 },
    baseline_store_complete: true
  } as unknown as GitWorkspaceSnapshot
}

/** count 个文件、每个 diff 正文约 textBytes 字节（单行）。 */
function stubDiffs(count: number, textBytes: number): GitFileDiff[] {
  const text = `+${'x'.repeat(Math.max(textBytes - 2, 1))}\n`
  return Array.from({ length: count }, (_, index) => ({
    repo_relative_path: `f${index}.txt`,
    change_kind: 'modified' as const,
    status_origin: 'worktree' as const,
    observation: 'changed' as const,
    content_hash_before: 'hash-before',
    content_hash_after: 'hash-after',
    pre_existing_dirty: false,
    head_moved: false,
    rename_from_path: null,
    mode_before: null,
    mode_after: null,
    insertions: 1,
    deletions: 0,
    artifact: {
      kind: 'diff' as const,
      text,
      insertions: 1,
      deletions: 0,
      byte_size: Buffer.byteLength(text)
    }
  }))
}

function makeStubEngine(options: {
  files: () => GitFileDiff[]
  /** 在 capture 里让出事件循环 → 两个实例的任务真正交错。 */
  delay?: boolean
}): GitSnapshotEngine {
  const engine = {
    capture: async () => {
      if (options.delay) await new Promise((resolve) => setImmediate(resolve))
      return stubSnapshot()
    },
    compare: async () => {
      const files = options.files()
      return {
        status: 'ok',
        error_code: null,
        manifest_completeness: 'complete',
        baseline_tree_status: 'ok',
        current_tree_status: 'ok',
        manifest_unavailable_reason: null,
        head_moved: false,
        baseline_store_complete: true,
        files,
        stats: {
          changed_files: files.length,
          undetermined: 0,
          added: 0,
          modified: files.length,
          deleted: 0,
          renamed: 0,
          type_changed: 0,
          conflicted: 0,
          mode_changed: 0,
          insertions_total: files.reduce((sum, file) => sum + (file.insertions ?? 0), 0),
          deletions_total: 0,
          omitted_sensitive: 0,
          omitted_binary: 0,
          omitted_over_budget: 0,
          unavailable: 0
        }
      }
    }
  }
  return engine as unknown as GitSnapshotEngine
}

// MARK: - 1) 持久化、按需读取与历史可复现

describe('Diff Artifact 持久化与按需读取（真实 SQLite + Git）', () => {
  it('真实 Diff 存入 SQLite；普通 evidence 不含正文；工作区被改/删后历史仍可读；重启实例同样可读', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    await runWindow(service, evidence, created.journey.id, () => {
      writeFileSync(join(repoRoot, 'a.ts'), 'A\nCHANGED LINE FOR P4\n')
    })

    // 普通 evidence：轻量元数据 + 结构可校验；**正文绝不随列表返回**
    const dto = evidence.listForJourney(created.journey.id)
    expect(journeyEvidenceSchema.safeParse(dto).success).toBe(true)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    expect(end.comparison_status).toBe('complete')
    const file = end.files.find((row) => row.repo_relative_path === 'a.ts')!
    expect(file.artifact_kind).toBe('diff')
    expect(file.artifact_status).toBe('available')
    expect(file.artifact_omission).toBeNull()
    expect(Object.keys(file)).not.toContain('artifact_ref') // P4 起字段从普通 DTO 移除
    const listed = JSON.stringify(dto)
    expect(listed).not.toContain('CHANGED LINE FOR P4')
    expect(listed).not.toContain('+CHANGED')

    // 按需读取：结构化 DTO + 真实正文（UTF-8 字节一致）
    const artifact = evidence.readArtifact(created.journey.id, end.id, file.id)
    expect(artifact.repo_relative_path).toBe('a.ts')
    expect(artifact.artifact.kind).toBe('diff')
    if (artifact.artifact.kind === 'diff') {
      expect(artifact.artifact.text).toContain('+CHANGED LINE FOR P4')
      expect(artifact.artifact.byte_size).toBe(Buffer.byteLength(artifact.artifact.text))
      expect(artifact.artifact.insertions).toBeGreaterThan(0)
    }

    // 工作区文件被覆盖 → 再被删除：历史 Diff 一字不改（不重访工作区）
    writeFileSync(join(repoRoot, 'a.ts'), 'TOTALLY DIFFERENT NOW\n')
    rmSync(join(repoRoot, 'a.ts'))
    expect(evidence.readArtifact(created.journey.id, end.id, file.id).artifact).toEqual(
      artifact.artifact
    )

    // 重启（全新实例、同一库）→ 同样可读（验收：退出重开仍能读历史 Diff）
    const restarted = new WorkspaceEvidenceService(handle.db, events, workspaces)
    expect(restarted.readArtifact(created.journey.id, end.id, file.id).artifact).toEqual(
      artifact.artifact
    )
  })

  it('三元组归属校验：跨 Journey / 跨 Snapshot / 无效 id → NOT_FOUND；未存 artifact 明确报错', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    await runWindow(service, evidence, created.journey.id, () => {
      writeFileSync(join(repoRoot, 'b.ts'), 'B\nNEW\n')
    })
    const dto = evidence.listForJourney(created.journey.id)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    const file = end.files.find((row) => row.repo_relative_path === 'b.ts')!
    const baseline = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'baseline')!

    // 正常链路可读
    expect(evidence.readArtifact(created.journey.id, end.id, file.id).artifact.kind).toBe('diff')
    // 跨 Journey：另一个 Journey 拿同样的 snapshot/file id → 拒绝
    const other = createJourney(service, { workspaceId })
    expect(() => evidence.readArtifact(other.journey.id, end.id, file.id)).toThrow(/snapshot/)
    // 跨 Snapshot：file 不属于 baseline 快照 → 拒绝
    expect(() => evidence.readArtifact(created.journey.id, baseline.id, file.id)).toThrow(/snapshot/)
    // 无效 id
    expect(() => evidence.readArtifact(created.journey.id, randomUUID(), file.id)).toThrow(/snapshot/)
    expect(() => evidence.readArtifact(created.journey.id, end.id, randomUUID())).toThrow(/file/)

    // artifact_ref 为 NULL 的历史行 → 明确报错，绝不回空正文装成功
    const bare = insertSnapshotWithFiles(
      handle.db,
      {
        journeyId: created.journey.id,
        workspaceId,
        executionEventId: null,
        snapshotType: 'journey_final',
        triggerKey: `final:${randomUUID()}`,
        captureStatus: 'ok',
        comparisonStatus: 'complete',
        errorCode: null,
        capturedAt: Date.now(),
        repositoryIdentity: null,
        repositoryRootIdentifier: null,
        branch: null,
        headSha: null,
        treeSha: null,
        indexStateHash: null,
        worktreeStateHash: null,
        isGit: 0,
        isWorktree: 0,
        isSubmodule: 0,
        hasUnbornHead: 0,
        trackedCount: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        ignoredCount: 0,
        changedFilesCount: 1,
        insertions: 0,
        deletions: 0
      },
      [
        {
          repoRelativePath: 'bare.ts',
          changeKind: 'modified',
          statusOrigin: 'worktree',
          contentHashBefore: null,
          contentHashAfter: null,
          preExistingDirty: 0,
          headMoved: 0,
          renameFromPath: null,
          insertions: null,
          deletions: null,
          lineRanges: null,
          artifactRef: null, // 旧数据 / 未存正文
          attribution: null,
          attributionConfidence: null
        }
      ]
    )
    expect(bare.status).toBe('inserted')
    const bareId = bare.status === 'inserted' ? bare.id : ''
    const bareFile = fileRows(bareId)[0]
    expect(bareFile.artifactRef).toBeNull()
    expect(() => evidence.readArtifact(created.journey.id, bareId, bareFile.id)).toThrow(
      /no diff artifact/
    )
  })

  it('按需读取不回工作区、不执行 Git：resolveRoot / capture / compare 零调用', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    await runWindow(service, evidence, created.journey.id, () => {
      writeFileSync(join(repoRoot, 'a.ts'), 'A\nSPOTLIGHT\n')
    })
    const dto = evidence.listForJourney(created.journey.id)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    const file = end.files[0]

    const resolveSpy = vi.spyOn(workspaces, 'resolveRoot')
    const captureSpy = vi.spyOn(GitSnapshotEngine.prototype, 'capture')
    const compareSpy = vi.spyOn(GitSnapshotEngine.prototype, 'compare')
    try {
      rmSync(repoRoot, { recursive: true, force: true }) // 目录没了也照样读
      const artifact = evidence.readArtifact(created.journey.id, end.id, file.id)
      expect(artifact.artifact.kind).toBe('diff')
      expect(resolveSpy).not.toHaveBeenCalled()
      expect(captureSpy).not.toHaveBeenCalled()
      expect(compareSpy).not.toHaveBeenCalled()
    } finally {
      resolveSpy.mockRestore()
      captureSpy.mockRestore()
      compareSpy.mockRestore()
    }
  })
})

// MARK: - 2) Artifact 类型映射（真实 git）

describe('Artifact 类型映射与隐私（真实 git）', () => {
  it('全类型：diff / binary / sensitive / mode_only / symlink；证据特有排除（.git/**、*.p12）无正文', async () => {
    const typeRepo = join(dir, 'types')
    initRepo(typeRepo, {
      'a.ts': 'plain\n',
      'mode.ts': 'chmod me\n',
      'img.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      '.env': 'OLD=1\n',
      'cert.p12': 'old-container',
      'bigsecret.txt': 'nothing\n'
    })
    symlinkSync('a.ts', join(typeRepo, 'link'))
    git(['add', '-A', '.'], typeRepo)
    git(['commit', '-qm', 'add link'], typeRepo)
    const typeWorkspace = workspaces.add(typeRepo, 'ArtifactTypes').id

    const created = createJourney(service, { workspaceId: typeWorkspace })
    await evidence.flushPending()

    const planned = append(service, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'types'
    })
    const before = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: before.updatedAt
    })
    await evidence.flushPending()

    // 窗口内：每类各一
    writeFileSync(join(typeRepo, 'a.ts'), 'plain\nmodified for diff\n')
    writeFileSync(join(typeRepo, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 4, 5, 6]))
    writeFileSync(join(typeRepo, '.env'), 'NEW=2\n')
    writeFileSync(join(typeRepo, 'cert.p12'), 'new-container')
    chmodSync(join(typeRepo, 'mode.ts'), 0o755)
    rmSync(join(typeRepo, 'link'))
    symlinkSync('b.ts', join(typeRepo, 'link'))
    writeFileSync(join(typeRepo, 'bigsecret.txt'), 'nothing\nAPI_KEY=supersecretvalue12345\n')
    // 证据特有排除：.git 内部（config / hooks）——任何清单都不该出现
    const configPath = join(typeRepo, '.git/config')
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n# p4 tamper\n`)
    writeFileSync(join(typeRepo, '.git/hooks/pre-commit'), '#!/bin/sh\necho tamper\n')

    const running = selectEvent(handle.db, planned.event.id)!
    service.updateEventStatus({
      eventId: planned.event.id,
      status: 'completed',
      expectedUpdatedAt: running.updatedAt
    })
    await evidence.flushPending()

    const dto = evidence.listForJourney(created.journey.id)
    expect(journeyEvidenceSchema.safeParse(dto).success).toBe(true)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    const rowOf = (path: string) => end.files.find((file) => file.repo_relative_path === path)
    const artifactOf = (path: string) => {
      const row = rowOf(path)
      expect(row, `file row ${path}`).toBeDefined()
      return evidence.readArtifact(created.journey.id, end.id, row!.id).artifact
    }

    expect(rowOf('a.ts')?.artifact_kind).toBe('diff')
    expect(rowOf('img.bin')?.artifact_kind).toBe('binary')
    expect(rowOf('.env')?.artifact_kind).toBe('sensitive')
    expect(rowOf('cert.p12')?.artifact_kind).toBe('sensitive')
    expect(rowOf('mode.ts')?.artifact_kind).toBe('mode_only')
    expect(rowOf('link')?.artifact_kind).toBe('symlink')
    // .git 内部路径绝不进文件明细（先排除、后任何读取——不是展示层隐藏）
    expect(end.files.some((file) => file.repo_relative_path.startsWith('.git/'))).toBe(false)

    // 结构化读取：二进制 / 敏感没有正文；mode / symlink 给事实
    expect(artifactOf('img.bin')).toEqual({ kind: 'binary' })
    expect(artifactOf('.env')).toEqual({ kind: 'sensitive' })
    expect(artifactOf('cert.p12')).toEqual({ kind: 'sensitive' })
    const mode = artifactOf('mode.ts')
    expect(mode).toMatchObject({ kind: 'mode_only', mode_before: '100644', mode_after: '100755' })
    const link = artifactOf('link')
    expect(link.kind).toBe('symlink')
    if (link.kind === 'symlink') {
      expect(link.target_before).toBe('a.ts')
      expect(link.target_after).toBe('b.ts')
    }

    // Diff 正文经 redactSecrets：密钥不落库
    const diff = artifactOf('bigsecret.txt')
    expect(diff.kind).toBe('diff')
    if (diff.kind === 'diff') {
      expect(diff.text).not.toContain('supersecretvalue12345')
      expect(diff.text).toContain('[redacted]')
    }
    expect(JSON.stringify(dto)).not.toContain('supersecretvalue12345') // 列表同样干净
  })
})

// MARK: - 3) 容量限制（真实 git）

describe('容量限制（UTF-8 字节，真实 git）', () => {
  it('单文件 64 KB / 2000 行：正文省略、统计保留（omitted + file_budget）', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    await runWindow(service, evidence, created.journey.id, () => {
      const lines = ['A']
      for (let i = 0; i < 3_000; i += 1) lines.push(`line ${i} of the very long file`)
      writeFileSync(join(repoRoot, 'a.ts'), `${lines.join('\n')}\n`)
    })

    const dto = evidence.listForJourney(created.journey.id)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    const file = end.files.find((row) => row.repo_relative_path === 'a.ts')!
    expect(file.artifact_kind).toBe('over_budget')
    expect(file.artifact_status).toBe('omitted')
    expect(file.artifact_omission).toBe('file_budget')
    expect(file.insertions).toBeGreaterThanOrEqual(3_000) // 超预算仍保留统计

    const artifact = evidence.readArtifact(created.journey.id, end.id, file.id).artifact
    expect(artifact.kind).toBe('over_budget')
    if (artifact.kind === 'over_budget') {
      expect(artifact.reason).toBe('file_budget')
      expect(artifact.insertions).toBeGreaterThanOrEqual(3_000)
      expect(JSON.stringify(artifact)).not.toContain('line 0 of the very long file') // 无正文
    }
  })

  it('UTF-8 多字节按字节算：30,000 个汉字（90,000 字节 > 64 KB、字符数 30,000 < 64 KB）→ 省略', async () => {
    const multibyte = '你'.repeat(30_000)
    expect(multibyte.length).toBeLessThan(64 * 1024) // 若按字符数判定就会存正文
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    await runWindow(service, evidence, created.journey.id, () => {
      writeFileSync(join(repoRoot, 'a.ts'), multibyte)
    })

    const dto = evidence.listForJourney(created.journey.id)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    const file = end.files.find((row) => row.repo_relative_path === 'a.ts')!
    expect(file.artifact_omission).toBe('file_budget') // 按 UTF-8 字节判定 → 必须省略
    expect(file.artifact_status).toBe('omitted')
  })

  it('单快照 512 KB：后续文件只省略正文；已存正文总量不越界；统计与元数据齐全', async () => {
    const created = createJourney(service, { workspaceId })
    await evidence.flushPending()
    await runWindow(service, evidence, created.journey.id, () => {
      for (let i = 0; i < 10; i += 1) {
        writeFileSync(join(repoRoot, `big${i}.txt`), `${'x'.repeat(60_000)}-${i}\n`)
      }
    })

    const dto = evidence.listForJourney(created.journey.id)
    const end = dto.snapshots.find((snapshot) => snapshot.snapshot_type === 'execution_end')!
    const files = end.files.filter((row) => row.repo_relative_path.startsWith('big'))
    expect(files).toHaveLength(10)
    const omitted = files.filter((row) => row.artifact_omission === 'snapshot_budget')
    expect(omitted.length).toBeGreaterThanOrEqual(1) // 10 × 60 KB > 512 KB

    let stored = 0
    for (const row of files) {
      // 每一行都保留：路径、变化类型、统计（省略只省正文）
      expect(row.insertions).not.toBeNull()
      const artifact = evidence.readArtifact(created.journey.id, end.id, row.id).artifact
      if (artifact.kind === 'diff') stored += artifact.byte_size
      else expect(artifact.kind).toBe('over_budget')
    }
    expect(stored).toBeLessThanOrEqual(GIT_DIFF_MAX_BYTES_PER_SNAPSHOT)
    expect(stored).toBeGreaterThan(0) // 对照：确实存了正文，不是全省略
  })
})

// MARK: - 4) Journey 2 MB 与并发（stub 引擎，确定性）

describe('Journey 总量预算与并发（stub 引擎）', () => {
  it('5 个执行窗口累积超 2 MB → 新正文降级 journey_budget；总字节不越界；统计保留', async () => {
    const stub = makeStubEngine({ files: () => stubDiffs(8, 60_000) })
    const stubEvidence = new WorkspaceEvidenceService(handle.db, events, workspaces, stub)
    const stubService = new AgentJourneyService(handle.db, events, workspaces, stubEvidence)

    const created = createJourney(stubService, { workspaceId })
    await stubEvidence.flushPending()
    // 5 窗口 × 8 × ~60 KB ≈ 2.4 MB 需求 > 2 MB 预算
    for (let i = 0; i < 5; i += 1) {
      const planned = append(stubService, created.journey.id, {
        eventType: 'execution',
        status: 'planned',
        title: `w${i}`
      })
      const before = selectEvent(handle.db, planned.event.id)!
      stubService.updateEventStatus({
        eventId: planned.event.id,
        status: 'running',
        expectedUpdatedAt: before.updatedAt
      })
      const running = selectEvent(handle.db, planned.event.id)!
      stubService.updateEventStatus({
        eventId: planned.event.id,
        status: 'completed',
        expectedUpdatedAt: running.updatedAt
      })
    }
    await stubEvidence.flushPending()

    const storedBytes = journeyArtifactBytes(handle.db, created.journey.id)
    expect(storedBytes).toBeGreaterThan(1_500_000) // 对照：确实写了很多
    expect(storedBytes).toBeLessThanOrEqual(JOURNEY_LIMIT) // 硬闸门：不越界

    const dto = evidence.listForJourney(created.journey.id)
    const allFiles = dto.snapshots.flatMap((snapshot) => snapshot.files)
    const downgraded = allFiles.filter((row) => row.artifact_omission === 'journey_budget')
    expect(downgraded.length).toBeGreaterThanOrEqual(1)
    for (const row of downgraded) {
      expect(row.artifact_status).toBe('omitted')
      expect(row.insertions).not.toBeNull() // 统计保留（不写 0 冒充）
      expect(row.change_kind).toBe('modified') // 元数据一行不少
    }
    // 降级行按需读取 → 只有结构化 over_budget，没有正文
    const sample = downgraded[0]
    const owner = dto.snapshots.find((snapshot) =>
      snapshot.files.some((file) => file.id === sample.id)
    )!
    const artifact = evidence.readArtifact(created.journey.id, owner.id, sample.id).artifact
    expect(artifact.kind).toBe('over_budget')
    if (artifact.kind === 'over_budget') expect(artifact.reason).toBe('journey_budget')
  })

  it('并发写入不突破 Journey 总预算（两个服务实例交错写同一 Journey）', async () => {
    const evidenceA = new WorkspaceEvidenceService(
      handle.db,
      events,
      workspaces,
      makeStubEngine({ files: () => stubDiffs(8, 60_000), delay: true })
    )
    const evidenceB = new WorkspaceEvidenceService(
      handle.db,
      events,
      workspaces,
      makeStubEngine({ files: () => stubDiffs(8, 60_000), delay: true })
    )
    const serviceA = new AgentJourneyService(handle.db, events, workspaces, evidenceA)
    const serviceB = new AgentJourneyService(handle.db, events, workspaces, evidenceB)

    const created = createJourney(serviceA, { workspaceId })
    await evidenceA.flushPending()

    // 6 个窗口交替由两个实例驱动、中途不 flush → 两条队列真并发交错
    for (let i = 0; i < 6; i += 1) {
      const svc = i % 2 === 0 ? serviceA : serviceB
      const planned = append(svc, created.journey.id, {
        eventType: 'execution',
        status: 'planned',
        title: `race${i}`
      })
      const before = selectEvent(handle.db, planned.event.id)!
      svc.updateEventStatus({
        eventId: planned.event.id,
        status: 'running',
        expectedUpdatedAt: before.updatedAt
      })
      const running = selectEvent(handle.db, planned.event.id)!
      svc.updateEventStatus({
        eventId: planned.event.id,
        status: 'completed',
        expectedUpdatedAt: running.updatedAt
      })
    }
    await Promise.all([evidenceA.flushPending(), evidenceB.flushPending()])

    const storedBytes = journeyArtifactBytes(handle.db, created.journey.id)
    expect(storedBytes).toBeGreaterThan(1_500_000) // 交错确实发生了大量写入
    expect(storedBytes).toBeLessThanOrEqual(JOURNEY_LIMIT) // 预算事务内统计 → 无超额竞态
    const downgraded = evidence
      .listForJourney(created.journey.id)
      .snapshots.flatMap((snapshot) => snapshot.files)
      .filter((row) => row.artifact_omission === 'journey_budget')
    expect(downgraded.length).toBeGreaterThanOrEqual(1)
  })
})

// MARK: - 5) 写入失败不伪装成功

describe('Artifact 写入失败（stub 引擎）', () => {
  it('文件明细撞唯一键 → 事务整体回滚，快照标明确失败（constraint_unique），无半成品', async () => {
    const colliding = stubDiffs(2, 100).map((file) => ({ ...file, repo_relative_path: 'dup.txt' }))
    const stub = makeStubEngine({ files: () => colliding })
    const stubEvidence = new WorkspaceEvidenceService(handle.db, events, workspaces, stub)
    const stubService = new AgentJourneyService(handle.db, events, workspaces, stubEvidence)

    const created = createJourney(stubService, { workspaceId })
    await stubEvidence.flushPending()
    const planned = append(stubService, created.journey.id, {
      eventType: 'execution',
      status: 'planned',
      title: 'collision'
    })
    const before = selectEvent(handle.db, planned.event.id)!
    stubService.updateEventStatus({
      eventId: planned.event.id,
      status: 'running',
      expectedUpdatedAt: before.updatedAt
    })
    const running = selectEvent(handle.db, planned.event.id)!
    stubService.updateEventStatus({
      eventId: planned.event.id,
      status: 'completed',
      expectedUpdatedAt: running.updatedAt
    })
    await stubEvidence.flushPending()

    const end = rowsSync(created.journey.id).filter((row) => row.snapshotType === 'execution_end')
    expect(end).toHaveLength(1)
    expect(end[0].captureStatus).toBe('failed') // 绝不伪装成功
    expect(end[0].errorCode).toBe('constraint_unique') // 数据库错误 ≠ Git 采集失败
    expect(end[0].comparisonStatus).toBe('comparison_failed')
    expect(fileRows(end[0].id)).toHaveLength(0) // 无半成品文件行（主记录 + 明细一起回滚）
    // 相邻快照不受污染：start 行照常成功
    const start = rowsSync(created.journey.id).filter((row) => row.snapshotType === 'execution_start')
    expect(start).toHaveLength(1)
    expect(start[0].captureStatus).toBe('ok')
    // Journey 业务状态完全不受证据失败影响
    expect(selectEvent(handle.db, planned.event.id)!.status).toBe('completed')
  })
})
