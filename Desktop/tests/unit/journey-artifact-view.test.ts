import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { JourneyArtifact } from '@shared/contracts'
import {
  artifactBodyView,
  artifactFetchTarget,
  createArtifactController,
  parseUnifiedDiff,
  type ArtifactTarget
} from '../../src/renderer/src/features/records/journey-artifact-view'
import type { EvidenceFileRowView } from '../../src/renderer/src/features/records/journey-evidence-view'

/**
 * P5.2：按需 Diff Viewer 的纯函数与状态机（零 React）。
 * 覆盖 §七 Unit 全部条目：映射 / 类型展示 / omitted-absent / 未知回退 /
 * 按需触发 / 失败重试 / 防重复 / 切换隔离 / reported_only 不读 / 归属一致性。
 */

const JOURNEY = randomUUID()
const SNAPSHOT = randomUUID()
const FILE = randomUUID()

function observedRow(overrides: Partial<NonNullable<EvidenceFileRowView['observed']>> = {}): EvidenceFileRowView {
  return {
    key: `reported_and_observed:src/a.ts`,
    path: 'src/a.ts',
    attribution: 'reported_and_observed',
    reported: { changeType: 'modified', changeSummary: '调整实现', previousPath: null },
    observed: {
      fileKey: FILE,
      changeKind: 'modified',
      insertions: 3,
      deletions: 1,
      renameFrom: null,
      artifactKind: 'diff',
      artifactStatus: 'available',
      artifactOmission: null,
      observationStatus: 'changed',
      ...overrides
    }
  }
}

function targetFixture(overrides: Partial<ArtifactTarget> = {}): ArtifactTarget {
  return {
    journeyId: JOURNEY,
    snapshotId: SNAPSHOT,
    fileId: FILE,
    path: 'src/a.ts',
    changeKind: 'modified',
    ...overrides
  }
}

