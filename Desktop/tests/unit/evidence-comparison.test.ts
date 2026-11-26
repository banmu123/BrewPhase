import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildEvidenceComparison,
  EVIDENCE_ATTRIBUTION_TEXT,
  EVIDENCE_CONFIDENCE_TEXT,
  legacyObservationIsDeterminate,
  type EvidenceExecutionComparison
} from '../../src/shared/agent-journey/evidence-comparison'
import {
  JOURNEY_DETAIL_KEY,
  type JourneyChange,
  type JourneyDetail,
  type JourneyEventDTO,
  type JourneyEvidenceFile,
  type JourneyEvidenceSnapshot
} from '../../src/shared/contracts/entities/agent-journey'

/**
 * `buildEvidenceComparison()` 纯函数表驱动测试（R6-4.3.4，设计文档 §10 / §16-P4）。
 * 不碰数据库 / 文件系统 / git——对照只依赖传入的 DTO。
 */

const JOURNEY = randomUUID()
const WORKSPACE = randomUUID()

// MARK: - 夹具

function makeChange(path: string, overrides: Partial<JourneyChange> = {}): JourneyChange {
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
  changes?: JourneyChange[]
  eventType?: string
}): JourneyEventDTO {
  const changes = input.changes && input.changes.length > 0 ? input.changes : null
  return {
    id: input.id ?? randomUUID(),
    journey_id: JOURNEY,
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
    observation_status: 'changed', // 新记录默认：引擎已输出并持久化观察状态
    attribution: null,
    attribution_confidence: null,
    ...overrides
  }
}

function makeSnapshot(
  type: 'baseline' | 'execution_start' | 'execution_end' | 'journey_final',
  eventId: string | null,
  overrides: Partial<JourneyEvidenceSnapshot> = {}
): JourneyEvidenceSnapshot {
  return {
    id: randomUUID(),
    journey_id: JOURNEY,
    workspace_id: WORKSPACE,
    execution_event_id: eventId,
    snapshot_type: type,
    trigger_key: `${type}:${eventId ?? 'journey'}`,
    capture_status: 'ok',
    comparison_status: type === 'execution_end' ? 'complete' : 'not_applicable',
    error_code: null,
    captured_at: 1_000,
    repository_identity: 'a'.repeat(32),
    repository_root_identifier: 'repo#aaaaaa',
    branch: 'main',
    head_sha: 'head-sha-1',
    tree_sha: 'b'.repeat(40),
    index_state_hash: 'c'.repeat(64),
    worktree_state_hash: 'd'.repeat(64),
    is_git: true,
    is_worktree: true,
    is_submodule: false,
    has_unborn_head: false,
    counts: { tracked: 3, staged: 0, unstaged: 2, untracked: 0, ignored: 0 },
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

function window(
  eventId: string,
  files: JourneyEvidenceFile[],
  overrides: {
    start?: Partial<JourneyEvidenceSnapshot>
    end?: Partial<JourneyEvidenceSnapshot>
  } = {}
): JourneyEvidenceSnapshot[] {
  return [
    makeSnapshot('execution_start', eventId, overrides.start),
    makeSnapshot('execution_end', eventId, { files, ...overrides.end })
  ]
}

function only(report: EvidenceExecutionComparison[]): EvidenceExecutionComparison {
  expect(report).toHaveLength(1)
  return report[0]
}

// MARK: - 三类对照

describe('三类对照结果（§5.3）', () => {
  it('同一窗口内同时产出 reported_and_observed / observed_only / reported_only，文案逐字正确', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [
        makeChange('src/both.ts'),
        makeChange('src/ghost.ts') // 报了但窗口内没观察到净变化
      ]
    })
    const snapshots = window(event.id, [
      makeFile('src/both.ts'),
      makeFile('src/system-only.ts') // 观察到但没报告
    ])

    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries.map((entry) => entry.attribution)).toEqual([
      'reported_and_observed',
      'reported_only',
      'observed_only'
    ])

    const [both, ghost, system] = report.entries
    expect(both.title).toBe('已报告并观察到')
    expect(both.subtitle).toBe('该文件在本执行的观察窗口内出现了净变化。')
    expect(both.agent_report?.change_summary).toBe('调整了该文件的处理逻辑')
    expect(both.observation?.file_id).toBeTruthy()

    expect(system.title).toBe('仅系统观察到')
    expect(system.subtitle).toBe('工作区有变化，但本次执行的结构化详情未报告该文件。')
    expect(system.agent_report).toBeNull()

    expect(ghost.title).toBe('仅 Agent 报告，未观察到净变化')
    expect(ghost.subtitle).toBe(
      '可能是改后还原、观察时间不完整，或变化发生在窗口之外，不代表报告不真实。'
    )
    expect(ghost.observation).toBeNull()
    // reported_only **绝不**等于指控：文案里不出现任何否定真实性/执行的词
    for (const entry of report.entries) {
      expect(entry.title + entry.subtitle).not.toMatch(/虚假|伪造|说谎|未执行|谎报/)
    }
    expect(report.confidence).toBe('confirmed')
    expect(report.confidence_title).toBe(EVIDENCE_CONFIDENCE_TEXT.confirmed.title)
    expect(report.baseline_snapshot_id).toBeTruthy()
    expect(report.end_snapshot_id).toBeTruthy()
  })

  it('改后还原：窗口完整但该文件无净变化 → reported_only + confirmed（不是指控）', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/reverted.ts')] })
    // 结束快照存在、比较完整，但引擎确认无净变化 → 不产生任何观察条目
    const snapshots = window(event.id, [])

    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('confirmed')
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].attribution).toBe('reported_only')
    expect(report.entries[0].title).not.toMatch(/虚假|伪造|未执行/)
  })

  it('并发修改（用户 / 其他 Agent）：观察侧多出的文件只作 observed_only，不推断作者', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/mine.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/mine.ts'),
      makeFile('src/concurrent.ts', { pre_existing_dirty: true, head_moved: true })
    ])

    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    const concurrent = report.entries.find((entry) => entry.repo_relative_path === 'src/concurrent.ts')
    expect(concurrent?.attribution).toBe('observed_only')
    // 结构上没有「作者」字段可填——对照只陈述两个事实来源，不指认谁改的
    expect(Object.keys(concurrent ?? {})).not.toContain('author')
    expect(concurrent?.agent_report).toBeNull()
    expect(concurrent?.subtitle).toBe(EVIDENCE_ATTRIBUTION_TEXT.observed_only.subtitle)
    // 窗口内文件级 head_moved → 置信度降级
    expect(report.confidence).toBe('window_net_change')
    expect(report.confidence_title).toBe(EVIDENCE_CONFIDENCE_TEXT.window_net_change.title)
  })
})

