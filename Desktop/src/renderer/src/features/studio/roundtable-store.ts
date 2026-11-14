import { create } from 'zustand'
import { initialRoundtableSnapshot, type RoundtableSnapshot } from '@shared/roundtable'
import { moveCardBefore, reconcileCardOrder } from '@shared/web-cards'
import { api } from '../../shared/api'

/**
 * AI 圆桌 + 卡片架的渲染层状态（Phase 3）。
 *
 * **圆桌状态的主进程化**：主窗口与圆桌独立窗口是两个 Renderer，各自的
 * Zustand 不能互为真相。这里只保存主进程 RoundtableService 广播来的快照
 * （`snapshot`）与两件渲染层自己的事：架子顺序 `cardOrder`（可持久化，
 * 永不改 tabId）与拖拽中的临时 UI 状态。
 *
 * 所有圆桌动作都是「发意图 → 主进程校验/提交 → 广播回快照」：
 * - join 会校验 tabId 真实存在，网页关闭时主进程自动摘除参与者；
 * - setDraft 带 baseVersion 做乐观并发控制，过期写入被拒绝（返回最新快照）；
 * - detached=true 时主窗口显示占位区，独立窗口渲染完整圆桌。
 */

const ORDER_KEY = 'brewphase.webCards.order'

/** 只用最小结构类型：单测在 node 环境跑，没有 DOM 的 Storage 声明。 */
type OrderStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function orderStorage(): OrderStorage | null {
  const scope = globalThis as unknown as { localStorage?: OrderStorage }
  return scope.localStorage ?? null
}

function readStoredOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(orderStorage()?.getItem(ORDER_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function writeStoredOrder(order: string[]): void {
  try {
    orderStorage()?.setItem(ORDER_KEY, JSON.stringify(order))
  } catch {
    // 隐私模式/配额满：顺序退化为会话内记忆，不影响功能。
  }
}

type RoundtableStore = {
  /** 主进程广播的圆桌快照（唯一事实来源的缓存）。 */
  snapshot: RoundtableSnapshot
  hydrated: boolean
  /** 架子顺序（tabId 数组）：纯展示偏好，永不改写 tabId。 */
  cardOrder: string[]
  selectedTabId: string | null
  draggingTabId: string | null
  /** 拖动中光标已在所有已知窗口之外（主进程帧广播）。 */
  dragOutside: boolean
  /** 拖拽会话是否属于圆桌（区分卡片拖出与圆桌拖出的提示）。 */
  draggingRoundtable: boolean

  hydrate: () => Promise<void>
  applySnapshot: (snapshot: RoundtableSnapshot) => void

  /** 浏览器快照变化时对账：架子顺序保留、失效引用清理。 */
  syncTabs: (tabIds: string[]) => void
  /** 「添加网页」：新建真实标签（不抢焦点），卡片进入地址输入态。 */
  createCard: () => Promise<void>
  /** 关闭卡片 = 关闭真实标签；主进程会同步摘除圆桌参与者。 */
  closeCard: (tabId: string) => Promise<void>
  moveCard: (tabId: string, beforeTabId: string | null) => void
  selectTab: (tabId: string | null) => void
  setDraggingTab: (tabId: string | null) => void
  setDragOutside: (outside: boolean) => void
  setDraggingRoundtable: (dragging: boolean) => void

  joinRoundtable: (tabId: string) => Promise<void>
  leaveRoundtable: (tabId: string) => Promise<void>
  setDraft: (value: string) => Promise<void>
  detachRoundtable: (point?: { screenX: number; screenY: number }) => Promise<void>
  dockRoundtable: () => Promise<void>
  focusRoundtable: () => Promise<void>
}

export const useRoundtableStore = create<RoundtableStore>((set) => ({
  snapshot: initialRoundtableSnapshot(),
  hydrated: false,
  cardOrder: readStoredOrder(),
  selectedTabId: null,
  draggingTabId: null,
  dragOutside: false,
  draggingRoundtable: false,

  hydrate: async () => {
    try {
      const snapshot = await api.roundtable.state()
      set({ snapshot, hydrated: true })
    } catch (error) {
      console.error('[roundtable] hydrate failed', error)
      set({ hydrated: true })
    }
  },

  applySnapshot: (snapshot) => set({ snapshot, hydrated: true }),

  syncTabs: (tabIds) => {
    set((state) => {
      const cardOrder = reconcileCardOrder(state.cardOrder, tabIds)
      if (cardOrder.length !== state.cardOrder.length || cardOrder.some((id, at) => id !== state.cardOrder[at])) {
        writeStoredOrder(cardOrder)
      }
      const alive = new Set(tabIds)
      return {
        cardOrder,
        // 参与者的摘除在主进程（syncTabs 广播）；这里只清本窗口的临时选择。
        selectedTabId: state.selectedTabId && alive.has(state.selectedTabId) ? state.selectedTabId : null,
        draggingTabId: state.draggingTabId && alive.has(state.draggingTabId) ? state.draggingTabId : null
      }
    })
  },

  createCard: async () => {
    try {
      await api.browserTabs.createShelfTab()
    } catch (error) {
      console.error('[web-cards] create failed', error)
    }
  },

  closeCard: async (tabId) => {
    set((state) => {
      const cardOrder = state.cardOrder.filter((id) => id !== tabId)
      writeStoredOrder(cardOrder)
      return {
        cardOrder,
        selectedTabId: state.selectedTabId === tabId ? null : state.selectedTabId,
        draggingTabId: state.draggingTabId === tabId ? null : state.draggingTabId
      }
    })
    try {
      await api.browserTabs.closeTab(tabId)
    } catch (error) {
      console.error('[web-cards] close failed', error)
    }
  },

  moveCard: (tabId, beforeTabId) => {
    set((state) => {
      const cardOrder = moveCardBefore(state.cardOrder, tabId, beforeTabId)
      writeStoredOrder(cardOrder)
      return { cardOrder }
    })
  },

  selectTab: (tabId) => set({ selectedTabId: tabId }),
  setDraggingTab: (tabId) => set({ draggingTabId: tabId, dragOutside: false }),
  setDragOutside: (outside) => set({ dragOutside: outside }),
  setDraggingRoundtable: (dragging) => set({ draggingRoundtable: dragging, dragOutside: false }),

  joinRoundtable: async (tabId) => {
    try {
      set({ snapshot: await api.roundtable.join(tabId) })
    } catch (error) {
      console.error('[roundtable] join failed', error)
    }
  },

  leaveRoundtable: async (tabId) => {
    try {
      set({ snapshot: await api.roundtable.leave(tabId) })
    } catch (error) {
      console.error('[roundtable] leave failed', error)
    }
  },

  setDraft: async (value) => {
    try {
      set({ snapshot: await api.roundtable.setDraft(value) })
    } catch (error) {
      console.error('[roundtable] setDraft failed', error)
    }
  },

  detachRoundtable: async (point) => {
    try {
      set({ snapshot: await api.roundtable.detach(point) })
    } catch (error) {
      console.error('[roundtable] detach failed', error)
    }
  },

  dockRoundtable: async () => {
    try {
      set({ snapshot: await api.roundtable.dock() })
    } catch (error) {
      console.error('[roundtable] dock failed', error)
    }
  },

  focusRoundtable: async () => {
    try {
      set({ snapshot: await api.roundtable.focus() })
    } catch (error) {
      console.error('[roundtable] focus failed', error)
    }
  }
}))

/** E2E / 单测用：重置成初始状态（清空顺序，不动主进程状态）。 */
export function resetRoundtableStoreForTesting(): void {
  try {
    orderStorage()?.removeItem(ORDER_KEY)
  } catch {
    // ignore
  }
  useRoundtableStore.setState({
    snapshot: initialRoundtableSnapshot(),
    cardOrder: [],
    selectedTabId: null,
    draggingTabId: null,
    dragOutside: false,
    draggingRoundtable: false
  })
}

/** 主进程广播 → store。返回解绑函数；在 App 挂载时调一次即可。 */
export function subscribeRoundtableState(): () => void {
  return api.roundtable.onSnapshot((snapshot) => {
    useRoundtableStore.getState().applySnapshot(snapshot)
  })
}

/** 主进程拖拽帧 → store（窗口外提示）。 */
export function subscribeBrowserDragFrames(): () => void {
  return api.browserDrag.onFrame((frame) => {
    const store = useRoundtableStore.getState()
    if (!frame.active) {
      store.setDragOutside(false)
      store.setDraggingRoundtable(false)
      if (frame.kind === 'webcard') store.setDraggingTab(null)
      return
    }
    store.setDragOutside(frame.outside)
    if (frame.kind === 'roundtable') store.setDraggingRoundtable(true)
  })
}
