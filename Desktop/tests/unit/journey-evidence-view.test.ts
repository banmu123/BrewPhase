import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { JourneyDetail, JourneyEventDTO, JourneyEvidence, JourneyEvidenceSnapshot, JourneyEvidenceFile } from '@shared/contracts'
import { JOURNEY_DETAIL_KEY } from '@shared/contracts'
import { zhCN } from '../../src/renderer/src/i18n/messages/zh-CN'
import {
  createJourneyDetailLoader,
  createJourneyEvidenceLoader,
  evidenceLoadFailure,
  evidenceLoadStart,
  evidenceLoadSuccess,
  INITIAL_EVIDENCE_LOAD_STATE,
  journeyEvidenceViews,
  type JourneyEvidenceLoadState
} from '../../src/renderer/src/features/records/journey-evidence-view'

/**
 * P5.1：Evidence 数据接入状态机与时间线展示规则（纯函数，零 React）。
 *
 * 本仓库没有 renderer 测试设施（无 testing-library / jsdom），所以按
 * `journey-workspace-view.ts` 的既定模式：状态机、竞态守卫、展示映射全部
 * 在可单测的纯模块里，组件只照 view model 渲染。
 * 覆盖 §八 的 1/2/3/4/5/6/8/9/10（7 的 fail-closed 在 main 侧集成测试）。
 */

const evidenceT = zhCN.records.journey.evidence

// MARK: - 夹具

function makeChange(path: string, overrides: Record<string, unknown> = {}) {
  return {
    file_path: path,
    change_type: 'modified',
    change_summary: '调整了该文件的处理逻辑',
    before_behavior: '原先同步处理全部输入',
    after_behavior: '现在按窗口分批处理输入',
    why_this_location: '该模块拥有这条数据通路的处理规则',
    ...overrides
  }
}

function makeEvent(input: {
  id?: string
  sequence: number
  changes?: ReturnType<typeof makeChange>[]
  eventType?: string
}): JourneyEventDTO {
  const changes = input.changes && input.changes.length > 0 ? input.changes : null
  return {
    id: input.id ?? randomUUID(),
    journey_id: randomUUID(),
    sequence: input.sequence,
    event_type: input.eventType ?? 'execution',
    role: 'agent',
    status: 'completed',
    title: '执行',
    summary: '',
    content: '',
    reason: '',
    source_agent: 'codex',
    model: 'gpt',
    evidence_level: 'agent_reported',
    occurred_at: 1,
    updated_at: 1,
    metadata: changes ? { [JOURNEY_DETAIL_KEY]: { version: 1, changes } } : null
  }
}

function makeFile(path: string, overrides: Partial<JourneyEvidenceFile> = {}): JourneyEvidenceFile {
  return {
    id: randomUUID(),
    repo_relative_path: path,
    change_kind: 'modified',
    status_origin: 'worktree',
    content_hash_before: 'hash-before',
    content_hash_after: 'hash-after',
    pre_existing_dirty: false,
    head_moved: false,
    rename_from_path: null,
    insertions: 3,
    deletions: 1,
    line_ranges: null,
    artifact_kind: 'diff',
    artifact_status: 'available',
    artifact_omission: null,
    observation_status: 'changed',
    attribution: null,
    attribution_confidence: null,
    ...overrides
  }
}

function makeSnapshot(
  type: 'execution_start' | 'execution_end',
  eventId: string | null,
  overrides: Partial<JourneyEvidenceSnapshot> = {}
): JourneyEvidenceSnapshot {
  return {
    id: randomUUID(),
    journey_id: randomUUID(),
    workspace_id: randomUUID(),
    execution_event_id: eventId,
    snapshot_type: type,
    trigger_key: `${type}:${eventId ?? 'x'}`,
    capture_status: 'ok',
    comparison_status: type === 'execution_end' ? 'complete' : 'not_applicable',
    error_code: null,
    captured_at: 1_000,
    repository_identity: 'a'.repeat(32),
    repository_root_identifier: 'repo#aaaaaa',
    branch: 'main',
    head_sha: 'head-1',
    tree_sha: 'b'.repeat(40),
    index_state_hash: 'c'.repeat(64),
    worktree_state_hash: 'd'.repeat(64),
    is_git: true,
    is_worktree: true,
    is_submodule: false,
    has_unborn_head: false,
    counts: { tracked: 2, staged: 0, unstaged: 1, untracked: 0, ignored: 0 },
    changed_files_count: 0,
    insertions: 0,
    deletions: 0,
    files: [],
    ...overrides
  }
}

