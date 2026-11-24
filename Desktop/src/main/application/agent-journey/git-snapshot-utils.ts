/**
 * Git Snapshot Engine 的纯函数层（R6-4.3.2）：输出解析、哈希、
 * 以及**内存内自实现的 Unified Diff**。
 *
 * 为什么 Diff 自己算而不是 `git diff`：
 * - 窗口对比的「before」可能是**基线时已脏的工作区内容**（不在对象库里），
 *   git diff 无法直接对比任意两份内存内容；走 `--no-index` 则要把未脱敏的
 *   源码写进临时文件——违背 §十三「先脱敏后保存」的顺序；
 * - 自算可以精确执行 §9 的行数 / hunk / 字节配额，且单文件不产生子进程。
 *
 * 本文件不碰文件系统、不跑 git——全部可单测。
 */
import { createHash } from 'node:crypto'
import {
  GIT_DIFF_ALGO_OP_BUDGET,
  GIT_DIFF_MAX_BYTES_PER_FILE,
  GIT_DIFF_MAX_HUNKS_PER_FILE,
  GIT_DIFF_MAX_LINES_PER_FILE,
  type GitChangeKind,
  type GitTreeEntry
} from './git-snapshot-types'
import { isSensitiveName } from '../local-workspace/workspace-file-service'
import { redactSecrets } from './sanitize'

const NUL = String.fromCharCode(0)

// MARK: - 哈希与身份

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 仓库身份：`sha256(realpath)`——**绝不把绝对路径本身写进任何字段**。
 * `repository_root_identifier` 用 `basename#短哈希`：人能认出是哪个目录，
 * 但拿不到家目录结构。
 */
export function identityOf(resolvedPath: string): {
  repository_identity: string
  repository_root_identifier: string
} {
  const hash = sha256Hex(resolvedPath)
  const base = resolvedPath.split('/').filter(Boolean).pop() ?? 'root'
  return {
    repository_identity: hash.slice(0, 32),
    repository_root_identifier: `${base}#${hash.slice(0, 8)}`
  }
}

/** 二进制启发（与 git 一致）：前 8000 字节出现 NUL。 */
export function isProbablyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** 严格 UTF-8 解码：解不出来返回 null（按「不可作文本 diff」处理，绝不产出乱码 diff）。 */
export function decodeUtf8Strict(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}

/**
 * 敏感路径判定（§十：**先硬排除、后任何读取**）。
 * 复用 Local Workspace 的唯一权威清单 `SENSITIVE_FILE_PATTERNS`，再补上
 * 版本库内部路径（`.git/**` 永不进入 manifest，这里只是纵深防御）。
 */
export function isSensitiveRepoPath(repoRelativePath: string): boolean {
  if (repoRelativePath === '.git' || repoRelativePath.startsWith('.git/')) return true
  const slash = repoRelativePath.lastIndexOf('/')
  const base = slash === -1 ? repoRelativePath : repoRelativePath.slice(slash + 1)
  return isSensitiveName(base)
}

// MARK: - git 输出解析（全部按 NUL 切分，不按换行——§4.4）

export type PorcelainEntry = {
  /** `changed`（type 1/2）、`unmerged`（u）、`untracked`（?）、`ignored`（!）。 */
  kind: 'changed' | 'unmerged' | 'untracked' | 'ignored'
  /** index vs HEAD 状态码（`1`/`2` 的 X；unmerged 取 XY 首字符）。 */
  indexStatus: string
  /** worktree vs index 状态码（Y）。 */
  worktreeStatus: string
  /** porcelain 的 `<sub>` 字段：以 `S` 开头 = 子模块路径（v1 不下钻）。 */
  subField: string
  hH: string | null
  hI: string | null
  path: string
  renameFrom: string | null
}

/**
 * `git status --porcelain=v2 -z` 解析。
 *
 * 记录格式（字段以空格分隔、记录以 NUL 结尾；`-z` 下路径是**原始字节**，
 * 空格 / Tab / 换行 / Unicode 都在 `path` 里原样保留）：
 * - `1 XY sub mH mI mW hH hI <path>`
 * - `2 XY sub mH mI mW hH hI score <path>` NUL `<origPath>`（重命名多一段）
 * - `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`
 * - `? <path>` / `! <path>` / `# …`（branch 头，忽略）
 *
 * 固定字段数切分后再 `join(' ')` 还原路径：路径里的**连续空格 / 前导空格**
 * 也不会被拆坏（`split(' ')` 的空段在 join 时原样回来）。
 */
