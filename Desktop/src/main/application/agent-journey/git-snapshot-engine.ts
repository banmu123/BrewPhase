/**
 * Git Snapshot Engine（R6-4.3.2 §五）：**独立的只读采集与对比能力**。
 *
 * 边界（本阶段硬约束，测试逐条盯住）：
 * - 只做 `capture`（单时点快照）与 `compare`（两时点净变化 + Unified Diff）；
 * - **不落 SQLite、不接 `AgentJourneyService` 状态机、不自动采集、无 Renderer
 *   入口、不向 MCP 暴露**——P3 才由 `WorkspaceEvidenceService` 调用；
 * - `rootPath` 由调用方保证来自**已授权的 Local Workspace**（P3 传
 *   `LocalWorkspaceService.resolveRoot()` 的结果）；引擎本身不接受任何
 *   来自 Agent 的路径参数，文件路径全部来自 `git status` 输出；
 * - 只跑 §4.3 白名单里的只读命令（见 `git-command-runner.ts`）。
 *
 * 结果语义（§7/§8/§9）：
 * - 非 Git 目录 → `capture_status='not_a_repository'`（结构化，不抛异常）；
 * - Dirty 基线（B→C）：基线内容要么来自 `cat-file`（干净文件）、要么驻留
 *   内存预算（脏文件），两者都拿不到时**明确返回 Diff 不可用**，
 *   绝不回退成 HEAD→C 的错误 Diff；
 * - 窗口内只证明「两个观察时间点之间的净变化」，**不判断是谁改的**。
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { extname, resolve as resolvePath, sep } from 'node:path'
import {
  GitCommandError,
  isStructuralGitError,
  runGit,
  type GitRunOptions
} from './git-command-runner'
import {
  GIT_BASELINE_FILE_MAX_BYTES,
  GIT_BASELINE_STORE_TOTAL_BYTES,
  GIT_DIFF_MAX_BYTES_PER_FILE,
  GIT_DIFF_MAX_BYTES_PER_SNAPSHOT,
  GIT_HASH_MAX_SOURCE_BYTES,
  type GitBaselineContentRef,
  type GitChangeKind,
  type GitDiffArtifact,
  type GitDiffStats,
  type GitErrorCode,
  type GitFileDiff,
  type GitFileSnapshot,
  type GitSnapshotCounts,
  type GitStatusOrigin,
  type GitUnreadReason,
  type GitWorkspaceDiff,
  type GitWorkspaceSnapshot
} from './git-snapshot-types'
import {
  buildUnifiedDiff,
  changeKindFromStatusCode,
  countTrackedPaths,
  decodeUtf8Strict,
  identityOf,
  isProbablyBinary,
  isSensitiveRepoPath,
  parseLsTree,
  parsePorcelainV2,
  sha256Hex,
  type PorcelainEntry
} from './git-snapshot-utils'
import { BINARY_EXTENSIONS } from '../local-workspace/workspace-file-service'
import { redactSecrets } from './sanitize'

export type GitSnapshotEngineOptions = {
  /** 单条 git 命令超时（默认 5s；测试注入更小值）。 */
  timeoutMs?: number
  /** 单条命令输出上限（默认 16MB）。 */
  maxOutputBytes?: number
  /** git 可执行文件路径（默认 `git`；测试注入不存在的路径）。 */
  gitPath?: string
  /** Dirty 基线内容的内存总预算（默认 8MB）。 */
  baselineStoreBytes?: number
}

/** compare 时一侧内容的解析结果。 */
type ContentSide =
  | { state: 'ok'; bytes: Buffer; hash: string }
  | { state: 'missing' }
  | { state: 'binary'; hash: string | null }
  | { state: 'over_budget'; hash: string | null }
  | {
      state: 'unavailable'
      reason: 'baseline_not_stored' | 'blob_missing' | 'decode_failed' | 'current_unreadable'
      hash: string | null
    }

const NUL = String.fromCharCode(0)
const SHA_RE = /^[0-9a-f]{40,64}$/

export class GitSnapshotEngine {
  private readonly runOptions: GitRunOptions
  private readonly baselineBudgetBytes: number

  constructor(options: GitSnapshotEngineOptions = {}) {
    this.runOptions = {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      gitPath: options.gitPath
    }
    this.baselineBudgetBytes = options.baselineStoreBytes ?? GIT_BASELINE_STORE_TOTAL_BYTES
  }

  // MARK: - capture

