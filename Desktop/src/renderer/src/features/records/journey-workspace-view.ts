import type { LocalWorkspace } from '@shared/contracts'

/**
 * Journey 工作区关联的**展示规则**与**列表读取状态机**（R6-4.3.1 → R6-4.3.1.1）。
 *
 * 本仓库没有 renderer 测试设施（无 testing-library / jsdom，见
 * `remote-pairing-view.ts` 同一理由），所以「显示什么、能不能改、列表处于
 * 什么状态」被抽成纯函数——组件只负责照着 view model 渲染，测试钉住规则本身。
 *
 * 三条硬约束：
 * 1. **只回显示名，绝不回绝对路径**——options / label 里没有 `absolutePath`
 *    字段，机器上的目录位置不进渲染层的这段数据；
 * 2. **服务端才是权限**——这里的 `canManage` 只是客户端预判（省一次必然
 *    失败的请求），主进程 `AgentJourneyService.bindWorkspace` 会在事务里
 *    重新校验一次，下拉框里有什么选项不算数；
 * 3. **没加载 ≠ 没数据**（R6-4.3.1.1）——列表尚未加载、加载失败、确实没有
 *    工作区、登记已被删除是四件不同的事，任何一件都不许拿空数组顶替。
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

// MARK: - Workspace 列表读取状态机（R6-4.3.1.1）

/**
 * 列表读取状态：**判别联合**，状态与数据永远一致——
 * - `loading` / `failed` 不携带数组，因此不可能被误读成「确实没有工作区」；
 * - `loaded` 必带数组（**空数组 = 确实一个都没登记**）；
 * - `seq` 是已发出的最新请求序号：结果序号对不上 = 过期请求，原样丢弃，
 *   保证「较旧请求不得覆盖较新结果」。
 */
export type JourneyWorkspaceListState =
  | { status: 'loading'; seq: number }
  | { status: 'loaded'; seq: number; workspaces: readonly LocalWorkspace[] }
  | { status: 'failed'; seq: number }

/** 首次挂载前的初始状态：还没有任何请求完成过。 */
export const INITIAL_WORKSPACE_LIST_STATE: JourneyWorkspaceListState = {
  status: 'loading',
  seq: 0
}

/**
 * 发起一次读取。
 *
 * - `initial = true`（首次加载 / 用户点重试）→ 进入 `loading`，界面显示
 *   「正在读取」并暂时收起绑定操作；
 * - `initial = false`（`localWorkspaces` 变化触发的后台刷新）→ **保持当前
 *   状态**（loaded 继续显示列表、failed 继续显示重试），只推进序号，
 *   避免每次登记变化都让界面闪一下「正在读取」。
 */
export function workspaceListStart(
  prev: JourneyWorkspaceListState,
  seq: number,
  initial: boolean
): JourneyWorkspaceListState {
  if (initial) return { status: 'loading', seq }
  if (prev.status === 'loaded') return { ...prev, seq }
  return { status: prev.status, seq }
}

/** 读取成功：即使结果是空数组也算 `loaded`（空 ≠ 未加载）。 */
export function workspaceListSuccess(
  prev: JourneyWorkspaceListState,
  seq: number,
  workspaces: readonly LocalWorkspace[]
): JourneyWorkspaceListState {
  if (seq !== prev.seq) return prev // 过期请求：较旧结果不得覆盖较新状态
  return { status: 'loaded', seq, workspaces }
}

/** 读取失败：明确失败态，**绝不**退化成空列表。 */
export function workspaceListFailure(
  prev: JourneyWorkspaceListState,
  seq: number
): JourneyWorkspaceListState {
  if (seq !== prev.seq) return prev
  return { status: 'failed', seq }
}

// MARK: - 关联状态视图

/** 关联状态：六态分别对应六种文案，缺一个都会让用户猜。 */
export type JourneyWorkspaceBindingState =
  /** 列表读取中——不知道登记情况，**不得**当成 deleted。 */
  | 'loading'
  /** 列表读取失败——同样不得当成 deleted，也不得假装列表为空。 */
  | 'load_failed'
  /** 未关联（含升级后恒为 null 的旧数据）。 */
  | 'none'
  /** 已关联且文件夹当前可用。 */
  | 'linked'
  /** 关联还在，但文件夹已失效（被移走 / 删除）。 */
  | 'unavailable'
  /** **仅在列表成功加载后**：关联指向的登记确实不在列表里。 */
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
  /** 生命周期上主进程会接受绑定 / 换绑 / 解绑吗（客户端预判；服务端仍会再校验）。 */
  canManage: boolean
  /** 列表是否已成功加载——只有此时才渲染绑定操作与「没有登记」提示。 */
  listLoaded: boolean
  /** 锁定原因，`canManage=false` 时必有一个。 */
  lockedReason: 'execution_started' | 'journey_finished' | null
  workspaceId: string | null
  state: JourneyWorkspaceBindingState
  /** 关联工作区的显示名；列表未加载 / 未关联 / 登记已删除时为 null。永远不是路径。 */
  label: string | null
  options: JourneyWorkspaceOption[]
}

export function journeyWorkspaceView(input: {
  journey: { status: string; workspace_id: string | null }
  events: ReadonlyArray<{ event_type: string; status: string }>
  list: JourneyWorkspaceListState
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

  const list = input.list
  const listLoaded = list.status === 'loaded'
  // 局部 const 才能触发 TS 的别名收窄（直接写 `input.list.workspaces` 不收窄）。
  const workspaces: readonly LocalWorkspace[] = listLoaded ? list.workspaces : []
  const workspaceId = input.journey.workspace_id
  const bound = listLoaded && workspaceId
    ? workspaces.find((workspace) => workspace.id === workspaceId)
    : undefined

  // 列表状态优先于关联状态：没加载出来之前，任何 ID 匹配结论都不可信。
  let state: JourneyWorkspaceBindingState
  if (!listLoaded) {
    state = list.status === 'loading' ? 'loading' : 'load_failed'
  } else if (!workspaceId) {
    state = 'none'
  } else if (!bound) {
    state = 'deleted'
  } else {
    state = bound.availability === 'available' ? 'linked' : 'unavailable'
  }

  return {
    canManage: lockedReason === null,
    listLoaded,
    lockedReason,
    workspaceId,
    state,
    label: bound?.name ?? null,
    // 列表没加载出来时不给选项——「看起来没有可选项」≠「确实没登记」。
    options: listLoaded
      ? workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          available: workspace.availability === 'available',
          current: workspace.id === workspaceId,
          disabled: workspace.availability !== 'available'
        }))
      : []
  }
}