function artifactFixture(overrides: Partial<JourneyArtifact> = {}): JourneyArtifact {
  return {
    journey_id: JOURNEY,
    snapshot_id: SNAPSHOT,
    file_id: FILE,
    repo_relative_path: 'src/a.ts',
    artifact: { kind: 'binary' },
    ...overrides
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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// MARK: - 读取目标（§四 / §七.9）

describe('artifactFetchTarget：三元组入口', () => {
  it('正常行 → 完整 journeyId + endSnapshotId + fileId（无文件系统路径）', () => {
    const target = artifactFetchTarget(JOURNEY, SNAPSHOT, observedRow())
    expect(target).toEqual({
      journeyId: JOURNEY,
      snapshotId: SNAPSHOT,
      fileId: FILE,
      path: 'src/a.ts',
      changeKind: 'modified'
    })
  })

  it('§七.9：reported_only（无 observed）→ null，不触发任何读取', () => {
    const reportedOnly: EvidenceFileRowView = {
      key: 'reported_only:src/b.ts',
      path: 'src/b.ts',
      attribution: 'reported_only',
      reported: { changeType: 'modified', changeSummary: '改了', previousPath: null },
      observed: null
    }
    expect(artifactFetchTarget(JOURNEY, SNAPSHOT, reportedOnly)).toBeNull()
  })

  it('absent 记录 → null（组件改显「没有可读取的 Artifact」，不给必然失败的按钮）', () => {
    expect(
      artifactFetchTarget(JOURNEY, SNAPSHOT, observedRow({ artifactStatus: 'absent' }))
    ).toBeNull()
  })

  it('窗口结束快照缺失 → null（三元组不完整，无从校验归属）', () => {
    expect(artifactFetchTarget(JOURNEY, null, observedRow())).toBeNull()
  })
})

// MARK: - Artifact 呈现映射（§五 / §七.1/2/3/4）

describe('artifactBodyView：七类 Artifact 映射与安全回退', () => {
  it('diff → 正文渲染；binary / sensitive → marker（永远没有正文）', () => {
    expect(
      artifactBodyView({ kind: 'diff', text: '+x\n', insertions: 1, deletions: 0, byte_size: 3 })
    ).toEqual({ render: 'diff', text: '+x\n', insertions: 1, deletions: 0 })
    expect(artifactBodyView({ kind: 'binary' })).toEqual({ render: 'marker', kind: 'binary' })
    expect(artifactBodyView({ kind: 'sensitive' })).toEqual({
      render: 'marker',
      kind: 'sensitive'
    })
  })

  it('mode_only → 前后 mode；symlink → 前后目标字符串', () => {
    expect(
      artifactBodyView({ kind: 'mode_only', mode_before: '100644', mode_after: '100755' })
    ).toEqual({ render: 'modes', modeBefore: '100644', modeAfter: '100755' })
    expect(
      artifactBodyView({ kind: 'symlink', target_before: 'a', target_after: null })
    ).toEqual({ render: 'symlink', targetBefore: 'a', targetAfter: null })
  })

  it('§七.3：over_budget / unavailable → stats（带 kind、原因与统计——绝不渲染成「没变化」）', () => {
    const overBudget = artifactBodyView({
      kind: 'over_budget',
      reason: 'journey_budget',
      insertions: 9,
      deletions: 2
    })
    expect(overBudget).toEqual({
      render: 'stats',
      kind: 'over_budget',
      reason: 'journey_budget',
      insertions: 9,
      deletions: 2
    })
    const unavailable = artifactBodyView({
      kind: 'unavailable',
      reason: 'baseline_not_stored',
      insertions: null,
      deletions: null
    })
    expect(unavailable).toMatchObject({ render: 'stats', kind: 'unavailable' })
  })

  it('§七.4：未知类型与未知省略原因 → 安全回退（原样透出 token，不崩不编造）', () => {
    const unknown = artifactBodyView({ kind: 'holo_deck' } as never)
    expect(unknown).toEqual({ render: 'unknown', kind: 'holo_deck' })
    // 未知原因不映射文案（组件层 ?? raw 显示），结构里保留原值
    const futureReason = artifactBodyView({
      kind: 'over_budget',
      reason: 'future_reason',
      insertions: null,
      deletions: null
    } as never)
    expect(futureReason).toMatchObject({ render: 'stats', reason: 'future_reason' })
  })
})

// MARK: - Unified Diff 行分类

describe('parseUnifiedDiff：React 安全文本渲染的前置分类', () => {
  it('区分新增 / 删除 / 上下文 / meta（文件头与 hunk 头）', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-removed',
      '+added',
      '\\ No newline at end of file',
      '@@ -10,2 +11,2 @@',
      ' tail'
    ].join('\n')
    const lines = parseUnifiedDiff(text)
    expect(lines.map((line) => line.type)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'meta',
      'ctx',
      'del',
      'add',
      'meta',
      'meta',
      'ctx'
    ])
    expect(lines[7].content).toBe('+added')
    // 空文本不崩；带 hunk 头的最小片段正常识别为新增
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('@@ -0,0 +1 @@\n+x\n')).toEqual([
      { type: 'meta', content: '@@ -0,0 +1 @@' },
      { type: 'add', content: '+x' }
    ])
    // 无 hunk 头的裸片段一律 meta（`+++`/`---` 文件头绝不能被误判成增删）
    expect(parseUnifiedDiff('+++ b/x')).toEqual([{ type: 'meta', content: '+++ b/x' }])
  })
})

// MARK: - 按需读取状态机（§六 / §七.5-8、10）

