/**
 * Agent Reported ↔ Workspace Observed 对照（R6-4.3.4，P4，设计文档 §10）。
 *
 * **纯函数**：不碰数据库、文件系统、Git 子进程或 Renderer 状态；放 shared/
 * 是为了让 Records 时间线与 Canvas Inspector **同源**（一份实现、一份测试），
 * 并且**计算结果绝不回写数据库**——三类 attribution 只在读取时产生，
 * 不制造第二份事实来源（DB 里的 `attribution*` 列保持 NULL）。
 *
 * 数据来源（§10.1）：
 * - **Agent Reported**：`event.metadata.journey_detail_v1.changes[]`（Agent 自述，
 *   `evidence_level` 永远是 `agent_reported`）；
 * - **Workspace Observed**：该 Execution 的 `execution_end` 快照文件行
 *   （`journey_snapshot_files`，经 `execution_event_id` 关联）。
 *
 * 三条铁律：
 * 1. **按 Execution 窗口对照**：start/end 快照必须 `execution_event_id` 命中
 *    当前事件——绝不拿 Journey Final 或其他 Execution 的变化冒充本窗口；
 * 2. **路径只做 POSIX 精确匹配**：不忽略大小写、不去前缀、不按文件名猜、
 *    不跨 Workspace；重命名必须把 `previous_file_path` 与 `rename_from_path`
 *    对上；
 * 3. **`reported_only` 绝不等于「虚假/伪造/未执行」**——Agent 自述与工作区
 *    观察是两个独立事实来源，改后还原、窗口不完整、变化在窗口外都真实存在。
 */
import {
  parseJourneyDetail,
  type JourneyChange,
  type JourneyDetail,
  type JourneyEvidenceFile,
  type JourneyEvidenceSnapshot
} from '../contracts/entities/agent-journey'

// MARK: - 文案（规格 §6 / 设计 §10.2，zh 为准；i18n 属 P5）

export type EvidenceAttribution = 'reported_and_observed' | 'observed_only' | 'reported_only'

export type EvidenceConfidence = 'confirmed' | 'window_net_change' | 'unconfirmed'

/** 三类对照的 UI 文案。禁止出现「虚假 / 伪造 / 说谎 / 未执行」类表达。 */
export const EVIDENCE_ATTRIBUTION_TEXT: Record<
  EvidenceAttribution,
  { title: string; subtitle: string }
> = {
  reported_and_observed: {
    title: '已报告并观察到',
    subtitle: '该文件在本执行的观察窗口内出现了净变化。'
  },
  observed_only: {
    title: '仅系统观察到',
    subtitle: '工作区有变化，但本次执行的结构化详情未报告该文件。'
  },
  reported_only: {
    title: '仅 Agent 报告，未观察到净变化',
    subtitle: '可能是改后还原、观察时间不完整，或变化发生在窗口之外，不代表报告不真实。'
  }
}

/** 置信度与三分类**分开**输出（只显示一类会误导）。 */
export const EVIDENCE_CONFIDENCE_TEXT: Record<EvidenceConfidence, { title: string }> = {
  confirmed: { title: '观察窗口完整，结论可靠' },
  window_net_change: { title: '窗口内 HEAD 有变动，只能确认净变化' },
  unconfirmed: { title: '基线或结束快照缺失，无法确认' }
}

// MARK: - 输出类型

export type EvidenceComparisonEntry = {
  /** POSIX 仓库相对路径（两侧 join 键）。 */
  repo_relative_path: string
  attribution: EvidenceAttribution
  title: string
  subtitle: string
  /** Agent Reported 侧（observed_only 为 null）。 */
  agent_report: {
    change_type: string
    previous_file_path: string | null
    change_summary: string
    before_behavior: string | null
    after_behavior: string | null
    why_this_location: string
  } | null
  /**
   * Workspace Observed 侧（reported_only 为 null）。
   * `file_id` + 外层 `end_snapshot_id` 即按需取 Artifact 的三元组。
   */
  observation: {
    file_id: string
    change_kind: string
    insertions: number | null
    deletions: number | null
    rename_from_path: string | null
    artifact_kind: string | null
    artifact_status: 'available' | 'omitted' | 'absent'
    artifact_omission: string | null
  } | null
}

