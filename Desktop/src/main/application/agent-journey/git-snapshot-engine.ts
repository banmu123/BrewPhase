/**
 * Git Snapshot Engine（R6-4.3.2 → R6-4.3.2.1）：**独立的只读采集与对比能力**。
 *
 * 边界（测试逐条盯住）：
 * - 只做 `capture`（单时点快照）与 `compare`（两时点净变化 + Unified Diff）；
 * - **不落 SQLite、不接 `AgentJourneyService` 状态机、不自动采集、无 Renderer
 *   入口、不向 MCP 暴露**——P3 才由 `WorkspaceEvidenceService` 调用；
 * - `rootPath` 由调用方保证来自**已授权的 Local Workspace**；文件路径只来自
 *   `git status` / `git ls-tree` 输出，引擎不接受任何 Agent 路径参数；
 * - 只跑白名单只读命令（见 `git-command-runner.ts`）。
 *
 * R6-4.3.2.1 四项修复：
 * 1. **HEAD Tree 清单**（`ls-tree -r -z --full-tree HEAD`）：窗口内 commit 过的
 *    变化不再从 status 清单里蒸发；compare 合并 Tree + status 四份信息。
 * 2. **Symlink 安全**：compare **完全不读工作区**（内容只来自采集时驻留的
 *    字节与 git blob）；采集侧 no-follow 打开 + 父级 symlink 逃逸检查；
 *    symlink 变化走独立 artifact，绝对目标替换为占位符。
 * 3. **时间点一致**：Diff 内容 = 快照采集时刻的字节（驻留内存或按采集时记录
 *    的 blob sha 重建），绝不因 compare 之后的磁盘变化而漂移。
 * 4. **不可观测三态**：confirmed_unchanged（不产生条目）/ changed /
 *    unavailable——没有有效 hash 时**绝不**用「大小相同」推断内容相同。
 */
import { constants as fsConstants, open as openFile, lstat, readlink, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
  type GitHeadTree,
  type GitObservation,
  type GitSnapshotCounts,
  type GitStatusOrigin,
  type GitTreeEntry,
  type GitUnreadReason,
  type GitUnavailableReason,
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
  parseLsTreeAll,
  parsePorcelainV2,
  sanitizeLinkTarget,
  sha256Hex,
  type PorcelainEntry
} from './git-snapshot-utils'
import { BINARY_EXTENSIONS } from '../local-workspace/workspace-file-service'
import { redactSecrets } from './sanitize'

export type GitSnapshotEngineOptions = {
  /** 单条 git 命令超时（默认 5s；测试注入更小值）。 */
  timeoutMs?: number
  /** 单条命令输出上限（默认 16MB）——Tree 清单的容量上限也是它。 */
  maxOutputBytes?: number
  /** git 可执行文件路径（默认 `git`；测试注入不存在的路径）。 */
  gitPath?: string
  /** 脏文本基线内容的内存总预算（默认 8MB）。 */
  baselineStoreBytes?: number
}

// MARK: - compare 侧描述（不触发任何 IO）

/** 内部未知原因（artifact 层再映射成对外的 `GitUnavailableReason`）。 */
type UnknownWhy =
  | 'too_large'
  | 'unreadable'
  | 'symlink_escape'
  | 'not_stored'
  | 'stale'
  | 'blob_missing'
  | 'tree_unavailable'
  | 'gitlink'

/**
 * 一侧内容的**惰性描述**：`describeSide` 纯查表、零子进程；
 * `lazy`（tree/index blob）只在判定或产出 Diff 需要时才 `cat-file` 物化。
 */
