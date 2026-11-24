import { describe, expect, it } from 'vitest'
import {
  INITIAL_WORKSPACE_LIST_STATE,
  journeyWorkspaceView,
  JOURNEY_EXECUTION_EVENT_TYPES,
  JOURNEY_WORKSPACE_LOCKED_STATUSES,
  workspaceListFailure,
  workspaceListStart,
  workspaceListSuccess,
  type JourneyWorkspaceListState
} from '../../src/renderer/src/features/records/journey-workspace-view'
import type { LocalWorkspace } from '../../src/shared/contracts'

/**
 * Journey 工作区关联的展示规则（R6-4.3.1 §四.4 / §七）。
 *
 * 本仓库没有 renderer 测试设施（无 testing-library / jsdom），规则抽成纯函数
 * ——与 `remote-pairing-view.test.ts` 同一理由。这里钉住六件事：
 *
 * 1. 四种关联状态（未关联 / 已关联 / 失效 / 已删除）各有确定输出；
 * 2. 「是否已开始」看**真实执行事件**，不看 `journey.status`——plan 事件把
 *    Journey 推成 running 时不许误锁；
 * 3. 终态（含 failed）一律锁定；
 * 4. 视图数据里**没有绝对路径**——机器目录位置不进渲染层；
 * 5. 不可用的工作区在选项里被禁用；
 * 6. 与 main 层的两组常量不漂移。
 */

const PROJECT_PATH = '/Users/someone/secret-project'

function workspace(
  overrides: Partial<LocalWorkspace> & Pick<LocalWorkspace, 'id' | 'name'>
): LocalWorkspace {
  return {
    absolutePath: PROJECT_PATH,
    platform: 'darwin',
    createdAt: 1,
    updatedAt: 1,
    availability: 'available',
    ...overrides
  }
}

const WS_A = workspace({ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'BrewPhase' })
const WS_B = workspace({ id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'ChromeExt' })

/** 列表已成功加载的包装（R6-4.3.1.1 起输入是状态机而不是裸数组）。 */
function loadedList(workspaces: LocalWorkspace[]): JourneyWorkspaceListState {
  return { status: 'loaded', seq: 0, workspaces }
}

function viewWith(
  journey: { status: string; workspace_id: string | null },
  list: JourneyWorkspaceListState,
  events: Array<{ event_type: string; status: string }> = []
) {
  return journeyWorkspaceView({ journey, events, list })
}

function viewOf(
  journey: { status: string; workspace_id: string | null },
  events: Array<{ event_type: string; status: string }> = [],
  workspaces: LocalWorkspace[] = [WS_A, WS_B]
) {
  return viewWith(journey, loadedList(workspaces), events)
}

describe('四种关联状态', () => {
  it('未关联：state=none、无 label，但仍可管理', () => {
    const view = viewOf({ status: 'created', workspace_id: null })
    expect(view.state).toBe('none')
    expect(view.label).toBeNull()
    expect(view.canManage).toBe(true)
    expect(view.lockedReason).toBeNull()
    expect(view.workspaceId).toBeNull()
  })

  it('已关联且可用：state=linked，label 是显示名', () => {
    const view = viewOf({ status: 'created', workspace_id: WS_A.id })
    expect(view.state).toBe('linked')
    expect(view.label).toBe('BrewPhase')
    expect(view.canManage).toBe(true)
    expect(view.options.find((option) => option.id === WS_A.id)?.current).toBe(true)
  })

  it('关联的文件夹失效：state=unavailable，仍显示名字（用户知道坏的是哪个）', () => {
    const missing = workspace({
      id: WS_A.id,
      name: 'BrewPhase',
      availability: 'missing'
    })
    const view = viewOf({ status: 'created', workspace_id: WS_A.id }, [], [missing, WS_B])
    expect(view.state).toBe('unavailable')
    expect(view.label).toBe('BrewPhase')
    // 失效工作区的选项必须禁用——选中它只会换来一次必然失败的请求。
    expect(view.options.find((option) => option.id === WS_A.id)?.disabled).toBe(true)
    expect(view.options.find((option) => option.id === WS_B.id)?.disabled).toBe(false)
  })

  it('关联指向的登记已被删除：state=deleted、label 为 null（不猜名字）', () => {
    const view = viewOf({ status: 'created', workspace_id: 'cccccccc-0000-4000-8000-000000000003' })
    expect(view.state).toBe('deleted')
    expect(view.label).toBeNull()
  })
})

