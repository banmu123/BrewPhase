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

// MARK: - Snapshot（capture 输出）

/** 文件相对仓库根的变更种类（窗口语义，由 before/after 推导）。 */
export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type_changed'
  | 'conflicted'

/**
 * 变化来源。设计文档 §7.2 的 `status_origin` 扩展出 `both` 与 `untracked`：
 * 同一文件可能 staged 与 unstaged 同时变化，**必须分列**，不能压成一种。
 */
export type GitStatusOrigin = 'index' | 'worktree' | 'both' | 'untracked'

/** 内容没读到的原因（敏感文件永远不读）。 */
export type GitUnreadReason = 'sensitive' | 'too_large' | 'unreadable'

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
  /** 基线内容是否全部可重建（false = 至少一个脏文件超预算未存）。 */
  baseline_complete: boolean
}

// MARK: - Diff（compare 输出）

/**
 * 单文件产物。**没有「空字符串冒充成功」的状态**：
 * - `diff`：真实 Unified Diff（已过 `redactSecrets`，受配额约束）；
 * - `binary` / `sensitive` / `over_budget`：明确省略，`insertions/deletions`
 *   能算则给（敏感/二进制不读内容 → null），**绝不写 0 冒充「没有变化」**；
 * - `unavailable`：基线内容无法重建（未存 / blob 已被 gc），明确不可用。
 */
export type GitDiffArtifact =
  | { kind: 'diff'; text: string; insertions: number; deletions: number; byte_size: number }
  | { kind: 'binary' }
  | { kind: 'sensitive' }
  | {
      kind: 'over_budget'
      reason: 'file_budget' | 'snapshot_budget' | 'source_too_large' | 'algorithm_budget'
      insertions: number | null
      deletions: number | null
    }
  | {
      kind: 'unavailable'
      reason: 'baseline_not_stored' | 'blob_missing' | 'decode_failed' | 'current_unreadable'
      insertions: number | null
      deletions: number | null
    }

export type GitFileDiff = {
  repo_relative_path: string
  change_kind: GitChangeKind
  status_origin: GitStatusOrigin
  content_hash_before: string | null
  content_hash_after: string | null
  pre_existing_dirty: boolean
  /** 该文件的 HEAD sha 在窗口内是否变化（拿不到两侧时退回窗口级判定）。 */
  head_moved: boolean
  rename_from_path: string | null
  insertions: number | null
  deletions: number | null
  artifact: GitDiffArtifact
}

export type GitDiffStats = {
  changed_files: number
  added: number
  modified: number
  deleted: number
  renamed: number
  type_changed: number
  conflicted: number
  /** 可计算部分之和（省略/不可用的文件不计入，也不冒充 0）。 */
  insertions_total: number
  deletions_total: number
  omitted_sensitive: number
  omitted_binary: number
  omitted_over_budget: number
  unavailable: number
}

export type GitWorkspaceDiff = {
  status: 'ok' | 'error'
  error_code: GitErrorCode | 'repository_mismatch' | 'baseline_not_ok' | 'current_not_ok' | null
  /** 窗口内 HEAD 是否移动（归因置信度降级信号，设计文档 §8）。 */
  head_moved: boolean
  /**
   * 基线内容是否完整：false = 有脏文件的基线内容超预算未存，
   * 对应文件的 Diff 明确不可用。**内存态，重启后不可依赖**（§九）。
   */
  baseline_complete: boolean
  files: GitFileDiff[]
  stats: GitDiffStats
}

// MARK: - 容量预算（设计文档 §9 初始值）

/** 单文件 Diff 文本上限。 */
export const GIT_DIFF_MAX_BYTES_PER_FILE = 64 * 1024
/** 单次 Snapshot 的 Diff 总量上限（超出的文件依次省略，但保留统计）。 */
export const GIT_DIFF_MAX_BYTES_PER_SNAPSHOT = 512 * 1024
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