type Side = {
  kind: 'content' | 'hash' | 'lazy' | 'absent' | 'sensitive' | 'binary' | 'unknown'
  /** 该侧内容对应的路径（暂存重命名解析后可能是原路径）。 */
  path: string
  /** sha256 空间的内容指纹：快照 `worktree_hash` 或驻留字节的实算值。 */
  sha: string | null
  size: number | null
  /** git 对象 sha（HEAD blob / Tree blob / 子模块记录 sha）。 */
  gitSha: string | null
  fromTree: boolean
  submodule: boolean
  symlink: boolean
  /** 该侧「文件是否存在」是否已知（Tree 清单不可用时为 false）。 */
  existenceKnown: boolean
  bytes: Buffer | null
  /** `lazy` 待取的 git blob sha。 */
  blobSha: string | null
  unknownWhy: UnknownWhy | null
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
   * 采集单时点快照。**永不抛异常**（编程错误除外）：预期失败折叠成
   * `capture_status` + `error_code`；git stderr 只取首行并脱敏。
   */
  async capture(rootPath: string): Promise<GitWorkspaceSnapshot> {
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
      // 1) 是否在工作树内：普通目录 → not_a_repository（结构化结果）
      try {
        await runGit(resolved, 'rev-parse', ['--is-inside-work-tree'], this.runOptions)
      } catch (error) {
        if (error instanceof GitCommandError && error.gitError === 'git_failed') {
          return emptySnapshot(identity, 'not_a_repository', null, resolved)
        }
        throw error
      }

      // 2) 工作区根必须就是仓库根（v1 边界）
      const toplevelRaw = (
        await runGit(resolved, 'rev-parse', ['--show-toplevel'], this.runOptions)
      ).text.trim()
      const toplevel = await realpath(toplevelRaw)
      if (toplevel !== resolved) {
        return emptySnapshot(identity, 'error', 'workspace_not_repo_root', resolved)
      }

      // 3) 仓库事实
      let branch: string | null = null
      try {
        branch = (await runGit(resolved, 'symbolic-ref', ['--short', '-q', 'HEAD'], this.runOptions))
          .text.trim()
          .slice(0, 255)
        if (branch === '') branch = null
      } catch (error) {
        if (isStructuralGitError(error)) throw error
        branch = null // detached HEAD
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

      // 4) HEAD Tree 清单（修复一）：commit 过的变化不许丢。
      //    只存 path/mode/type/sha 元数据；空仓库 → 明确的 `empty`；
      //    超输出上限/读取失败 → `unavailable` + error_code（绝不假装空清单）。
      let headTree: GitHeadTree
      if (!headSha) {
        headTree = { status: 'empty', error_code: null, entries: [] }
      } else {
        try {
          const out = await runGit(
            resolved,
            'ls-tree',
            ['-r', '-z', '--full-tree', 'HEAD'],
            this.runOptions
          )
          headTree = { status: 'ok', error_code: null, entries: parseLsTreeAll(out.text) }
        } catch (error) {
          if (
            error instanceof GitCommandError &&
            (error.gitError === 'output_limit' || error.gitError === 'git_failed')
          ) {
            headTree = { status: 'unavailable', error_code: error.gitError, entries: [] }
          } else {
            throw error // 环境性失败（git 缺失/超时/权限）→ 整次采集失败
          }
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
        await runGit(resolved, 'rev-parse', ['--show-superproject-working-tree'], this.runOptions)
      ).text.trim()
      const isSubmodule = superproject.length > 0

      // 6) index 指纹 + tracked 计数
      const lsFiles = await runGit(resolved, 'ls-files', ['-s', '-z'], this.runOptions)
      const indexStateHash = sha256Hex(lsFiles.stdout)
      const trackedCount = countTrackedPaths(lsFiles.text)

      // 7) status manifest
      const status = await runGit(
        resolved,
        'status',
        ['--porcelain=v2', '-z', '-uall', '--ignored=matching'],
        this.runOptions
      )
      const parsed = parsePorcelainV2(status.text)

      // 8) 逐文件：敏感硬排除 → 父级 symlink 检查 → no-follow 读取 → hash → 驻留预算
      const ctx: CaptureContext = {
        root: resolved,
        baselineStore: new Map<string, Uint8Array>(),
        budgetLeft: { value: this.baselineBudgetBytes },
        storeComplete: { value: true }
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
        if (entry.kind === 'ignored') continue // ignored 只计数
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
        head_tree: headTree,
        rootPath: resolved,
        baselineStore: ctx.baselineStore,
        baseline_store_complete: ctx.storeComplete.value
      }
      return hideInternals(snapshot)
    } catch (error) {
      if (error instanceof GitCommandError) {
        return emptySnapshot(identity, 'error', error.gitError, resolved)
      }
      throw error // 编程错误不吞
    }
  }

  // MARK: - compare

  /**
   * 对比两个快照，产出**窗口净变化** + 每文件 Unified Diff（内存内）。
   *
   * 四份信息合并（修复一）：baseline/current 的 HEAD Tree 清单 + status 清单。
   * **绝不重新读取工作区文件**（修复二/三）：内容只来自采集时驻留的字节与
   * 按采集时记录的 blob sha 重建的 git 对象。
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
    const bStatus = new Map(baseline.files.map((file) => [file.repo_relative_path, file]))
    const cStatus = new Map(current.files.map((file) => [file.repo_relative_path, file]))
    const bTree = treeMapOf(baseline)
    const cTree = treeMapOf(current)
    const candidates = [
      ...new Set([...bStatus.keys(), ...cStatus.keys(), ...bTree.keys(), ...cTree.keys()])
    ]

    let artifactBudget = GIT_DIFF_MAX_BYTES_PER_SNAPSHOT
    const diffs: GitFileDiff[] = []

    try {
      for (const path of candidates) {
        // ---- §十 敏感硬排除：任何 cat-file 之前先按路径挡住
        if (isSensitiveRepoPath(path)) {
          const b = bStatus.get(path)
          const c = cStatus.get(path)
          if (!b && !c) continue // 干净的敏感文件：不读、不报
          if (sensitiveStateChanged(b, c)) {
            diffs.push(sensitiveOnlyDiff(path, b, c, headMoved))
          }
          continue
        }

        const b = bStatus.get(path)
        const c = cStatus.get(path)
        const renameFrom = c?.rename_from_path ?? null

        let before = describeSide(baseline, bTree, path, b)
        if (renameFrom && before.kind === 'absent') {
          // 暂存重命名：新路径在基线不存在，内容在原路径下
          const orig = describeSide(baseline, bTree, renameFrom, bStatus.get(renameFrom))
          if (orig.kind !== 'absent') before = orig
        }
        const after = describeSide(current, cTree, path, c)

        const decision = await this.decide(root, before, after)
        let observation: GitObservation = decision.observation
        // 重命名本身就是窗口变化（即使两侧内容逐字节相同）
        if (observation === 'confirmed_unchanged' && renameFrom) observation = 'changed'
        if (observation === 'confirmed_unchanged') continue

        // 产出条目：把仍惰性的一侧物化（供 Diff 文本 / 内容 hash）
        const bFinal = decision.before.kind === 'lazy'
          ? await this.materializeSide(root, decision.before)
          : decision.before
        const aFinal = decision.after.kind === 'lazy'
          ? await this.materializeSide(root, decision.after)
          : decision.after

        const artifact = buildArtifact(bFinal, aFinal, artifactBudget)
        if (artifact.kind === 'diff') {
          artifactBudget -= Buffer.byteLength(artifact.text)
        }
        diffs.push(
          makeFileDiff(
            path,
            b,
            c,
            deriveKind(bFinal, aFinal, b, c, renameFrom),
            artifact,
            bFinal.kind === 'absent' ? null : bFinal.sha,
            aFinal.kind === 'absent' ? null : aFinal.sha,
            headMoved,
            renameFrom,
            observation === 'changed' ? 'changed' : 'unavailable'
          )
        )
      }
    } catch (error) {
      if (error instanceof GitCommandError && isStructuralGitError(error)) {
        return diffError(error.gitError)
      }
      throw error
    }

    const reconciled = reconcileRenames(diffs)
    return {
      status: 'ok',
      error_code: null,
      head_moved: headMoved,
      baseline_store_complete: baseline.baseline_store_complete,
      files: reconciled,
      stats: aggregateStats(reconciled)
    }
  }

  // MARK: - compare 判定与物化

  /**
   * 三态判定（修复四）：confirmed_unchanged / changed / unavailable。
   * 顺序：存在性 → sha256 → 大小 → git sha（仅两侧内容都由各自 HEAD 支配）
   * → 物化 lazy 侧后再比 → 仍无证据则 unavailable（**绝不伪造无变化**）。
   */
  private async decide(
    root: string,
    rawBefore: Side,
    rawAfter: Side
  ): Promise<{ observation: GitObservation; before: Side; after: Side }> {
    let before = rawBefore
    let after = rawAfter

    if (before.kind === 'absent' && after.kind === 'absent') {
      return { observation: 'confirmed_unchanged', before, after }
    }
    if (before.kind === 'absent' || after.kind === 'absent') {
      const other = before.kind === 'absent' ? after : before
      if (other.kind === 'sensitive') return { observation: 'unavailable', before, after }
      if (other.kind === 'unknown' && !other.existenceKnown) {
        // Tree 清单不可用：连「是否存在」都不知道 → 不可判定
        return { observation: 'unavailable', before, after }
      }
      // 另一侧存在（git status / Tree / 驻留内容都证实过）→ 新增/删除确认
      return { observation: 'changed', before, after }
    }
    if (before.kind === 'sensitive' || after.kind === 'sensitive') {
      return { observation: 'unavailable', before, after }
    }

    // 1) 两侧都有 sha256（快照 worktree_hash / 驻留字节实算）
    const h1 = contentSha(before)
    const h2 = contentSha(after)
    if (h1 && h2) {
      return { observation: h1 === h2 ? 'confirmed_unchanged' : 'changed', before, after }
    }
    // 2) 大小证据：不同大小 = 确定变化（相同大小**不**代表内容相同）
    if (before.size !== null && after.size !== null && before.size !== after.size) {
      return { observation: 'changed', before, after }
    }
    // 3) git sha（记录状态）：
    //    - **不相等**且两侧都来自 Tree、或涉及子模块（v1 不下钻，子模块的
    //      可观测维度就是记录 sha）→ 记录状态变了 = 必然有变化；
    //    - **相等**只有在两侧内容都由各自 HEAD 支配（都来自 Tree 清单）时
    //      才算「未变」——脏侧/子模块脏内容的 gitSha 相等**不能**证明内容相同。
    if (before.gitSha && after.gitSha && before.gitSha !== after.gitSha) {
      if (
        (before.fromTree && after.fromTree) ||
        before.submodule ||
        after.submodule
      ) {
        return { observation: 'changed', before, after }
      }
    }
    if (before.gitSha && after.gitSha && before.gitSha === after.gitSha) {
      if (before.fromTree && after.fromTree) {
        return { observation: 'confirmed_unchanged', before, after }
      }
    }
    // 4) 物化 lazy 侧（git blob）后再比 sha256 / 大小
    if (before.kind === 'lazy') before = await this.materializeSide(root, before)
    if (after.kind === 'lazy') after = await this.materializeSide(root, after)
    const m1 = contentSha(before)
    const m2 = contentSha(after)
    if (m1 && m2) {
      return { observation: m1 === m2 ? 'confirmed_unchanged' : 'changed', before, after }
    }
    if (before.size !== null && after.size !== null && before.size !== after.size) {
      return { observation: 'changed', before, after }
    }
    // 5) 证据不足：不可判定（宁可 unavailable，也不伪造无变化）
    return { observation: 'unavailable', before, after }
  }

  /** `lazy` → `cat-file` 物化（只读 git 对象，**不碰工作区文件**）。 */
  private async materializeSide(root: string, side: Side): Promise<Side> {
    if (side.kind !== 'lazy') return side
    const blob = side.blobSha
    if (!blob) return { ...side, kind: 'unknown', unknownWhy: 'blob_missing', blobSha: null }
    const res = await this.catFileBlob(root, blob)
    if (res.kind === 'missing') {
      return { ...side, kind: 'unknown', unknownWhy: 'blob_missing', blobSha: null }
    }
    if (res.kind === 'too_large') {
      return { ...side, kind: 'unknown', unknownWhy: 'too_large', blobSha: null, size: null }
    }
    const bytes = res.bytes
    const base = { ...side, blobSha: null, size: bytes.length }
    if (
      isProbablyBinary(bytes) ||
      (side.path && BINARY_EXTENSIONS.has(extname(side.path).toLowerCase()))
    ) {
      return { ...base, kind: 'binary', sha: sha256Hex(bytes) }
    }
    return { ...base, kind: 'content', bytes, sha: sha256Hex(bytes) }
  }

  private async catFileBlob(
    root: string,
    sha: string
  ): Promise<{ kind: 'ok'; bytes: Buffer } | { kind: 'missing' } | { kind: 'too_large' }> {
    if (!SHA_RE.test(sha)) return { kind: 'missing' }
    try {
      const result = await runGit(root, 'cat-file', ['blob', sha], this.runOptions)
      return { kind: 'ok', bytes: result.stdout }
    } catch (error) {
      if (error instanceof GitCommandError && error.gitError === 'output_limit') {
        return { kind: 'too_large' } // 单 blob 超输出上限 → 不可物化，而非整次 compare 失败
      }
      if (isStructuralGitError(error)) throw error
      return { kind: 'missing' } // 对象被 gc / 无效
    }
  }
}

// MARK: - capture 内部

type CaptureContext = {
  root: string
  baselineStore: Map<string, Uint8Array>
  budgetLeft: { value: number }
  /** 预算语义：脏文本基线是否全部驻留（预算没爆）。 */
  storeComplete: { value: boolean }
}

/** 读取被安全策略拒绝的原因（映射到 `GitUnreadReason`）。 */
class SnapshotReadError extends Error {
  constructor(readonly reason: 'symlink_swap' | 'unreadable' | 'too_large') {
    super(reason)
    this.name = 'SnapshotReadError'
  }
}

/**
 * 父级目录逃逸检查（修复二 §四.4）：路径的任何一级父目录是 symlink、
 * 不是目录、或不存在 → 拒绝触碰该路径（git 正常也不会列出这类路径，
 * 这里防的是捕获期间的竞态与篡改）。
 */
async function hasSymlinkParent(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/')
  parts.pop()
  let current = root
  for (const part of parts) {
    if (!part || part === '.') continue
    current = `${current}/${part}`
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return true
    } catch {
      return true // 无法确认 → 拒绝
    }
  }
  return false
}