  /**
   * 采集单时点快照。**永不抛异常**（编程错误除外）：所有预期失败都折叠成
   * `capture_status` + `error_code`；git 的 stderr 只取首行并脱敏。
   */
  async capture(rootPath: string): Promise<GitWorkspaceSnapshot> {
    // 1) 根目录可用性 → realpath → 身份（身份基于 realpath，绝不写原始路径）
    let resolved: string
    let identity: ReturnType<typeof identityOf>
    try {
      const info = await stat(rootPath)
      if (!info.isDirectory()) throw new Error('workspace root is not a directory')
      resolved = await realpath(rootPath)
      identity = identityOf(resolved)
    } catch {
      return emptySnapshot(identityOf(rootPath), 'error', 'root_unavailable', rootPath)
    }

    try {
      // 2) 是否在工作树内：普通目录 → not_a_repository（结构化结果）
      try {
        await runGit(resolved, 'rev-parse', ['--is-inside-work-tree'], this.runOptions)
      } catch (error) {
        if (error instanceof GitCommandError && error.gitError === 'git_failed') {
          return emptySnapshot(identity, 'not_a_repository', null, resolved)
        }
        throw error
      }

      // 3) 工作区根必须就是仓库根（v1 边界：子目录工作区会越权看到仓库其余部分）
      const toplevelRaw = (
        await runGit(resolved, 'rev-parse', ['--show-toplevel'], this.runOptions)
      ).text.trim()
      const toplevel = await realpath(toplevelRaw)
      if (toplevel !== resolved) {
        return emptySnapshot(identity, 'error', 'workspace_not_repo_root', resolved)
      }

      // 4) 仓库事实
      let branch: string | null = null
      try {
        branch = (await runGit(resolved, 'symbolic-ref', ['--short', '-q', 'HEAD'], this.runOptions))
          .text.trim()
          .slice(0, 255)
        if (branch === '') branch = null
      } catch (error) {
        if (isStructuralGitError(error)) throw error
        branch = null // detached HEAD：退出码 1，无输出
      }

      let headSha: string | null = null
      let hasUnbornHead = false
      try {
        headSha = (
          await runGit(resolved, 'rev-parse', ['--verify', 'HEAD^{commit}'], this.runOptions)
        ).text.trim()
        if (headSha === '') headSha = null
      } catch (error) {
        if (isStructuralGitError(error)) throw error
        hasUnbornHead = true // 空仓库：还没有第一个 commit
      }

      let treeSha: string | null = null
      if (headSha) {
        try {
          treeSha = (
            await runGit(resolved, 'rev-parse', ['--verify', 'HEAD^{tree}'], this.runOptions)
          ).text.trim()
          if (treeSha === '') treeSha = null
        } catch (error) {
          if (isStructuralGitError(error)) throw error
          treeSha = null
        }
      }

      // 5) Worktree / Submodule 识别
      const gitDirRaw = (await runGit(resolved, 'rev-parse', ['--git-dir'], this.runOptions))
        .text.trim()
      const commonDirRaw = (
        await runGit(resolved, 'rev-parse', ['--git-common-dir'], this.runOptions)
      ).text.trim()
      const gitDir = await softRealpath(resolvePath(resolved, gitDirRaw))
      const commonDir = await softRealpath(resolvePath(resolved, commonDirRaw))
      const isWorktree = gitDir !== commonDir
      const superproject = (
        await runGit(
          resolved,
          'rev-parse',
          ['--show-superproject-working-tree'],
          this.runOptions
        )
      ).text.trim()
      const isSubmodule = superproject.length > 0

      // 6) index 指纹 + tracked 计数
      const lsFiles = await runGit(resolved, 'ls-files', ['-s', '-z'], this.runOptions)
      const indexStateHash = sha256Hex(lsFiles.stdout)
      const trackedCount = countTrackedPaths(lsFiles.text)

      // 7) status manifest（`--ignored=matching`：ignored 目录紧凑成一条，
      //    `-uall`：untracked 逐文件）
      const status = await runGit(
        resolved,
        'status',
        ['--porcelain=v2', '-z', '-uall', '--ignored=matching'],
        this.runOptions
      )
      const parsed = parsePorcelainV2(status.text)

      // 8) 逐文件：敏感硬排除 → lstat/读取 → hash → Dirty 基线入内存预算
      const ctx: CaptureContext = {
        root: resolved,
        baselineStore: new Map<string, Uint8Array>(),
        budgetLeft: { value: this.baselineBudgetBytes },
        baselineComplete: { value: true }
      }
      const files: GitFileSnapshot[] = []
      const counts: GitSnapshotCounts = {
        tracked: trackedCount,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        ignored: parsed.ignoredCount,
        conflicted: parsed.conflictedCount
      }

      for (const entry of parsed.entries) {
        if (entry.kind === 'ignored') continue // ignored 只计数（§7.4）
        if (entry.kind === 'untracked') counts.untracked += 1
        else if (entry.kind === 'changed') {
          if (entry.indexStatus !== '.') counts.staged += 1
          if (entry.worktreeStatus !== '.') counts.unstaged += 1
        }
        files.push(await buildFileSnapshot(ctx, entry))
      }

      // 9) worktree 状态指纹（排序后的 路径+内容hash）
      const manifestHash = createHash('sha256')
      for (const file of [...files]
        .filter((file) => file.worktree_hash !== null)
        .sort((x, y) => (x.repo_relative_path < y.repo_relative_path ? -1 : 1))) {
        manifestHash.update(file.repo_relative_path)
        manifestHash.update(NUL)
        manifestHash.update(file.worktree_hash ?? '')
        manifestHash.update(NUL)
      }

      const snapshot: GitWorkspaceSnapshot = {
        capture_status: 'ok',
        error_code: null,
        captured_at: Date.now(),
        ...identity,
        branch,
        head_sha: headSha,
        tree_sha: treeSha,
        index_state_hash: indexStateHash,
        worktree_state_hash: manifestHash.digest('hex'),
        is_git: true,
        is_worktree: isWorktree,
        is_submodule: isSubmodule,
        has_unborn_head: hasUnbornHead,
        counts,
        files,
        rootPath: resolved,
        baselineStore: ctx.baselineStore,
        baseline_complete: ctx.baselineComplete.value
      }
      return hideInternals(snapshot)
    } catch (error) {
      if (error instanceof GitCommandError) {
        return emptySnapshot(identity, 'error', error.gitError, resolved)
      }
      throw error // 编程错误不吞：测试必须能看见
    }
  }