describe('生命周期锁定', () => {
  it('执行事件仍为 planned 时不锁（可以绑定 / 换绑 / 解绑）', () => {
    const view = viewOf({ status: 'running', workspace_id: null }, [
      { event_type: 'execution', status: 'planned' }
    ])
    expect(view.canManage).toBe(true)
    expect(view.lockedReason).toBeNull()
  })

  it('执行事件进入 running → 锁定，原因 execution_started', () => {
    const view = viewOf({ status: 'running', workspace_id: WS_A.id }, [
      { event_type: 'execution', status: 'running' }
    ])
    expect(view.canManage).toBe(false)
    expect(view.lockedReason).toBe('execution_started')
  })

  it('验证类事件进入终态同样算已开始', () => {
    const view = viewOf({ status: 'running', workspace_id: null }, [
      { event_type: 'verification', status: 'completed' }
    ])
    expect(view.canManage).toBe(false)
    expect(view.lockedReason).toBe('execution_started')
  })

  it('plan 事件把 Journey 推成 running 时**不锁**——判据是执行事件不是 status', () => {
    // 这是规格 §四.4 点名的坑：append plan 也会让 journey.status=running。
    const view = viewOf({ status: 'running', workspace_id: null }, [
      { event_type: 'plan', status: 'completed' }
    ])
    expect(view.canManage).toBe(true)
    expect(view.lockedReason).toBeNull()
  })

  it('终态（completed / cancelled / failed / abandoned）一律锁定', () => {
    for (const status of ['completed', 'cancelled', 'failed', 'abandoned']) {
      const view = viewOf({ status, workspace_id: WS_A.id })
      expect(view.canManage, status).toBe(false)
      expect(view.lockedReason, status).toBe('journey_finished')
    }
  })

  it('paused 不在锁定名单里（用户级中断，还没出结果）', () => {
    const view = viewOf({ status: 'paused', workspace_id: null }, [
      { event_type: 'plan', status: 'completed' }
    ])
    expect(view.canManage).toBe(true)
  })
})

describe('安全与常量', () => {
  it('视图数据里没有任何绝对路径', () => {
    const view = viewOf({ status: 'created', workspace_id: WS_A.id })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(PROJECT_PATH)
    expect(serialized).not.toContain('/Users/')
    // 选项只暴露白名单字段——即使源对象带 absolutePath 也不会被展开。
    for (const option of view.options) {
      expect(Object.keys(option).sort()).toEqual(
        ['available', 'current', 'disabled', 'id', 'name']
      )
    }
  })

  it('与 main 层的两组常量不漂移', async () => {
    const main = await import('../../src/main/database/repositories/agent-journeys')
    expect([...JOURNEY_EXECUTION_EVENT_TYPES]).toEqual([
      ...main.AGENT_JOURNEY_EXECUTION_EVENT_TYPES
    ])
    // 终态：main 侧 JOURNEY_WORKSPACE_LOCKED_STATUSES 是 service 内部常量，
    // 这里用状态枚举全集做外层校验——四个值必须都是合法 Journey 状态。
    for (const status of JOURNEY_WORKSPACE_LOCKED_STATUSES) {
      expect(main.AGENT_JOURNEY_STATUSES).toContain(status)
    }
    expect([...JOURNEY_WORKSPACE_LOCKED_STATUSES]).toEqual([
      'completed',
      'cancelled',
      'failed',
      'abandoned'
    ])
  })
})

// MARK: - R6-4.3.1.1 列表加载状态（loading / failed 绝不等于 deleted）

describe('列表未加载时的展示（规格 §二）', () => {
  const bound = { status: 'created', workspace_id: WS_A.id }

  it('loading：显示 loading，**即使已绑定也绝不判成 deleted**', () => {
    const view = viewWith(bound, { status: 'loading', seq: 1 })
    expect(view.state).toBe('loading')
    expect(view.state).not.toBe('deleted')
    expect(view.listLoaded).toBe(false)
    expect(view.label).toBeNull() // 没加载出来就不假装知道名字
    expect(view.options).toEqual([])
  })

  it('failed：显示 load_failed，既不判 deleted 也不装作列表为空', () => {
    const view = viewWith(bound, { status: 'failed', seq: 2 })
    expect(view.state).toBe('load_failed')
    expect(view.state).not.toBe('deleted')
    expect(view.state).not.toBe('none')
    expect(view.listLoaded).toBe(false)
    expect(view.options).toEqual([])
  })

  it('failed 且未绑定 → 仍是 load_failed（不是「未关联工作区」的空态）', () => {
    const view = viewWith({ status: 'created', workspace_id: null }, { status: 'failed', seq: 3 })
    expect(view.state).toBe('load_failed')
    expect(view.listLoaded).toBe(false)
  })

  it('只有列表成功加载后才允许用 ID 匹配判 deleted', () => {
    const unknownId = 'cccccccc-0000-4000-8000-000000000003'
    const unknown = { status: 'created', workspace_id: unknownId }
    // 未加载：不知道 → loading / load_failed
    expect(viewWith(unknown, { status: 'loading', seq: 1 }).state).toBe('loading')
    expect(viewWith(unknown, { status: 'failed', seq: 1 }).state).toBe('load_failed')
    // 已加载且列表里没有 → 才是 deleted
    expect(viewWith(unknown, loadedList([WS_A])).state).toBe('deleted')
  })

  it('加载成功且列表为空：未绑定 = none（确实没登记），已绑定 = deleted', () => {
    const empty = loadedList([])
    expect(viewWith({ status: 'created', workspace_id: null }, empty).state).toBe('none')
    expect(viewWith({ status: 'created', workspace_id: WS_A.id }, empty).state).toBe('deleted')
    // 空列表也算 loaded——「确实没有」必须能与「没加载」区分开
    expect(viewWith({ status: 'created', workspace_id: null }, empty).listLoaded).toBe(true)
  })

  it('已加载但文件夹失效：仍显示名字（unavailable 不是 deleted）', () => {
    const missing = workspace({ id: WS_A.id, name: 'BrewPhase', availability: 'missing' })
    const view = viewWith(bound, loadedList([missing]))
    expect(view.state).toBe('unavailable')
    expect(view.label).toBe('BrewPhase')
  })

  it('生命周期锁定在加载中 / 失败时依然成立（两条规则互不覆盖）', () => {
    const locked = { status: 'completed', workspace_id: WS_A.id }
    expect(viewWith(locked, { status: 'loading', seq: 1 }).canManage).toBe(false)
    expect(viewWith(locked, { status: 'failed', seq: 1 }).canManage).toBe(false)
    expect(viewWith(locked, { status: 'loading', seq: 1 }).lockedReason).toBe('journey_finished')
  })

  it('任何状态下序列化结果都不含绝对路径', () => {
    for (const list of [
      { status: 'loading', seq: 1 },
      { status: 'failed', seq: 1 },
      loadedList([WS_A]),
      loadedList([])
    ] as JourneyWorkspaceListState[]) {
      const serialized = JSON.stringify(
        viewWith({ status: 'created', workspace_id: WS_A.id }, list)
      )
      expect(serialized).not.toContain(PROJECT_PATH)
      expect(serialized).not.toContain('/Users/')
    }
  })
})

