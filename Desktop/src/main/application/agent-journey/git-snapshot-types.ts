/**
 * Git Snapshot Engine 的共享类型与容量预算（R6-4.3.2）。
 *
 * 对应设计文档 §7（快照数据模型）/ §8（Dirty 归因）/ §9（Diff 配额）/
 * §13（隐私边界）。本阶段**只存在内存**：不落 SQLite、不进 Renderer、
 * 不接 Journey 状态机（P3 才由 WorkspaceEvidenceService 消费）。
 *
 * 两条贯穿全文的约束：
 * 1. **绝不把机器绝对路径写进对外字段**——仓库身份用 `sha256(realpath)`
 *    与 `basename#短哈希`；真正的工作区根路径 `rootPath` 是内部字段，
 *    被 `Object.defineProperties` 设为**不可枚举**，`JSON.stringify` 天然排除；
 * 2. **状态永远显式**——非 Git 目录是 `capture_status='not_a_repository'`
 *    这一结构化结果而不是异常；内容读不到时用带原因的 artifact 标记，
 *    绝不伪造空 Diff，也绝不把「不知道」写成 0。
 */

// MARK: - 采集状态与错误码

/** 采集状态：非 Git 目录是结构化结果；`error` 才是失败。 */
export type GitCaptureStatus = 'ok' | 'not_a_repository' | 'error'

/**
 * 结构化错误码。错误消息一律由引擎自行拼装（不含绝对路径、不含环境变量），
 * git 的 stderr 只取首行、截断并把工作区根替换成 `<workspace>`。
 */
export type GitErrorCode =
  /** 工作区根不存在 / 不可访问（含被移动）。 */
  | 'root_unavailable'
  /** git 可执行文件找不到。 */
  | 'git_not_found'
  /** 命令超时（默认 5s，可注入）。 */
  | 'git_timeout'
  /** git 非零退出（仓库损坏 / 权限等，stderr 已脱敏）。 */
  | 'git_failed'
  /** 执行 git 可执行文件时权限不足。 */
  | 'permission_denied'
  /** 输出超过上限（巨大仓库 / 未跟踪树失控）。 */
  | 'output_limit'
  /** 工作区根不是仓库根（v1 不支持子目录工作区，见交付报告 §10）。 */
  | 'workspace_not_repo_root'
  /** 白名单外的子命令（防御性，正常流程不可达）。 */
  | 'command_not_allowed'
  /** 参数含 NUL（execFile 无法安全传递）。 */
  | 'invalid_argument'
  /** 采集期间 HEAD/Index/Status 发生变化且重试后仍不稳定（R6-4.3.2.2 修复一/五）。 */
  | 'snapshot_unstable'
  /** Tree 清单含无法解析的记录——绝不静默跳过后仍标「完整」（修复二）。 */
  | 'tree_malformed'

// MARK: - Snapshot（capture 输出）

/** 文件相对仓库根的变更种类（窗口语义，由 before/after 推导）。 */
export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type_changed'
  | 'conflicted'
  /** 仅权限/可执行位变化（内容 hash 相同或不可知），内容未变（修复三）。 */
  | 'mode_changed'

/**
 * 变化来源。设计文档 §7.2 的 `status_origin` 扩展出 `both` 与 `untracked`：
 * 同一文件可能 staged 与 unstaged 同时变化，**必须分列**，不能压成一种。
 *
 * `committed`（R6-4.3.2.1 新增，向后兼容的超集）：两侧 status 清单里都
 * **没有**该路径——变化只能由 HEAD Tree 清单观察到（例如窗口内发生了
 * commit）。绝不能把它错标成普通 index/worktree 变化。
 */
export type GitStatusOrigin = 'index' | 'worktree' | 'both' | 'untracked' | 'committed'

/** 内容没读到的原因（敏感文件永远不读）。 */
export type GitUnreadReason =
  | 'sensitive'
  | 'too_large'
  | 'unreadable'
  | 'symlink_escape'
  /** 读取期间文件身份/大小/时间元数据变化（修复五），拒绝采用撕裂内容。 */
  | 'torn_read'

