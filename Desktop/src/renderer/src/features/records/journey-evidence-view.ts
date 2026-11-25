import type { JourneyDetail, JourneyEvidence } from '@shared/contracts'
import type { JourneyObservationStatus } from '@shared/contracts'
import {
  buildEvidenceComparison,
  type EvidenceAttribution,
  type EvidenceConfidence
} from '@shared/agent-journey/evidence-comparison'

/**
 * Journey Evidence 的**数据接入状态机**与**时间线展示规则**（R6-P5.1）。
 *
 * 与 `journey-workspace-view.ts` 同一动机：本仓库没有 renderer 测试设施
 * （无 testing-library / jsdom），所以「什么时候取数、旧请求怎么作废、
 * 每个事件展示什么」全部抽成纯函数——组件只照 view model 渲染。
 *
 * 四条硬约束（P5.1 §四 / §五）：
 * 1. **loading / loaded / failed 是三个不同状态**——绝不拿空数组顶替
 *    「还没加载」「查询失败」与「确实没有证据」；
 * 2. **序号守卫**：切换 Journey、刷新、卸载都会推进序号，在途旧结果一律
 *    作废——旧请求不得覆盖新数据，卸载后不再写状态；
 * 3. **复用 `buildEvidenceComparison()`**——Renderer 不再写第二套文件匹配
 *    算法，分类结果以纯函数为唯一事实；
 * 4. **本模块与组件都不接触 Artifact 正文**——只消费 evidence 快照元数据，
 *    按需读取正文的接口留给 P5.2（边界测试会扫源码确认这里没碰它）。
 */

// MARK: - Evidence 读取状态机

/**
 * 读取状态：判别联合，状态与数据永远一致——
 * - `loading` / `failed` 不带数据，不可能被误读成「确实没有证据」；
 * - `loaded` 必带 `JourneyEvidence`（`snapshots` 为空数组 = 这条 Journey
 *   确实没有采集过证据）；
 * - `seq` = 已发出的最新请求序号，结果对不上 = 过期请求，原样丢弃。
 */
export type JourneyEvidenceLoadState =
  | { status: 'loading'; seq: number }
  | { status: 'loaded'; seq: number; evidence: JourneyEvidence }
  | { status: 'failed'; seq: number }

/** 首次挂载前的初始状态：还没有任何请求完成过。 */
export const INITIAL_EVIDENCE_LOAD_STATE: JourneyEvidenceLoadState = {
  status: 'loading',
  seq: 0
}

/**
 * 发起一次读取（与 `workspaceListStart` 同语义）：
 * - `initial = true`（打开 / 切换 / 点重试）→ 进入 `loading`；
 * - `initial = false`（`agentJourneys` 领域更新触发的后台刷新）→ **保持当前
 *   状态**（loaded 继续显示、failed 继续显示重试），只推进序号，
 *   不让每次事件写入都让时间线闪一下「正在加载」。
 */
export function evidenceLoadStart(
  prev: JourneyEvidenceLoadState,
  seq: number,
  initial: boolean
): JourneyEvidenceLoadState {
  if (initial) return { status: 'loading', seq }
  // loaded 必须带数据（展开保留 evidence），loading / failed 本来就不带。
  if (prev.status === 'loaded') return { ...prev, seq }
  return { status: prev.status, seq }
}

/** 读取成功：即使快照为空也算 `loaded`（空 ≠ 未加载）。过期序号原样丢弃。 */
export function evidenceLoadSuccess(
  prev: JourneyEvidenceLoadState,
  seq: number,
  evidence: JourneyEvidence
): JourneyEvidenceLoadState {
  if (seq !== prev.seq) return prev
  return { status: 'loaded', seq, evidence }
}

/** 读取失败：明确失败态，**绝不**退化成「没有证据」。过期序号原样丢弃。 */
export function evidenceLoadFailure(
  prev: JourneyEvidenceLoadState,
  seq: number
): JourneyEvidenceLoadState {
  if (seq !== prev.seq) return prev
  return { status: 'failed', seq }
}

// MARK: - Evidence 取数 loader（可注入 fetch，便于单测真实竞态）