// MARK: - 重命名

describe('重命名精确匹配（§5.2）', () => {
  it('新路径相等且 rename 来源一致 → 匹配；旧路径观察行被该报告覆盖，不产生 observed_only 噪音', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [makeChange('src/new-name.ts', { change_type: 'renamed', previous_file_path: 'src/old-name.ts' })]
    })
    const snapshots = window(event.id, [
      makeFile('src/new-name.ts', { change_kind: 'renamed', rename_from_path: 'src/old-name.ts' }),
      makeFile('src/old-name.ts', { change_kind: 'deleted' }) // 旧路径消失（重命名的另一半）
    ])

    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].attribution).toBe('reported_and_observed')
    expect(report.entries[0].repo_relative_path).toBe('src/new-name.ts')
    expect(report.entries[0].agent_report?.previous_file_path).toBe('src/old-name.ts')
    expect(report.entries[0].observation?.rename_from_path).toBe('src/old-name.ts')
  })

  it('rename 来源不一致（Agent 说 A→B，观察到 C→B）→ 拆成 reported_only + observed_only', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [makeChange('src/b.ts', { change_type: 'renamed', previous_file_path: 'src/a.ts' })]
    })
    const snapshots = window(event.id, [
      makeFile('src/b.ts', { change_kind: 'renamed', rename_from_path: 'src/c.ts' })
    ])

    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries.map((entry) => entry.attribution)).toEqual([
      'reported_only',
      'observed_only'
    ])
    expect(report.entries[0].repo_relative_path).toBe('src/b.ts')
    expect(report.entries[1].repo_relative_path).toBe('src/b.ts')
  })

  it('§3.3 只有一方是重命名：Agent 报重命名、观察侧 rename_from 为 null → 不匹配', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [makeChange('src/b.ts', { change_type: 'renamed', previous_file_path: 'src/a.ts' })]
    })
    const snapshots = window(event.id, [
      makeFile('src/b.ts', { change_kind: 'added', rename_from_path: null })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // 绝不把「观察到文件发生变化」升级成「观察到同一次重命名」
    expect(report.entries.map((entry) => entry.attribution)).toEqual([
      'reported_only',
      'observed_only'
    ])
    expect(report.entries[0].observation).toBeNull()
    expect(report.entries[1].agent_report).toBeNull()
  })

  it('§3.3 只有一方是重命名：Agent 只报 modified、观察侧却是重命名 → 同样拆开', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/b.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/b.ts', { change_kind: 'renamed', rename_from_path: 'src/a.ts' })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries.map((entry) => entry.attribution)).toEqual([
      'reported_only',
      'observed_only'
    ])
  })

  it('§3.4 旧路径是独立变化（modified，非删除侧）→ 不被吞，仍产出 observed_only', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [makeChange('src/new.ts', { change_type: 'renamed', previous_file_path: 'src/old.ts' })]
    })
    const snapshots = window(event.id, [
      makeFile('src/new.ts', {
        change_kind: 'renamed',
        rename_from_path: 'src/old.ts',
        content_hash_before: 'lineage-hash'
      }),
      makeFile('src/old.ts', {
        change_kind: 'modified',
        content_hash_before: 'unrelated-1',
        content_hash_after: 'unrelated-2'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(
      report.entries.map((entry) => [entry.repo_relative_path, entry.attribution])
    ).toEqual([
      ['src/new.ts', 'reported_and_observed'],
      ['src/old.ts', 'observed_only'] // 路径相等也不能吞：它不是本次重命名的删除侧
    ])
  })

  it('§3.4 旧路径虽是 deleted 但内容血缘不同 → 归属证明不了，不消费', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [makeChange('src/new.ts', { change_type: 'renamed', previous_file_path: 'src/old.ts' })]
    })
    const snapshots = window(event.id, [
      makeFile('src/new.ts', {
        change_kind: 'renamed',
        rename_from_path: 'src/old.ts',
        content_hash_before: 'lineage-hash'
      }),
      makeFile('src/old.ts', {
        change_kind: 'deleted',
        content_hash_before: 'some-other-content', // 与重命名 before 不同源 → 不是删除侧
        content_hash_after: null
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(
      report.entries.map((entry) => [entry.repo_relative_path, entry.attribution])
    ).toEqual([
      ['src/new.ts', 'reported_and_observed'],
      ['src/old.ts', 'observed_only']
    ])
  })
})

// MARK: - 路径精确匹配

describe('POSIX 路径只做精确匹配（§5.2）', () => {
  it('大小写、目录层级、文件名相同都不构成匹配（./ 前缀在 schema 层已被拒，见契约测试）', () => {
    const event = makeEvent({
      sequence: 1,
      changes: [
        makeChange('src/A.ts'), // 大小写不同
        makeChange('dir/file.ts') // 同名不同目录
      ]
    })
    const snapshots = window(event.id, [
      makeFile('src/a.ts'),
      makeFile('file.ts'),
      makeFile('src/x.ts') // 没人报告
    ])

    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // 一个都没匹配上：两个 reported_only + 三个 observed_only
    expect(report.entries.filter((entry) => entry.attribution === 'reported_only')).toHaveLength(2)
    expect(report.entries.filter((entry) => entry.attribution === 'observed_only')).toHaveLength(3)
    expect(report.entries.some((entry) => entry.attribution === 'reported_and_observed')).toBe(false)
  })
})

// MARK: - 置信度

describe('置信度（§5.4）', () => {
  it('缺 baseline（无 execution_start）→ unconfirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const end = makeSnapshot('execution_end', event.id, { files: [makeFile('src/a.ts')] })
    const report = only(buildEvidenceComparison(detailOf(event), [end]))
    expect(report.confidence).toBe('unconfirmed')
    expect(report.baseline_snapshot_id).toBeNull()
    expect(report.confidence_title).toBe(EVIDENCE_CONFIDENCE_TEXT.unconfirmed.title)
    // 窗口不完整时观察侧仍如实呈现（不因为不确定就吞掉事实）
    expect(report.entries.find((entry) => entry.repo_relative_path === 'src/a.ts')?.attribution).toBe(
      'reported_and_observed'
    )
  })

  it('缺结束快照（窗口未关闭）→ unconfirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const start = makeSnapshot('execution_start', event.id)
    const report = only(buildEvidenceComparison(detailOf(event), [start]))
    expect(report.confidence).toBe('unconfirmed')
    expect(report.end_snapshot_id).toBeNull()
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].attribution).toBe('reported_only')
  })

  it('任一侧采集失败 / 比较未完成 → unconfirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })

    const failedBaseline = window(event.id, [makeFile('src/a.ts')], {
      start: { capture_status: 'failed', error_code: 'git_timeout' }
    })
    expect(only(buildEvidenceComparison(detailOf(event), failedBaseline)).confidence).toBe(
      'unconfirmed'
    )

    const comparisonFailed = window(event.id, [makeFile('src/a.ts')], {
      end: { comparison_status: 'comparison_failed', capture_status: 'ok' }
    })
    expect(only(buildEvidenceComparison(detailOf(event), comparisonFailed)).confidence).toBe(
      'unconfirmed'
    )
  })

  it('非完整 manifest（comparison_status=partial）绝不标 confirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const partial = window(event.id, [makeFile('src/a.ts')], {
      end: { comparison_status: 'partial' }
    })
    const report = only(buildEvidenceComparison(detailOf(event), partial))
    expect(report.confidence).toBe('unconfirmed')
    expect(report.confidence).not.toBe('confirmed')
  })

  it('窗口完整且 HEAD 未动 → confirmed；HEAD 移动 → window_net_change', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const stable = window(event.id, [makeFile('src/a.ts')], {
      start: { head_sha: 'same-sha' },
      end: { head_sha: 'same-sha' }
    })
    expect(only(buildEvidenceComparison(detailOf(event), stable)).confidence).toBe('confirmed')

    const moved = window(event.id, [makeFile('src/a.ts')], {
      start: { head_sha: 'sha-before' },
      end: { head_sha: 'sha-after' }
    })
    const report = only(buildEvidenceComparison(detailOf(event), moved))
    expect(report.confidence).toBe('window_net_change')
    expect(report.confidence).not.toBe('confirmed')
  })

  it('不能只凭单个文件 hash 宣称窗口完整：文件级 head_moved 也会降级', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const snapshots = window(event.id, [makeFile('src/a.ts', { head_moved: true })], {
      start: { head_sha: 'same' },
      end: { head_sha: 'same' }
    })
    expect(only(buildEvidenceComparison(detailOf(event), snapshots)).confidence).toBe(
      'window_net_change'
    )
  })
})