/**
 * 基线内容的重建方式（Dirty baseline，设计文档 §9）。
 *
 * - `index_blob`：基线时工作区内容与暂存区一致 → 事后 `cat-file` 可重建，
 *   **不占内存**；
 * - `stored`：基线时已脏且内容存进了内存预算（B→C Diff 的原料）；
 * - `not_stored`：该存没存（预算/敏感/二进制/过大）→ compare 时明确返回
 *   Diff 不可用，**绝不回退成 HEAD→C 的错误 Diff**；
 * - `absent`：基线时文件不存在。
 */
export type GitBaselineContentRef =
  | { kind: 'index_blob'; sha: string }
  | { kind: 'stored' }
  | {
      kind: 'not_stored'
      reason: 'budget' | 'index_missing' | GitUnreadReason | 'binary'
    }
  | { kind: 'absent' }

/**
 * HEAD Tree 清单元数据（R6-4.3.2.1 修复一）：来自
 * `git ls-tree -r -z --full-tree HEAD`——**只存 path/mode/type/sha**，
 * 不复制文件内容，因此窗口内 commit 掉的变化不会从 status 清单里消失后
 * 就无从发现。
 *
 * `status` 三态：
 * - `ok`：完整读到（`entries` 可为空 = 空树提交）；
 * - `empty`：没有 HEAD（空仓库 / 非 Git 目录）——**明确的空 Tree 状态**；
 * - `unavailable`：超输出上限或读取失败——**绝不返回看似完整的空清单**，
 *   此时 compare 会把受影响路径标成不可判定而不是「无变化」。
 */
export type GitTreeEntry = {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
}

export type GitHeadTree = {
  status: 'ok' | 'empty' | 'unavailable'
  /** status==='unavailable' 时非 null（如 `output_limit` / `git_failed`）。 */
  error_code: GitErrorCode | null
  entries: GitTreeEntry[]
  /**
   * 无法解析的记录数（R6-4.3.2.2 修复二）：**parser 绝不静默跳过**——
   * 只要 > 0，该侧 Tree 就不算「完整」，全局完整性降级为 partial/unavailable。
   * 已解析出的 entries 仍可用于文件级比较（能确定的路径照常产出 Diff）。
   */
  malformed_records: number
}

/** 单文件在快照中的状态（manifest 条目；来自 `git status --porcelain=v2`）。 */
export type GitFileSnapshot = {
  repo_relative_path: string
  /** porcelain v2 的 X（index vs HEAD）；`.` = 无变化，`u` = 冲突。 */
  index_status: string
  /** porcelain v2 的 Y（worktree vs index）；`.` = 无变化。 */
  worktree_status: string
  /** 暂存区相对 HEAD 的变化；null = 无。 */
  staged_change: GitChangeKind | null
  /** 工作区相对暂存区的变化；null = 无。 */
  worktree_change: GitChangeKind | null
  untracked: boolean
  conflicted: boolean
  /** 子模块作为**一个特殊路径**处理，v1 不下钻（设计文档 §6.3）。 */
  submodule_path: boolean
  /** 重命名原路径（porcelain `2` 记录）。 */
  rename_from_path: string | null
  /** 暂存区内容的 git blob sha（冲突多 stage 时为 null）。 */
  index_hash: string | null
  /** HEAD 中该路径的 blob sha。 */
  head_hash: string | null
  /** porcelain mH：HEAD 中该路径的 mode（100644/100755/120000/160000）。 */
  head_mode: string | null
  /** porcelain mI：index 中的 mode。 */
  index_mode: string | null
  /**
   * 工作区 mode：porcelain mW；untracked 文件无 mW 字段，由 lstat 按 git
   * 规则归一（symlink→120000、可执行→100755、普通→100644）。
   */
  worktree_mode: string | null
  /**
   * 工作区当前内容的 sha256（symlink 取**目标字符串**，绝不跟随读取外部）。
   * null = 文件不存在 / 未读取（见 `unread_reason`）。
   */
  worktree_hash: string | null
  unread_reason: GitUnreadReason | null
  size_bytes: number | null
  is_binary: boolean | null
  is_symlink: boolean
  /** 采集时该文件已有未提交变化（设计文档 §8 `pre_existing_dirty`）。 */
  pre_existing_dirty: boolean
  /** 基线内容如何重建（只有脏/新文件才需要，见类型注释）。 */
  baseline_content: GitBaselineContentRef
}

