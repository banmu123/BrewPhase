import { randomUUID } from 'node:crypto'
import type { Db } from '../../database/client'
import type { ApplicationEvents } from '../events/application-events'
import type { LocalWorkspaceService } from '../local-workspace/local-workspace-service'
import type { AgentJourneyStatus } from '../../database/repositories/agent-journeys'
import {
  insertSnapshot,
  insertSnapshotFiles,
  selectFilesForSnapshots,
  selectSnapshotsForJourney,
  selectSnapshotByTrigger,
  type EvidenceFileInsert
} from '../../database/repositories/agent-journey-evidence'
import type { JourneyEvidence } from '../../../shared/contracts/entities/agent-journey'
import { GitSnapshotEngine } from './git-snapshot-engine'
import type { GitFileDiff, GitWorkspaceSnapshot } from './git-snapshot-types'

/**
 * 工作区证据服务（R6-4.3.3，P3）：把 R6-4.3.2 的 Git Snapshot Engine
 * 接入 Agent Journey 生命周期，并把结果持久化到本地 SQLite。
 *
 * 边界：
 * - **触发方是 `AgentJourneyService`**（T1–T5，全部在事务提交之后调用）；
 *   本服务只负责采集、比较、落库——Journey 状态是真相，Snapshot 是附加证据。
 * - **fire-and-forget**：`collectXxx` 同步入队、异步执行，任何失败都折叠成
 *   失败快照或被队列吞掉，**绝不影响 Agent 的状态推进**。
 * - **per-workspace 串行队列**：同一 Workspace 的采集不交错；不同 Workspace
 *   可并发；上次失败不阻塞后续；完成后清理失效 Promise。
 * - 根目录只经 `LocalWorkspaceService.resolveRoot(workspaceId)` 取得——
 *   **不接受任何来自 MCP / Renderer / URL 的绝对路径**，也不把
 *   LocalWorkspaceService 的文件读取能力暴露给 Agent。
 * - 证据查询是**只读**的（`agent-journey:evidence`）；写入只发生在触发点。
 *
 * 内存态（重启即失，绝不假装可恢复）：
 * - `journeyBaselines`：每个 Journey 的 baseline 快照对象（含 baselineStore）；
 * - `executionStarts`：每个 Execution 的 start 快照对象。
 * 重启后**已持久化的行仍可查询**，但丢失的内存基线无法再比较——
 * 对应比较会明确写 `comparison_status='baseline_unavailable'`，
 * 绝不制造虚假的前后变化结果。
 */
/**
 * 证据采集出口（P3）：`AgentJourneyService` 在**事务提交之后**同步调用；
 * 实现方内部入队异步执行，**绝不阻塞、绝不向调用方抛出**。
 */
export type JourneyEvidenceCollector = {
  /** T1：创建 / 重新绑定后采集 baseline（version = journey.updated_at 绑定版本）。 */
  collectBaseline(journeyId: string, workspaceId: string, version: number): void
  /** T2：Execution 首次进入 running。 */
  collectExecutionStart(journeyId: string, workspaceId: string, eventId: string): void
  /** T3：Execution 离开 running（含取消路径的批量补采）。 */
  collectExecutionEnd(
    journeyId: string,
    workspaceId: string,
    eventIds: readonly string[]
  ): void
  /** T4/T5：Journey 到达最终状态（version = 转换后的 journey.updated_at）。 */
  collectJourneyFinal(
    journeyId: string,
    workspaceId: string,
    version: number,
    status: AgentJourneyStatus
  ): void
}

export class WorkspaceEvidenceService {
  private readonly engine: GitSnapshotEngine
  /** workspaceId → 队列尾 Promise（同 Workspace 串行）。 */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly journeyBaselines = new Map<string, GitWorkspaceSnapshot>()
  private readonly executionStarts = new Map<string, GitWorkspaceSnapshot>()

  constructor(
    private readonly db: Db,
    private readonly events: ApplicationEvents,
    private readonly workspaces: LocalWorkspaceService,
    /** 测试注入：替换引擎（gitPath/超时失败场景、串行门控）。 */
    engine?: GitSnapshotEngine
  ) {
    this.engine = engine ?? new GitSnapshotEngine()
  }