export function parsePorcelainV2(text: string): {
  entries: PorcelainEntry[]
  ignoredCount: number
  untrackedCount: number
  conflictedCount: number
} {
  const parts = text.split(NUL)
  const entries: PorcelainEntry[] = []
  let ignoredCount = 0
  let untrackedCount = 0
  let conflictedCount = 0

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]
    if (!record) continue
    const type = record[0]
    const rest = record.slice(2) // 类型后固定一个空格
    if (type === '1') {
      const f = rest.split(' ')
      entries.push({
        kind: 'changed',
        indexStatus: f[0]?.[0] ?? '.',
        worktreeStatus: f[0]?.[1] ?? '.',
        subField: f[1] ?? 'N...',
        hH: f[5] ?? null,
        hI: f[6] ?? null,
        path: f.slice(7).join(' '),
        renameFrom: null
      })
    } else if (type === '2') {
      const f = rest.split(' ')
      entries.push({
        kind: 'changed',
        indexStatus: f[0]?.[0] ?? '.',
        worktreeStatus: f[0]?.[1] ?? '.',
        subField: f[1] ?? 'N...',
        hH: f[5] ?? null,
        hI: f[6] ?? null,
        path: f.slice(8).join(' '),
        // 重命名记录的下一段 NUL 字段是原路径
        renameFrom: parts[i + 1] ?? null
      })
      i += 1
    } else if (type === 'u') {
      const f = rest.split(' ')
      conflictedCount += 1
      entries.push({
        kind: 'unmerged',
        indexStatus: f[0]?.[0] ?? 'u',
        worktreeStatus: f[0]?.[1] ?? 'u',
        subField: f[1] ?? 'N...',
        hH: null,
        hI: null,
        path: f.slice(9).join(' '),
        renameFrom: null
      })
    } else if (type === '?') {
      untrackedCount += 1
      entries.push({
        kind: 'untracked',
        indexStatus: '?',
        worktreeStatus: '?',
        subField: 'N...',
        hH: null,
        hI: null,
        path: rest,
        renameFrom: null
      })
    } else if (type === '!') {
      ignoredCount += 1
      entries.push({
        kind: 'ignored',
        indexStatus: '!',
        worktreeStatus: '!',
        subField: 'N...',
        hH: null,
        hI: null,
        path: rest,
        renameFrom: null
      })
    }
    // '#' branch 头与未知记录类型：向前兼容地忽略
  }
  return { entries, ignoredCount, untrackedCount, conflictedCount }
}

/** `git ls-files -s -z` 的记录数（= tracked 文件数；冲突文件占多个 stage 仍按路径算）。 */
export function countTrackedPaths(text: string): number {
  const seen = new Set<string>()
  for (const record of text.split(NUL)) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab >= 0) seen.add(record.slice(tab + 1))
  }
  return seen.size
}

/** 单条 `ls-tree -z` 记录：`<mode> SP <type> SP <sha> TAB <path>`。 */
function parseLsTreeRecord(record: string): { mode: string; type: string; sha: string; path: string } | null {
  if (!record) return null
  const tab = record.indexOf('\t')
  if (tab < 0) return null
  const head = record.slice(0, tab).split(' ')
  if (head.length < 3) return null
  const type = head[1]
  return {
    mode: head[0],
    type: type === 'blob' || type === 'tree' || type === 'commit' ? type : 'blob',
    sha: head[2],
    path: record.slice(tab + 1)
  }
}

/** `git ls-tree -z <sha> -- <path>` → 首条；无匹配返回 null。 */
export function parseLsTree(text: string): { mode: string; type: string; sha: string; path: string } | null {
  return parseLsTreeRecord(text.split(NUL)[0] ?? '')
}

/**
 * `git ls-tree -r -z --full-tree HEAD` 全量解析（R6-4.3.2.1 修复一）。
 * 按 NUL 切分——中文 / 空格 / Tab / 换行等文件名原样保留（§4.4）。
 */