/**
 * no-follow 读取（修复二 §四.6）：
 * 1. lstat 必须是普通文件（symlink 直接拒绝，绝不跟随）；
 * 2. `O_RDONLY | O_NOFOLLOW` 打开（POSIX；Windows 退化为第 3 步的校验）；
 * 3. fstat 复核类型/大小，并与第 1 步的 ino/dev 对比——**捕获与打开之间
 *    文件被替换成 symlink 或其它文件的竞态一律拒绝**。
 * 读取上限在打开前后各查一次，绝不无上限读入。
 */
async function readFileNoFollow(full: string, limit: number): Promise<Buffer> {
  const before = await lstat(full)
  if (before.isSymbolicLink()) throw new SnapshotReadError('symlink_swap')
  if (!before.isFile()) throw new SnapshotReadError('unreadable')
  if (before.size > limit) throw new SnapshotReadError('too_large')

  const noFollow =
    process.platform !== 'win32' && typeof fsConstants.O_NOFOLLOW === 'number'
      ? fsConstants.O_NOFOLLOW
      : 0
  const handle = await openFile(full, fsConstants.O_RDONLY | noFollow)
  try {
    const after = await handle.stat()
    if (!after.isFile()) throw new SnapshotReadError('symlink_swap')
    if (after.size > limit) throw new SnapshotReadError('too_large')
    if (after.ino !== before.ino || after.dev !== before.dev) {
      throw new SnapshotReadError('symlink_swap') // 打开前后不是同一个文件
    }
    const buf = Buffer.allocUnsafe(after.size)
    let offset = 0
    while (offset < after.size) {
      const { bytesRead } = await handle.read(buf, offset, after.size - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    return offset === after.size ? buf : buf.subarray(0, offset)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 单文件快照：敏感硬排除 → 父级 symlink → no-follow 读取 → 驻留预算判定。 */
async function buildFileSnapshot(
  ctx: CaptureContext,
  entry: PorcelainEntry
): Promise<GitFileSnapshot> {
  const rel = entry.path
  const sensitive = isSensitiveRepoPath(rel) // ① 硬排除在任何 fs 触碰之前
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
  let content: Uint8Array | null = null

  if (sensitive) {
    unreadReason = 'sensitive'
  } else {
    const full = safeJoin(ctx.root, rel)
    if (!full) {
      unreadReason = 'unreadable'
    } else if (await hasSymlinkParent(ctx.root, rel)) {
      unreadReason = 'symlink_escape' // ② 父级 symlink 逃逸：绝不触碰
    } else {
      try {
        const info = await lstat(full)
        exists = true
        if (info.isSymbolicLink()) {
          // symlink：hash 与驻留内容都是**目标字符串**——readlink 不跟随链接
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
            // ③ no-follow + 打开后复核（含被替换竞态）
            const buf = await readFileNoFollow(full, GIT_HASH_MAX_SOURCE_BYTES)
            isBinary =
              isProbablyBinary(buf) || BINARY_EXTENSIONS.has(extname(rel).toLowerCase())
            worktreeHash = sha256Hex(buf)
            if (!isBinary) content = buf
          }
        } else {
          unreadReason = 'unreadable' // 目录等罕见情形
        }
      } catch (error) {
        if (error instanceof SnapshotReadError) {
          if (error.reason === 'too_large') {
            unreadReason = 'too_large'
          } else if (error.reason === 'symlink_swap') {
            // lstat 之后被换成 symlink：按「链接逃逸」处理，绝不跟随
            unreadReason = 'symlink_escape'
            exists = true
          } else {
            unreadReason = 'unreadable'
          }
        } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          exists = false
        } else if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
          unreadReason = 'symlink_escape'
          exists = true
        } else {
          unreadReason = 'unreadable'
        }
      }
    }
  }

  // ④ 脏基线驻留判定（预算语义）
  let baselineContent: GitBaselineContentRef
  if (sensitive) {
    baselineContent = { kind: 'not_stored', reason: 'sensitive' }
  } else if (unreadReason === 'symlink_escape') {
    baselineContent = { kind: 'not_stored', reason: 'symlink_escape' }
  } else if (!exists) {
    baselineContent = { kind: 'absent' }
  } else if (unreadReason === 'too_large') {
    baselineContent = { kind: 'not_stored', reason: 'too_large' }
  } else if (unreadReason === 'unreadable') {
    baselineContent = { kind: 'not_stored', reason: 'unreadable' }
  } else if (isBinary === true) {
    baselineContent = { kind: 'not_stored', reason: 'binary' }
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
      ctx.storeComplete.value = false // 只有预算溢出影响这个旗标
    }
  } else if (entry.hI) {
    baselineContent = { kind: 'index_blob', sha: entry.hI }
  } else {
    baselineContent = { kind: 'not_stored', reason: 'index_missing' }
  }

  return {
    repo_relative_path: rel,
    index_status: entry.kind === 'untracked' ? '?' : entry.indexStatus,
    worktree_status: entry.kind === 'untracked' ? '?' : entry.worktreeStatus,
    staged_change: stagedChange,
    worktree_change: worktreeChange,
    untracked,
    conflicted,
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
  const headTree: GitHeadTree =
    status === 'error'
      ? { status: 'unavailable', error_code: errorCode, entries: [] }
      : { status: 'empty', error_code: null, entries: [] }
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
    head_tree: headTree,
    rootPath,
    baselineStore: new Map<string, Uint8Array>(),
    baseline_store_complete: true
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

/** 路径必须落在工作区内（`..` 防御）。 */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes(NUL)) return null
  const full = resolvePath(root, rel)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

// MARK: - compare 内部

function treeMapOf(snapshot: GitWorkspaceSnapshot): Map<string, GitTreeEntry> {
  if (snapshot.head_tree.status !== 'ok') return new Map()
  return new Map(snapshot.head_tree.entries.map((entry) => [entry.path, entry]))
}

/**
 * 一侧的惰性描述（零 IO）。优先级：status 条目（采集时刻的工作区事实）
 * → HEAD Tree 清单（干净态）→ 空 / 不可观测。
 */
function describeSide(
  snapshot: GitWorkspaceSnapshot,
  tree: Map<string, GitTreeEntry>,
  path: string,
  entry: GitFileSnapshot | undefined
): Side {
  const base = {
    path,
    sha: null,
    size: null,
    gitSha: null,
    fromTree: false,
    submodule: false,
    symlink: false,
    existenceKnown: true,
    bytes: null,
    blobSha: null,
    unknownWhy: null
  } as const

  if (entry) {
    const side = {
      ...base,
      gitSha: entry.head_hash,
      submodule: entry.submodule_path,
      symlink: entry.is_symlink,
      size: entry.size_bytes
    }
    if (entry.unread_reason === 'sensitive') return { ...side, kind: 'sensitive' }
    if (entry.unread_reason === 'too_large') {
      return { ...side, kind: 'unknown', unknownWhy: 'too_large' }
    }
    if (entry.unread_reason === 'unreadable') {
      return { ...side, kind: 'unknown', unknownWhy: 'unreadable' }
    }
    if (entry.unread_reason === 'symlink_escape') {
      return { ...side, kind: 'unknown', unknownWhy: 'symlink_escape' }
    }
    if (entry.worktree_hash === null) return { ...side, kind: 'absent' } // 已删除
    if (entry.is_binary) return { ...side, kind: 'binary', sha: entry.worktree_hash }

    const ref: GitBaselineContentRef = entry.baseline_content
    if (ref.kind === 'absent') return { ...side, kind: 'absent' }
    if (ref.kind === 'stored') {
      const bytes = snapshot.baselineStore.get(path)
      if (!bytes) return { ...side, kind: 'unknown', unknownWhy: 'not_stored' }
      const buf = Buffer.from(bytes)
      // 修复三·完整性守卫：驻留字节必须与采集时的 hash 一致，否则 stale
      if (sha256Hex(buf) !== entry.worktree_hash) {
        return { ...side, kind: 'unknown', unknownWhy: 'stale', size: buf.length }
      }
      return { ...side, kind: 'content', bytes: buf, sha: entry.worktree_hash, size: buf.length }
    }
    if (ref.kind === 'index_blob') {
      // 决策指纹用快照 hash（过滤器可能让 index blob ≠ 工作区原始字节）；
      // Diff 文本在物化时取 blob 字节。
      return { ...side, kind: 'lazy', sha: entry.worktree_hash, blobSha: ref.sha }
    }
    // not_stored（预算等）：仍有快照 hash → 可与其他侧比对
    return { ...side, kind: 'hash', sha: entry.worktree_hash }
  }

  // 无 status 条目 → 干净态：来自 HEAD Tree 清单（修复一）
  const treeState = snapshot.head_tree
  if (treeState.status === 'empty') return { ...base, kind: 'absent' }
  if (treeState.status === 'unavailable') {
    return { ...base, kind: 'unknown', unknownWhy: 'tree_unavailable', existenceKnown: false }
  }
  const found = tree.get(path)
  if (!found) return { ...base, kind: 'absent' }
  const treeSide = {
    ...base,
    gitSha: found.sha,
    fromTree: true,
    // git 对象模型里 symlink 就是 blob：ls-tree 的 type 恒为 blob，
    // 链接靠 mode 120000 判定；子模块 gitlink 是 commit + mode 160000。
    submodule: found.type === 'commit' || found.mode === '160000',
    symlink: found.mode === '120000'
  }
  if (found.type === 'commit') {
    // 子模块 gitlink：v1 不下钻，可观测维度就是记录 sha
    return { ...treeSide, kind: 'unknown', unknownWhy: 'gitlink' }
  }
  return { ...treeSide, kind: 'lazy', blobSha: found.sha }
}

/** 该侧可用的 sha256 指纹（content/hash/binary 有；lazy/unknown 没有）。 */
function contentSha(side: Side): string | null {
  if (side.kind === 'content' || side.kind === 'hash' || side.kind === 'binary') return side.sha
  return null
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
    observation: 'changed', // git status 已经证实状态变了（内容按策略永不读取）
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
  renameFrom: string | null | undefined,
  observation: 'changed' | 'unavailable'
): GitFileDiff {
  return {
    repo_relative_path: path,
    change_kind: changeKind,
    status_origin: originOf(c, b),
    observation,
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

function artifactInsertions(artifact: GitDiffArtifact): number | null {
  if (artifact.kind === 'diff') return artifact.insertions
  if (artifact.kind === 'over_budget' || artifact.kind === 'unavailable') {
    return artifact.insertions
  }
  return null // binary / sensitive / symlink：不产出文本行，行数不可知（null ≠ 0）
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
  // 两侧 status 清单都没有该路径 → 变化只能由 HEAD Tree 观察到（commit）
  if (!c && !b) return 'committed'
  const source = c ?? b
  if (!source) return 'committed'
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

function deriveKind(
  before: Side,
  after: Side,
  b: GitFileSnapshot | undefined,
  c: GitFileSnapshot | undefined,
  renameFrom: string | null
): GitChangeKind {
  if (c?.conflicted || b?.conflicted) return 'conflicted'
  const statuses = [b?.staged_change, b?.worktree_change, c?.staged_change, c?.worktree_change]
  if (statuses.includes('type_changed')) return 'type_changed'
  const beforePresent = before.kind !== 'absent'
  const afterPresent = after.kind !== 'absent'
  if (beforePresent && afterPresent && before.symlink !== after.symlink) {
    return 'type_changed' // 普通文件 ↔ symlink
  }
  if (renameFrom) return 'renamed'
  if (!beforePresent && afterPresent) return 'added'
  if (beforePresent && !afterPresent) return 'deleted'
  return 'modified'
}

/** 未知侧 → 对外 unavailable 原因（区分基线/当前侧）。 */
function unknownArtifactReason(side: Side, role: 'before' | 'after'): GitUnavailableReason {
  if (side.kind === 'hash') return role === 'before' ? 'baseline_not_stored' : 'current_not_stored'
  switch (side.unknownWhy) {
    case 'not_stored':
      return role === 'before' ? 'baseline_not_stored' : 'current_not_stored'
    case 'blob_missing':
      return 'blob_missing'
    case 'stale':
      return 'stale'
    default:
      return 'not_observable' // too_large / unreadable / symlink_escape / tree_unavailable / gitlink
  }
}

/** symlink 目标展示：content 侧取字节、脱敏后展示；缺内容为 null（绝不给绝对路径）。 */
function targetOf(side: Side): string | null {
  if (side.kind !== 'content' || !side.bytes) return null
  return sanitizeLinkTarget(side.bytes.toString('utf8'))
}

/**
 * 两侧 → Diff artifact（§十顺序：先挡敏感/链接/二进制，再文本，再脱敏与配额）。
 * **绝不读取工作区**——所有字节都来自快照驻留或 git 对象。
 */
function buildArtifact(before: Side, after: Side, snapshotBudget: number): GitDiffArtifact {
  if (before.kind === 'sensitive' || after.kind === 'sensitive') return { kind: 'sensitive' }
  // 修复二 §四.9-10：链接变化走独立 artifact——展示链接事实，不读外部目标
  if (before.symlink || after.symlink) {
    return {
      kind: 'symlink',
      target_before: targetOf(before),
      target_after: targetOf(after)
    }
  }
  if (before.kind === 'binary' || after.kind === 'binary') return { kind: 'binary' }
  const blocked =
    blockedSide(before, 'before') ?? blockedSide(after, 'after')
  if (blocked) return blocked

  const beforeText =
    before.kind === 'content'
      ? decodeUtf8Strict(before.bytes as Buffer)
      : before.kind === 'absent'
        ? ''
        : null
  const afterText =
    after.kind === 'content'
      ? decodeUtf8Strict(after.bytes as Buffer)
      : after.kind === 'absent'
        ? ''
        : null
  if (beforeText === null || afterText === null) {
    return { kind: 'unavailable', reason: 'decode_failed', insertions: null, deletions: null }
  }
  return finishDiff(beforeText, afterText, snapshotBudget)
}

function blockedSide(side: Side, role: 'before' | 'after'): GitDiffArtifact | null {
  if (side.kind === 'unknown') {
    // 内容存在但超过读取/物化上限 → 配额语义（over_budget），不是「不可观测」
    if (side.unknownWhy === 'too_large') {
      return { kind: 'over_budget', reason: 'source_too_large', insertions: null, deletions: null }
    }
    return {
      kind: 'unavailable',
      reason: unknownArtifactReason(side, role),
      insertions: null,
      deletions: null
    }
  }
  if (side.kind === 'hash') {
    // 有指纹可判定变化，但内容没驻留 → 明确的「不可重建」，不是空 diff
    return {
      kind: 'unavailable',
      reason: unknownArtifactReason(side, role),
      insertions: null,
      deletions: null
    }
  }
  return null
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
  const text = redactSecrets(outcome.text)
  const bytes = Buffer.byteLength(text)
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

/** 窗口重命名归并（修复一场景 D）：内容配对 + 去掉已被 renamed 引用的 deleted。 */
function reconcileRenames(diffs: GitFileDiff[]): GitFileDiff[] {
  const pairable = (diff: GitFileDiff): boolean =>
    (diff.artifact.kind === 'diff' || diff.artifact.kind === 'symlink') &&
    (diff.change_kind === 'deleted' ? diff.content_hash_before : diff.content_hash_after) !== null

  const deleted = diffs.filter((diff) => diff.change_kind === 'deleted' && pairable(diff))
  const added = diffs.filter((diff) => diff.change_kind === 'added' && pairable(diff))

  const consumed = new Set<string>()
  let result = diffs
  if (deleted.length > 0 && added.length > 0) {
    result = []
    for (const diff of diffs) {
      if (diff.change_kind !== 'added' || diff.content_hash_after === null || !pairable(diff)) {
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
        const artifact =
          diff.artifact.kind === 'symlink' && partner.artifact.kind === 'symlink'
            ? { ...diff.artifact, target_before: partner.artifact.target_before }
            : diff.artifact
        result.push({
          ...diff,
          change_kind: 'renamed',
          rename_from_path: partner.repo_relative_path,
          content_hash_before: partner.content_hash_before,
          artifact,
          pre_existing_dirty: diff.pre_existing_dirty || partner.pre_existing_dirty
        })
      } else {
        result.push(diff)
      }
    }
    result = result.filter(
      (diff) => !(diff.change_kind === 'deleted' && consumed.has(diff.repo_relative_path))
    )
  }

  // rename_from_path 已经指向的路径不再重复报 deleted（场景 D：一条 renamed）
  const renameSources = new Set(
    result
      .filter((diff) => diff.change_kind === 'renamed' && diff.rename_from_path)
      .map((diff) => diff.rename_from_path as string)
  )
  if (renameSources.size > 0) {
    result = result.filter(
      (diff) => !(diff.change_kind === 'deleted' && renameSources.has(diff.repo_relative_path))
    )
  }
  return result
}

function aggregateStats(files: GitFileDiff[]): GitDiffStats {
  const stats: GitDiffStats = {
    changed_files: 0,
    undetermined: 0,
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
    if (file.observation === 'changed') stats.changed_files++
    else stats.undetermined++
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
    baseline_store_complete: false,
    files: [],
    stats: aggregateStats([])
  }
}
