import { create } from 'zustand'
import {
  addBlankCard,
  addParticipant,
  blankWebCard,
  cardDisplayName,
  clampRoundtable,
  closeCard,
  initialRoundtable,
  isJoinableCard,
  nextWebCardId,
  removeParticipant,
  reorderCards,
  reorderParticipants,
  resetWebCardSeqForTesting,
  undockRoundtable,
  dockRoundtable,
  type PanelViewport,
  type Roundtable,
  type WebCard
} from '@shared/roundtable'

/**
 * 网页卡片架 + AI 圆桌的渲染层状态（Roundtable Phase 1）。
 *
 * 与 browser-store 的分工：那份状态的主人在主进程（BrowserManager 广播），
 * 这份状态**只在渲染层**——本阶段网页卡片是本地模拟数据，不连 WebContents。
 * 所以它就是真相本身，不需要 hydrate / 广播；后续接真实浏览器时再把它
 * 改造成「主进程快照的缓存」，操作语义（join / leave / close）保持不变。
 *
 * 几何 clamp 在 store 收口：组件只报增量（位移 / 尺寸），这里负责不越界。
 */

/**
 * 演示用测试数据由 UI 填入：初始只有**一张空白卡**（规格 §3），
 * 用户通过卡片上的内联表单把它填成站点卡；「添加网页」再开新的空白卡。
 * 本阶段不连 WebContents，卡片数据就是本地状态。
 */

type RoundtableStore = {
  cards: WebCard[]
  roundtable: Roundtable
  /** 当前选中的卡片 ID（选中态与拖入无关，只是架上的高亮）。 */
  selectedCardId: string | null
  /** 正在架内拖动的卡片 ID（拖动态样式）。 */
  draggingCardId: string | null
  /** 圆桌提问草稿：停靠 ↔ 浮动切换（两棵子树）也不丢（规格 §4.4）。 */
  draft: string
  setDraft: (value: string) => void

  addCard: () => void
  /** 编辑卡片（本阶段：把空白卡填成一张站点卡，或改标题/地址）。 */
  updateCard: (id: string, patch: Partial<Pick<WebCard, 'title' | 'url' | 'status' | 'favicon'>>) => void
  closeCard: (id: string) => void
  selectCard: (id: string | null) => void
  setDraggingCard: (id: string | null) => void
  reorderCard: (id: string, overId: string) => void

  /** 拖入圆桌（建立参与关系）。空白卡不可加入。 */
  joinRoundtable: (cardId: string) => boolean
  leaveRoundtable: (cardId: string) => void
  reorderRoundtable: (cardId: string, overId: string) => void

  undock: (viewport: PanelViewport) => void
  dock: () => void
  moveFloating: (delta: { dx: number; dy: number }, viewport: PanelViewport) => void
  resizeFloating: (delta: { dw: number; dh: number }, viewport: PanelViewport) => void

  /** 测试 / E2E 直接取展示名，避免组件里拼兜底逻辑。 */
  displayName: (id: string, fallback: string) => string
}

export const useRoundtableStore = create<RoundtableStore>((set, get) => ({
  cards: [blankWebCard(nextWebCardId())],
  roundtable: initialRoundtable(),
  selectedCardId: null,
  draggingCardId: null,
  draft: '',
  setDraft: (value) => set({ draft: value }),

  addCard: () => {
    set((state) => ({ cards: addBlankCard(state.cards, nextWebCardId()) }))
  },

  updateCard: (id, patch) => {
    set((state) => ({
      cards: state.cards.map((card) => (card.id === id ? { ...card, ...patch } : card))
    }))
  },

  closeCard: (id) => {
    set((state) => {
      const { cards, roundtable } = closeCard(state.cards, state.roundtable, id)
      return {
        cards,
        roundtable,
        selectedCardId: state.selectedCardId === id ? null : state.selectedCardId
      }
    })
  },

  selectCard: (id) => set({ selectedCardId: id }),
  setDraggingCard: (id) => set({ draggingCardId: id }),

  reorderCard: (id, overId) => {
    set((state) => ({ cards: reorderCards(state.cards, id, overId) }))
  },

  joinRoundtable: (cardId) => {
    const state = get()
    const card = state.cards.find((item) => item.id === cardId)
    if (!card || !isJoinableCard(card)) return false
    set({ roundtable: addParticipant(state.roundtable, cardId) })
    return true
  },

  leaveRoundtable: (cardId) => {
    set((state) => ({ roundtable: removeParticipant(state.roundtable, cardId) }))
  },

  reorderRoundtable: (cardId, overId) => {
    set((state) => ({ roundtable: reorderParticipants(state.roundtable, cardId, overId) }))
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
      const { position, size } = clampRoundtable(
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
      return { roundtable: { ...state.roundtable, size } }
    })
  },

  displayName: (id, fallback) => {
    const card = get().cards.find((item) => item.id === id)
    return card ? cardDisplayName(card, fallback) : fallback
  }
}))

/** E2E / 单测用：重置成初始状态（一张空白卡 + 空圆桌）。ID 序号同步拨回
 * 起点，所以重置后第一张卡恒为 `webcard-1`、`addCard()` 从 `webcard-2` 起。 */
export function resetRoundtableStoreForTesting(): void {
  resetWebCardSeqForTesting()
  useRoundtableStore.setState({
    cards: [blankWebCard(nextWebCardId())],
    roundtable: initialRoundtable(),
    selectedCardId: null,
    draggingCardId: null,
    draft: ''
  })
}