export type JourneyEvidenceLoader = {
  /** 打开 / 切换 Journey：清空旧数据 → loading → 立即取数。 */
  open(journeyId: string): void
  /** `agentJourneys` 领域更新：后台刷新（loaded/failed 不闪回 loading）。 */
  refresh(): void
  /** 失败后的重试入口：回到 loading 再取一次。 */
  retry(): void
  /** 卸载：推进序号并封笔——在途结果不再写回状态。 */
  dispose(): void
}

/**
 * 取数编排：内部持有 `seq` 与当前状态，把「切换不覆盖、刷新不闪、卸载不写」
 * 三条竞态规则变成可单测的行为。`fetchEvidence` 由组件注入
 * （生产 = `api.agentJourneys.evidence`——只读快照元数据，不含正文）。
 */
export function createJourneyEvidenceLoader(deps: {
  fetchEvidence: (journeyId: string) => Promise<JourneyEvidence>
  onChange: (state: JourneyEvidenceLoadState) => void
}): JourneyEvidenceLoader {
  let seq = 0
  let journeyId: string | null = null
  let disposed = false
  let state: JourneyEvidenceLoadState = INITIAL_EVIDENCE_LOAD_STATE

  function emit(): void {
    if (!disposed) deps.onChange(state)
  }

  function run(initial: boolean): void {
    const id = journeyId
    if (id === null || disposed) return
    const mySeq = ++seq
    state = evidenceLoadStart(state, mySeq, initial)
    emit()
    deps.fetchEvidence(id).then(
      (evidence) => {
        if (mySeq !== seq || disposed) return // 过期 / 已卸载：作废
        state = evidenceLoadSuccess(state, mySeq, evidence)
        emit()
      },
      () => {
        if (mySeq !== seq || disposed) return
        state = evidenceLoadFailure(state, mySeq)
        emit()
      }
    )
  }

  return {
    open(id) {
      journeyId = id
      // 切换 Journey：旧数据立即清空（绝不显示上一条 Journey 的证据），
      // run() 会推进序号让上一条的在途结果过期。
      run(true)
    },
    refresh() {
      run(false)
    },
    retry() {
      run(true)
    },
    dispose() {
      disposed = true
      seq += 1 // 在途结果同时被 seq 与 disposed 双重拦截
    }
  }
}

// MARK: - Journey 详情重取 loader（§四.3：事件更新后打开中的详情要刷新）

export type JourneyDetailLoader = {
  /** 传 null = 关闭详情（清空）；传 id = 立即取该详情。 */
  open(journeyId: string | null): void
  /** `agentJourneys` 领域更新：后台重取（保留旧值直到新值到达，不闪空）。 */
  refresh(): void
  dispose(): void
}

/**
 * 详情（events/edges/notes/links 全量）的序号守卫取数：
 * - **快速切换**：旧 id 的在途结果序号过期 → 不覆盖新详情（§八.9）；
 * - **领域更新刷新**：打开中的详情随 MCP / 笔记 / 证据写入变新（§四.3）；
 * - **卸载**：之后任何结果都不再写回。
 */
export function createJourneyDetailLoader(deps: {
  fetchDetail: (journeyId: string) => Promise<JourneyDetail>
  onChange: (detail: JourneyDetail | null) => void
}): JourneyDetailLoader {
  let seq = 0
  let journeyId: string | null = null
  let disposed = false

  function load(): void {
    const id = journeyId
    if (id === null || disposed) return
    const mySeq = ++seq
    deps.fetchDetail(id).then(
      (detail) => {
        if (mySeq !== seq || disposed) return
        deps.onChange(detail)
      },
      () => undefined // 详情刷新失败：保留旧值（列表层面已有错误提示）
    )
  }

  return {
    open(id) {
      journeyId = id
      if (id === null) {
        seq += 1 // 旧在途结果作废
        if (!disposed) deps.onChange(null)
        return
      }
      load()
    },
    refresh() {
      load()
    },
    dispose() {
      disposed = true
      seq += 1
    }
  }
}

// MARK: - 时间线展示视图

