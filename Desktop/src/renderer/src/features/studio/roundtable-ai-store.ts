import { create } from 'zustand'
import {
  isRoundtableAITaskBusy,
  type AIRoundtableParticipantStatus,
  type AIRoundtableTaskSnapshot
} from '@shared/contracts'
import { api } from '../../shared/api'
import { useRoundtableStore } from './roundtable-store'

/**
 * 圆桌真实 WebCard 问答的状态（Phase 4.2）。
 *
 * **tabId 是参与者身份**：成员识别（describe）与任务快照（task）都按
 * tabId 组织，同平台多张卡是多个独立成员。Renderer 不传平台名——
 * 提交时把当前圆桌成员 tabIds 原样交给主进程，由主进程筛选可自动
 * 交互的 AI 网页成员；平台识别来自主进程 Registry 对实时 URL 的判定。
 *
 * 广播来自主进程（roundtable-ai-task:changed），两个圆桌窗口同态；
 * 成员识别是拉取式：挂载、成员增减、页面导航、任务结束后刷新。
 */

type RoundtableAIStore = {
  /** 最近一次（或进行中的）任务快照；按 tabId 区分参与者结果。 */
  task: AIRoundtableTaskSnapshot | null
  /** 成员识别结果（tabId → 状态）；普通网页 / 未适配平台也在其中。 */
  members: Record<string, AIRoundtableParticipantStatus>
  membersLoading: boolean
  /** ask 的本地失败（无可用 AI 成员、忙时重复提交等）。 */
  error: string | null

  hydrate: () => Promise<void>
  /** 主进程广播 → store（App 挂载时订阅一次；两个窗口都会走到）。 */
  applyTask: (payload: AIRoundtableTaskSnapshot | null) => void
  /** 重新识别指定成员（挂载 / 成员增减 / 页面导航 / 手动刷新）。 */
  refreshMembers: (tabIds: string[]) => Promise<void>
  /** 从圆桌发起：prompt 取共享草稿、成员取圆桌快照，无第二份来源。 */
  ask: () => Promise<void>
  stop: () => Promise<void>
  clearError: () => void
}

export const useRoundtableAIStore = create<RoundtableAIStore>((set, get) => ({
  task: null,
  members: {},
  membersLoading: false,
  error: null,

  hydrate: async () => {
    try {
      const [task, snapshot] = await Promise.all([api.roundtableAI.lastTask(), api.roundtable.state()])
      set({ task })
      await get().refreshMembers(snapshot.participantTabIds)
    } catch (error) {
      console.error('[roundtable-ai] hydrate failed', error)
    }
  },

  applyTask: (payload) => {
    const wasBusy = isRoundtableAITaskBusy(get().task)
    const busy = isRoundtableAITaskBusy(payload)
    set({ task: payload, error: null })
    // 任务从忙转闲：成员状态（登录态/页面 URL）重新识别一次。
    if (wasBusy && !busy) {
      void get().refreshMembers(useRoundtableStore.getState().snapshot.participantTabIds)
    }
  },

  refreshMembers: async (tabIds) => {
    if (tabIds.length === 0) {
      set({ members: {}, membersLoading: false })
      return
    }
    set({ membersLoading: true })
    try {
      const statuses = await api.roundtableAI.describe(tabIds)
      // 只合并仍在圆桌里的成员，避免异步返回时成员已变化。
      const alive = new Set(useRoundtableStore.getState().snapshot.participantTabIds)
      const next = { ...get().members }
      for (const status of statuses) {
        if (alive.has(status.tabId)) next[status.tabId] = status
        else delete next[status.tabId]
      }
      set({ members: next, membersLoading: false })
    } catch (error) {
      console.error('[roundtable-ai] describe failed', error)
      set({ membersLoading: false })
    }
  },

  ask: async () => {
    const snapshot = useRoundtableStore.getState().snapshot
    const prompt = snapshot.draft.trim()
    if (!prompt || snapshot.participantTabIds.length === 0) return
    set({ error: null })
    try {
      const { conversationId, snapshot: result } = await api.roundtableAI.ask({
        prompt,
        participantTabIds: [...snapshot.participantTabIds]
      })
      set({ task: { ...result, conversationId } })
    } catch (caught) {
      set({ error: String(caught instanceof Error ? caught.message : caught) })
    } finally {
      void get().refreshMembers(snapshot.participantTabIds)
    }
  },

  stop: async () => {
    try {
      await api.roundtableAI.cancel()
    } catch (error) {
      console.error('[roundtable-ai] cancel failed', error)
    }
  },

  clearError: () => set({ error: null })
}))

/** 主进程圆桌 AI 任务广播 → store。返回解绑函数；App 挂载时调一次（两个窗口都会走到）。 */
export function subscribeRoundtableAI(): () => void {
  return api.roundtableAI.onChanged((payload) => {
    useRoundtableAIStore.getState().applyTask(payload)
  })
}

/** E2E / 单测用：清空本地缓存（不动主进程状态）。 */
export function resetRoundtableAIStoreForTesting(): void {
  useRoundtableAIStore.setState({ task: null, members: {}, membersLoading: false, error: null })
}
