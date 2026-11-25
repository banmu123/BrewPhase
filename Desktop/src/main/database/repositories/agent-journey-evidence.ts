import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { journeySnapshotFiles, journeyWorkspaceSnapshots } from '../schema'

/**
 * 工作区证据仓储（R6-4.3.3 / 收尾 R6-4.3.3.1）。
 *
 * 只有 Main 进程的 Service 写这里；Renderer 经 `agent-journey:evidence`
 * 只读查询。全部 local-first：不进 change_log / iOS 同步 / Cloud / Remote。
 *
 * 可靠性不变量（本阶段的核心）：
 * - **原子**：快照主记录与其全部文件明细永远在同一个事务里写入——
 *   不允许「主记录在、changed_files_count>0、文件明细缺」的半成品。
 * - **精确分类**：只有**确认命中** `UNIQUE(journey_id, trigger_key)`
 *   （错误码 + message 列名 + 精确查询三重确认）才返回 `duplicate`；
 *   外键 / NOT NULL / 其他唯一键冲突一律抛 `EvidenceConstraintError`
 *   显式暴露给 Service——绝不 `startsWith('SQLITE_CONSTRAINT')` 一把吞。
 * - **pending 生命周期**：预留行只允许 `pending → 最终状态` 单向转换；
 *   已终结（ok / error / failed）的行永不被覆盖。
 */

export type EvidenceSnapshotInsert = {
  id?: string
  journeyId: string
  workspaceId: string | null
  executionEventId: string | null
  snapshotType: string
  triggerKey: string
  captureStatus: string
  comparisonStatus: string
  errorCode: string | null
  capturedAt: number
  repositoryIdentity: string | null
  repositoryRootIdentifier: string | null
  branch: string | null
  headSha: string | null
  treeSha: string | null
  indexStateHash: string | null
  worktreeStateHash: string | null
  isGit: number
  isWorktree: number
  isSubmodule: number
  hasUnbornHead: number
  trackedCount: number
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  ignoredCount: number
  changedFilesCount: number
  insertions: number
  deletions: number
}

/**
 * 终结 / 标失败时可改的字段——**不含身份键**（journey / workspace / event /
 * type / trigger），这些列在预留时定死，任何后续写都不能挪动引用。
 */
export type EvidenceSnapshotPatch = Omit<
  EvidenceSnapshotInsert,
  'id' | 'journeyId' | 'workspaceId' | 'executionEventId' | 'snapshotType' | 'triggerKey'
>

export type EvidenceFileInsert = {
  repoRelativePath: string
  changeKind: string
  statusOrigin: string
  contentHashBefore: string | null
  contentHashAfter: string | null
  preExistingDirty: number
  headMoved: number
  renameFromPath: string | null
  /** NULL = 不可计算（绝不写 0 冒充「没有变化」）。 */
  insertions: number | null
  deletions: number | null
  lineRanges: string | null
  artifactRef: string | null
  attribution: string | null
  attributionConfidence: string | null
}

export type SnapshotWriteResult =
  | { status: 'inserted'; id: string }
  /** 且仅于：确认命中 UNIQUE(journey_id, trigger_key)——幂等重复，不是错误。 */
  | { status: 'duplicate' }

export type EvidenceConstraintKind =
  /** 外键失败（journey / workspace / event 引用不存在）——必须显式暴露。 */
  | 'foreign_key'
  /** NOT NULL 失败（必填字段缺失）——必须显式暴露。 */
  | 'not_null'
  /** 唯一键/主键冲突，但**不是** trigger 防重键（如文件明细重复路径）。 */
  | 'unique'
  /** 其他完整性错误（CHECK 等）。 */
  | 'other'

/** 证据写入的完整性错误：永远不吞、永远不伪装成 duplicate。 */
export class EvidenceConstraintError extends Error {
  readonly kind: EvidenceConstraintKind
  readonly sqliteCode: string | null

  constructor(kind: EvidenceConstraintKind, message: string, sqliteCode: string | null) {
    super(message)
    this.name = 'EvidenceConstraintError'
    this.kind = kind
    this.sqliteCode = sqliteCode
  }
}

/**
 * trigger 防重键在 SQLite 错误消息里的精确列名。
 * `SQLITE_CONSTRAINT_UNIQUE` + 这段列名 + 精确查询确认，三者齐全才算 duplicate。
 */
const TRIGGER_UNIQUE_COLUMNS =
  'journey_workspace_snapshots.journey_id, journey_workspace_snapshots.trigger_key'

function sqliteCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** 翻译成证据语义的错误：SQLITE_CONSTRAINT* → EvidenceConstraintError；其余原样返回。 */
function asConstraintError(error: unknown): unknown {
  if (error instanceof EvidenceConstraintError) return error
  const code = sqliteCodeOf(error)
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) return error
  const message = error instanceof Error ? error.message : String(error)
  let kind: EvidenceConstraintKind
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') kind = 'foreign_key'
  else if (code === 'SQLITE_CONSTRAINT_NOTNULL') kind = 'not_null'
  else if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
    kind = 'unique'
  else kind = 'other'
  return new EvidenceConstraintError(kind, message, code)
}

/**
 * 写入冲突分类：只有确认命中 `UNIQUE(journey_id, trigger_key)` 返回 'duplicate'；
 * 其余（含无法确认的冲突）一律抛出——调用方据此区分「幂等重复」与「真故障」。
 */
function classifyWriteConflict(
  error: unknown,
  db: Db,
  journeyId: string,
  triggerKey: string
): { status: 'duplicate' } {
  const code = sqliteCodeOf(error)
  const message = error instanceof Error ? error.message : ''
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' && message.includes(TRIGGER_UNIQUE_COLUMNS)) {
    // 精确查询确认：确实已存在同一 (journey, trigger) 的行（而非同名索引的巧合）
    if (selectSnapshotByTrigger(db, journeyId, triggerKey)) return { status: 'duplicate' }
  }
  throw asConstraintError(error)
}

/** 同一 (journey, trigger) 是否已有行——省掉重复的 git 采集开销（唯一索引仍是兜底）。 */
export function selectSnapshotByTrigger(
  db: Db,
  journeyId: string,
  triggerKey: string
): boolean {
  const rows = db
    .select({ id: journeyWorkspaceSnapshots.id })
    .from(journeyWorkspaceSnapshots)
    .where(
      and(
        eq(journeyWorkspaceSnapshots.journeyId, journeyId),
        eq(journeyWorkspaceSnapshots.triggerKey, triggerKey)
      )
    )
    .limit(1)
    .all()
  return rows.length > 0
}

function snapshotRow(input: EvidenceSnapshotInsert, id: string) {
  return {
    id,
    journeyId: input.journeyId,
    workspaceId: input.workspaceId,
    executionEventId: input.executionEventId,
    snapshotType: input.snapshotType,
    triggerKey: input.triggerKey,
    captureStatus: input.captureStatus,
    comparisonStatus: input.comparisonStatus,
    errorCode: input.errorCode,
    capturedAt: input.capturedAt,
    repositoryIdentity: input.repositoryIdentity,
    repositoryRootIdentifier: input.repositoryRootIdentifier,
    branch: input.branch,
    headSha: input.headSha,
    treeSha: input.treeSha,
    indexStateHash: input.indexStateHash,
    worktreeStateHash: input.worktreeStateHash,
    isGit: input.isGit,
    isWorktree: input.isWorktree,
    isSubmodule: input.isSubmodule,
    hasUnbornHead: input.hasUnbornHead,
    trackedCount: input.trackedCount,
    stagedCount: input.stagedCount,
    unstagedCount: input.unstagedCount,
    untrackedCount: input.untrackedCount,
    ignoredCount: input.ignoredCount,
    changedFilesCount: input.changedFilesCount,
    insertions: input.insertions,
    deletions: input.deletions
  }
}

function insertFileRows(db: Db, snapshotId: string, files: readonly EvidenceFileInsert[]): void {
  for (const file of files) {
    db.insert(journeySnapshotFiles)
      .values({
        id: randomUUID(),
        snapshotId,
        repoRelativePath: file.repoRelativePath,
        changeKind: file.changeKind,
        statusOrigin: file.statusOrigin,
        contentHashBefore: file.contentHashBefore,
        contentHashAfter: file.contentHashAfter,
        preExistingDirty: file.preExistingDirty,
        headMoved: file.headMoved,
        renameFromPath: file.renameFromPath,
        insertions: file.insertions,
        deletions: file.deletions,
        lineRanges: file.lineRanges,
        artifactRef: file.artifactRef,
        attribution: file.attribution,
        attributionConfidence: file.attributionConfidence
      })
      .run()
  }
}

/**
 * 插入快照主记录（预留 pending 与「无预留行」的兜底路径使用）。
 *
 * 返回 `duplicate` 仅当确认命中 trigger 防重键；外键 / NOT NULL /
 * 其他冲突抛 `EvidenceConstraintError`——绝不吞成 duplicate。
 */
export function insertSnapshot(db: Db, input: EvidenceSnapshotInsert): SnapshotWriteResult {
  const id = input.id ?? randomUUID()
  try {
    db.insert(journeyWorkspaceSnapshots).values(snapshotRow(input, id)).run()
    return { status: 'inserted', id }
  } catch (error) {
    return classifyWriteConflict(error, db, input.journeyId, input.triggerKey)
  }
}