/** 规模统计（ignored 只计数，不进文件明细——设计文档 §7.4）。 */
export type GitSnapshotCounts = {
  tracked: number
  staged: number
  unstaged: number
  untracked: number
  ignored: number
  conflicted: number
}

export type GitWorkspaceSnapshot = {
  capture_status: GitCaptureStatus
  error_code: GitErrorCode | null
  captured_at: number

  /** sha256(realpath) 前 32 位——多个 Workspace 天然拥有独立身份。 */
  repository_identity: string
  /** `basename#sha256(realpath) 前 8 位`：可读、但不泄露家目录。 */
  repository_root_identifier: string

  branch: string | null
  head_sha: string | null
  tree_sha: string | null
  /** `git ls-files -s -z` 输出的 sha256（index 状态指纹）。 */
  index_state_hash: string | null
  /** manifest（路径 + 工作区内容 hash）排序后的 sha256。 */
  worktree_state_hash: string | null

  is_git: boolean
  is_worktree: boolean
  is_submodule: boolean
  has_unborn_head: boolean

  counts: GitSnapshotCounts
  files: GitFileSnapshot[]

  /** HEAD Tree 清单（R6-4.3.2.1）：commit 过的文件变化靠它不丢。 */
  head_tree: GitHeadTree

  /**
   * 内部字段：工作区根绝对路径。**不可枚举**——`JSON.stringify(snapshot)`
   * 不会包含它，误入 DTO 的概率被结构性排除。仅供 compare 内部使用。
   */
  rootPath: string
  /**
   * 内部字段：Dirty 基线内容（路径 → 字节），受 §9 预算约束。
   * **不可枚举**，且是内存态：本阶段不承诺重启后可恢复（P3 负责入 SQLite）。
   */
  baselineStore: Map<string, Uint8Array>
  /**
   * **预算语义**（R6-4.3.2.1 重新定义，原 `baseline_complete` 改名）：
   * 所有应驻留的脏**文本**基线内容都在内存预算内（没有发生预算溢出）。
   *
   * 它**不**表示「所有文件都能重建」——单文件能否重建看每条
   * `baseline_content` / compare 里每条 `artifact` 的 unavailable 原因；
   * 是否存在不可判定文件看 `diff.stats.undetermined`。拆开是为了不让 P3
   * 把一个布尔值误读成「Diff 一定都可生成」。
   */
  baseline_store_complete: boolean
}

// MARK: - Diff（compare 输出）

/**
 * 单文件产物。**没有「空字符串冒充成功」的状态**：
 * - `diff`：真实 Unified Diff（已过 `redactSecrets`，受配额约束）；
 * - `binary` / `sensitive` / `over_budget`：明确省略，`insertions/deletions`
 *   能算则给（敏感/二进制不读内容 → null），**绝不写 0 冒充「没有变化」**；
 * - `unavailable`：基线内容无法重建（未存 / blob 已被 gc），明确不可用。
 */
/** 不可重建 / 不可观测的原因（R6-4.3.2.1 扩展：分侧、stale、不可观测）。 */
export type GitUnavailableReason =
  /** 基线侧内容没驻留内存且无 blob 可重建。 */
  | 'baseline_not_stored'
  /** 当前侧内容没驻留内存且无 blob 可重建。 */
  | 'current_not_stored'
  /** git 对象缺失（被 gc 等），无法重建。 */
  | 'blob_missing'
  /** 内容不是合法 UTF-8，不能产出文本 diff。 */
  | 'decode_failed'
  /** 该侧没有有效 hash / 内容（超大、不可读、Tree 清单不可用）——无法判定是否变化。 */
  | 'not_observable'
  /** 驻留字节与快照 hash 不一致（完整性守卫），拒绝产出看似准确的 Diff。 */
  | 'stale'