export type EvidenceExecutionComparison = {
  event_id: string
  event_type: string
  /** 窗口级置信度（与单文件分类独立，必须分行展示）。 */
  confidence: EvidenceConfidence
  confidence_title: string
  /** 观察窗口两份快照（null = 缺失 → confidence 必为 unconfirmed）。 */
  baseline_snapshot_id: string | null
  end_snapshot_id: string | null
  entries: EvidenceComparisonEntry[]
}

// MARK: - 主入口

/**
 * 对照整个 Journey：对每个**有证据可对照**的事件产出一份报告
 * （有 Agent 报告、或有该事件的观察窗口；两者皆无的事件跳过）。
 *
 * @param detail `agent-journeys:get` 的结果（本函数只消费 `events`）
 * @param snapshots 该 Journey 的全部快照（含文件明细）——内部按
 *   `execution_event_id` + 快照类型切窗口，跨 Execution 不可能串
 */
export function buildEvidenceComparison(
  detail: Pick<JourneyDetail, 'events'>,
  snapshots: readonly JourneyEvidenceSnapshot[]
): EvidenceExecutionComparison[] {
  const events = [...detail.events].sort((a, b) => a.sequence - b.sequence)
  const report: EvidenceExecutionComparison[] = []

  for (const event of events) {
    const reported: JourneyChange[] = parseJourneyDetail(event.metadata)?.changes ?? []
    // 窗口 = 同一 Execution 的 start/end；baseline / journey_final 的
    // execution_event_id 为 null，结构上不可能被当成某个窗口的观察结果。
    const start =
      snapshots.find(
        (snapshot) =>
          snapshot.execution_event_id === event.id &&
          snapshot.snapshot_type === 'execution_start'
      ) ?? null
    const end =
      snapshots.find(
        (snapshot) => snapshot.execution_event_id === event.id && snapshot.snapshot_type === 'execution_end'
      ) ?? null

    if (reported.length === 0 && !start && !end) continue // 无证据可对照

    const entries = compareEntries(reported, end?.files ?? [])
    if (entries.length === 0) continue

    const confidence = computeConfidence(start, end)
    report.push({
      event_id: event.id,
      event_type: event.event_type,
      confidence,
      confidence_title: EVIDENCE_CONFIDENCE_TEXT[confidence].title,
      baseline_snapshot_id: start?.id ?? null,
      end_snapshot_id: end?.id ?? null,
      entries
    })
  }
  return report
}

// MARK: - 三类对照

function compareEntries(
  reported: readonly JourneyChange[],
  observedFiles: readonly JourneyEvidenceFile[]
): EvidenceComparisonEntry[] {
  // 只有**已确认的净变化**才作为观察事实；不可判定的条目不宣称「观察到」
  const observed = observedFiles.filter(hasObservedNetChange)
  const entries: EvidenceComparisonEntry[] = []
  const consumed = new Set<number>()

  for (const change of reported) {
    const index = observed.findIndex((file, i) => !consumed.has(i) && matches(change, file))
    if (index >= 0) {
      consumed.add(index)
      // 重命名的旧路径观察行由该报告一并覆盖（它不是「未报告的文件」）
      if (change.change_type === 'renamed' && change.previous_file_path) {
        const companion = observed.findIndex(
          (file, i) => !consumed.has(i) && file.repo_relative_path === change.previous_file_path
        )
        if (companion >= 0) consumed.add(companion)
      }
      entries.push(buildEntry(change, observed[index], 'reported_and_observed'))
    } else {
      entries.push(buildEntry(change, null, 'reported_only'))
    }
  }
  observed.forEach((file, i) => {
    if (consumed.has(i)) return
    entries.push(buildEntry(null, file, 'observed_only'))
  })
  return entries
}

