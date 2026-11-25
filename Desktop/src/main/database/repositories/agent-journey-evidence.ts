import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { journeySnapshotFiles, journeyWorkspaceSnapshots } from '../schema'

/**
 * 工作区证据仓储（R6-4.3.3，P3）。
 *
 * 只有 Main 进程的 Service 写这里；Renderer 经 `agent-journey:evidence`
 * 只读查询。全部 local-first：不进 change_log / iOS 同步 / Cloud / Remote。
 *
 * 幂等的**真正防线是数据库唯一约束**（`UNIQUE(journey_id, trigger_key)`），
 * 仓储层的 exists 检查只是省掉重复的 git 采集开销。
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

/** 同一 (journey, trigger) 是否已采过——命中则跳过 git 采集（唯一索引兜底）。 */
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

/**
 * 插入快照行。返回 false = 唯一约束冲突（同 trigger 已存在）——
 * 幂等路径把它当「已采集」吞掉，绝不向上抛。
 */
export function insertSnapshot(db: Db, input: EvidenceSnapshotInsert): boolean {
  try {
    db.insert(journeyWorkspaceSnapshots)
      .values({
        id: input.id ?? randomUUID(),
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
      })
      .run()
    return true
  } catch (error) {
    const code = (error as { code?: string }).code
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return false
    throw error
  }
}

/** 批量写文件级摘要（单事务；files 为空直接返回——不写空记录）。 */
export function insertSnapshotFiles(
  db: Db,
  snapshotId: string,
  files: readonly EvidenceFileInsert[]
): void {
  if (files.length === 0) return
  // drizzle/better-sqlite3：transaction(fn) 同步执行并返回 fn 的结果（非工厂）
  db.transaction(() => {
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
  })
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