  // MARK: - compare

  /**
   * 对比两个快照，产出**窗口净变化** + 每文件 Unified Diff（内存内）。
   *
   * 永不抛异常（编程错误除外）。身份不一致（跨 Workspace）/ 任一侧采集
   * 不是 `ok` 时返回结构化 `status:'error'`。
   */
  async compare(
    baseline: GitWorkspaceSnapshot,
    current: GitWorkspaceSnapshot
  ): Promise<GitWorkspaceDiff> {
    if (baseline.capture_status !== 'ok') return diffError('baseline_not_ok')
    if (current.capture_status !== 'ok') return diffError('current_not_ok')
    if (baseline.repository_identity !== current.repository_identity) {
      return diffError('repository_mismatch')
    }

    const root = current.rootPath
    const headMoved = baseline.head_sha !== current.head_sha
    const baseMap = new Map(baseline.files.map((file) => [file.repo_relative_path, file]))
    const curMap = new Map(current.files.map((file) => [file.repo_relative_path, file]))
    const paths = [...new Set([...baseMap.keys(), ...curMap.keys()])]

    let artifactBudget = GIT_DIFF_MAX_BYTES_PER_SNAPSHOT
    const diffs: GitFileDiff[] = []

    try {
      for (const path of paths) {
        const b = baseMap.get(path)
        const c = curMap.get(path)

        // ---- §十：任一侧是敏感文件 → 只看状态变化，绝不读内容
        if (b?.unread_reason === 'sensitive' || c?.unread_reason === 'sensitive') {
          if (sensitiveStateChanged(b, c)) diffs.push(sensitiveOnlyDiff(path, b, c, headMoved))
          continue
        }

        if (b && c) {
          // 两侧都在：状态键相同且 index 相同 → 无净变化（含「改后恢复」）
          if (stateKey(b) === stateKey(c) && b.index_hash === c.index_hash) continue
          // 工作区内容相同、只有暂存状态变了 → 空内容 diff（0/0 是真话）
          if (stateKey(b) === stateKey(c)) {
            diffs.push(
              makeFileDiff(
                path,
                b,
                c,
                'modified',
                { kind: 'diff', text: '', insertions: 0, deletions: 0, byte_size: 0 },
                b.worktree_hash,
                c.worktree_hash,
                headMoved
              )
            )
            continue
          }
          const before = await this.resolveBaselineSide(root, baseline, path, b)
          const after = await this.resolveCurrentSide(root, current, path, c)
          const entry = await this.entryFromSides(
            path,
            b,
            c,
            before,
            after,
            headMoved,
            artifactBudget,
            null
          )
          if (entry) {
            diffs.push(entry.diff)
            artifactBudget = entry.budget
          }
          continue
        }

        if (b && !c) {
          // 当前干净或已删：另一侧从 ls-tree + cat-file 重建
          const before = await this.resolveBaselineSide(root, baseline, path, b)
          const after = await this.resolveCurrentSide(root, current, path, undefined)
          const entry = await this.entryFromSides(
            path,
            b,
            undefined,
            before,
            after,
            headMoved,
            artifactBudget,
            null
          )
          if (entry) {
            diffs.push(entry.diff)
            artifactBudget = entry.budget
          }
          continue
        }

        if (!b && c) {
          // 基线干净或不存在；暂存重命名时基线内容在原路径下
          const beforePath = c.rename_from_path ?? path
          const before = await this.resolveBaselineSide(root, baseline, beforePath, undefined)
          const after = await this.resolveCurrentSide(root, current, path, c)
          const entry = await this.entryFromSides(
            path,
            undefined,
            c,
            before,
            after,
            headMoved,
            artifactBudget,
            c.rename_from_path
          )
          if (entry) {
            diffs.push(entry.diff)
            artifactBudget = entry.budget
          }
        }
      }
    } catch (error) {
      if (error instanceof GitCommandError && isStructuralGitError(error)) {
        return diffError(error.gitError)
      }
      throw error
    }

    // ---- 内容配对的窗口重命名：删除侧 + 新增侧 hash 相同 → renamed
    const renamed = pairRenames(diffs)

    return {
      status: 'ok',
      error_code: null,
      head_moved: headMoved,
      baseline_complete: baseline.baseline_complete,
      files: renamed,
      stats: aggregateStats(renamed)
    }
  }