export type GitDiffArtifact =
  | { kind: 'diff'; text: string; insertions: number; deletions: number; byte_size: number }
  | { kind: 'binary' }
  | { kind: 'sensitive' }
  /**
   * 仅 mode 变化（R6-4.3.2.2 修复三）：内容 hash 相同、只有权限/可执行位
   * 变了——**不产出伪造的内容 Diff**，只陈述 mode 事实。
   */
  | { kind: 'mode_only'; mode_before: string; mode_after: string }
  /**
   * Symlink 变化（R6-4.3.2.1 修复二）：只展示**链接事实**（两侧目标字符串，
   * 绝对目标已替换为占位符），绝不读取、也绝不展示链接外部的目标内容。
   */
  | {
      kind: 'symlink'
      target_before: string | null
      target_after: string | null
    }
  | {
      kind: 'over_budget'
      /**
       * `journey_budget`（R6-4.3.4）：由持久化层在**事务内**按 Journey 总量
       * 预算追加——引擎本身不知道跨快照的累积用量。其余 reason 由引擎产生。
       */
      reason:
        | 'file_budget'
        | 'snapshot_budget'
        | 'journey_budget'
        | 'source_too_large'
        | 'algorithm_budget'
      insertions: number | null
      deletions: number | null
    }
  | {
      kind: 'unavailable'
      reason: GitUnavailableReason
      insertions: number | null
      deletions: number | null
    }

/**
 * 判定三态（R6-4.3.2.1 修复四）：
 * - `confirmed_unchanged`：有足够证据确认内容一致 → **不产生条目**；
 * - `changed`：可以确定净变化 → 条目 `observation='changed'`；
 * - `unavailable`：无法确定 → 条目 `observation='unavailable'`
 *   （宁可给出不可判定条目，也绝不伪造「无变化」或 insertions=0）。
 */
export type GitObservation = 'confirmed_unchanged' | 'changed' | 'unavailable'

export type GitFileDiff = {
  repo_relative_path: string
  change_kind: GitChangeKind
  status_origin: GitStatusOrigin
  /** 本条目的判定结果（`confirmed_unchanged` 不会出现——它不产生条目）。 */
  observation: 'changed' | 'unavailable'
  content_hash_before: string | null
  content_hash_after: string | null
  pre_existing_dirty: boolean
  /** 该文件的 HEAD sha 在窗口内是否变化（拿不到两侧时退回窗口级判定）。 */
  head_moved: boolean
  rename_from_path: string | null
  /** 窗口前后该文件的 mode（能取到时恒填；mode_changed 的可读输出，修复三）。 */
  mode_before: string | null
  mode_after: string | null
  insertions: number | null
  deletions: number | null
  artifact: GitDiffArtifact
}

export type GitDiffStats = {
  /** `observation='changed'` 的条目数（不可判定的**不**混进来）。 */
  changed_files: number
  /** `observation='unavailable'` 的条目数：无法确认是否变化的文件。 */
  undetermined: number
  added: number
  modified: number
  deleted: number
  renamed: number
  type_changed: number
  conflicted: number
  mode_changed: number
  /** 可计算部分之和（省略/不可用的文件不计入，也不冒充 0）。 */
  insertions_total: number
  deletions_total: number
  omitted_sensitive: number
  omitted_binary: number
  omitted_over_budget: number
  unavailable: number
}