function detailOf(...events: JourneyEventDTO[]): Pick<JourneyDetail, 'events'> {
  return { events }
}

function loadedState(snapshots: readonly JourneyEvidenceSnapshot[]): JourneyEvidenceLoadState {
  return {
    status: 'loaded',
    seq: 1,
    evidence: { journey_id: randomUUID(), snapshots: [...snapshots] } satisfies JourneyEvidence
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 刷新微任务队列：让 then 回调稳定执行（比连续 await Promise.resolve 可靠）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** loaded → snapshots；非 loaded → null（断言时先收窄，避免 TS 无法收窄方法调用结果）。 */
function snapshotsOf(state: JourneyEvidenceLoadState) {
  return state.status === 'loaded' ? state.evidence.snapshots : null
}

// MARK: - 状态机（workspace-list 同款判别联合）

describe('Evidence 读取状态机', () => {
  it('loading / loaded / failed 是三个不同状态；空快照算 loaded（空 ≠ 未加载）', () => {
    const loading = evidenceLoadStart(INITIAL_EVIDENCE_LOAD_STATE, 1, true)
    expect(loading).toEqual({ status: 'loading', seq: 1 })
    expect(loading).not.toHaveProperty('evidence')

    const loaded = evidenceLoadSuccess(loading, 1, {
      journey_id: randomUUID(),
      snapshots: []
    })
    expect(loaded.status).toBe('loaded')
    // 空数组 = 这条 Journey 确实没有证据，不是「没加载」也不是「失败」
    expect(loaded.status === 'loaded' && loaded.evidence.snapshots).toEqual([])

    // failure 携带的是「本次读取」的序号（由 start 推进）——失败态同样不带数据
    const advanced = evidenceLoadStart(loaded, 2, false)
    const failed = evidenceLoadFailure(advanced, 2)
    expect(failed).toEqual({ status: 'failed', seq: 2 })
    expect(failed).not.toHaveProperty('evidence') // 失败绝不携带「没有证据」的空数据

    // 过期序号原样丢弃：状态已推进到 2，旧结果（序号 1）不得覆盖较新状态
    expect(evidenceLoadFailure(advanced, 1)).toEqual(advanced)
    expect(evidenceLoadSuccess(advanced, 1, { journey_id: randomUUID(), snapshots: [] })).toEqual(
      advanced
    )
  })

  it('后台刷新（initial=false）不闪回 loading：loaded 保持 loaded、failed 保持 failed', () => {
    const loaded = evidenceLoadSuccess(
      evidenceLoadStart(INITIAL_EVIDENCE_LOAD_STATE, 1, true),
      1,
      { journey_id: randomUUID(), snapshots: [] }
    )
    expect(evidenceLoadStart(loaded, 2, false).status).toBe('loaded')
    const failed = evidenceLoadFailure(evidenceLoadStart(loaded, 2, false), 2)
    expect(evidenceLoadStart(failed, 3, false).status).toBe('failed')
    const stillLoading = evidenceLoadStart(
      evidenceLoadStart(INITIAL_EVIDENCE_LOAD_STATE, 1, true),
      2,
      false
    )
    expect(stillLoading.status).toBe('loading')
  })
})

// MARK: - 取数 loader 竞态（§八.5 / 8 / 9）

describe('Evidence 取数 loader（真实竞态行为）', () => {
  it('打开即 loading → 成功 loaded；查询失败 → failed；retry 回到 loading 再成功', async () => {
    const states: JourneyEvidenceLoadState[] = []
    const first = deferred<JourneyEvidence>()
    const second = deferred<JourneyEvidence>()
    let fetchCall = 0
    const loader = createJourneyEvidenceLoader({
      fetchEvidence: () => (fetchCall++ === 0 ? first.promise : second.promise),
      onChange: (state) => states.push(state)
    })

    loader.open('journey-1')
    expect(states.at(-1)?.status).toBe('loading')
    first.resolve({ journey_id: randomUUID(), snapshots: [] })
    await flushMicrotasks()
    expect(states.at(-1)?.status).toBe('loaded')

    loader.retry()
    expect(states.at(-1)?.status).toBe('loading') // retry 是 initial 语义
    second.reject(new Error('boom'))
    await flushMicrotasks()
    expect(states.at(-1)?.status).toBe('failed') // 失败是独立状态，不是「没有证据」
    expect(snapshotsOf(states.at(-1)!)).toBeNull()
    loader.dispose()
  })

  it('§八.8：领域更新后 refresh() 重新取数并应用新 Evidence（事件更新 → 证据刷新）', async () => {
    let call = 0
    const states: JourneyEvidenceLoadState[] = []
    const loader = createJourneyEvidenceLoader({
      fetchEvidence: async () => {
        call += 1
        return {
          journey_id: randomUUID(),
          snapshots: call === 1 ? [] : [makeSnapshot('execution_end', randomUUID())]
        }
      },
      onChange: (state) => states.push(state)
    })

    loader.open('journey-1')
    await flushMicrotasks()
    expect(states.at(-1)?.status).toBe('loaded')
    expect(snapshotsOf(states.at(-1)!)).toHaveLength(0) // 首次：还没有证据

    loader.refresh() // 模拟收到 agentJourneys 领域更新（事件更新 → 证据刷新）
    expect(states.at(-1)?.status).toBe('loaded') // 后台刷新不闪回 loading
    await flushMicrotasks()
    expect(snapshotsOf(states.at(-1)!)).toHaveLength(1) // 应用了新 Evidence
    expect(call).toBe(2)
    loader.dispose()
  })

  it('§八.9：快速切换 Journey——旧请求晚到不覆盖新 Journey 的证据', async () => {
    const slow = deferred<JourneyEvidence>()
    const fast = deferred<JourneyEvidence>()
    const seen: Array<{ id: string; state: JourneyEvidenceLoadState }> = []
    const loader = createJourneyEvidenceLoader({
      fetchEvidence: (journeyId) => (journeyId === 'old' ? slow.promise : fast.promise),
      onChange: () => undefined
    })
    void seen

    const states: JourneyEvidenceLoadState[] = []
    const switching = createJourneyEvidenceLoader({
      fetchEvidence: (journeyId) => (journeyId === 'old' ? slow.promise : fast.promise),
      onChange: (state) => states.push(state)
    })
    switching.open('old') // 在途、未返回
    switching.open('new') // 立即切换：旧序号作废
    fast.resolve({ journey_id: randomUUID(), snapshots: [] })
    await flushMicrotasks()
    expect(states.at(-1)?.status).toBe('loaded')

    // 旧 Journey 的结果此刻才到 → 必须被丢弃（不覆盖新详情）
    slow.resolve({
      journey_id: randomUUID(),
      snapshots: [makeSnapshot('execution_end', randomUUID())]
    })
    await flushMicrotasks()
    expect(snapshotsOf(states.at(-1)!)).toHaveLength(0)
    switching.dispose()
    void loader
  })

  it('卸载（dispose）后在途结果不写回状态', async () => {
    const pending = deferred<JourneyEvidence>()
    const states: JourneyEvidenceLoadState[] = []
    const loader = createJourneyEvidenceLoader({
      fetchEvidence: () => pending.promise,
      onChange: (state) => states.push(state)
    })
    loader.open('journey-1')
    expect(states.at(-1)?.status).toBe('loading')
    loader.dispose()
    pending.resolve({ journey_id: randomUUID(), snapshots: [] })
    await flushMicrotasks()
    expect(states).toHaveLength(1) // dispose 后没有任何状态写回
  })
})

describe('Journey 详情重取 loader（§四.3 / §八.9）', () => {
  it('快速切换：旧 id 的详情晚到不覆盖新详情', async () => {
    const slow = deferred<JourneyDetail>()
    const fast = deferred<JourneyDetail>()
    const seen: Array<JourneyDetail | null> = []
    const loader = createJourneyDetailLoader({
      fetchDetail: (id) => (id === 'old' ? slow.promise : fast.promise),
      onChange: (detail) => seen.push(detail)
    })
    const oldDetail = { events: [makeEvent({ sequence: 1 })] } as unknown as JourneyDetail
    const newDetail = { events: [makeEvent({ sequence: 2 })] } as unknown as JourneyDetail

    loader.open('old')
    loader.open('new')
    fast.resolve(newDetail)
    await flushMicrotasks()
    expect(seen.at(-1)).toBe(newDetail)

    slow.resolve(oldDetail) // 旧请求晚到 → 作废
    await flushMicrotasks()
    expect(seen.at(-1)).toBe(newDetail)
    loader.dispose()
  })

  it('领域更新 refresh() 重取：保留旧值直到新值到达；open(null) 清空；dispose 后不写回', async () => {
    const first = deferred<JourneyDetail>()
    const second = deferred<JourneyDetail>()
    const third = deferred<JourneyDetail>()
    const pending = [first.promise, second.promise, third.promise]
    let call = 0
    const seen: Array<JourneyDetail | null> = []
    const loader = createJourneyDetailLoader({
      fetchDetail: () => pending[call++],
      onChange: (detail) => seen.push(detail)
    })
    const detailA = { events: [makeEvent({ sequence: 1 })] } as unknown as JourneyDetail
    const detailB = { events: [makeEvent({ sequence: 2 })] } as unknown as JourneyDetail

    loader.open('journey-1')
    first.resolve(detailA)
    await flushMicrotasks()
    expect(seen).toEqual([detailA])

    loader.refresh() // 刷新期间**不先清空**：旧值保留到新值到达
    expect(seen).toEqual([detailA])
    second.resolve(detailB)
    await flushMicrotasks()
    expect(seen).toEqual([detailA, detailB])

    loader.open(null)
    expect(seen.at(-1)).toBeNull() // 关闭详情 → 清空

    loader.dispose()
    loader.refresh() // dispose 后：既不发新请求、也不写回
    expect(call).toBe(2)
    third.resolve(detailA)
    await flushMicrotasks()
    expect(seen.at(-1)).toBeNull()
  })
})

// MARK: - 时间线展示视图（§五）

describe('时间线 Evidence 视图', () => {
  it('§八.1：三类归因行齐全，计数分别呈现', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [makeChange('src/both.ts'), makeChange('src/ghost.ts')]
    })
    const snapshots = [
      makeSnapshot('execution_start', event.id),
      makeSnapshot('execution_end', event.id, {
        files: [makeFile('src/both.ts'), makeFile('src/system-only.ts')]
      })
    ]
    const views = journeyEvidenceViews(loadedState(snapshots), detailOf(event))
    expect(views).not.toBeNull()
    const view = views!.get(event.id)!
    expect(view.counts).toEqual({
      reported: 2, // both + ghost
      observed: 2, // both + system-only
      matched: 1,
      reportedOnly: 1,
      observedOnly: 1
    })
    const attributions = view.fileRows.map((row) => row.attribution).sort()
    expect(attributions).toEqual(['observed_only', 'reported_and_observed', 'reported_only'])
    // 两侧来源分块的数据都在（组件据此渲染两个带标签的块）
    const both = view.fileRows.find((row) => row.attribution === 'reported_and_observed')!
    expect(both.reported?.changeSummary).toBeTruthy()
    expect(both.observed?.changeKind).toBe('modified')
    const observedOnly = view.fileRows.find((row) => row.attribution === 'observed_only')!
    expect(observedOnly.reported).toBeNull()
    expect(observedOnly.observed).not.toBeNull()
    const reportedOnly = view.fileRows.find((row) => row.attribution === 'reported_only')!
    expect(reportedOnly.reported).not.toBeNull()
    expect(reportedOnly.observed).toBeNull()
  })

  it('§八.2：三种窗口置信度透传；zh 文案逐字存在且 window_net_change 不显示成完全确认', () => {
    expect(evidenceT.confidence.confirmed).toBe('观察窗口完整，结论可靠')
    expect(evidenceT.confidence.window_net_change).toBe('窗口内 HEAD 有变动，只能确认净变化')
    expect(evidenceT.confidence.unconfirmed).toBe('基线或结束快照缺失，无法确认')
    // 三者互不相同——window_net_change 绝不能显示成 confirmed 的文案
    const labels = [
      evidenceT.confidence.confirmed,
      evidenceT.confidence.window_net_change,
      evidenceT.confidence.unconfirmed
    ]
    expect(new Set(labels).size).toBe(3)

    // 视图层原样透传（组件按 key 取文案）
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const headMoved = [
      makeSnapshot('execution_start', event.id, { head_sha: 'sha-1' }),
      makeSnapshot('execution_end', event.id, { head_sha: 'sha-2', files: [makeFile('src/a.ts')] })
    ]
    const view = journeyEvidenceViews(loadedState(headMoved), detailOf(event))!.get(event.id)!
    expect(view.confidence).toBe('window_net_change')
  })

  it('§八.3/4：零文件空态按窗口完整性分两种文案——不完整绝不给确定性结论', () => {
    const completeEvent = makeEvent({ sequence: 1 })
    const incompleteEvent = makeEvent({ sequence: 2 })
    const snapshots = [
      makeSnapshot('execution_start', completeEvent.id),
      makeSnapshot('execution_end', completeEvent.id), // 完整窗口、零文件
      makeSnapshot('execution_start', incompleteEvent.id) // 缺 end
    ]
    const views = journeyEvidenceViews(
      loadedState(snapshots),
      detailOf(completeEvent, incompleteEvent)
    )!
    const complete = views.get(completeEvent.id)!
    expect(complete.confidence).toBe('confirmed')
    expect(complete.emptyKind).toBe('complete')
    expect(complete.fileRows).toEqual([])
    expect(evidenceT.emptyComplete).toBe('观察窗口完整，本次未发现净文件变化。')

    const incomplete = views.get(incompleteEvent.id)!
    expect(incomplete.confidence).toBe('unconfirmed')
    expect(incomplete.emptyKind).toBe('incomplete')
    expect(evidenceT.emptyIncomplete).toBe('观察窗口未完整，暂时无法确认文件变化。')
    // 两种空态文案互斥：不完整时绝不出现「未发现变化」的确定性结论
    expect(evidenceT.emptyIncomplete).not.toBe(evidenceT.emptyComplete)
    expect(incomplete.emptyKind).not.toBe('complete')
  })

  it('§八.5：查询失败 / 加载中 → 视图返回 null（事件不会被标成「没有证据」）', () => {
    const event = makeEvent({ sequence: 1 })
    const detail = detailOf(event)
    const failed: JourneyEvidenceLoadState = { status: 'failed', seq: 3 }
    const loading: JourneyEvidenceLoadState = { status: 'loading', seq: 4 }
    expect(journeyEvidenceViews(failed, detail)).toBeNull()
    expect(journeyEvidenceViews(loading, detail)).toBeNull()
    // loaded 但确实没有该事件的证据 → Map 存在但取不到（区别于 null）
    const loaded = journeyEvidenceViews(loadedState([]), detail)!
    expect(loaded).toBeInstanceOf(Map)
    expect(loaded.get(event.id)).toBeUndefined()
  })

  it('§八.6：历史 NULL observation_status 原样保留；zh 有 legacy 文案、不伪造状态', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/legacy.ts')] })
    const snapshots = [
      makeSnapshot('execution_start', event.id),
      makeSnapshot('execution_end', event.id, {
        files: [
          makeFile('src/legacy.ts', {
            observation_status: null, // Migration 18 前的历史行
            artifact_kind: 'unavailable',
            artifact_status: 'omitted',
            artifact_omission: 'baseline_not_stored'
          })
        ]
      })
    ]
    const view = journeyEvidenceViews(loadedState(snapshots), detailOf(event))!.get(event.id)!
    expect(view.fileRows[0].observed?.observationStatus).toBeNull()
    expect(evidenceT.observation.legacy).toBe('历史记录未保存观察状态')
    expect(evidenceT.observation.changed).toBe('净变化已确定')
    expect(evidenceT.observation.unavailable).toBe('净变化不可判定')
  })

  it('文案安全：evidence 子树无指控性表达；reported_only 保留「不代表报告不真实」', () => {
    const zh = JSON.stringify(evidenceT)
    expect(zh).not.toMatch(/虚假|伪造|说谎|谎报|未执行/)
    expect(evidenceT.reportedOnlyHint).toContain('不代表报告不真实')
    expect(evidenceT.attribution.reported_only).toBe('仅 Agent 报告，未观察到净变化')
    // 三类归因文案与 shared 纯函数一致（同一事实、两种语言入口不冲突）
    expect(evidenceT.attribution.observed_only).toBe('仅系统观察到')
    expect(evidenceT.attribution.reported_and_observed).toBe('已报告并观察到')
  })
})

// MARK: - 边界：不读取 Diff 正文（§六 / §八.10）

describe('边界：时间线只读摘要元数据', () => {
  it('Records 列表 / JourneyDetail / 视图模块都不出现按需正文接口 evidenceArtifact', () => {
    // 时间线在 P5.1 只消费 evidence 快照（buildEvidenceComparison 输入），
    // 完整 Diff 正文按需读取属 P5.2——这三处绝不允许出现该调用。
    const files = [
      'src/renderer/src/features/records/RecordsPage.tsx',
      'src/renderer/src/features/records/JourneyDetail.tsx',
      'src/renderer/src/features/records/journey-evidence-view.ts'
    ]
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toContain('evidenceArtifact')
    }
    // 视图模块只依赖 buildEvidenceComparison（复用，不写第二套匹配算法）
    const viewModule = readFileSync('src/renderer/src/features/records/journey-evidence-view.ts', 'utf8')
    expect(viewModule).toContain('buildEvidenceComparison')
    expect(viewModule).not.toContain('fetch(')
  })
})