  // MARK: - compare 侧内容解析

  /**
   * 基线侧内容：
   * - 条目在：按 `baseline_content`（stored / index_blob / absent / not_stored）；
   * - 条目不在（基线时干净）：`ls-tree baseline.head → cat-file` 重建；
   *   基线无 HEAD（空仓库）→ missing。
   */
  private async resolveBaselineSide(
    root: string,
    baseline: GitWorkspaceSnapshot,
    path: string,
    entry: GitFileSnapshot | undefined
  ): Promise<ContentSide> {
    if (entry) {
      if (entry.unread_reason === 'too_large') return { state: 'over_budget', hash: null }
      if (entry.unread_reason === 'unreadable') {
        return { state: 'unavailable', reason: 'current_unreadable', hash: null }
      }
      if (entry.is_binary) return { state: 'binary', hash: entry.worktree_hash }
      const ref: GitBaselineContentRef = entry.baseline_content
      switch (ref.kind) {
        case 'absent':
          return { state: 'missing' }
        case 'not_stored':
          return ref.reason === 'too_large'
            ? { state: 'over_budget', hash: null }
            : { state: 'unavailable', reason: 'baseline_not_stored', hash: null }
        case 'stored': {
          const bytes = baseline.baselineStore.get(path)
          if (!bytes) return { state: 'unavailable', reason: 'baseline_not_stored', hash: null }
          return {
            state: 'ok',
            bytes: Buffer.from(bytes),
            hash: entry.worktree_hash ?? sha256Hex(bytes)
          }
        }
        case 'index_blob': {
          const bytes = await this.catFileBlob(root, ref.sha)
          if (!bytes) return { state: 'unavailable', reason: 'blob_missing', hash: null }
          return { state: 'ok', bytes, hash: entry.worktree_hash ?? sha256Hex(bytes) }
        }
      }
    }
    // 基线时干净（不在 manifest）→ 用基线 HEAD 的 blob 重建
    if (!baseline.head_sha) return { state: 'missing' }
    const sha = await this.lsTreeBlob(root, baseline.head_sha, path)
    if (!sha) return { state: 'missing' }
    const bytes = await this.catFileBlob(root, sha)
    if (!bytes) return { state: 'unavailable', reason: 'blob_missing', hash: null }
    if (isProbablyBinary(bytes)) return { state: 'binary', hash: sha256Hex(bytes) }
    return { state: 'ok', bytes, hash: sha256Hex(bytes) }
  }

  /**
   * 当前侧内容：
   * - 条目在：直接读工作区文件（敏感/二进制/超限在快照阶段已标记，不读）；
   * - 条目不在（当前干净）：`ls-tree current.head → cat-file`。
   */
  private async resolveCurrentSide(
    root: string,
    current: GitWorkspaceSnapshot,
    path: string,
    entry: GitFileSnapshot | undefined
  ): Promise<ContentSide> {
    if (entry) {
      if (entry.unread_reason === 'too_large') return { state: 'over_budget', hash: null }
      if (entry.unread_reason === 'unreadable') {
        return { state: 'unavailable', reason: 'current_unreadable', hash: null }
      }
      if (entry.worktree_hash === null) return { state: 'missing' } // 已删除
      if (entry.is_binary) return { state: 'binary', hash: entry.worktree_hash }
      if (entry.size_bytes !== null && entry.size_bytes > GIT_BASELINE_FILE_MAX_BYTES) {
        return { state: 'over_budget', hash: entry.worktree_hash }
      }
      const full = safeJoin(root, path)
      if (!full) {
        return { state: 'unavailable', reason: 'current_unreadable', hash: entry.worktree_hash }
      }
      try {
        const bytes = await readFile(full)
        if (isProbablyBinary(bytes)) return { state: 'binary', hash: entry.worktree_hash }
        return { state: 'ok', bytes, hash: entry.worktree_hash }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
        return { state: 'unavailable', reason: 'current_unreadable', hash: entry.worktree_hash }
      }
    }
    if (!current.head_sha) return { state: 'missing' }
    const sha = await this.lsTreeBlob(root, current.head_sha, path)
    if (!sha) return { state: 'missing' }
    const bytes = await this.catFileBlob(root, sha)
    if (!bytes) return { state: 'unavailable', reason: 'blob_missing', hash: null }
    if (isProbablyBinary(bytes)) return { state: 'binary', hash: sha256Hex(bytes) }
    return { state: 'ok', bytes, hash: sha256Hex(bytes) }
  }