/** 单个文件条目的展示行（i18n 中立：文案 key 由组件解析）。 */
export type EvidenceFileRowView = {
  /** 列表 key：归因 + 路径（同一路径在不同归因下只会出现一次）。 */
  key: string
  path: string
  attribution: EvidenceAttribution
  /** Agent Reported 侧摘要（observed_only 为 null）。 */
  reported: {
    changeType: string
    changeSummary: string
    previousPath: string | null
  } | null
  /** Workspace Observed 侧摘要（reported_only 为 null）。 */
  observed: {
    fileKey: string
    changeKind: string
    insertions: number | null
    deletions: number | null
    renameFrom: string | null
    artifactKind: string | null
    artifactOmission: string | null
    observationStatus: JourneyObservationStatus | null
  } | null
}

export type EventEvidenceView = {
  eventId: string
  /** 窗口置信度（与文件条目各自独立展示，绝不合并）。 */
  confidence: EvidenceConfidence
  counts: {
    /** Agent Reported 文件数。 */
    reported: number
    /** Workspace Observed 文件数。 */
    observed: number
    /** 两侧匹配。 */
    matched: number
    /** 仅 Agent 报告。 */
    reportedOnly: number
    /** 仅工作区观察。 */
    observedOnly: number
  }
  /**
   * `entries` 为空时的空态（§五.4）：
   * - `complete`：完整 start/end、窗口完整 → 可以断言「未发现净变化」；
   * - `incomplete`：窗口不完整 → **不得**给确定性结论；
   * - `none`：有条目，不需要空态文案。
   */
  emptyKind: 'none' | 'complete' | 'incomplete'
  fileRows: EvidenceFileRowView[]
}

function buildEventView(comparison: {
  event_id: string
  confidence: EvidenceConfidence
  entries: ReturnType<typeof buildEvidenceComparison>[number]['entries']
}): EventEvidenceView {
  const matched = comparison.entries.filter(
    (entry) => entry.attribution === 'reported_and_observed'
  ).length
  const reportedOnly = comparison.entries.filter(
    (entry) => entry.attribution === 'reported_only'
  ).length
  const observedOnly = comparison.entries.filter(
    (entry) => entry.attribution === 'observed_only'
  ).length
  return {
    eventId: comparison.event_id,
    confidence: comparison.confidence,
    counts: {
      reported: matched + reportedOnly,
      observed: matched + observedOnly,
      matched,
      reportedOnly,
      observedOnly
    },
    emptyKind:
      comparison.entries.length > 0
        ? 'none'
        : comparison.confidence === 'unconfirmed'
          ? 'incomplete'
          : 'complete',
    fileRows: comparison.entries.map((entry): EvidenceFileRowView => ({
      key: `${entry.attribution}:${entry.repo_relative_path}`,
      path: entry.repo_relative_path,
      attribution: entry.attribution,
      reported: entry.agent_report
        ? {
            changeType: entry.agent_report.change_type,
            changeSummary: entry.agent_report.change_summary,
            previousPath: entry.agent_report.previous_file_path
          }
        : null,
      observed: entry.observation
        ? {
            fileKey: entry.observation.file_id,
            changeKind: entry.observation.change_kind,
            insertions: entry.observation.insertions,
            deletions: entry.observation.deletions,
            renameFrom: entry.observation.rename_from_path,
            artifactKind: entry.observation.artifact_kind,
            artifactOmission: entry.observation.artifact_omission,
            observationStatus: entry.observation.observation_status
          }
        : null
    }))
  }
}

/**
 * 每个事件的 Evidence 视图（按 `event_id` 索引）。
 *
 * **只在 `loaded` 时产出**——`loading` / `failed` 返回 null：查询失败时
 * 组件在区域层显示失败态与重试，绝不给事件渲染「没有证据」（§八.5）。
 * 复用 `buildEvidenceComparison()`：分类、置信度、历史兼容全部以纯函数为准。
 */
export function journeyEvidenceViews(
  state: JourneyEvidenceLoadState,
  detail: Pick<JourneyDetail, 'events'>
): Map<string, EventEvidenceView> | null {
  if (state.status !== 'loaded') return null
  const report = buildEvidenceComparison(detail, state.evidence.snapshots)
  return new Map(report.map((comparison) => [comparison.event_id, buildEventView(comparison)]))
}