/**
 * Tree 对比完整性（R6-4.3.2.2 修复二）——与 `stats.undetermined` **相互独立**：
 * undetermined 统计的是「有路径但判不了」的文件条目；没有路径可枚举的未知
 * 变化只能由这个全局字段表达，绝不写进任何文件计数。
 *
 * - `complete`：两侧 Tree 均可枚举（ok 且无 malformed，或 empty）；
 * - `partial`：恰好一侧可枚举——已可枚举侧的路径照常比较；
 * - `unavailable`：两侧都不可枚举——**绝不把空结果表达成完整成功**。
 */
export type GitManifestCompleteness = 'complete' | 'partial' | 'unavailable'

export type GitWorkspaceDiff = {
  status: 'ok' | 'error'
  error_code: GitErrorCode | 'repository_mismatch' | 'baseline_not_ok' | 'current_not_ok' | null
  /** 全局 Tree 可枚举性（见类型注释）。 */
  manifest_completeness: GitManifestCompleteness
  /** baseline 快照的 Tree 状态（原样透出，便于 P3 落库）。 */
  baseline_tree_status: GitHeadTree['status']
  current_tree_status: GitHeadTree['status']
  /** completeness!==complete 时的原因（unavailable 的 error_code / tree_malformed）。 */
  manifest_unavailable_reason: GitErrorCode | null
  /** 窗口内 HEAD 是否移动（归因置信度降级信号，设计文档 §8）。 */
  head_moved: boolean
  /**
   * 沿用 baseline 快照的**预算语义**（原 `baseline_complete` 改名）：
   * false = 至少一个脏文本基线超预算未存。单文件可否重建看 `artifact`，
   * 不可判定文件数看 `stats.undetermined`。**内存态，重启后不可依赖**（§九）。
   */
  baseline_store_complete: boolean
  files: GitFileDiff[]
  stats: GitDiffStats
}

// MARK: - 容量预算（设计文档 §9 初始值）

/** 单文件 Diff 文本上限。 */
export const GIT_DIFF_MAX_BYTES_PER_FILE = 64 * 1024
/** 单次 Snapshot 的 Diff 总量上限（超出的文件依次省略，但保留统计）。 */
export const GIT_DIFF_MAX_BYTES_PER_SNAPSHOT = 512 * 1024
/**
 * 单 Journey 的 Diff Artifact 总量上限（R6-4.3.4，设计文档 §9.3）。
 *
 * 与上面两层不同：它跨快照累积，只能由持久化层在**写入事务内**统计
 * SQLite 已落库的 artifact 字节（UTF-8），先查后写的竞态由事务消除。
 * 超出后新的 `diff` 正文降级为 `over_budget/journey_budget`——
 * 统计与文件元数据保留，绝不删除或改写历史快照。
 */
export const GIT_DIFF_MAX_BYTES_PER_JOURNEY = 2 * 1024 * 1024
/** 单文件参与渲染的行数上限。 */
export const GIT_DIFF_MAX_LINES_PER_FILE = 2_000
/** 单文件 hunk 数上限。 */
export const GIT_DIFF_MAX_HUNKS_PER_FILE = 800
/** Diff 算法的操作预算：超过即判定 `algorithm_budget`（不挂死、不伪造统计）。 */
export const GIT_DIFF_ALGO_OP_BUDGET = 5_000_000

/** 单个 Dirty 文件允许驻留内存的基线内容上限（复用既有 512KB 常量）。 */
export { WORKSPACE_FILE_MAX_BYTES as GIT_BASELINE_FILE_MAX_BYTES } from '../../../shared/contracts/local-workspace'
/** 全部基线内容的内存总预算（8MB）：超出后新文件标 `not_stored: budget`。 */
export const GIT_BASELINE_STORE_TOTAL_BYTES = 8 * 1024 * 1024
/** 参与 hash / Diff 的单文件读取上限（超过标 `too_large`，不整读）。 */
export const GIT_HASH_MAX_SOURCE_BYTES = 8 * 1024 * 1024

/** 默认超时（规格 §4.1：5 秒，必须可注入）。 */
export const GIT_SNAPSHOT_TIMEOUT_MS = 5_000
/** 单条 git 命令的 stdout/stderr 上限。 */
export const GIT_COMMAND_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