  /** 两侧解析 → 是否纳入 + 生成条目（含配额与脱敏）。 */
  private async entryFromSides(
    path: string,
    b: GitFileSnapshot | undefined,
    c: GitFileSnapshot | undefined,
    before: ContentSide,
    after: ContentSide,
    headMoved: boolean,
    budget: number,
    renameFrom: string | null
  ): Promise<{ diff: GitFileDiff; budget: number } | null> {
    // 两侧都不存在 → 没有任何净变化可说
    if (before.state === 'missing' && after.state === 'missing') return null
    // 内容一致 → 净变化为 0（「改后恢复」「仅 commit / 仅 HEAD 移动」都在此收敛）。
    // 暂存状态单独变化的情形已在调用方（stateKey 相同、index 不同）先行处理。
    if (!renameFrom && before.state === 'ok' && after.state === 'ok' && before.hash === after.hash) {
      return null
    }

    const kind = deriveChangeKind(path, b, c, before, after, renameFrom)
    const artifact = await buildArtifact(before, after, budget)
    const remaining =
      artifact.kind === 'diff' ? budget - Buffer.byteLength(artifact.text) : budget

    const diff = makeFileDiff(
      path,
      b,
      c,
      kind,
      artifact,
      sideHash(before),
      sideHash(after),
      headMoved,
      renameFrom
    )
    return { diff, budget: remaining }
  }

  // MARK: - git 只读子查询（compare 内部）

  private async lsTreeBlob(root: string, treeSha: string, path: string): Promise<string | null> {
    if (!SHA_RE.test(treeSha)) return null
    try {
      const result = await runGit(root, 'ls-tree', ['-z', treeSha, '--', path], this.runOptions)
      return parseLsTree(result.text)?.sha ?? null
    } catch (error) {
      if (isStructuralGitError(error)) throw error
      return null // git_failed：对象已被 gc / 路径无效 → 当作无匹配
    }
  }

  private async catFileBlob(root: string, sha: string): Promise<Buffer | null> {
    if (!SHA_RE.test(sha)) return null
    try {
      const result = await runGit(root, 'cat-file', ['blob', sha], this.runOptions)
      return result.stdout
    } catch (error) {
      if (isStructuralGitError(error)) throw error
      return null // git_failed：对象缺失 → blob_missing
    }
  }
}

// MARK: - capture 内部

type CaptureContext = {
  root: string
  baselineStore: Map<string, Uint8Array>
  budgetLeft: { value: number }
  baselineComplete: { value: boolean }
}