// MARK: - Execution 隔离与快照类型

describe('窗口隔离（§5.1）', () => {
  it('不同 Execution 的快照绝不交叉匹配', () => {
    const eventA = makeEvent({ id: randomUUID(), sequence: 1, changes: [makeChange('src/shared.ts')] })
    const eventB = makeEvent({ id: randomUUID(), sequence: 2 })
    // A 报了 shared.ts 但 A 的窗口是空的；同一文件的变化发生在 B 的窗口
    const snapshots = [
      ...window(eventA.id, []),
      ...window(eventB.id, [makeFile('src/shared.ts')])
    ]

    const report = buildEvidenceComparison(detailOf(eventA, eventB), snapshots)
    expect(report).toHaveLength(2)
    const reportA = report.find((entry) => entry.event_id === eventA.id)!
    const reportB = report.find((entry) => entry.event_id === eventB.id)!
    // A 绝不借用 B 的观察结果 → 只能是 reported_only（observation 为 null）
    expect(reportA.entries).toHaveLength(1)
    expect(reportA.entries[0].attribution).toBe('reported_only')
    expect(reportA.entries[0].observation).toBeNull()
    // B 的观察只属于 B → observed_only（agent_report 为 null）
    expect(reportB.entries).toHaveLength(1)
    expect(reportB.entries[0].attribution).toBe('observed_only')
    expect(reportB.entries[0].agent_report).toBeNull()
    // 各自的窗口快照 id 指向各自的 execution_event_id（真实归属，非自比较）
    const endA = snapshots.find(
      (snapshot) =>
        snapshot.execution_event_id === eventA.id && snapshot.snapshot_type === 'execution_end'
    )!
    const endB = snapshots.find(
      (snapshot) =>
        snapshot.execution_event_id === eventB.id && snapshot.snapshot_type === 'execution_end'
    )!
    expect(reportA.end_snapshot_id).toBe(endA.id)
    expect(reportB.end_snapshot_id).toBe(endB.id)
    expect(reportA.end_snapshot_id).not.toBe(reportB.end_snapshot_id)
    expect(reportA.baseline_snapshot_id).not.toBe(reportB.baseline_snapshot_id)
  })

  it('Journey Final / baseline 快照的文件绝不冒充某次执行的观察结果', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const finalSnapshot = makeSnapshot('journey_final', null, {
      files: [makeFile('src/a.ts')], // final 里也有该文件——但不是本窗口的观察
      comparison_status: 'complete'
    })
    const baseline = makeSnapshot('baseline', null)
    // 该事件没有任何 start/end
    const report = only(buildEvidenceComparison(detailOf(event), [baseline, finalSnapshot]))
    expect(report.baseline_snapshot_id).toBeNull()
    expect(report.end_snapshot_id).toBeNull()
    expect(report.confidence).toBe('unconfirmed')
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].attribution).toBe('reported_only') // 没有可借用的观察
    expect(report.entries[0].observation).toBeNull()
  })

  it('不可判定的观察条目（双 hash 为空、observation=unavailable）不宣称「观察到」', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const undetermined = makeFile('src/a.ts', {
      content_hash_before: null,
      content_hash_after: null,
      artifact_kind: 'unavailable',
      artifact_status: 'omitted',
      artifact_omission: 'baseline_not_stored',
      // P5.1.2：「不可判定」的权威表达是 observation_status=unavailable——
      // 新记录里 changed 才是权威，夹具必须与语义一致
      observation_status: 'unavailable'
    })
    const snapshots = window(event.id, [undetermined])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries[0].attribution).toBe('reported_only') // 未确认净变化（断言未放宽）
    // 且该文件在独立的无法判定集合里（不静默消失）
    expect(report.undetermined_observations.map((file) => file.repo_relative_path)).toEqual([
      'src/a.ts'
    ])
  })

  it('敏感文件（artifact=sensitive、hash 按策略为空）仍算观察到状态变化', () => {
    const event = makeEvent({ sequence: 1, changes: [] })
    const sensitive = makeFile('.env.local', {
      content_hash_before: null,
      content_hash_after: null,
      artifact_kind: 'sensitive',
      artifact_status: 'available'
    })
    const report = only(buildEvidenceComparison(detailOf(event), window(event.id, [sensitive])))
    expect(report.entries[0].attribution).toBe('observed_only')
    expect(report.entries[0].observation?.artifact_kind).toBe('sensitive')
  })
})