export function parseLsTreeAll(text: string): GitTreeEntry[] {
  const entries: GitTreeEntry[] = []
  for (const record of text.split(NUL)) {
    const parsed = parseLsTreeRecord(record)
    if (parsed) {
      entries.push({
        path: parsed.path,
        mode: parsed.mode,
        type: parsed.type as GitTreeEntry['type'],
        sha: parsed.sha
      })
    }
  }
  return entries
}

/**
 * Symlink 目标脱敏（R6-4.3.2.1 修复二 §四.7-9）：
 * - **绝对目标一律替换为占位符**——绝不把机器绝对路径写进对外 Diff；
 * - 相对目标是链接文本本身（不含机器信息），过一遍 `redactSecrets` 兜底。
 */
export function sanitizeLinkTarget(target: string): string {
  if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(target)) return '<absolute-target>'
  return redactSecrets(target)
}

/** 状态码 → 变更种类（`.` / `u` 等不产生种类）。 */
export function changeKindFromStatusCode(code: string): GitChangeKind | null {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      // copy 按新增处理（v1 不单独建 kind）
      return 'added'
    case 'T':
      return 'type_changed'
    default:
      return null
  }
}

// MARK: - 行切分

export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: true }
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  return { lines: body.split('\n'), trailingNewline }
}

// MARK: - Myers 差分（O(ND)，带操作预算）

export type DiffOp = { type: 'eq' | 'del' | 'ins'; ai: number; bi: number }

/**
 * 行级编辑脚本。超出 `opBudget` 返回 null（调用方标 `algorithm_budget`，
 * **绝不返回半截脚本冒充完整结果**）。
 */
export function diffLineOps(
  a: string[],
  b: string[],
  opBudget: number = GIT_DIFF_ALGO_OP_BUDGET
): DiffOp[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let ops = 0
  let found = false

  outer: for (let d = 0; d <= max; d++) {
    // 进入第 d 轮**之前**的快照 = V_{d-1}：回溯时按轮取用
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1] // 向下：插入 b 的一行
      } else {
        x = v[offset + k - 1] + 1 // 向右：删除 a 的一行
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
        ops++
        if (ops > opBudget) return null
      }
      v[offset + k] = x
      ops++
      if (ops > opBudget) return null
      if (x >= n && y >= m) {
        found = true
        break outer
      }
    }
  }
  if (!found) return null

  // 回溯：从 (n, m) 走回 (0, 0)
  const script: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = d === 0 ? 0 : vd[offset + prevK]
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      script.push({ type: 'eq', ai: x, bi: y })
    }
    if (d > 0) {
      if (x === prevX) {
        y--
        script.push({ type: 'ins', ai: x, bi: y })
      } else {
        x--
        script.push({ type: 'del', ai: x, bi: y })
      }
    }
  }
  script.reverse()
  return script
}

// MARK: - Unified Diff 组装（§9 配额在这一层执行）

export type UnifiedDiffOutcome =
  | { kind: 'diff'; text: string; insertions: number; deletions: number }
  /** 行数 / hunk / 字节超配额：丢弃文本、**保留统计**（§九）。 */
  | { kind: 'file_budget'; insertions: number; deletions: number }
  /** 算法预算耗尽：统计也不可得（null，绝不冒充 0）。 */
  | { kind: 'algorithm_budget' }

type HunkRange = { lo: number; hi: number }

/**
 * 生成 Unified Diff 文本（有限上下文 3 行、`@@ -a,b +c,d @@`、
 * `\ No newline at end of file` 标记、Unicode 原样）。
 *
 * 配额（超出 → `file_budget`，保留 insertions/deletions）：
 * 单文件 64KB / 2000 渲染行（含 hunk 头） / 800 hunk。
 */