/** 单文件快照：§十顺序 = 敏感硬排除 → 大小/二进制 → 读取 → 基线驻留判定。 */
async function buildFileSnapshot(
  ctx: CaptureContext,
  entry: PorcelainEntry
): Promise<GitFileSnapshot> {
  const rel = entry.path
  const sensitive = isSensitiveRepoPath(rel) // ① 硬排除在任何读取之前
  const conflicted = entry.kind === 'unmerged'
  const untracked = entry.kind === 'untracked'
  const stagedChange =
    entry.kind === 'changed' ? changeKindFromStatusCode(entry.indexStatus) : null
  const worktreeChange =
    entry.kind === 'changed' ? changeKindFromStatusCode(entry.worktreeStatus) : null
  const preExistingDirty =
    untracked ||
    conflicted ||
    (entry.kind === 'changed' && (entry.indexStatus !== '.' || entry.worktreeStatus !== '.'))

  let worktreeHash: string | null = null
  let unreadReason: GitUnreadReason | null = null
  let sizeBytes: number | null = null
  let isBinary: boolean | null = null
  let isSymlink = false
  let exists = false
  let content: Uint8Array | null = null // 非敏感、非二进制、未超限的当前内容

  if (sensitive) {
    unreadReason = 'sensitive'
  } else {
    const full = safeJoin(ctx.root, rel)
    if (!full) {
      unreadReason = 'unreadable'
    } else {
      try {
        const info = await lstat(full)
        exists = true
        if (info.isSymbolicLink()) {
          // symlink：hash 与内容都是**目标字符串**——绝不跟随读取链接外部（§11.27）
          isSymlink = true
          const target = await readlink(full)
          const bytes = Buffer.from(target, 'utf8')
          content = bytes
          sizeBytes = bytes.length
          isBinary = false
          worktreeHash = sha256Hex(bytes)
        } else if (info.isFile()) {
          sizeBytes = info.size
          if (sizeBytes > GIT_HASH_MAX_SOURCE_BYTES) {
            unreadReason = 'too_large'
          } else {
            const buf = await readFile(full)
            // ② 二进制判定在保存之前：NUL 启发（与 git 一致）+ 共享扩展名清单
            isBinary =
              isProbablyBinary(buf) || BINARY_EXTENSIONS.has(extname(rel).toLowerCase())
            worktreeHash = sha256Hex(buf)
            if (!isBinary) content = buf // 只有文本才可能进基线存储
          }
        } else {
          unreadReason = 'unreadable' // 目录（type_changed 到目录等罕见情形）
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          exists = false // 窗口内被删 / 从未存在
        } else {
          unreadReason = 'unreadable'
        }
      }
    }
  }

  // ⑤ Dirty 基线：工作区内容与任何 blob 都不同 → 必须驻留内存（受预算）
  let baselineContent: GitBaselineContentRef
  if (sensitive) {
    baselineContent = { kind: 'not_stored', reason: 'sensitive' }
  } else if (!exists) {
    baselineContent = { kind: 'absent' }
  } else if (unreadReason === 'too_large') {
    baselineContent = { kind: 'not_stored', reason: 'too_large' }
  } else if (unreadReason === 'unreadable') {
    baselineContent = { kind: 'not_stored', reason: 'unreadable' }
  } else if (isBinary === true) {
    baselineContent = { kind: 'not_stored', reason: 'binary' } // 二进制内容不保存
  } else if (untracked || conflicted || worktreeChange !== null) {
    if (
      content &&
      content.length <= GIT_BASELINE_FILE_MAX_BYTES &&
      content.length <= ctx.budgetLeft.value
    ) {
      ctx.baselineStore.set(rel, content)
      ctx.budgetLeft.value -= content.length
      baselineContent = { kind: 'stored' }
    } else {
      baselineContent = { kind: 'not_stored', reason: 'budget' }
      ctx.baselineComplete.value = false
    }
  } else if (entry.hI) {
    baselineContent = { kind: 'index_blob', sha: entry.hI } // 干净：事后 cat-file 可重建
  } else {
    baselineContent = { kind: 'not_stored', reason: 'index_missing' }
    ctx.baselineComplete.value = false
  }

  return {
    repo_relative_path: rel,
    index_status: entry.kind === 'untracked' ? '?' : entry.indexStatus,
    worktree_status: entry.kind === 'untracked' ? '?' : entry.worktreeStatus,
    staged_change: stagedChange,
    worktree_change: worktreeChange,
    untracked,
    conflicted,
    // porcelain `<sub>` 以 S 开头 = 子模块：作为**一个特殊路径**记录，v1 不下钻（§6.3）
    submodule_path: entry.subField.startsWith('S'),
    rename_from_path: entry.renameFrom,
    index_hash: entry.hI,
    head_hash: entry.hH,
    worktree_hash: worktreeHash,
    unread_reason: unreadReason,
    size_bytes: sizeBytes,
    is_binary: isBinary,
    is_symlink: isSymlink,
    pre_existing_dirty: preExistingDirty,
    baseline_content: baselineContent
  }
}

function emptySnapshot(
  identity: ReturnType<typeof identityOf>,
  status: 'not_a_repository' | 'error',
  errorCode: GitErrorCode | null,
  rootPath: string
): GitWorkspaceSnapshot {
  return hideInternals({
    capture_status: status,
    error_code: errorCode,
    captured_at: Date.now(),
    ...identity,
    branch: null,
    head_sha: null,
    tree_sha: null,
    index_state_hash: null,
    worktree_state_hash: null,
    is_git: false,
    is_worktree: false,
    is_submodule: false,
    has_unborn_head: false,
    counts: { tracked: 0, staged: 0, unstaged: 0, untracked: 0, ignored: 0, conflicted: 0 },
    files: [],
    rootPath,
    baselineStore: new Map<string, Uint8Array>(),
    baseline_complete: true
  })
}

/** 内部字段（工作区绝对路径 / 内存基线）设为不可枚举：序列化天然排除。 */
function hideInternals(snapshot: GitWorkspaceSnapshot): GitWorkspaceSnapshot {
  Object.defineProperties(snapshot, {
    rootPath: { value: snapshot.rootPath, enumerable: false, configurable: true },
    baselineStore: { value: snapshot.baselineStore, enumerable: false, configurable: true }
  })
  return snapshot
}

async function softRealpath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** 路径必须落在工作区内（status 给的是相对路径；这里再兜一层 `..` 防御）。 */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes(NUL)) return null
  const full = resolvePath(root, rel)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

// MARK: - compare 内部

function stateKey(file: GitFileSnapshot): string {
  if (file.unread_reason === 'sensitive') return 'sensitive'
  if (file.worktree_hash !== null) return `h:${file.worktree_hash}`
  if (file.unread_reason === 'too_large') {
    return `t:${file.size_bytes}:${file.index_status}:${file.worktree_status}`
  }
  if (file.unread_reason === 'unreadable') {
    return `u:${file.index_status}:${file.worktree_status}`
  }
  return 'absent'
}

function sensitiveStateChanged(
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined
): boolean {
  const key = (file: GitFileSnapshot | undefined): string =>
    file ? `${file.index_status}:${file.worktree_status}:${file.untracked}` : 'clean'
  return key(b) !== key(c)
}

