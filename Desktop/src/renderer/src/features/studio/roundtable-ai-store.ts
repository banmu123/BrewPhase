import { create } from 'zustand'
import { isAIChatTaskBusy, type AIChatTaskSnapshot, type AIPlatformStatus } from '@shared/contracts'
import { api } from '../../shared/api'
import { useRoundtableStore } from './roundtable-store'

/**
 * 圆桌的 Multi-AI 任务状态（Phase 4.1）。
 *
 * 提问能力**复用** AIChatService——这里没有第二套调度：提交就是
 * `api.aiChat.ask({ prompt: 圆桌草稿, providers })`，进度全部来自主进程的
 * `ai-chat:status:changed` 广播。主窗口与圆桌独立窗口订阅同一份广播，
 * 所以两边永远看到同一个任务状态；本地不猜测、不倒推。
 *
 * 平台登录状态（statuses）是 DOM 探测的结果，不走广播：挂载时拉一次、
 * 任务结束后刷新、用户点「重新检测」再刷新。
 */

type RoundtableAIStore = {
  /** 最近一次（或进行中的）任务快照；广播与 lastTask hydration 的缓存。 */
  task: AIChatTaskSnapshot | null
  /** 平台登录状态（未拉取过时是 null，UI 显示占位）。 */
  statuses: AIPlatformStatus[] | null
  /** ask 的本地失败（网络断开、忙时重复提交等）。 */
  error: string | null

  hydrate: () => Promise<void>
  /** 主进程广播 → store（App 挂载时订阅一次；两个窗口都订阅）。 */
  applyTask: (payload: AIChatTaskSnapshot | null) => void
  refreshStatuses: () => Promise<void>
  /** 从圆桌发起：prompt 直接取共享草稿，绝不第二份来源。 */
  ask: (providers: Array<'chatgpt' | 'claude'>) => Promise<void>
  stop: () => Promise<void>
  clearError: () => void
}

export const useRoundtableAIStore = create<RoundtableAIStore>((set, get) => ({
  task: null,
  statuses: null,
  error: null,

  hydrate: async () => {
    try {
      const [task, statuses] = await Promise.all([api.aiChat.lastTask(), api.aiChat.statuses()])
      set({ task, statuses })
    } catch (error) {
      console.error('[roundtable-ai] hydrate failed', error)
      set({ statuses: [] })
    }
  },

  applyTask: (payload) => {
    const wasBusy = isAIChatTaskBusy(get().task)
    const busy = isAIChatTaskBusy(payload)
    set({ task: payload, error: null })
    // 任务从忙转闲：平台状态重新探测一次（生成期间的登录态可能是旧的）。
    if (wasBusy && !busy) void get().refreshStatuses()
  },

  refreshStatuses: async () => {
    try {
      set({ statuses: await api.aiChat.statuses() })
    } catch (error) {
      console.error('[roundtable-ai] statuses failed', error)
    }
  },

  ask: async (providers) => {
    if (providers.length === 0) return
    const prompt = useRoundtableStore.getState().snapshot.draft.trim()
    if (!prompt) return
    set({ error: null })
    try {
      const { conversationId, snapshot } = await api.aiChat.ask({ prompt, providers })
      set({ task: { ...snapshot, conversationId } })
    } catch (caught) {
      set({ error: String(caught instanceof Error ? caught.message : caught) })
    } finally {
      void get().refreshStatuses()
    }
  },

  stop: async () => {
    try {
      await api.aiChat.cancel()
    } catch (error) {
      console.error('[roundtable-ai] cancel failed', error)
    }
  },

  clearError: () => set({ error: null })
}))

/** 主进程 AI 任务广播 → store。返回解绑函数；App 挂载时调一次（两个窗口都会走到）。 */
export function subscribeRoundtableAI(): () => void {
  return api.aiChat.onChanged((payload) => {
    useRoundtableAIStore.getState().applyTask(payload)
  })
}

/** E2E / 单测用：清空本地缓存（不动主进程状态）。 */
export function resetRoundtableAIStoreForTesting(): void {
  useRoundtableAIStore.setState({ task: null, statuses: null, error: null })
}
