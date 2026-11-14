import { create } from 'zustand'
import {
  addParticipant,
  clampRoundtable,
  dockRoundtable,
  initialRoundtable,
  removeParticipant,
  reorderParticipants,
  retainParticipants,
  undockRoundtable,
  type PanelViewport,
  type Roundtable
} from '@shared/roundtable'
import { moveCardBefore, reconcileCardOrder } from '@shared/web-cards'
import { api } from '../../shared/api'

/**
 * 网页卡片架 + AI 圆桌的渲染层状态（Phase 2）。
 *
 * **卡片不再是一份数据**：卡片的身份、标题、URL、加载态全部来自
 * `useBrowserStore`（主进程快照），这里只保存两件渲染层自己的事：
 * - `cardOrder`：架上的展示顺序（可持久化，永不改写 tabId）；
 * - `roundtable`：参与者 tabId 与圆桌几何。
 *
 * 所以 `syncTabs` 必须在浏览器快照变化时被调用：它做顺序对账，并把已关闭
 * 的标签从圆桌里摘掉。关闭卡片 = 关闭真实标签；加入圆桌 = 建立引用。
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
  roundtable: Roundtable
  /** 架子顺序（tabId 数组）。 */
  cardOrder: string[]
  selectedTabId: string | null
  draggingTabId: string | null
  /** 拖动中光标已在主窗口之外（卡片显示「松手拆出」）。 */
  dragOutside: boolean
  /** 圆桌提问草稿：停靠 ↔ 浮动切换也不丢。 */
  draft: string
  setDraft: (value: string) => void
  setDragOutside: (outside: boolean) => void

  /** 浏览器快照变化时对账：顺序保留、失效标签清理、参与者同步。 */
  syncTabs: (tabIds: string[]) => void
  /** 「添加网页」：新建真实标签（不抢焦点），卡片进入地址输入态。 */
  createCard: () => Promise<void>
  /** 关闭卡片 = 关闭真实标签；同时解除圆桌引用。 */
  closeCard: (tabId: string) => Promise<void>
  moveCard: (tabId: string, beforeTabId: string | null) => void
  selectTab: (tabId: string | null) => void
  setDraggingTab: (tabId: string | null) => void

  joinRoundtable: (tabId: string) => void
  leaveRoundtable: (tabId: string) => void
  reorderRoundtable: (tabId: string, overId: string) => void

  undock: (viewport: PanelViewport) => void
  dock: () => void
  moveFloating: (delta: { dx: number; dy: number }, viewport: PanelViewport) => void
  resizeFloating: (delta: { dw: number; dh: number }, viewport: PanelViewport) => void
}

export const useRoundtableStore = create<RoundtableStore>((set, get) => ({
  roundtable: initialRoundtable(),
  cardOrder: readStoredOrder(),
  selectedTabId: null,
  draggingTabId: null,
  dragOutside: false,
  draft: '',
  setDraft: (value) => set({ draft: value }),
  setDragOutside: (outside) => set({ dragOutside: outside }),

  syncTabs: (tabIds) => {
    set((state) => {
      const cardOrder = reconcileCardOrder(state.cardOrder, tabIds)
      if (cardOrder.length !== state.cardOrder.length || cardOrder.some((id, at) => id !== state.cardOrder[at])) {
        writeStoredOrder(cardOrder)
      }
      const alive = new Set(tabIds)
      return {
        cardOrder,
        roundtable: retainParticipants(state.roundtable, tabIds),
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
        roundtable: removeParticipant(state.roundtable, tabId),
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

  joinRoundtable: (tabId) => {
    set((state) => ({ roundtable: addParticipant(state.roundtable, tabId) }))
  },

  leaveRoundtable: (tabId) => {
    set((state) => ({ roundtable: removeParticipant(state.roundtable, tabId) }))
  },

  reorderRoundtable: (tabId, overId) => {
    set((state) => ({ roundtable: reorderParticipants(state.roundtable, tabId, overId) }))
  },

  undock: (viewport) => {
    set((state) => {
      const next = undockRoundtable(state.roundtable)
      const { position, size } = clampRoundtable(next.position, next.size, viewport)
      return { roundtable: { ...next, position, size } }
    })
  },

  dock: () => {
    set((state) => ({ roundtable: dockRoundtable(state.roundtable) }))
  },

  moveFloating: (delta, viewport) => {
    set((state) => {
      const { position } = clampRoundtable(
        { x: state.roundtable.position.x + delta.dx, y: state.roundtable.position.y + delta.dy },
        state.roundtable.size,
        viewport
      )
      return { roundtable: { ...state.roundtable, position } }
    })
  },

  resizeFloating: (delta, viewport) => {
    set((state) => {
      const { position, size } = clampRoundtable(
        state.roundtable.position,
        {
          width: state.roundtable.size.width + delta.dw,
          height: state.roundtable.size.height + delta.dh
        },
        viewport
      )
      return { roundtable: { ...state.roundtable, position, size } }
    })
  }
}))

/** E2E / 单测用：重置成初始状态（清空顺序与参与者，不动真实浏览器）。 */
export function resetRoundtableStoreForTesting(): void {
  try {
    orderStorage()?.removeItem(ORDER_KEY)
  } catch {
    // ignore
  }
  useRoundtableStore.setState({
    roundtable: initialRoundtable(),
    cardOrder: [],
    selectedTabId: null,
    draggingTabId: null,
    dragOutside: false,
    draft: ''
  })
}