  // MARK: - 触发入口（同步；调用方保证已在事务提交之后）

  /** T1：Journey 创建 / 重新绑定后采集 baseline（trigger = 绑定版本）。 */
  collectBaseline(journeyId: string, workspaceId: string, version: number): void {
    this.enqueue(workspaceId, () =>
      this.runBaseline(journeyId, workspaceId, `baseline:${version}`)
    )
  }

  /** T2：Execution 首次进入 running。 */
  collectExecutionStart(journeyId: string, workspaceId: string, eventId: string): void {
    this.enqueue(workspaceId, () => this.runExecutionStart(journeyId, workspaceId, eventId))
  }

  /** T3：Execution 离开 running（含取消路径的批量补采）。 */
  collectExecutionEnd(
    journeyId: string,
    workspaceId: string,
    eventIds: readonly string[]
  ): void {
    if (eventIds.length === 0) return
    this.enqueue(workspaceId, () => this.runExecutionEnd(journeyId, workspaceId, eventIds))
  }

  /** T4/T5：Journey 到达最终状态（failed 可恢复 → 后续完成还能再采一次）。 */
  collectJourneyFinal(
    journeyId: string,
    workspaceId: string,
    version: number,
    status: AgentJourneyStatus
  ): void {
    this.enqueue(workspaceId, () =>
      this.runJourneyFinal(journeyId, workspaceId, `final:${version}`, status)
    )
  }

  // MARK: - 只读查询（IPC `agent-journey:evidence`）

  listForJourney(journeyId: string): JourneyEvidence {
    const snapshots = selectSnapshotsForJourney(this.db, journeyId)
    const files = selectFilesForSnapshots(
      this.db,
      snapshots.map((row) => row.id)
    )
    const filesBySnapshot = new Map<string, typeof files>()
    for (const file of files) {
      const list = filesBySnapshot.get(file.snapshotId) ?? []
      list.push(file)
      filesBySnapshot.set(file.snapshotId, list)
    }
    return {
      journey_id: journeyId,
      snapshots: snapshots.map((row) => ({
        id: row.id,
        journey_id: row.journeyId,
        workspace_id: row.workspaceId,
        execution_event_id: row.executionEventId,
        snapshot_type: row.snapshotType,
        trigger_key: row.triggerKey,
        capture_status: row.captureStatus,
        comparison_status: row.comparisonStatus,
        error_code: row.errorCode,
        captured_at: row.capturedAt,
        repository_identity: row.repositoryIdentity,
        repository_root_identifier: row.repositoryRootIdentifier,
        branch: row.branch,
        head_sha: row.headSha,
        tree_sha: row.treeSha,
        index_state_hash: row.indexStateHash,
        worktree_state_hash: row.worktreeStateHash,
        is_git: row.isGit === 1,
        is_worktree: row.isWorktree === 1,
        is_submodule: row.isSubmodule === 1,
        has_unborn_head: row.hasUnbornHead === 1,
        counts: {
          tracked: row.trackedCount,
          staged: row.stagedCount,
          unstaged: row.unstagedCount,
          untracked: row.untrackedCount,
          ignored: row.ignoredCount
        },
        changed_files_count: row.changedFilesCount,
        insertions: row.insertions,
        deletions: row.deletions,
        files: (filesBySnapshot.get(row.id) ?? []).map((file) => ({
          repo_relative_path: file.repoRelativePath,
          change_kind: file.changeKind,
          status_origin: file.statusOrigin,
          content_hash_before: file.contentHashBefore,
          content_hash_after: file.contentHashAfter,
          pre_existing_dirty: file.preExistingDirty === 1,
          head_moved: file.headMoved === 1,
          rename_from_path: file.renameFromPath,
          insertions: file.insertions,
          deletions: file.deletions,
          line_ranges: file.lineRanges,
          artifact_ref: file.artifactRef,
          attribution: file.attribution,
          attribution_confidence: file.attributionConfidence
        }))
      }))
    }
  }