export function buildUnifiedDiff(
  before: string,
  after: string,
  options: { context?: number } = {}
): UnifiedDiffOutcome {
  const context = options.context ?? 3
  const a = splitLines(before)
  const b = splitLines(after)

  const script = diffLineOps(a.lines, b.lines)
  if (!script) return { kind: 'algorithm_budget' }

  let insertions = 0
  let deletions = 0
  for (const op of script) {
    if (op.type === 'ins') insertions++
    else if (op.type === 'del') deletions++
  }
  if (insertions === 0 && deletions === 0) return { kind: 'diff', text: '', insertions: 0, deletions: 0 }

  // 变更分组：间隔 ≤ 2*context 条 eq 的变更属于同一 hunk
  const changeIdx: number[] = []
  for (let i = 0; i < script.length; i++) {
    if (script[i].type !== 'eq') changeIdx.push(i)
  }
  const rawGroups: HunkRange[] = []
  let groupStart = changeIdx[0]
  let groupPrev = changeIdx[0]
  for (const i of changeIdx.slice(1)) {
    if (i - groupPrev <= context * 2 + 1) {
      groupPrev = i
    } else {
      rawGroups.push({ lo: groupStart, hi: groupPrev })
      groupStart = i
      groupPrev = i
    }
  }
  rawGroups.push({ lo: groupStart, hi: groupPrev })

  // 扩展上下文并合并重叠
  const expanded: HunkRange[] = []
  for (const group of rawGroups) {
    const lo = Math.max(0, group.lo - context)
    const hi = Math.min(script.length - 1, group.hi + context)
    const last = expanded[expanded.length - 1]
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi)
    else expanded.push({ lo, hi })
  }
  if (expanded.length > GIT_DIFF_MAX_HUNKS_PER_FILE) return { kind: 'file_budget', insertions, deletions }

  const out: string[] = []
  let renderedLines = 0
  let byteSize = 0
  const budgetFail = (): UnifiedDiffOutcome => ({ kind: 'file_budget', insertions, deletions })

  for (const range of expanded) {
    let oldCount = 0
    let newCount = 0
    let oldStart = -1
    let newStart = -1
    for (let i = range.lo; i <= range.hi; i++) {
      const op = script[i]
      if (op.type === 'eq' || op.type === 'del') {
        oldCount++
        if (oldStart === -1) oldStart = op.ai + 1
      }
      if (op.type === 'eq' || op.type === 'ins') {
        newCount++
        if (newStart === -1) newStart = op.bi + 1
      }
    }
    // count 为 0 时 git 的约定：start 写「插入点前的行数」（纯插入/纯删除头）
    if (oldStart === -1) oldStart = firstIndex(script, range, 'ins', 'ai')
    if (newStart === -1) newStart = firstIndex(script, range, 'del', 'bi')

    const header = `@@ -${fmtRange(oldStart, oldCount)} +${fmtRange(newStart, newCount)} @@`
    out.push(header)
    renderedLines++
    byteSize += Buffer.byteLength(header) + 1
    if (renderedLines > GIT_DIFF_MAX_LINES_PER_FILE || byteSize > GIT_DIFF_MAX_BYTES_PER_FILE) {
      return budgetFail()
    }

    for (let i = range.lo; i <= range.hi; i++) {
      const op = script[i]
      let line: string
      if (op.type === 'eq') line = ` ${a.lines[op.ai]}`
      else if (op.type === 'del') line = `-${a.lines[op.ai]}`
      else line = `+${b.lines[op.bi]}`
      out.push(line)
      renderedLines++
      const bytes = Buffer.byteLength(line) + 1
      byteSize += bytes
      if (renderedLines > GIT_DIFF_MAX_LINES_PER_FILE || byteSize > GIT_DIFF_MAX_BYTES_PER_FILE) {
        return budgetFail()
      }
      // `\ No newline at end of file`：该侧最后一行且该侧没有结尾换行
      const noNewlineA = !a.trailingNewline && op.ai === a.lines.length - 1 && op.type !== 'ins'
      const noNewlineB = !b.trailingNewline && op.bi === b.lines.length - 1 && op.type !== 'del'
      if (noNewlineA || noNewlineB) {
        out.push('\\ No newline at end of file')
        renderedLines++
        byteSize += Buffer.byteLength('\\ No newline at end of file') + 1
        if (renderedLines > GIT_DIFF_MAX_LINES_PER_FILE || byteSize > GIT_DIFF_MAX_BYTES_PER_FILE) {
          return budgetFail()
        }
      }
    }
  }

  return { kind: 'diff', text: out.join('\n'), insertions, deletions }
}

/** 纯插入/纯删除 hunk 的起始行号（count=0 时 git 写插入点前的行数）。 */
function firstIndex(script: DiffOp[], range: HunkRange, type: DiffOp['type'], field: 'ai' | 'bi'): number {
  for (let i = range.lo; i <= range.hi; i++) {
    if (script[i].type === type) return script[i][field]
  }
  return 0
}

/** git 风格的范围：count === 1 时省略 `,1`。 */
function fmtRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`
}
