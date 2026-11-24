import { describe, expect, it } from 'vitest'
import {
  journeyWorkspaceView,
  JOURNEY_EXECUTION_EVENT_TYPES,
  JOURNEY_WORKSPACE_LOCKED_STATUSES
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

function viewOf(
  journey: { status: string; workspace_id: string | null },
  events: Array<{ event_type: string; status: string }> = [],
  workspaces: LocalWorkspace[] = [WS_A, WS_B]
) {
  return journeyWorkspaceView({ journey, events, workspaces })
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