  /** 等待队列排空（测试与优雅退出用；生产触发路径不 await）。 */
  async flushPending(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()])
    }
  }

  // MARK: - 队列（§三.1）

  /**
   * per-workspace 串行：同一 Workspace 依次执行、不同 Workspace 并发；
   * 上一次失败不阻塞后续（next 永不 reject，不产生未处理拒绝）；
   * 完成后若仍是队尾则清理——不永久保留失效 Promise。
   */
  private enqueue(workspaceId: string, task: () => Promise<void>): void {
    const prev = this.queues.get(workspaceId) ?? Promise.resolve()
    const next = prev.then(task).catch(() => undefined)
    this.queues.set(workspaceId, next)
    void next.then(() => {
      if (this.queues.get(workspaceId) === next) this.queues.delete(workspaceId)
    })
  }

  // MARK: - 四个采集任务（均在队列内串行执行）

  private async runBaseline(
    journeyId: string,
    workspaceId: string,
    triggerKey: string
  ): Promise<void> {
    try {
      // 幂等前置：同 trigger 已采过 → 连 git 都不跑（唯一索引是兜底）
      if (selectSnapshotByTrigger(this.db, journeyId, triggerKey)) return
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        this.persistFailure({
          journeyId,
          workspaceId,
          executionEventId: null,
          snapshotType: 'baseline',
          triggerKey,
          errorCode: 'workspace_unavailable',
          comparisonStatus: 'not_applicable'
        })
        this.emitEvidenceChanged()
        return
      }
      const snapshot = await this.engine.capture(root)
      const inserted = insertSnapshot(this.db, {
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'baseline',
        triggerKey,
        // baseline 是参照物：本身不做比较（0 是「未比较」的真话，由状态列解释）
        comparisonStatus: 'not_applicable',
        changedFilesCount: 0,
        insertions: 0,
        deletions: 0,
        ...this.snapshotFields(snapshot)
      })
      if (inserted && snapshot.capture_status === 'ok') {
        // 内存基线：供后续 execution_end / journey_final 比较（重启即失）
        this.journeyBaselines.set(journeyId, snapshot)
      }
      this.emitEvidenceChanged()
    } catch {
      this.safeFailure({
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'baseline',
        triggerKey,
        errorCode: 'internal_error',
        comparisonStatus: 'not_applicable'
      })
    }
  }

  private async runExecutionStart(
    journeyId: string,
    workspaceId: string,
    eventId: string
  ): Promise<void> {
    const triggerKey = `start:${eventId}`
    try {
      if (selectSnapshotByTrigger(this.db, journeyId, triggerKey)) return
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        this.persistFailure({
          journeyId,
          workspaceId,
          executionEventId: eventId,
          snapshotType: 'execution_start',
          triggerKey,
          errorCode: 'workspace_unavailable',
          comparisonStatus: 'not_applicable'
        })
        this.emitEvidenceChanged()
        return
      }
      const snapshot = await this.engine.capture(root)
      const inserted = insertSnapshot(this.db, {
        journeyId,
        workspaceId,
        executionEventId: eventId,
        snapshotType: 'execution_start',
        triggerKey,
        comparisonStatus: 'not_applicable', // 窗口起点本身不比较
        changedFilesCount: 0,
        insertions: 0,
        deletions: 0,
        ...this.snapshotFields(snapshot)
      })
      if (inserted && snapshot.capture_status === 'ok') {
        this.executionStarts.set(eventId, snapshot)
      }
      this.emitEvidenceChanged()
    } catch {
      this.safeFailure({
        journeyId,
        workspaceId,
        executionEventId: eventId,
        snapshotType: 'execution_start',
        triggerKey,
        errorCode: 'internal_error',
        comparisonStatus: 'not_applicable'
      })
    }
  }

  private async runExecutionEnd(
    journeyId: string,
    workspaceId: string,
    eventIds: readonly string[]
  ): Promise<void> {
    const pending = [
      ...new Set(eventIds)
    ].filter((eventId) => !selectSnapshotByTrigger(this.db, journeyId, `end:${eventId}`))
    if (pending.length === 0) return
    try {
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        for (const eventId of pending) {
          this.persistFailure({
            journeyId,
            workspaceId,
            executionEventId: eventId,
            snapshotType: 'execution_end',
            triggerKey: `end:${eventId}`,
            errorCode: 'workspace_unavailable',
            comparisonStatus: 'comparison_failed'
          })
        }
        this.emitEvidenceChanged()
        return
      }
      // 同一转换窗口只采一次：N 个被取消的执行共享同一观察时刻
      const current = await this.engine.capture(root)
      for (const eventId of pending) {
        const start = this.executionStarts.get(eventId)
        let comparisonStatus: 'complete' | 'partial' | 'baseline_unavailable' | 'comparison_failed'
        let files: EvidenceFileInsert[] = []
        let changedFiles = 0
        let insertions = 0
        let deletions = 0
        if (current.capture_status !== 'ok') {
          comparisonStatus = 'comparison_failed'
        } else if (!start) {
          // 重启后 start 快照的内存对象已失 → 明确标记，绝不伪造比较
          comparisonStatus = 'baseline_unavailable'
        } else {
          const diff = await this.engine.compare(start, current)
          if (diff.status !== 'ok') {
            comparisonStatus = 'comparison_failed'
          } else {
            comparisonStatus =
              diff.manifest_completeness === 'complete' ? 'complete' : 'partial'
            files = diff.files.map(toFileInsert)
            changedFiles = diff.stats.changed_files
            insertions = diff.stats.insertions_total
            deletions = diff.stats.deletions_total
          }
        }
        const rowId = randomUUID()
        const inserted = insertSnapshot(this.db, {
          id: rowId,
          journeyId,
          workspaceId,
          executionEventId: eventId,
          snapshotType: 'execution_end',
          triggerKey: `end:${eventId}`,
          comparisonStatus,
          changedFilesCount: changedFiles,
          insertions,
          deletions,
          ...this.snapshotFields(current)
        })
        if (inserted && files.length > 0) insertSnapshotFiles(this.db, rowId, files)
        this.executionStarts.delete(eventId) // 窗口关闭，释放内存
      }
      this.emitEvidenceChanged()
    } catch {
      this.safeFailure({
        journeyId,
        workspaceId,
        executionEventId: pending[0] ?? null,
        snapshotType: 'execution_end',
        triggerKey: `end:${pending[0]}`,
        errorCode: 'internal_error',
        comparisonStatus: 'comparison_failed'
      })
    }
  }

  private async runJourneyFinal(
    journeyId: string,
    workspaceId: string,
    triggerKey: string,
    status: AgentJourneyStatus
  ): Promise<void> {
    try {
      if (selectSnapshotByTrigger(this.db, journeyId, triggerKey)) return
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        this.persistFailure({
          journeyId,
          workspaceId,
          executionEventId: null,
          snapshotType: 'journey_final',
          triggerKey,
          errorCode: 'workspace_unavailable',
          comparisonStatus: 'comparison_failed'
        })
        this.emitEvidenceChanged()
        return
      }
      const current = await this.engine.capture(root)
      const baseline = this.journeyBaselines.get(journeyId)
      let comparisonStatus: 'complete' | 'partial' | 'baseline_unavailable' | 'comparison_failed'
      let files: EvidenceFileInsert[] = []
      let changedFiles = 0
      let insertions = 0
      let deletions = 0
      if (current.capture_status !== 'ok') {
        comparisonStatus = 'comparison_failed'
      } else if (!baseline) {
        // 重启后内存基线已失：可以采集当前状态，但不做假比较
        comparisonStatus = 'baseline_unavailable'
      } else {
        const diff = await this.engine.compare(baseline, current)
        if (diff.status !== 'ok') {
          comparisonStatus = 'comparison_failed'
        } else {
          comparisonStatus = diff.manifest_completeness === 'complete' ? 'complete' : 'partial'
          files = diff.files.map(toFileInsert)
          changedFiles = diff.stats.changed_files
          insertions = diff.stats.insertions_total
          deletions = diff.stats.deletions_total
        }
      }
      const rowId = randomUUID()
      const inserted = insertSnapshot(this.db, {
        id: rowId,
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'journey_final',
        triggerKey,
        comparisonStatus,
        changedFilesCount: changedFiles,
        insertions,
        deletions,
        ...this.snapshotFields(current)
      })
      if (inserted && files.length > 0) insertSnapshotFiles(this.db, rowId, files)
      // 真终态释放内存基线；failed 可恢复（failed→running→completed）→ 保留
      if (status === 'completed' || status === 'cancelled') {
        this.journeyBaselines.delete(journeyId)
      }
      this.emitEvidenceChanged()
    } catch {
      this.safeFailure({
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'journey_final',
        triggerKey,
        errorCode: 'internal_error',
        comparisonStatus: 'comparison_failed'
      })
    }
  }

  // MARK: - 内部工具

  /** 授权根目录：只经 LocalWorkspaceService；拿不到（已删/失效）→ null。 */
  private rootOrNull(workspaceId: string): string | null {
    try {
      return this.workspaces.resolveRoot(workspaceId)
    } catch {
      return null
    }
  }

  /** 引擎快照 → 快照行字段（根目录不可得时 identity 两列为 NULL，绝不存路径）。 */
  private snapshotFields(snapshot: GitWorkspaceSnapshot) {
    const identityUnavailable = snapshot.error_code === 'root_unavailable'
    return {
      captureStatus: snapshot.capture_status,
      errorCode: snapshot.error_code,
      capturedAt: snapshot.captured_at,
      repositoryIdentity: identityUnavailable ? null : snapshot.repository_identity,
      repositoryRootIdentifier: identityUnavailable
        ? null
        : snapshot.repository_root_identifier,
      branch: snapshot.branch,
      headSha: snapshot.head_sha,
      treeSha: snapshot.tree_sha,
      indexStateHash: snapshot.index_state_hash,
      worktreeStateHash: snapshot.worktree_state_hash,
      isGit: snapshot.is_git ? 1 : 0,
      isWorktree: snapshot.is_worktree ? 1 : 0,
      isSubmodule: snapshot.is_submodule ? 1 : 0,
      hasUnbornHead: snapshot.has_unborn_head ? 1 : 0,
      trackedCount: snapshot.counts.tracked,
      stagedCount: snapshot.counts.staged,
      unstagedCount: snapshot.counts.unstaged,
      untrackedCount: snapshot.counts.untracked,
      ignoredCount: snapshot.counts.ignored
    }
  }

  /** 采集根本拿不到（目录被删/失效）→ 明确的失败快照，绝不写「零变化」。 */
  private persistFailure(input: {
    journeyId: string
    workspaceId: string
    executionEventId: string | null
    snapshotType: string
    triggerKey: string
    errorCode: string
    comparisonStatus: string
  }): void {
    insertSnapshot(this.db, {
      journeyId: input.journeyId,
      workspaceId: input.workspaceId,
      executionEventId: input.executionEventId,
      snapshotType: input.snapshotType,
      triggerKey: input.triggerKey,
      captureStatus: 'failed',
      comparisonStatus: input.comparisonStatus,
      errorCode: input.errorCode,
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
      changedFilesCount: 0,
      insertions: 0,
      deletions: 0
    })
  }

  /** 意外异常的兜底：尽力落一条失败快照，绝不向 Journey 主流程抛出。 */
  private safeFailure(input: Parameters<WorkspaceEvidenceService['persistFailure']>[0]): void {
    try {
      this.persistFailure(input)
      this.emitEvidenceChanged()
    } catch {
      // 连失败行都写不进就算了——队列已吞掉，Journey 不受影响
    }
  }

  /** 证据有变化 → 复用 `agentJourneys` domain 广播（不新建 domain）。 */
  private emitEvidenceChanged(): void {
    this.events.emit('agentJourneys')
  }
}

/** 文件级摘要 → 仓储输入（P4 字段恒 NULL，不伪造）。 */
function toFileInsert(diff: GitFileDiff): EvidenceFileInsert {
  return {
    repoRelativePath: diff.repo_relative_path,
    changeKind: diff.change_kind,
    statusOrigin: diff.status_origin,
    contentHashBefore: diff.content_hash_before,
    contentHashAfter: diff.content_hash_after,
    preExistingDirty: diff.pre_existing_dirty ? 1 : 0,
    headMoved: diff.head_moved ? 1 : 0,
    renameFromPath: diff.rename_from_path,
    insertions: diff.insertions,
    deletions: diff.deletions,
    lineRanges: null, // P4 展开
    artifactRef: null, // P4 的 Diff 数据位置
    attribution: null, // P4 统一计算
    attributionConfidence: null
  }
}
