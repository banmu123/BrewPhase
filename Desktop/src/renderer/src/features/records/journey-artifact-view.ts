import type { JourneyArtifact, JourneyArtifactBody } from '@shared/contracts'
import type { EvidenceFileRowView } from './journey-evidence-view'

/**
 * 单文件 Diff Artifact 的**按需读取状态机**与**呈现映射**（R6-P5.2）。
 *
 * 与 `journey-evidence-view.ts` 同一动机（无 renderer 测试设施 → 纯函数可单测）。
 * 四条硬约束：
 * 1. **点开才取**：只有用户点击「查看证据」才经详情层注入的取数函数
 *    （携带 journeyId + snapshotId + fileId 三元组）发起请求——
 *    打开 Journey、展开事件、刷新页面都**不**自动加载正文；
 * 2. **完整三元组**：读取必须携带 journeyId + execution_end 的 snapshotId +
 *    fileId，Renderer 永不传路径、永不直接碰文件系统或 git；
 * 3. **reported_only 没有 Workspace Observation** → 没有读取入口；
 * 4. **竞态沿用 request sequence 思想**：同一文件防重复并发、失败可重试、
 *    reset（切换 Journey / 关闭详情）后在途旧结果一律作废。
 */

// MARK: - 读取目标

export type ArtifactTarget = {
  journeyId: string
  snapshotId: string
  fileId: string
  /** 展示用仓库相对路径（来自 evidence DTO，不是文件系统路径）。 */
  path: string
  /** 展示用变化类型 token（i18n 由组件解析）。 */
  changeKind: string
}

/**
 * 文件行 → 可读取目标；返回 `null` 表示**不提供**读取入口：
 * - `reported_only`（无 observed）：没有 Workspace Observation，无从读取；
 * - 缺 `end_snapshot_id`：没有归属快照，三元组不完整；
 * - `artifact_status === 'absent'`：该记录本来就没有存 Artifact（组件显示
 *   「没有可读取的 Artifact」说明，而不是一个必然失败的按钮）。
 */
export function artifactFetchTarget(
  journeyId: string,
  endSnapshotId: string | null,
  row: EvidenceFileRowView
): ArtifactTarget | null {
  if (!row.observed) return null
  if (!endSnapshotId) return null
  if (row.observed.artifactStatus === 'absent') return null
  return {
    journeyId,
    snapshotId: endSnapshotId,
    fileId: row.observed.fileKey,
    path: row.path,
    changeKind: row.observed.changeKind
  }
}

// MARK: - Artifact 呈现映射

/**
 * Artifact body → 展示形态（i18n 中立；文案 key 由组件解析）。
 * **安全回退**：未来出现未知 kind / 未知省略原因时给 raw token，不崩、不编造。
 */
export type ArtifactBodyView =
  | { render: 'diff'; text: string; insertions: number; deletions: number }
  /** 二进制 / 敏感：只有「是什么」，永远没有正文。 */
  | { render: 'marker'; kind: 'binary' | 'sensitive' }
  | { render: 'modes'; modeBefore: string; modeAfter: string }
  | { render: 'symlink'; targetBefore: string | null; targetAfter: string | null }
  /** 超预算 / 不可生成：有原因与统计，**正文不可用 ≠ 没有变化**。 */
  | { render: 'stats'; kind: 'over_budget' | 'unavailable'; reason: string | null; insertions: number | null; deletions: number | null }
  /** 未知类型：原样透出 token，绝不伪造内容。 */
  | { render: 'unknown'; kind: string }

export function artifactBodyView(body: JourneyArtifactBody): ArtifactBodyView {
  switch (body.kind) {
    case 'diff':
      return {
        render: 'diff',
        text: body.text,
        insertions: body.insertions,
        deletions: body.deletions
      }
    case 'binary':
    case 'sensitive':
      return { render: 'marker', kind: body.kind }
    case 'mode_only':
      return { render: 'modes', modeBefore: body.mode_before, modeAfter: body.mode_after }
    case 'symlink':
      return {
        render: 'symlink',
        targetBefore: body.target_before,
        targetAfter: body.target_after
      }
    case 'over_budget':
    case 'unavailable':
      return {
        render: 'stats',
        kind: body.kind,
        reason: body.reason,
        insertions: body.insertions,
        deletions: body.deletions
      }
    default:
      // 契约演进后的新类型：安全回退（显示原始 kind，不崩、不假装有正文）
      return { render: 'unknown', kind: (body as { kind: string }).kind }
  }
}

// MARK: - Unified Diff 行分类

export type DiffLineView = {
  type: 'add' | 'del' | 'ctx' | 'meta'
  content: string
}