/**
 * 复合持久化（§二）：Snapshot 主记录与其**全部** File rows 在同一个事务里写入。
 * 任何一条 File row 失败 → 主记录与已写文件一起回滚（不产生半成品）。
 * `files` 为空 → 只写主记录（不产生空文件记录）。
 */
export function insertSnapshotWithFiles(
  db: Db,
  input: EvidenceSnapshotInsert,
  files: readonly EvidenceFileInsert[]
): SnapshotWriteResult {
  if (files.length === 0) return insertSnapshot(db, input)
  const id = input.id ?? randomUUID()
  try {
    db.transaction(() => {
      db.insert(journeyWorkspaceSnapshots).values(snapshotRow(input, id)).run()
      insertFileRows(db, id, files)
    })
    return { status: 'inserted', id }
  } catch (error) {
    // 事务已整体回滚——调用方拿到 duplicate（可安全跳过）或被显式抛出的完整性错误。
    return classifyWriteConflict(error, db, input.journeyId, input.triggerKey)
  }
}

/**
 * 终结 pending 行：主记录更新 + 文件明细写入在**同一个事务**里。
 * 先把 pending 改成最终状态、再单独写文件——这条歧路在这里结构上不可能发生：
 * 文件失败 → 整体回滚 → 行保持 pending，由调用方标明确失败。
 *
 * 只允许 `pending → 最终状态`：行已被终结（ok/error/failed/interrupted）时
 * 返回 'stale'，**绝不覆盖已有结果**。
 */
export function finalizeSnapshot(
  db: Db,
  snapshotId: string,
  patch: EvidenceSnapshotPatch,
  files: readonly EvidenceFileInsert[]
): 'updated' | 'stale' {
  try {
    return db.transaction(() => {
      const result = db
        .update(journeyWorkspaceSnapshots)
        .set({ ...patch })
        .where(
          and(
            eq(journeyWorkspaceSnapshots.id, snapshotId),
            eq(journeyWorkspaceSnapshots.captureStatus, 'pending')
          )
        )
        .run()
      if (result.changes === 0) return 'stale' as const
      if (files.length > 0) insertFileRows(db, snapshotId, files)
      return 'updated' as const
    })
  } catch (error) {
    // 文件明细唯一键冲突等 → 连同主记录更新一起回滚（行保持 pending）。
    throw asConstraintError(error)
  }
}

/**
 * 把 pending 行标成明确失败（采集失败 / 中断恢复）。
 * 与 finalize 同一条单向闸门：已终结的行返回 'stale'，不覆盖。
 */
export function failSnapshot(
  db: Db,
  snapshotId: string,
  patch: Pick<EvidenceSnapshotPatch, 'captureStatus' | 'comparisonStatus' | 'errorCode' | 'capturedAt'>
): 'updated' | 'stale' {
  const result = db
    .update(journeyWorkspaceSnapshots)
    .set({ ...patch })
    .where(
      and(
        eq(journeyWorkspaceSnapshots.id, snapshotId),
        eq(journeyWorkspaceSnapshots.captureStatus, 'pending')
      )
    )
    .run()
  return result.changes === 0 ? 'stale' : 'updated'
}

/** 仍处于 pending 的快照（启动恢复的扫描对象）。 */
export function selectPendingSnapshots(db: Db) {
  return db
    .select()
    .from(journeyWorkspaceSnapshots)
    .where(eq(journeyWorkspaceSnapshots.captureStatus, 'pending'))
    .orderBy(asc(journeyWorkspaceSnapshots.capturedAt), asc(journeyWorkspaceSnapshots.id))
    .all()
}

/** Journey 的全部快照（按采集时间升序——时间线顺序）。 */
export function selectSnapshotsForJourney(db: Db, journeyId: string) {
  return db
    .select()
    .from(journeyWorkspaceSnapshots)
    .where(eq(journeyWorkspaceSnapshots.journeyId, journeyId))
    .orderBy(asc(journeyWorkspaceSnapshots.capturedAt), asc(journeyWorkspaceSnapshots.id))
    .all()
}

/** 这批快照的全部文件级摘要（一次查询，调用方自行分组）。 */
export function selectFilesForSnapshots(db: Db, snapshotIds: readonly string[]) {
  if (snapshotIds.length === 0) return []
  return db
    .select()
    .from(journeySnapshotFiles)
    .where(inArray(journeySnapshotFiles.snapshotId, [...snapshotIds]))
    .orderBy(asc(journeySnapshotFiles.repoRelativePath))
    .all()
}