function sensitiveOnlyDiff(
  path: string,
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined,
  headMoved: boolean
): GitFileDiff {
  return {
    repo_relative_path: path,
    change_kind: deriveKindFromStatuses(b, c),
    status_origin: originOf(c, b),
    content_hash_before: null,
    content_hash_after: null,
    pre_existing_dirty: b?.pre_existing_dirty ?? false,
    head_moved: fileHeadMoved(b, c, headMoved),
    rename_from_path: c?.rename_from_path ?? null,
    insertions: null,
    deletions: null,
    artifact: { kind: 'sensitive' }
  }
}

function makeFileDiff(
  path: string,
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined,
  changeKind: GitChangeKind,
  artifact: GitDiffArtifact,
  hashBefore: string | null,
  hashAfter: string | null,
  headMoved: boolean,
  renameFrom?: string | null
): GitFileDiff {
  return {
    repo_relative_path: path,
    change_kind: changeKind,
    status_origin: originOf(c, b),
    content_hash_before: hashBefore,
    content_hash_after: hashAfter,
    pre_existing_dirty: b?.pre_existing_dirty ?? false,
    head_moved: fileHeadMoved(b, c, headMoved),
    rename_from_path: renameFrom ?? c?.rename_from_path ?? null,
    insertions: artifactInsertions(artifact),
    deletions: artifactDeletions(artifact),
    artifact
  }
}

function sideHash(side: ContentSide): string | null {
  if (side.state === 'ok' || side.state === 'binary') return side.hash
  if (side.state === 'over_budget' || side.state === 'unavailable') return side.hash
  return null // missing
}

function artifactInsertions(artifact: GitDiffArtifact): number | null {
  if (artifact.kind === 'diff') return artifact.insertions
  if (artifact.kind === 'over_budget' || artifact.kind === 'unavailable') {
    return artifact.insertions
  }
  return null // binary / sensitive：不读内容，行数不可知（null ≠ 0）
}

function artifactDeletions(artifact: GitDiffArtifact): number | null {
  if (artifact.kind === 'diff') return artifact.deletions
  if (artifact.kind === 'over_budget' || artifact.kind === 'unavailable') {
    return artifact.deletions
  }
  return null
}

function fileHeadMoved(
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined,
  windowHeadMoved: boolean
): boolean {
  if (b?.head_hash && c?.head_hash) return b.head_hash !== c.head_hash
  return windowHeadMoved
}

function originOf(
  c: GitFileSnapshot | undefined,
  b: GitFileSnapshot | undefined
): GitStatusOrigin {
  const source = c ?? b
  if (!source) return 'worktree'
  if (source.conflicted) return 'both'
  if (source.untracked) return 'untracked'
  const idx = source.index_status !== '.' && source.index_status !== 'u'
  const wt = source.worktree_status !== '.' && source.worktree_status !== 'u'
  if (idx && wt) return 'both'
  if (idx) return 'index'
  if (wt) return 'worktree'
  return 'worktree'
}

function deriveKindFromStatuses(
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined
): GitChangeKind {
  if (c?.conflicted || b?.conflicted) return 'conflicted'
  const kinds = [b?.staged_change, b?.worktree_change, c?.staged_change, c?.worktree_change]
  if (kinds.includes('type_changed')) return 'type_changed'
  return 'modified'
}

function deriveChangeKind(
  path: string,
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined,
  before: ContentSide,
  after: ContentSide,
  renameFrom?: string | null
): GitChangeKind {
  if (c?.conflicted || b?.conflicted) return 'conflicted'
  const statuses = [b?.staged_change, b?.worktree_change, c?.staged_change, c?.worktree_change]
  if (statuses.includes('type_changed')) return 'type_changed'
  if (renameFrom) return 'renamed'
  const beforePresent = before.state !== 'missing'
  const afterPresent = after.state !== 'missing'
  if (!beforePresent && afterPresent) return 'added'
  if (beforePresent && !afterPresent) return 'deleted'
  void path
  return 'modified'
}

/** 内容两侧 → Diff artifact（含脱敏与配额，§十顺序 ④⑤）。 */
async function buildArtifact(
  before: ContentSide,
  after: ContentSide,
  snapshotBudget: number
): Promise<GitDiffArtifact> {
  const blocked = (side: ContentSide): GitDiffArtifact | null => {
    if (side.state === 'unavailable') {
      return { kind: 'unavailable', reason: side.reason, insertions: null, deletions: null }
    }
    if (side.state === 'over_budget') {
      return { kind: 'over_budget', reason: 'source_too_large', insertions: null, deletions: null }
    }
    return null
  }
  if (before.state === 'binary' || after.state === 'binary') return { kind: 'binary' }
  const blockedSide = blocked(before) ?? blocked(after)
  if (blockedSide) return blockedSide

  const beforeText =
    before.state === 'ok'
      ? decodeUtf8Strict(before.bytes)
      : before.state === 'missing'
        ? ''
        : null
  const afterText =
    after.state === 'ok' ? decodeUtf8Strict(after.bytes) : after.state === 'missing' ? '' : null
  if (beforeText === null || afterText === null) {
    return { kind: 'unavailable', reason: 'decode_failed', insertions: null, deletions: null }
  }
  return finishDiff(beforeText, afterText, snapshotBudget)
}