/**
 * Unified Diff 文本 → 行分类（**React 安全文本渲染**的前置数据——组件只放
 * 文本节点，绝不使用危险 HTML 注入）。
 *
 * 规则：首个 `@@` 之前（文件头 / `diff --git` 等）一律 `meta`；hunk 内
 * `+`/`-` 前缀区分增删、`\ No newline` 与后续文件头为 `meta`，其余为上下文。
 * 已持久化的正文受单文件 64 KB / 2000 行约束（引擎配额），整段渲染不会撑破弹层
 * （弹层另有 max-height + 双向滚动）。
 */
export function parseUnifiedDiff(text: string): DiffLineView[] {
  const lines: DiffLineView[] = []
  let inHunk = false
  for (const raw of text.split('\n')) {
    if (raw === '') continue // 仅末尾换行产生
    if (raw.startsWith('diff --git')) {
      inHunk = false
      lines.push({ type: 'meta', content: raw })
      continue
    }
    if (raw.startsWith('@@')) {
      inHunk = true
      lines.push({ type: 'meta', content: raw })
      continue
    }
    if (!inHunk) {
      lines.push({ type: 'meta', content: raw }) // index / --- / +++ / new file …
      continue
    }
    if (raw.startsWith('\\')) {
      lines.push({ type: 'meta', content: raw })
      continue
    }
    if (raw.startsWith('+')) lines.push({ type: 'add', content: raw })
    else if (raw.startsWith('-')) lines.push({ type: 'del', content: raw })
    else lines.push({ type: 'ctx', content: raw })
  }
  return lines
}

// MARK: - 按需读取状态机

export type ArtifactLoadState =
  | { status: 'loading'; seq: number }
  | { status: 'loaded'; seq: number; artifact: JourneyArtifact }
  | { status: 'failed'; seq: number }

export type ArtifactController = {
  /** 点击触发（重试复用同一入口）：内部决定「不重复发 / 用缓存 / 重新取」。 */
  load(target: ArtifactTarget): void
  /** 切换 Journey / 详情重置：清空缓存并作废在途结果（旧数据绝不泄漏）。 */
  reset(): void
  /** 卸载：之后不再发起、不再写回。 */
  dispose(): void
}

/**
 * 按需读取编排：状态以 **fileId** 为键（一行一态），序号按文件推进。
 *
 * - `loading` 中再次 `load` → 忽略（§六.6 防重复并发）；
 * - 已 `loaded` 再次 `load` → 用缓存，不重取（§六.9 重开同一文件）；
 * - `failed` 再次 `load` → 重新请求（§六.5 失败重试）；
 * - `reset()` 清空 seqs → 旧请求回来时对不上序号，直接作废（§六.7/8）；
 * - 返回的三元组必须与请求一致，错记录按失败处理（§七 归属一致性）。
 */
export function createArtifactController(deps: {
  fetchArtifact: (
    journeyId: string,
    snapshotId: string,
    fileId: string
  ) => Promise<JourneyArtifact>
  onChange: (states: ReadonlyMap<string, ArtifactLoadState>) => void
}): ArtifactController {
  const states = new Map<string, ArtifactLoadState>()
  const seqs = new Map<string, number>()
  let disposed = false

  function emit(): void {
    if (!disposed) deps.onChange(new Map(states))
  }

  return {
    load(target) {
      if (disposed) return
      const current = states.get(target.fileId)
      if (current?.status === 'loading') return // 防重复并发
      if (current?.status === 'loaded') return // 已读过 → 缓存
      const mySeq = (seqs.get(target.fileId) ?? 0) + 1
      seqs.set(target.fileId, mySeq)
      states.set(target.fileId, { status: 'loading', seq: mySeq })
      emit()
      deps.fetchArtifact(target.journeyId, target.snapshotId, target.fileId).then(
        (artifact) => {
          if (disposed || seqs.get(target.fileId) !== mySeq) return // 过期 / 已重置
          const owned =
            artifact.journey_id === target.journeyId &&
            artifact.snapshot_id === target.snapshotId &&
            artifact.file_id === target.fileId
          states.set(
            target.fileId,
            owned
              ? { status: 'loaded', seq: mySeq, artifact }
              : { status: 'failed', seq: mySeq } // 归属不一致 → 失败，绝不展示错记录
          )
          emit()
        },
        () => {
          if (disposed || seqs.get(target.fileId) !== mySeq) return
          states.set(target.fileId, { status: 'failed', seq: mySeq })
          emit()
        }
      )
    },
    reset() {
      states.clear()
      seqs.clear() // 在途结果回来时 seqs 对不上 → 作废
      emit()
    },
    dispose() {
      disposed = true
      states.clear()
      seqs.clear()
      // 卸载后不 emit（组件已不在）
    }
  }
}
