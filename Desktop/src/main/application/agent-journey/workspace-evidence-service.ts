import { randomUUID } from 'node:crypto'
import type { Db } from '../../database/client'
import type { ApplicationEvents } from '../events/application-events'
import type { LocalWorkspaceService } from '../local-workspace/local-workspace-service'
import type { AgentJourneyStatus } from '../../database/repositories/agent-journeys'
import {
  EvidenceConstraintError,
  failSnapshot,
  finalizeSnapshot,
  insertSnapshot,
  insertSnapshotWithFiles,
  selectFilesForSnapshots,
  selectPendingSnapshots,
  selectSnapshotsForJourney,
  selectSnapshotByTrigger,
  type EvidenceFileInsert,
  type EvidenceSnapshotPatch
} from '../../database/repositories/agent-journey-evidence'
import type { JourneyEvidence } from '../../../shared/contracts/entities/agent-journey'
import { GitSnapshotEngine } from './git-snapshot-engine'
import type { GitFileDiff, GitWorkspaceSnapshot } from './git-snapshot-types'

/**
 * 工作区证据服务（R6-4.3.3 → 收尾 R6-4.3.3.1，P3）：把 R6-4.3.2 的
 * Git Snapshot Engine 接入 Agent Journey 生命周期，并把结果持久化到本地 SQLite。
 *
 * 边界（继承 P3）：
 * - **触发方是 `AgentJourneyService`**（T1–T5，全部在事务提交之后调用）；
 *   本服务只负责采集、比较、落库——Journey 状态是真相，Snapshot 是附加证据。
 * - **fire-and-forget**：`collectXxx` 同步**预留 pending 行**、入队异步执行，
 *   任何失败都折叠成明确失败行或被队列吞掉，**绝不影响 Agent 的状态推进**。
 * - **per-workspace 串行队列**：同一 Workspace 的采集不交错；不同 Workspace
 *   可并发；上次失败不阻塞后续；完成后清理失效 Promise。
 * - 根目录只经 `LocalWorkspaceService.resolveRoot(workspaceId)` 取得——
 *   **不接受任何来自 MCP / Renderer / URL 的绝对路径**，也不把
 *   LocalWorkspaceService 的文件读取能力暴露给 Agent。
 *
 * 可靠性不变量（R6-4.3.3.1 的核心验收）——**无论正常完成、采集失败、
 * Workspace 删除、应用退出或重启，都不得把未完成的证据伪装成完整成功，
 * 也不得静默丢失已经发生过的采集尝试**：
 * - **预留**：每个触发入口在入队时同步写一条 `capture_status='pending'` 的
 *   快照行（Journey 事务提交之后；预留失败只降级、绝不回滚 Journey）。
 * - **原子终结**：采集成功后，主记录更新与全部文件明细在**同一个事务**里提交。
 * - **单向闸门**：pending → 最终状态；已终结的行永不被覆盖（'stale' 返回）。
 * - **失败折叠**：采集失败 / DB 写入失败 / 意外异常各记各的 error_code——
 *   数据库写入失败绝不等价成 Git 采集失败。
 * - **中断恢复**：进程死亡遗留的 pending 行，下次启动由
 *   `recoverInterruptedCaptures()` 统一标 `failed + capture_interrupted`。
 * - **退出封写**：`beginShutdown()` 之后不再产生任何有效写入——
 *   DB 关闭后绝不允许异步任务继续落数据。
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

/** 同步预留的结果：duplicate → 该触发已有行（不入队、不覆盖）；unreserved → 预留失败但仍入队。 */
type Reservation = { rowId: string | null; skip: boolean }

type ComparisonOutcome = 'complete' | 'partial' | 'baseline_unavailable' | 'comparison_failed'

type PendingFailure = {
  rowId: string | null
  journeyId: string
  workspaceId: string
  executionEventId: string | null
  snapshotType: string
  triggerKey: string
  errorCode: string
  comparisonStatus: string
}

const ZERO_STATS: { changedFiles: number; insertions: number; deletions: number } = {
  changedFiles: 0,
  insertions: 0,
  deletions: 0
}