function finishDiff(beforeText: string, afterText: string, snapshotBudget: number): GitDiffArtifact {
  const outcome = buildUnifiedDiff(beforeText, afterText)
  if (outcome.kind === 'algorithm_budget') {
    return { kind: 'over_budget', reason: 'algorithm_budget', insertions: null, deletions: null }
  }
  if (outcome.kind === 'file_budget') {
    return {
      kind: 'over_budget',
      reason: 'file_budget',
      insertions: outcome.insertions,
      deletions: outcome.deletions
    }
  }
  // ④ 脱敏（对允许保留的文本 diff）
  const text = redactSecrets(outcome.text)
  const bytes = Buffer.byteLength(text)
  // ⑤ 容量限制（脱敏可能放大文本 → 单文件与快照两级再各过一次）
  if (bytes > GIT_DIFF_MAX_BYTES_PER_FILE) {
    return {
      kind: 'over_budget',
      reason: 'file_budget',
      insertions: outcome.insertions,
      deletions: outcome.deletions
    }
  }
  if (bytes > snapshotBudget) {
    return {
      kind: 'over_budget',
      reason: 'snapshot_budget',
      insertions: outcome.insertions,
      deletions: outcome.deletions
    }
  }
  return {
    kind: 'diff',
    text,
    insertions: outcome.insertions,
    deletions: outcome.deletions,
    byte_size: bytes
  }
}

/** 窗口重命名：删除侧与新增侧内容 hash 相同 → 合并成一条 renamed。 */
function pairRenames(diffs: GitFileDiff[]): GitFileDiff[] {
  const deleted = diffs.filter(
    (diff) =>
      diff.change_kind === 'deleted' &&
      diff.artifact.kind === 'diff' &&
      diff.content_hash_before !== null
  )
  const added = diffs.filter(
    (diff) =>
      diff.change_kind === 'added' &&
      diff.artifact.kind === 'diff' &&
      diff.content_hash_after !== null
  )
  if (deleted.length === 0 || added.length === 0) return diffs

  const consumed = new Set<string>()
  const result: GitFileDiff[] = []
  for (const diff of diffs) {
    if (diff.change_kind !== 'added' || diff.content_hash_after === null) {
      result.push(diff)
      continue
    }
    const partner = deleted.find(
      (candidate) =>
        !consumed.has(candidate.repo_relative_path) &&
        candidate.content_hash_before === diff.content_hash_after
    )
    if (partner) {
      consumed.add(partner.repo_relative_path)
      result.push({
        ...diff,
        change_kind: 'renamed',
        rename_from_path: partner.repo_relative_path,
        content_hash_before: partner.content_hash_before,
        pre_existing_dirty: diff.pre_existing_dirty || partner.pre_existing_dirty
      })
    } else {
      result.push(diff)
    }
  }
  return result.filter(
    (diff) => !(diff.change_kind === 'deleted' && consumed.has(diff.repo_relative_path))
  )
}

function aggregateStats(files: GitFileDiff[]): GitDiffStats {
  const stats: GitDiffStats = {
    changed_files: files.length,
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    type_changed: 0,
    conflicted: 0,
    insertions_total: 0,
    deletions_total: 0,
    omitted_sensitive: 0,
    omitted_binary: 0,
    omitted_over_budget: 0,
    unavailable: 0
  }
  for (const file of files) {
    if (file.change_kind === 'added') stats.added++
    else if (file.change_kind === 'modified') stats.modified++
    else if (file.change_kind === 'deleted') stats.deleted++
    else if (file.change_kind === 'renamed') stats.renamed++
    else if (file.change_kind === 'type_changed') stats.type_changed++
    else if (file.change_kind === 'conflicted') stats.conflicted++
    if (file.insertions !== null) stats.insertions_total += file.insertions
    if (file.deletions !== null) stats.deletions_total += file.deletions
    if (file.artifact.kind === 'sensitive') stats.omitted_sensitive++
    else if (file.artifact.kind === 'binary') stats.omitted_binary++
    else if (file.artifact.kind === 'over_budget') stats.omitted_over_budget++
    else if (file.artifact.kind === 'unavailable') stats.unavailable++
  }
  return stats
}

function diffError(errorCode: GitWorkspaceDiff['error_code']): GitWorkspaceDiff {
  return {
    status: 'error',
    error_code: errorCode,
    head_moved: false,
    baseline_complete: false,
    files: [],
    stats: aggregateStats([])
  }
}