// MARK: - 结构与排序

describe('报告结构', () => {
  it('无任何证据的事件跳过；报告按 sequence 排序；observation 带回 artifact 轻量元数据', () => {
    const empty = makeEvent({ sequence: 1 })
    const later = makeEvent({ sequence: 3, changes: [makeChange('src/b.ts')] })
    const earlier = makeEvent({ sequence: 2, changes: [makeChange('src/a.ts')] })
    const snapshots = [
      ...window(earlier.id, [
        makeFile('src/a.ts', {
          artifact_kind: 'sensitive',
          artifact_status: 'available',
          artifact_omission: null
        })
      ]),
      ...window(later.id, [
        makeFile('src/b.ts', {
          artifact_kind: 'over_budget',
          artifact_status: 'omitted',
          artifact_omission: 'journey_budget'
        })
      ])
    ]

    const report = buildEvidenceComparison(detailOf(empty, later, earlier), snapshots)
    expect(report.map((entry) => entry.event_id)).toEqual([earlier.id, later.id])
    expect(report[0].entries[0].observation).toMatchObject({
      artifact_kind: 'sensitive',
      artifact_status: 'available',
      artifact_omission: null
    })
    expect(report[1].entries[0].observation).toMatchObject({
      artifact_kind: 'over_budget',
      artifact_status: 'omitted',
      artifact_omission: 'journey_budget'
    })
    // entry 观察侧带 end_snapshot_id 可组合出按需 Artifact 三元组
    expect(report[1].end_snapshot_id).toBeTruthy()
  })

  it('文案常量表完整且不含任何指控性表达（验收硬项）', () => {
    const allText = Object.values(EVIDENCE_ATTRIBUTION_TEXT)
      .flatMap((text) => [text.title, text.subtitle])
      .concat(Object.values(EVIDENCE_CONFIDENCE_TEXT).map((text) => text.title))
      .join('\n')
    expect(allText).not.toMatch(/虚假|伪造|说谎|谎报|未执行/)
    expect(Object.keys(EVIDENCE_ATTRIBUTION_TEXT).sort()).toEqual([
      'observed_only',
      'reported_and_observed',
      'reported_only'
    ])
    expect(Object.keys(EVIDENCE_CONFIDENCE_TEXT).sort()).toEqual([
      'confirmed',
      'unconfirmed',
      'window_net_change'
    ])
  })
})