// MARK: - R6-4.3.1.1 列表状态机（规格 §2.1）

describe('workspace 列表读取状态机', () => {
  it('初始即 loading，且不携带数组（空数组 ≠ 未加载）', () => {
    expect(INITIAL_WORKSPACE_LIST_STATE).toEqual({ status: 'loading', seq: 0 })
    expect('workspaces' in INITIAL_WORKSPACE_LIST_STATE).toBe(false)
  })

  it('首次加载 → loading；成功（哪怕空数组）→ loaded', () => {
    const loading = workspaceListStart(INITIAL_WORKSPACE_LIST_STATE, 1, true)
    expect(loading).toEqual({ status: 'loading', seq: 1 })
    const loaded = workspaceListSuccess(loading, 1, [])
    expect(loaded).toEqual({ status: 'loaded', seq: 1, workspaces: [] })
    expect('workspaces' in loaded).toBe(true)
  })

  it('失败 → failed，且不携带数组（不得吞成空列表）', () => {
    const loading = workspaceListStart(INITIAL_WORKSPACE_LIST_STATE, 1, true)
    const failed = workspaceListFailure(loading, 1)
    expect(failed).toEqual({ status: 'failed', seq: 1 })
    expect('workspaces' in failed).toBe(false)
  })

  it('较旧请求的结果不得覆盖较新状态（序号守卫）', () => {
    // 请求 1 发出 → 请求 2（重试）发出 → 请求 1 的结果才回来
    const req1 = workspaceListStart(INITIAL_WORKSPACE_LIST_STATE, 1, true)
    const req2 = workspaceListStart(req1, 2, true)
    expect(req2).toEqual({ status: 'loading', seq: 2 })
    // 请求 1 的成功/失败都必须被丢弃
    expect(workspaceListSuccess(req2, 1, [WS_A])).toEqual(req2)
    expect(workspaceListFailure(req2, 1)).toEqual(req2)
    // 只有请求 2 的结果能落库
    expect(workspaceListSuccess(req2, 2, [WS_A]).status).toBe('loaded')
  })

  it('后台刷新（非 initial）保持当前状态，只推进序号', () => {
    const loaded = workspaceListSuccess(
      workspaceListStart(INITIAL_WORKSPACE_LIST_STATE, 1, true),
      1,
      [WS_A]
    )
    const refreshing = workspaceListStart(loaded, 2, false)
    expect(refreshing.status).toBe('loaded')
    expect(refreshing.seq).toBe(2)
    // 刷新期间列表数据仍在（不闪回 loading）
    expect(refreshing).toHaveProperty('workspaces', [WS_A])

    const failed = workspaceListFailure(workspaceListStart(INITIAL_WORKSPACE_LIST_STATE, 1, true), 1)
    const retryByEvent = workspaceListStart(failed, 2, false)
    expect(retryByEvent.status).toBe('failed') // 后台事件不悄悄清掉失败态
    expect(retryByEvent.seq).toBe(2)
  })

  it('重试链：failed →（initial）loading → 成功 → loaded', () => {
    const failed = workspaceListFailure(
      workspaceListStart(INITIAL_WORKSPACE_LIST_STATE, 1, true),
      1
    )
    const retrying = workspaceListStart(failed, 2, true)
    expect(retrying).toEqual({ status: 'loading', seq: 2 })
    const recovered = workspaceListSuccess(retrying, 2, [WS_A, WS_B])
    expect(recovered.status).toBe('loaded')
    expect(recovered).toHaveProperty('workspaces', [WS_A, WS_B])
  })
})
