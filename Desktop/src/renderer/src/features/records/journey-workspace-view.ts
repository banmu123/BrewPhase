import type { LocalWorkspace } from '@shared/contracts'

/**
 * Journey 工作区关联的**展示规则**（R6-4.3.1）。
 *
 * 本仓库没有 renderer 测试设施（无 testing-library / jsdom，见
 * `remote-pairing-view.ts` 同一理由），所以「显示什么、能不能改」被抽成
 * 纯函数——组件只负责照着 view model 渲染，测试钉住规则本身。
 *
 * 两条硬约束：
 * 1. **只回显示名，绝不回绝对路径**——options / label 里没有 `absolutePath`
 *    字段，机器上的目录位置不进渲染层的这段数据；
 * 2. **服务端才是权限**——这里的 `canManage` 只是客户端预判（省一次必然
 *    失败的请求），主进程 `AgentJourneyService.bindWorkspace` 会在事务里
 *    重新校验一次，下拉框里有什么选项不算数。
 */

/** 执行类事件；与 main 层 `AGENT_JOURNEY_EXECUTION_EVENT_TYPES` 保持一致。 */
export const JOURNEY_EXECUTION_EVENT_TYPES = ['execution', 'verification'] as const

/**
 * 这些状态下不允许再改工作区关联；与 main 层
 * `JOURNEY_WORKSPACE_LOCKED_STATUSES` 保持一致（`failed` 也在内：出过结果
 * 的任务不允许再换观察范围，即便状态机还允许它回到 running）。
 */
export const JOURNEY_WORKSPACE_LOCKED_STATUSES = [
  'completed',
  'cancelled',
  'failed',
  'abandoned'
] as const

/** 关联状态：四态分别对应四种文案，缺一个都会让用户猜。 */
export type JourneyWorkspaceBindingState =
  /** 未关联（含升级后恒为 null 的旧数据）。 */
  | 'none'
  /** 已关联且文件夹当前可用。 */
  | 'linked'
  /** 关联还在，但文件夹已失效（被移走 / 删除）。 */
  | 'unavailable'
  /** 关联指向的工作区登记已被删除（正常应由外键置 null，这里是兜底展示）。 */
  | 'deleted'

export type JourneyWorkspaceOption = {
  id: string
  /** 只有显示名——**不是路径**。 */
  name: string
  available: boolean
  current: boolean
  /** 不可用的工作区不许被选中（服务端同样会拒绝）。 */
  disabled: boolean
}

export type JourneyWorkspaceView = {
  /** 主进程会接受绑定 / 换绑 / 解绑吗（客户端预判；服务端仍会再校验）。 */
  canManage: boolean
  /** 锁定原因，`canManage=false` 时必有一个。 */
  lockedReason: 'execution_started' | 'journey_finished' | null
  workspaceId: string | null
  state: JourneyWorkspaceBindingState
  /** 关联工作区的显示名；`state='deleted'` 时为 null。永远不是路径。 */
  label: string | null
  options: JourneyWorkspaceOption[]
}

export function journeyWorkspaceView(input: {
  journey: { status: string; workspace_id: string | null }
  events: ReadonlyArray<{ event_type: string; status: string }>
  workspaces: readonly LocalWorkspace[]
}): JourneyWorkspaceView {
  // 「是否已开始」看**真实执行事件**，不看 journey.status：plan / decision
  // 这类陈述事件也会把 Journey 推成 running（与 Service 的判据一致）。
  const executionStarted = input.events.some(
    (event) =>
      (JOURNEY_EXECUTION_EVENT_TYPES as readonly string[]).includes(event.event_type) &&
      event.status !== 'planned'
  )
  const finished = (JOURNEY_WORKSPACE_LOCKED_STATUSES as readonly string[]).includes(
    input.journey.status
  )
  const lockedReason = finished
    ? 'journey_finished'
    : executionStarted
      ? 'execution_started'
      : null

  const workspaceId = input.journey.workspace_id
  const bound = workspaceId
    ? input.workspaces.find((workspace) => workspace.id === workspaceId)
    : undefined
  const state: JourneyWorkspaceBindingState = !workspaceId
    ? 'none'
    : !bound
      ? 'deleted'
      : bound.availability === 'available'
        ? 'linked'
        : 'unavailable'

  return {
    canManage: lockedReason === null,
    lockedReason,
    workspaceId,
    state,
    label: bound?.name ?? null,
    options: input.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      available: workspace.availability === 'available',
      current: workspace.id === workspaceId,
      disabled: workspace.availability !== 'available'
    }))
  }
}