// MARK: - 观察类型补齐（R6-4.3.4.1 §四）

describe('观察类型补齐：type_changed / conflicted（§四）', () => {
  it('type_changed 且前后 hash 相同 → 仍是观察到的净变化（不因 hash 相同判无变化）', () => {
    const event = makeEvent({ sequence: 1 })
    const snapshots = window(event.id, [
      makeFile('src/f.txt', {
        change_kind: 'type_changed',
        content_hash_before: 'same-hash',
        content_hash_after: 'same-hash',
        artifact_kind: 'symlink',
        artifact_status: 'available'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].attribution).toBe('observed_only')
    expect(report.entries[0].observation?.change_kind).toBe('type_changed')
    // 文件级事实与窗口级置信度分开：窗口完整 → confirmed（不互相冒充）
    expect(report.confidence).toBe('confirmed')
    expect(report.confidence_title).toBe(EVIDENCE_CONFIDENCE_TEXT.confirmed.title)
  })

  it('conflicted 且 hash 双空不足以判断 → 进独立无法判定集合（不静默、不进 observed_only）', () => {
    const event = makeEvent({ sequence: 1 })
    const snapshots = window(event.id, [
      makeFile('src/c.ts', {
        change_kind: 'conflicted',
        content_hash_before: null,
        content_hash_after: null,
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable',
        observation_status: 'unavailable' // 引擎明确：净变化不可判定（三轴各自如实）
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // P5.1.1 §三：无法判定的观察**不进三类归因**——既不是 observed_only，
    // 也不静默丢弃，而是进入独立集合
    expect(report.entries).toHaveLength(0)
    expect(report.entries.some((entry) => entry.attribution === 'observed_only')).toBe(false)
    expect(report.undetermined_observations).toHaveLength(1)
    const undetermined = report.undetermined_observations[0]
    expect(undetermined.repo_relative_path).toBe('src/c.ts')
    expect(undetermined.change_kind).toBe('conflicted')
    expect(undetermined.observation_status).toBe('unavailable')
    expect(undetermined.artifact_kind).toBe('unavailable')
    expect(undetermined.artifact_omission).toBe('not_observable')
    // 结构上不存在作者字段：无法判定的观察不指向任何 Agent
    expect(Object.keys(undetermined)).not.toContain('author')
    // 不可判定文件在场 → 观察窗口不完整，绝不 confirmed
    expect(report.confidence).toBe('unconfirmed')
  })
})

// MARK: - 零文件变化的执行报告（R6-4.3.4.1 §六）

describe('零文件变化的执行仍输出报告（§六）', () => {
  it('完整 start + end、无变化文件 → 输出 confirmed + entries 为空（窗口 id 齐全）', () => {
    const event = makeEvent({ sequence: 1 })
    const snapshots = window(event.id, [])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('confirmed')
    expect(report.confidence_title).toBe(EVIDENCE_CONFIDENCE_TEXT.confirmed.title)
    expect(report.entries).toEqual([])
    expect(report.event_id).toBe(event.id)
    expect(report.event_type).toBe('execution')
    expect(report.baseline_snapshot_id).toBe(snapshots[0].id)
    expect(report.end_snapshot_id).toBe(snapshots[1].id)
  })

  it('start 存在、end 缺失 → 输出 unconfirmed + entries 为空', () => {
    const event = makeEvent({ sequence: 1 })
    const start = makeSnapshot('execution_start', event.id)
    const report = only(buildEvidenceComparison(detailOf(event), [start]))
    expect(report.confidence).toBe('unconfirmed')
    expect(report.entries).toEqual([])
    expect(report.baseline_snapshot_id).toBe(start.id)
    expect(report.end_snapshot_id).toBeNull()
  })

  it('没有 Agent Reported 且没有 start/end → 不输出（不给历史事件灌水）', () => {
    const quiet = makeEvent({ sequence: 1 })
    const active = makeEvent({ sequence: 2, changes: [makeChange('src/x.ts')] })
    const snapshots = window(active.id, [makeFile('src/x.ts')])
    const report = buildEvidenceComparison(detailOf(quiet, active), snapshots)
    expect(report.map((entry) => entry.event_id)).toEqual([active.id])
  })

  it('Agent Reported 有文件、观察窗口无净变化 → reported_only 仍输出（entries 非空）', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/touched.ts')] })
    const report = only(buildEvidenceComparison(detailOf(event), window(event.id, [])))
    expect(report.entries.map((entry) => entry.attribution)).toEqual(['reported_only'])
    expect(report.confidence).toBe('confirmed')
  })
})

// MARK: - 置信度兜底：unavailable ≠ over_budget（R6-4.3.4.1 §五）

describe('置信度兜底：unavailable 与 over_budget 严格区分（§五）', () => {
  it('历史行（observation_status=NULL）且无 hash 证据 → 保守 unconfirmed（不得升级为 confirmed）', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/a.ts', {
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'baseline_not_stored',
        observation_status: null, // Migration 18 前的历史行
        content_hash_before: null,
        content_hash_after: null // 无前后 hash、非结构性变化 → 无法证明净变化
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('unconfirmed')
    expect(report.confidence).not.toBe('confirmed')
  })

  it('over_budget 只是正文不可展示 → 不降级（文件净变化仍可判定）', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/a.ts', {
        artifact_kind: 'over_budget',
        artifact_status: 'omitted',
        artifact_omission: 'file_budget'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('confirmed')
    expect(report.entries[0].attribution).toBe('reported_and_observed')
  })
})

// MARK: - 三轴分离场景（R6-4.3.4.2 §三.3）

describe('观察确定性 / artifact 可用性 / 窗口置信度三轴分离（A–D）', () => {
  it('场景 A：净变化已确认（observation=changed、hash 不同）但正文不可用 → confirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/a.ts', {
        observation_status: 'changed',
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'baseline_not_stored',
        content_hash_before: 'hash-before-1',
        content_hash_after: 'hash-before-2' // 前后不同：净变化已确定
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('confirmed')
    // 正文生成不了不影响条目：观察侧仍成立
    expect(report.entries[0].attribution).toBe('reported_and_observed')
    expect(report.entries[0].observation?.artifact_kind).toBe('unavailable')
    expect(report.entries[0].observation?.observation_status).toBe('changed')
  })

  it('场景 B：净变化不可判定（observation=unavailable）→ unconfirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/a.ts', {
        observation_status: 'unavailable',
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable',
        content_hash_before: null,
        content_hash_after: null
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('unconfirmed')
    expect(report.confidence).not.toBe('confirmed')
  })

  it('场景 C：Diff 超预算（observation=changed + over_budget）→ 仍允许 confirmed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/a.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/a.ts', {
        observation_status: 'changed',
        artifact_kind: 'over_budget',
        artifact_status: 'omitted',
        artifact_omission: 'snapshot_budget'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.confidence).toBe('confirmed')
    expect(report.entries[0].observation?.artifact_status).toBe('omitted')
  })

  it('场景 D：历史行（NULL）——hash 证明变化不降级；无法证明保守 unconfirmed', () => {
    const proven = makeEvent({ sequence: 1, changes: [makeChange('src/proven.ts')] })
    const unproven = makeEvent({ sequence: 2, changes: [makeChange('src/unproven.ts')] })
    const snapshots = [
      ...window(proven.id, [
        makeFile('src/proven.ts', {
          observation_status: null, // 历史行
          artifact_kind: 'unavailable',
          artifact_status: 'omitted',
          artifact_omission: 'baseline_not_stored',
          content_hash_before: 'legacy-1',
          content_hash_after: 'legacy-2' // 明确前后 hash 变化 → 不应被错误降级
        })
      ]),
      ...window(unproven.id, [
        makeFile('src/unproven.ts', {
          observation_status: null,
          artifact_kind: 'unavailable',
          artifact_status: 'omitted',
          artifact_omission: 'not_observable',
          content_hash_before: null,
          content_hash_after: null // 证据不足 → 保守
        })
      ])
    ]
    const report = buildEvidenceComparison(detailOf(proven, unproven), snapshots)
    expect(report).toHaveLength(2)
    expect(report.find((entry) => entry.event_id === proven.id)!.confidence).toBe('confirmed')
    expect(report.find((entry) => entry.event_id === unproven.id)!.confidence).toBe('unconfirmed')
  })

  it('历史兼容纯函数 legacyObservationIsDeterminate 的证据规则（独立可测）', () => {
    const base = { artifact_kind: 'unavailable' as const }
    // 结构性 git 事实 → 可确定
    expect(legacyObservationIsDeterminate(makeFile('src/a.ts', { ...base, change_kind: 'renamed' }))).toBe(true)
    expect(legacyObservationIsDeterminate(makeFile('src/a.ts', { ...base, change_kind: 'type_changed' }))).toBe(true)
    expect(legacyObservationIsDeterminate(makeFile('src/a.ts', { ...base, change_kind: 'conflicted' }))).toBe(true)
    // 敏感：状态已证实 → 可确定
    expect(
      legacyObservationIsDeterminate(
        makeFile('.env', { artifact_kind: 'sensitive', content_hash_before: null, content_hash_after: null })
      )
    ).toBe(true)
    // 两侧 hash 齐全 → 可确定（相同 = 改后还原也是确定的观察）
    expect(
      legacyObservationIsDeterminate(
        makeFile('src/a.ts', { ...base, content_hash_before: 'x', content_hash_after: 'x' })
      )
    ).toBe(true)
    // added/deleted 单侧有 hash → 可确定
    expect(
      legacyObservationIsDeterminate(
        makeFile('src/a.ts', { ...base, change_kind: 'added', content_hash_before: null, content_hash_after: 'h' })
      )
    ).toBe(true)
    // 双空 + 非结构性 → 无法证明（保守 false）
    expect(
      legacyObservationIsDeterminate(
        makeFile('src/a.ts', { ...base, content_hash_before: null, content_hash_after: null })
      )
    ).toBe(false)
    // 单侧空且类型不明 → 无法证明
    expect(
      legacyObservationIsDeterminate(
        makeFile('src/a.ts', { ...base, change_kind: 'modified', content_hash_before: null, content_hash_after: 'h' })
      )
    ).toBe(false)
  })
})

// MARK: - 无法判定的独立集合（P5.1.1 §三 / §六 1-4、6）

describe('无法判定的观察独立集合（P5.1.1 §三）', () => {
  it('§六.1：新记录 observation_status=unavailable → 进独立集合，绝不进 observed_only', () => {
    const event = makeEvent({ sequence: 1 })
    const snapshots = window(event.id, [
      makeFile('src/mystery.ts', {
        observation_status: 'unavailable',
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable',
        content_hash_before: null,
        content_hash_after: null
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries).toHaveLength(0) // 不升级成 observed_only
    expect(report.undetermined_observations).toHaveLength(1)
    expect(report.undetermined_observations[0].observation_status).toBe('unavailable')
  })

  it('§六.2/3：历史 NULL——无法证明的进独立集合；hash 能证明的不进（仍走观察池）', () => {
    const unproven = makeEvent({ sequence: 1 })
    const proven = makeEvent({ sequence: 2, changes: [makeChange('src/proven.ts')] })
    const snapshots = [
      ...window(unproven.id, [
        makeFile('src/unproven.ts', {
          observation_status: null,
          artifact_kind: 'unavailable',
          artifact_status: 'omitted',
          artifact_omission: 'not_observable',
          content_hash_before: null,
          content_hash_after: null
        })
      ]),
      ...window(proven.id, [
        makeFile('src/proven.ts', {
          observation_status: null,
          artifact_kind: 'unavailable',
          artifact_status: 'omitted',
          artifact_omission: 'baseline_not_stored',
          content_hash_before: 'legacy-1',
          content_hash_after: 'legacy-2' // 明确 hash 变化 → 已确定，不进无法判定集合
        })
      ])
    ]
    const report = buildEvidenceComparison(detailOf(unproven, proven), snapshots)
    const unprovenReport = report.find((entry) => entry.event_id === unproven.id)!
    expect(unprovenReport.undetermined_observations).toHaveLength(1)
    expect(unprovenReport.entries).toHaveLength(0)

    const provenReport = report.find((entry) => entry.event_id === proven.id)!
    expect(provenReport.undetermined_observations).toHaveLength(0)
    // hash 证明了变化 → 仍是已确认观察（不因 artifact 不可用被降级）
    expect(provenReport.entries.map((entry) => entry.attribution)).toEqual([
      'reported_and_observed'
    ])
  })

  it('§六.4：Agent 报告但 Workspace 无法判定 → 两侧事实分别保留，不错误匹配', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/both.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/both.ts', {
        observation_status: 'unavailable',
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable',
        content_hash_before: null,
        content_hash_after: null
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // 不配成 reported_and_observed；Agent 侧事实保留为 reported_only
    expect(report.entries.map((entry) => entry.attribution)).toEqual(['reported_only'])
    expect(report.entries[0].agent_report?.change_summary).toBeTruthy()
    // Workspace 侧事实保留在独立集合
    expect(report.undetermined_observations).toHaveLength(1)
    expect(report.undetermined_observations[0].repo_relative_path).toBe('src/both.ts')
    // 两侧集合路径可以相同，但绝不合并成一条
    expect(report.entries[0].observation).toBeNull()
  })

  it('§六.5/6：计数独立（不混入 observed）；artifact 类型与 omission 不丢失', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/ok.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/ok.ts'), // 已确认净变化（默认 hashes 不同）
      makeFile('src/mystery.ts', {
        observation_status: 'unavailable',
        artifact_kind: 'over_budget',
        artifact_status: 'omitted',
        artifact_omission: 'journey_budget',
        content_hash_before: null,
        content_hash_after: null
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // observed 池只含已确认变化（mystery 不在 entries 里）
    expect(report.entries.map((entry) => entry.repo_relative_path)).toEqual(['src/ok.ts'])
    expect(report.undetermined_observations).toHaveLength(1)
    const undetermined = report.undetermined_observations[0]
    // artifact 类型与省略原因原样带出（不许丢）
    expect(undetermined.artifact_kind).toBe('over_budget')
    expect(undetermined.artifact_status).toBe('omitted')
    expect(undetermined.artifact_omission).toBe('journey_budget')
    expect(undetermined.file_id).toBeTruthy()
    expect(undetermined.change_kind).toBe('modified')
  })
})

// MARK: - 引擎权威 observation_status（P5.1.2 §三）

describe('引擎权威 observation_status（P5.1.2 §三）', () => {
  /**
   * 贴近 GitSnapshotEngine 真实输出的夹具（§三「文件大小不同、hash 不可用、
   * 仍能确认变化」）：worktree 内容没驻留 → 前后 content hash 双 null；
   * 但两侧**大小不同**是确定性证据 → `decide()` 判 changed 并持久化；
   * 正文因基线/当前内容不可重建 → artifact=unavailable + omitted。
   */
  function engineConfirmedNullHashFile(path: string, overrides: Record<string, unknown> = {}) {
    return makeFile(path, {
      change_kind: 'modified',
      content_hash_before: null,
      content_hash_after: null,
      artifact_kind: 'unavailable',
      artifact_status: 'omitted',
      artifact_omission: 'baseline_not_stored',
      observation_status: 'changed',
      insertions: 5,
      deletions: 2,
      ...overrides
    })
  }

  it('§三.1/3：modified、前后 hash 双 null、observation=changed → 进入 Workspace Observed', () => {
    const event = makeEvent({ sequence: 1 }) // 没有 Agent Reported
    const snapshots = window(event.id, [engineConfirmedNullHashFile('src/grown.ts')])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // 必须进入观察侧展示流程：observed_only（绝不再因 hash 缺失从时间线消失）
    expect(report.entries.map((entry) => entry.attribution)).toEqual(['observed_only'])
    expect(report.entries[0].repo_relative_path).toBe('src/grown.ts')
    // 且绝不落入无法判定集合（changed 是权威）
    expect(report.undetermined_observations).toHaveLength(0)
  })

  it('§三.2：同一路径有 Agent Reported → 正确配成 reported_and_observed', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/grown.ts')] })
    const snapshots = window(event.id, [engineConfirmedNullHashFile('src/grown.ts')])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].attribution).toBe('reported_and_observed')
    expect(report.entries[0].agent_report?.change_summary).toBeTruthy()
    expect(report.entries[0].observation?.observation_status).toBe('changed')
    expect(report.undetermined_observations).toHaveLength(0)
  })

  it('§三.7：changed + artifact 不可用的合法组合——artifact 类型/状态/omission 全保留', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/grown.ts')] })
    const snapshots = window(event.id, [engineConfirmedNullHashFile('src/grown.ts')])
    const observation = only(buildEvidenceComparison(detailOf(event), snapshots)).entries[0]
      .observation!
    // 观察确定性与 artifact 可用性正交：变化已确认，正文仍可省略
    expect(observation.observation_status).toBe('changed')
    expect(observation.artifact_kind).toBe('unavailable')
    expect(observation.artifact_status).toBe('omitted')
    expect(observation.artifact_omission).toBe('baseline_not_stored')
    expect(observation.insertions).toBe(5)
    expect(observation.deletions).toBe(2)
  })

  it('§三.4：observation=unavailable（即使 modified、双 null）仍只进独立集合', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/mystery.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/mystery.ts', {
        change_kind: 'modified',
        content_hash_before: null,
        content_hash_after: null,
        observation_status: 'unavailable',
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    expect(report.entries.map((entry) => entry.attribution)).toEqual(['reported_only'])
    expect(report.entries[0].observation).toBeNull() // 绝不配成 reported_and_observed
    expect(report.undetermined_observations).toHaveLength(1)
    expect(report.undetermined_observations[0].observation_status).toBe('unavailable')
  })

  it('§三.5：历史记录（observation=null）缺 hash 证据 → 仍保守判为无法确定', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/legacy.ts')] })
    const snapshots = window(event.id, [
      makeFile('src/legacy.ts', {
        change_kind: 'modified',
        content_hash_before: null,
        content_hash_after: null,
        observation_status: null, // 历史行：绝不升级成新记录语义
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    // 不能证明 → 不进观察侧、进独立集合（保守）
    expect(report.entries.map((entry) => entry.attribution)).toEqual(['reported_only'])
    expect(report.entries[0].observation).toBeNull()
    expect(report.undetermined_observations).toHaveLength(1)
    expect(report.undetermined_observations[0].observation_status).toBeNull()
  })

  it('§三.6（对照层）：已确认的 hash 缺失文件在观察池、unavailable 不在——两侧互斥', () => {
    const event = makeEvent({ sequence: 1, changes: [makeChange('src/grown.ts')] })
    const snapshots = window(event.id, [
      engineConfirmedNullHashFile('src/grown.ts'), // 已确认（hash 缺失但 changed）
      makeFile('src/mystery.ts', {
        change_kind: 'modified',
        content_hash_before: null,
        content_hash_after: null,
        observation_status: 'unavailable',
        artifact_kind: 'unavailable',
        artifact_status: 'omitted',
        artifact_omission: 'not_observable'
      })
    ])
    const report = only(buildEvidenceComparison(detailOf(event), snapshots))
    const observedPaths = report.entries.map((entry) => entry.repo_relative_path)
    expect(observedPaths).toContain('src/grown.ts')
    expect(observedPaths).not.toContain('src/mystery.ts')
    expect(report.undetermined_observations.map((file) => file.repo_relative_path)).toEqual([
      'src/mystery.ts'
    ])
    // 两集合零交集
    const undeterminedPaths = report.undetermined_observations.map(
      (file) => file.repo_relative_path
    )
    expect(observedPaths.filter((path) => undeterminedPaths.includes(path))).toEqual([])
  })
})