export class WorkspaceEvidenceService {
  private readonly engine: GitSnapshotEngine
  /** workspaceId → 队列尾 Promise（同 Workspace 串行）。 */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly journeyBaselines = new Map<string, GitWorkspaceSnapshot>()
  private readonly executionStarts = new Map<string, GitWorkspaceSnapshot>()
  /** 退出/关库前置位：之后不入队、不写库（遗留 pending 交给下次启动标 interrupted）。 */
  private closed = false

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
    if (this.closed) return
    const triggerKey = `baseline:${version}`
    const { rowId, skip } = this.reserve({
      journeyId,
      workspaceId,
      executionEventId: null,
      snapshotType: 'baseline',
      triggerKey
    })
    if (skip) return
    this.enqueue(workspaceId, () => this.runBaseline(journeyId, workspaceId, triggerKey, rowId))
  }

  /** T2：Execution 首次进入 running。 */
  collectExecutionStart(journeyId: string, workspaceId: string, eventId: string): void {
    if (this.closed) return
    const triggerKey = `start:${eventId}`
    const { rowId, skip } = this.reserve({
      journeyId,
      workspaceId,
      executionEventId: eventId,
      snapshotType: 'execution_start',
      triggerKey
    })
    if (skip) return
    this.enqueue(workspaceId, () =>
      this.runExecutionStart(journeyId, workspaceId, eventId, triggerKey, rowId)
    )
  }

  /** T3：Execution 离开 running（含取消路径的批量补采）。 */
  collectExecutionEnd(
    journeyId: string,
    workspaceId: string,
    eventIds: readonly string[]
  ): void {
    if (this.closed) return
    const ids = [...new Set(eventIds)]
    if (ids.length === 0) return
    // 每个 eventId 各预留一行（§六：失败隔离的落点就是各自的行）
    const rowIds = new Map<string, string | null>()
    for (const eventId of ids) {
      const { rowId, skip } = this.reserve({
        journeyId,
        workspaceId,
        executionEventId: eventId,
        snapshotType: 'execution_end',
        triggerKey: `end:${eventId}`
      })
      if (skip) continue
      rowIds.set(eventId, rowId)
    }
    if (rowIds.size === 0) return
    this.enqueue(workspaceId, () =>
      this.runExecutionEnd(journeyId, workspaceId, [...rowIds.keys()], rowIds)
    )
  }

  /** T4/T5：Journey 到达最终状态（failed 可恢复 → 后续完成还能再采一次）。 */
  collectJourneyFinal(
    journeyId: string,
    workspaceId: string,
    version: number,
    status: AgentJourneyStatus
  ): void {
    if (this.closed) return
    const triggerKey = `final:${version}`
    const { rowId, skip } = this.reserve({
      journeyId,
      workspaceId,
      executionEventId: null,
      snapshotType: 'journey_final',
      triggerKey
    })
    if (skip) return
    this.enqueue(workspaceId, () =>
      this.runJourneyFinal(journeyId, workspaceId, triggerKey, status, rowId)
    )
  }

  // MARK: - 生命周期（启动恢复 / 退出）

  /**
   * 启动恢复（§五.4）：上个会话（崩溃 / 超时退出）遗留的 pending 行统一标
   * `failed + error_code='capture_interrupted'`——如实记录「这次采集发生过、
   * 但没完成」，不伪造快照内容、不恢复已丢失的内存 baselineStore。
   *
   * comparison_status 按任务类型给明确的不可比较状态：
   * baseline / execution_start → `not_applicable`；
   * execution_end / journey_final → `comparison_failed`（比较确实没有发生）。
   *
   * 后续若要重建 baseline，必须走新的触发版本（新的 updated_at → 新
   * trigger_key），绝不复用被标 interrupted 的旧键假装完成。
   *
   * @returns 本次被标记的行数。
   */
  recoverInterruptedCaptures(): number {
    let recovered = 0
    try {
      for (const row of selectPendingSnapshots(this.db)) {
        try {
          const outcome = failSnapshot(this.db, row.id, {
            captureStatus: 'failed',
            comparisonStatus:
              row.snapshotType === 'execution_end' || row.snapshotType === 'journey_final'
                ? 'comparison_failed'
                : 'not_applicable',
            errorCode: 'capture_interrupted',
            capturedAt: Date.now()
          })
          if (outcome === 'updated') recovered += 1
        } catch (error) {
          // 单行标记失败不阻断启动：它仍是 pending，下次启动会再试。
          console.error('[workspace-evidence] mark interrupted capture failed', error)
        }
      }
      if (recovered > 0) this.emitEvidenceChanged()
    } catch (error) {
      // 恢复扫描整体失败也绝不阻断启动（库本身已通过 openDatabase 的迁移校验）。
      console.error('[workspace-evidence] recover interrupted captures failed', error)
      return 0
    }
    return recovered
  }

  /**
   * 退出 / 关库前调用（§五.5）：之后不再入队、不再写库。
   * 队列里还没跑完的任务会在写入前被拦下——对应行保持 `pending`，
   * 由下次启动的 `recoverInterruptedCaptures()` 标 `capture_interrupted`，
   * **绝不让异步任务在 DB 关闭后继续产生有效写入、也不把残缺结果伪装成完成**。
   */
  beginShutdown(): void {
    this.closed = true
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

  // MARK: - 队列与预留（§三.1 / §五.1）

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

  /**
   * 同步预留 pending 快照行（§五.1）——在 Journey 业务事务提交之后调用。
   *
   * - `Workspace 已删除 → workspace_id 置 NULL`（§四.1/2）：`get()` 只查库、
   *   不碰文件系统，登记不存在就写 NULL，绝不让 FK 失败吞掉这次采集尝试；
   * - 同 trigger 已有行（completed/failed/pending）→ `skip`：
   *   **同一触发不多条 pending、已终结的行不被覆盖**；
   * - 预留本身失败（库异常）→ 降级为「无预留行」任务照常入队：
   *   **预留失败绝不回滚 Journey**，采集尝试不因预留故障而静默丢失。
   */
  private reserve(input: {
    journeyId: string
    workspaceId: string
    executionEventId: string | null
    snapshotType: string
    triggerKey: string
  }): Reservation {
    try {
      // get() 只查库、不碰文件系统；整体包在 try 里——预留链路的任何异常
      // 都只降级为「无预留行」，绝不向 Journey 主流程抛出。
      const workspaceId = this.workspaces.get(input.workspaceId) ? input.workspaceId : null
      const result = insertSnapshot(this.db, {
        ...input,
        workspaceId,
        captureStatus: 'pending', // 预留状态：已发生、尚未完成
        comparisonStatus: 'not_applicable', // 预留阶段还没有可声明的比较结果
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
        changedFilesCount: 0,
        insertions: 0,
        deletions: 0
      })
      if (result.status === 'duplicate') return { rowId: null, skip: true }
      return { rowId: result.id, skip: false }
    } catch {
      return { rowId: null, skip: false }
    }
  }

  // MARK: - 四个采集任务（均在队列内串行执行）

  private async runBaseline(
    journeyId: string,
    workspaceId: string,
    triggerKey: string,
    rowId: string | null
  ): Promise<void> {
    try {
      // 无预留行的兜底防重（有预留行时由唯一键 + 状态闸门兜底）
      if (rowId === null && selectSnapshotByTrigger(this.db, journeyId, triggerKey)) return
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        this.markFailed({
          rowId,
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
      const written = this.finalize({
        rowId,
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'baseline',
        triggerKey,
        // baseline 是参照物：本身不做比较（0 是「未比较」的真话，由状态列解释）
        comparisonStatus: 'not_applicable',
        snapshot,
        stats: ZERO_STATS,
        files: []
      })
      if (written && snapshot.capture_status === 'ok') {
        // 内存基线：供后续 execution_end / journey_final 比较（重启即失）
        this.journeyBaselines.set(journeyId, snapshot)
      }
      this.emitEvidenceChanged()
    } catch (error) {
      this.markFailed({
        rowId,
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'baseline',
        triggerKey,
        errorCode: this.errorCodeOf(error),
        comparisonStatus: 'not_applicable'
      })
      this.emitEvidenceChanged()
    }
  }

  private async runExecutionStart(
    journeyId: string,
    workspaceId: string,
    eventId: string,
    triggerKey: string,
    rowId: string | null
  ): Promise<void> {
    try {
      if (rowId === null && selectSnapshotByTrigger(this.db, journeyId, triggerKey)) return
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        this.markFailed({
          rowId,
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
      const written = this.finalize({
        rowId,
        journeyId,
        workspaceId,
        executionEventId: eventId,
        snapshotType: 'execution_start',
        triggerKey,
        comparisonStatus: 'not_applicable', // 窗口起点本身不比较
        snapshot,
        stats: ZERO_STATS,
        files: []
      })
      if (written && snapshot.capture_status === 'ok') {
        this.executionStarts.set(eventId, snapshot)
      }
      this.emitEvidenceChanged()
    } catch (error) {
      this.markFailed({
        rowId,
        journeyId,
        workspaceId,
        executionEventId: eventId,
        snapshotType: 'execution_start',
        triggerKey,
        errorCode: this.errorCodeOf(error),
        comparisonStatus: 'not_applicable'
      })
      this.emitEvidenceChanged()
    }
  }

  /**
   * Execution 离开 running（§六）：一次取消多个 running 执行时**共用一次**
   * current capture，但各 Execution 的比较与持久化**独立**——单条失败只写
   * 自己那条 trigger 的失败行，绝不污染已成功持久化的邻居；
   * 每个 eventId 最终必有一条 execution_end 结果（成功或明确失败）。
   */
  private async runExecutionEnd(
    journeyId: string,
    workspaceId: string,
    eventIds: readonly string[],
    rowIds: ReadonlyMap<string, string | null>
  ): Promise<void> {
    // 无预留行的事件补做幂等前置；有预留行的由唯一键 + 状态闸门兜底
    const ids = eventIds.filter((eventId) => {
      const reserved = rowIds.get(eventId)
      if (reserved !== undefined && reserved !== null) return true
      return !selectSnapshotByTrigger(this.db, journeyId, `end:${eventId}`)
    })
    if (ids.length === 0) return

    const failOne = (eventId: string, errorCode: string): void => {
      this.markFailed({
        rowId: rowIds.get(eventId) ?? null,
        journeyId,
        workspaceId,
        executionEventId: eventId,
        snapshotType: 'execution_end',
        triggerKey: `end:${eventId}`,
        errorCode,
        comparisonStatus: 'comparison_failed'
      })
    }

    try {
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        for (const eventId of ids) {
          failOne(eventId, 'workspace_unavailable')
          // 窗口真实存在过、现已结束（终态已到）：释放 start 快照，不泄漏内存
          this.executionStarts.delete(eventId)
        }
        this.emitEvidenceChanged()
        return
      }
      // 同一转换窗口只采一次：N 个被取消的执行共享同一观察时刻
      const current = await this.engine.capture(root)
      for (const eventId of ids) {
        try {
          const start = this.executionStarts.get(eventId)
          let comparisonStatus: ComparisonOutcome
          let files: EvidenceFileInsert[] = []
          let stats = ZERO_STATS
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
              stats = {
                changedFiles: diff.stats.changed_files,
                insertions: diff.stats.insertions_total,
                deletions: diff.stats.deletions_total
              }
            }
          }
          this.finalize({
            rowId: rowIds.get(eventId) ?? null,
            journeyId,
            workspaceId,
            executionEventId: eventId,
            snapshotType: 'execution_end',
            triggerKey: `end:${eventId}`,
            comparisonStatus,
            snapshot: current,
            stats,
            files
          })
        } catch (error) {
          // 单条隔离：只更新它自己的 trigger 行（已成功的行有 'stale' 闸门保护）
          failOne(eventId, this.errorCodeOf(error))
        } finally {
          // 窗口真正结束：成功或异常都释放 start 快照，防止长期泄漏（§六.7）
          this.executionStarts.delete(eventId)
        }
      }
      this.emitEvidenceChanged()
    } catch (error) {
      // current capture 本身异常（引擎契约外）→ 每个 eventId 各自落明确失败行
      for (const eventId of ids) {
        failOne(eventId, this.errorCodeOf(error))
        this.executionStarts.delete(eventId)
      }
      this.emitEvidenceChanged()
    }
  }

  private async runJourneyFinal(
    journeyId: string,
    workspaceId: string,
    triggerKey: string,
    status: AgentJourneyStatus,
    rowId: string | null
  ): Promise<void> {
    try {
      if (rowId === null && selectSnapshotByTrigger(this.db, journeyId, triggerKey)) return
      const root = this.rootOrNull(workspaceId)
      if (root === null) {
        this.markFailed({
          rowId,
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
      let comparisonStatus: ComparisonOutcome
      let files: EvidenceFileInsert[] = []
      let stats = ZERO_STATS
      if (current.capture_status !== 'ok') {
        comparisonStatus = 'comparison_failed'
      } else if (!baseline) {
        // 重启后内存基线已失（含被标 capture_interrupted 的 baseline）：
        // 可以采集当前状态，但不做假比较
        comparisonStatus = 'baseline_unavailable'
      } else {
        const diff = await this.engine.compare(baseline, current)
        if (diff.status !== 'ok') {
          comparisonStatus = 'comparison_failed'
        } else {
          comparisonStatus = diff.manifest_completeness === 'complete' ? 'complete' : 'partial'
          files = diff.files.map(toFileInsert)
          stats = {
            changedFiles: diff.stats.changed_files,
            insertions: diff.stats.insertions_total,
            deletions: diff.stats.deletions_total
          }
        }
      }
      const written = this.finalize({
        rowId,
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'journey_final',
        triggerKey,
        comparisonStatus,
        snapshot: current,
        stats,
        files
      })
      // 真终态释放内存基线；failed 可恢复（failed→running→completed）→ 保留
      if (written && (status === 'completed' || status === 'cancelled')) {
        this.journeyBaselines.delete(journeyId)
      }
      this.emitEvidenceChanged()
    } catch (error) {
      this.markFailed({
        rowId,
        journeyId,
        workspaceId,
        executionEventId: null,
        snapshotType: 'journey_final',
        triggerKey,
        errorCode: this.errorCodeOf(error),
        comparisonStatus: 'comparison_failed'
      })
      this.emitEvidenceChanged()
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

  /**
   * 写入时的 workspace 引用核验（只查库，不碰文件系统）：
   * 登记刚被删除 → NULL（FK 合法，且历史不该随删除消失）。
   */
  private liveWorkspaceId(workspaceId: string): string | null {
    return this.workspaces.get(workspaceId) ? workspaceId : null
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

  /**
   * 原子终结（§二.2 / §五.2）：**整个事务成功才认为持久化完成**——
   * pending 行更新与文件明细同生共死；DB 写入失败向上抛（由调用方标明确失败）。
   *
   * 退出中（closed）不写：行保持 pending → 下次启动标 capture_interrupted。
   *
   * @returns 是否真正写入（'stale' = 行已被终结 / 已关库 → 不覆盖、不算成功）。
   */
  private finalize(input: {
    rowId: string | null
    journeyId: string
    workspaceId: string
    executionEventId: string | null
    snapshotType: string
    triggerKey: string
    comparisonStatus: string
    snapshot: GitWorkspaceSnapshot
    stats: { changedFiles: number; insertions: number; deletions: number }
    files: EvidenceFileInsert[]
  }): boolean {
    if (this.closed) return false
    const patch: EvidenceSnapshotPatch = {
      ...this.snapshotFields(input.snapshot),
      comparisonStatus: input.comparisonStatus,
      changedFilesCount: input.stats.changedFiles,
      insertions: input.stats.insertions,
      deletions: input.stats.deletions
    }
    if (input.rowId !== null) {
      return finalizeSnapshot(this.db, input.rowId, patch, input.files) === 'updated'
    }
    // 无预留行（预留时库异常）→ 复合插入路径，同样原子
    const result = insertSnapshotWithFiles(
      this.db,
      {
        id: randomUUID(),
        journeyId: input.journeyId,
        workspaceId: this.liveWorkspaceId(input.workspaceId),
        executionEventId: input.executionEventId,
        snapshotType: input.snapshotType,
        triggerKey: input.triggerKey,
        ...patch
      },
      input.files
    )
    return result.status === 'inserted'
  }

  /**
   * 把该触发标成明确失败（§五.3）：优先更新自己的 pending 行；
   * 无预留行时尽力插入一条失败记录。**已终结的行绝不覆盖**（'stale' 闸门）。
   *
   * 连失败行都写不进（库不可写）→ 允许这次记录丢失，但绝不伪装成功：
   * 未被终结的 pending 行会由下次启动标 `capture_interrupted`。
   */
  private markFailed(input: PendingFailure): void {
    if (this.closed) return
    const capturedAt = Date.now()
    try {
      if (input.rowId !== null) {
        failSnapshot(this.db, input.rowId, {
          captureStatus: 'failed',
          comparisonStatus: input.comparisonStatus,
          errorCode: input.errorCode,
          capturedAt
        })
        return
      }
      insertSnapshot(this.db, {
        id: randomUUID(),
        journeyId: input.journeyId,
        workspaceId: this.liveWorkspaceId(input.workspaceId),
        executionEventId: input.executionEventId,
        snapshotType: input.snapshotType,
        triggerKey: input.triggerKey,
        captureStatus: 'failed',
        comparisonStatus: input.comparisonStatus,
        errorCode: input.errorCode,
        capturedAt,
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
    } catch {
      // 库不可写：这次失败标记本身丢失可接受——pending 行留给下次启动标 interrupted。
    }
  }

  /**
   * 异常 → error_code（§五.3 / §三）：**数据库写入失败绝不等价成 Git 采集失败**——
   * 约束分类有自己的码；引擎错误码原样透传；其余才是 internal_error。
   */
  private errorCodeOf(error: unknown): string {
    if (error instanceof EvidenceConstraintError) {
      if (error.kind === 'foreign_key') return 'constraint_foreign_key'
      if (error.kind === 'not_null') return 'constraint_not_null'
      if (error.kind === 'unique') return 'constraint_unique'
      return 'constraint_violation'
    }
    return 'internal_error'
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