/**
 * 路径 join（§5.2）：**只允许 POSIX 仓库相对路径的精确字符串相等**。
 * 不忽略大小写、不删前缀、不按文件名匹配、不跨 Workspace。
 * 重命名两侧都有来源信息时必须一致（Agent `previous_file_path` ↔ 观察 `rename_from_path`）。
 */
function matches(change: JourneyChange, file: JourneyEvidenceFile): boolean {
  if (change.file_path !== file.repo_relative_path) return false
  if (change.change_type === 'renamed' && file.rename_from_path !== null) {
    if (change.previous_file_path !== file.rename_from_path) return false
  }
  return true
}

/**
 * 观察侧「已确认净变化」的重建规则（只读存量列，纯函数）：
 * 1. 重命名 / mode 变化 → 是（路径与权限位的净变化不依赖内容 hash）；
 * 2. 两侧内容 hash 严格不等（含 null↔value 的新增/删除）→ 是；
 * 3. 敏感文件（两侧 hash 按策略为空、artifact=sensitive）→ 是——
 *    `git status` 已证实状态变化，内容按隐私策略永不读取；
 * 4. 其余（两侧同值 = 改后还原 / 双空不可判定 / 单侧不可观测）→ **否**，
 *    宁可不宣称观察到，也不伪造。
 */
function hasObservedNetChange(file: JourneyEvidenceFile): boolean {
  if (file.change_kind === 'renamed' || file.change_kind === 'mode_changed') return true
  const before = file.content_hash_before
  const after = file.content_hash_after
  if (before !== null && after !== null) return before !== after
  if (before === null && after === null) return file.artifact_kind === 'sensitive'
  return file.change_kind === 'added' || file.change_kind === 'deleted'
}

// MARK: - 置信度

/**
 * 窗口级置信度（§5.4）——**只看窗口完整性与 HEAD 是否移动**，
 * 绝不根据某一个文件的 hash 就宣称整个 Execution 观察完整：
 * - 缺 start/end、任一侧采集失败、比较未完成（含 partial 观察不完整）
 *   → `unconfirmed`；
 * - 窗口完整但 HEAD 移动（或任一文件 `head_moved`）→ `window_net_change`；
 * - 窗口完整且 HEAD 未动 → `confirmed`。
 */
function computeConfidence(
  start: JourneyEvidenceSnapshot | null,
  end: JourneyEvidenceSnapshot | null
): EvidenceConfidence {
  if (!start || !end) return 'unconfirmed'
  if (start.capture_status !== 'ok' || end.capture_status !== 'ok') return 'unconfirmed'
  if (end.comparison_status !== 'complete') return 'unconfirmed'
  const headMoved =
    (start.head_sha ?? '') !== (end.head_sha ?? '') || end.files.some((file) => file.head_moved)
  return headMoved ? 'window_net_change' : 'confirmed'
}

// MARK: - 条目构造

function buildEntry(
  change: JourneyChange | null,
  file: JourneyEvidenceFile | null,
  attribution: EvidenceAttribution
): EvidenceComparisonEntry {
  const text = EVIDENCE_ATTRIBUTION_TEXT[attribution]
  return {
    repo_relative_path: change ? change.file_path : (file as JourneyEvidenceFile).repo_relative_path,
    attribution,
    title: text.title,
    subtitle: text.subtitle,
    agent_report: change
      ? {
          change_type: change.change_type,
          previous_file_path: change.previous_file_path ?? null,
          change_summary: change.change_summary,
          before_behavior: change.before_behavior ?? null,
          after_behavior: change.after_behavior ?? null,
          why_this_location: change.why_this_location
        }
      : null,
    observation: file
      ? {
          file_id: file.id,
          change_kind: file.change_kind,
          insertions: file.insertions,
          deletions: file.deletions,
          rename_from_path: file.rename_from_path,
          artifact_kind: file.artifact_kind,
          artifact_status: file.artifact_status,
          artifact_omission: file.artifact_omission
        }
      : null
  }
}