describe('createArtifactController：按需读取与竞态', () => {
  it('§七.5：点开才触发请求；loading → loaded', async () => {
    const calls: string[][] = []
    const states: string[] = []
    const pending = deferred<JourneyArtifact>()
    const controller = createArtifactController({
      fetchArtifact: (j, s, f) => {
        calls.push([j, s, f])
        return pending.promise
      },
      onChange: (next) => states.push([...next.values()].map((state) => state.status).join())
    })

    // 未点击 → 零请求（打开 Journey / 展开事件都不取正文）
    expect(calls).toHaveLength(0)
    expect(states).toHaveLength(0)

    controller.load(targetFixture())
    expect(calls).toEqual([[JOURNEY, SNAPSHOT, FILE]]) // 完整三元组
    expect(states.at(-1)).toBe('loading')

    pending.resolve(artifactFixture())
    await flushMicrotasks()
    expect(states.at(-1)).toBe('loaded')
    controller.dispose()
  })

  it('§七.6：请求失败 → failed，再次 load（重试）→ 重新请求并成功', async () => {
    const first = deferred<JourneyArtifact>()
    const second = deferred<JourneyArtifact>()
    let call = 0
    const statuses: string[] = []
    const controller = createArtifactController({
      fetchArtifact: () => (call++ === 0 ? first.promise : second.promise),
      onChange: (next) => statuses.push([...next.values()].map((state) => state.status).join())
    })

    controller.load(targetFixture())
    first.reject(new Error('ipc down'))
    await flushMicrotasks()
    expect(statuses.at(-1)).toBe('failed')

    controller.load(targetFixture()) // 失败后重试
    expect(call).toBe(2)
    second.resolve(artifactFixture())
    await flushMicrotasks()
    expect(statuses.at(-1)).toBe('loaded')
    controller.dispose()
  })

  it('§七.7：防重复并发 + 已读缓存不重取', async () => {
    const pending = deferred<JourneyArtifact>()
    let call = 0
    const controller = createArtifactController({
      fetchArtifact: () => {
        call += 1
        return pending.promise
      },
      onChange: () => undefined
    })

    controller.load(targetFixture())
    controller.load(targetFixture()) // loading 中重复点击 → 忽略
    expect(call).toBe(1)

    pending.resolve(artifactFixture())
    await flushMicrotasks()
    controller.load(targetFixture()) // 已读过 → 缓存，不重取（重开同一文件）
    expect(call).toBe(1)
    controller.dispose()
  })

  it('§七.8：切换 Journey（reset）后旧请求作废，不污染新状态', async () => {
    const oldRequest = deferred<JourneyArtifact>()
    const newRequest = deferred<JourneyArtifact>()
    let call = 0
    const snapshots: Array<Map<string, { status: string }>> = []
    const controller = createArtifactController({
      fetchArtifact: () => (call++ === 0 ? oldRequest.promise : newRequest.promise),
      onChange: (next) => snapshots.push(new Map(next))
    })

    const oldTarget = targetFixture({ journeyId: 'journey-old' })
    const newTarget = targetFixture({ journeyId: 'journey-new', fileId: 'file-new' })
    controller.load(oldTarget)
    controller.reset() // 切换 Journey：清空缓存 + 作废在途
    expect(snapshots.at(-1)?.size ?? 0).toBe(0)

    controller.load(newTarget)
    newRequest.resolve(
      artifactFixture({ journey_id: 'journey-new', file_id: 'file-new' })
    )
    await flushMicrotasks()
    expect(snapshots.at(-1)?.get('file-new')?.status).toBe('loaded')

    // 旧 Journey 的慢请求此刻才到 → 必须被丢弃（不写回任何状态）
    oldRequest.resolve(artifactFixture())
    await flushMicrotasks()
    expect(snapshots.at(-1)?.has(FILE)).toBe(false)
    expect(snapshots.at(-1)?.size).toBe(1)
    controller.dispose()
  })

  it('卸载（dispose）后在途结果不写回；归属三元组不一致按失败处理', async () => {
    // dispose 隔离
    const pending = deferred<JourneyArtifact>()
    let writes = 0
    const disposing = createArtifactController({
      fetchArtifact: () => pending.promise,
      onChange: () => {
        writes += 1
      }
    })
    disposing.load(targetFixture())
    const writesBeforeDispose = writes
    disposing.dispose()
    pending.resolve(artifactFixture())
    await flushMicrotasks()
    expect(writes).toBe(writesBeforeDispose)

    // §七.10 归属一致性：返回了别的记录 → failed，绝不展示错内容
    const recorded: string[] = []
    const flow = createArtifactController({
      fetchArtifact: () =>
        Promise.resolve(artifactFixture({ snapshot_id: randomUUID(), file_id: randomUUID() })),
      onChange: (next) => recorded.push([...next.values()].map((state) => state.status).join())
    })
    flow.load(targetFixture())
    await flushMicrotasks()
    expect(recorded.at(-1)).toBe('failed') // 归属不一致 → 失败，不是 loaded
    flow.dispose()
  })
})
