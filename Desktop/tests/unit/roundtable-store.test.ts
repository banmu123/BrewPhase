import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetRoundtableStoreForTesting,
  useRoundtableStore
} from '../../src/renderer/src/features/studio/roundtable-store'

/**
 * 圆桌 store 的关系语义：join / leave / close 三者边界 + 浮动几何收口。
 * store 本身在 renderer，但它是纯 zustand（无 DOM 依赖），node 环境可直接跑
 * （tsconfig.node.json 的 include 覆盖 tests/unit，路径别名 @shared 由
 * vitest.config.ts 提供——与 greeting 测试同一套机制）。
 */

const viewport = { width: 1200, height: 800 }

describe('roundtable store', () => {
  beforeEach(() => {
    resetRoundtableStoreForTesting()
  })

  it('初始：一张空白卡、圆桌停靠、无参与者', () => {
    const state = useRoundtableStore.getState()
    expect(state.cards).toHaveLength(1)
    expect(state.cards[0].status).toBe('empty')
    expect(state.roundtable.docked).toBe(true)
    expect(state.roundtable.participantIds).toEqual([])
  })

  it('添加网页：新空白卡追加到末尾', () => {
    useRoundtableStore.getState().addCard()
    const state = useRoundtableStore.getState()
    expect(state.cards).toHaveLength(2)
    expect(state.cards[1].status).toBe('empty')
  })

  it('编辑卡片后可加入圆桌；空白卡被拒绝', () => {
    const { updateCard, joinRoundtable } = useRoundtableStore.getState()
    // 空白卡：拒绝。
    expect(joinRoundtable('webcard-1')).toBe(false)
    expect(useRoundtableStore.getState().roundtable.participantIds).toEqual([])
    // 填成站点卡：接受。
    updateCard('webcard-1', { title: 'ChatGPT', url: 'https://chatgpt.com', status: 'ready' })
    expect(joinRoundtable('webcard-1')).toBe(true)
    expect(useRoundtableStore.getState().roundtable.participantIds).toEqual(['webcard-1'])
  })

  it('移除参与者：卡片仍留在架上', () => {
    const store = useRoundtableStore.getState()
    store.updateCard('webcard-1', { title: 'A', url: 'https://a.com', status: 'ready' })
    store.joinRoundtable('webcard-1')
    useRoundtableStore.getState().leaveRoundtable('webcard-1')
    const state = useRoundtableStore.getState()
    expect(state.roundtable.participantIds).toEqual([])
    expect(state.cards.map((card) => card.id)).toContain('webcard-1')
  })

  it('关闭卡片：架上消失，且不再是参与者', () => {
    const store = useRoundtableStore.getState()
    store.updateCard('webcard-1', { title: 'A', url: 'https://a.com', status: 'ready' })
    store.joinRoundtable('webcard-1')
    useRoundtableStore.getState().closeCard('webcard-1')
    const state = useRoundtableStore.getState()
    expect(state.cards).toHaveLength(0)
    expect(state.roundtable.participantIds).toEqual([])
  })

  it('重复 join 幂等；reorder 只动顺序', () => {
    const store = useRoundtableStore.getState()
    store.addCard()
    store.updateCard('webcard-1', { title: 'A', url: 'https://a.com', status: 'ready' })
    store.updateCard('webcard-2', { title: 'B', url: 'https://b.com', status: 'ready' })
    store.joinRoundtable('webcard-1')
    store.joinRoundtable('webcard-2')
    store.joinRoundtable('webcard-1')
    expect(useRoundtableStore.getState().roundtable.participantIds).toEqual(['webcard-1', 'webcard-2'])
    useRoundtableStore.getState().reorderRoundtable('webcard-2', 'webcard-1')
    expect(useRoundtableStore.getState().roundtable.participantIds).toEqual(['webcard-2', 'webcard-1'])
  })

  it('卡片架内排序', () => {
    const store = useRoundtableStore.getState()
    store.addCard()
    store.updateCard('webcard-1', { title: 'A', url: 'https://a.com', status: 'ready' })
    store.updateCard('webcard-2', { title: 'B', url: 'https://b.com', status: 'ready' })
    useRoundtableStore.getState().reorderCard('webcard-2', 'webcard-1')
    expect(useRoundtableStore.getState().cards.map((card) => card.id)).toEqual(['webcard-2', 'webcard-1'])
  })

  it('选中与拖动态互不干扰', () => {
    const store = useRoundtableStore.getState()
    store.selectCard('webcard-1')
    store.setDraggingCard('webcard-1')
    const state = useRoundtableStore.getState()
    expect(state.selectedCardId).toBe('webcard-1')
    expect(state.draggingCardId).toBe('webcard-1')
    store.setDraggingCard(null)
    expect(useRoundtableStore.getState().selectedCardId).toBe('webcard-1')
  })

  it('拖出 → 归位：参与者与草稿保留', () => {
    const store = useRoundtableStore.getState()
    store.updateCard('webcard-1', { title: 'A', url: 'https://a.com', status: 'ready' })
    store.joinRoundtable('webcard-1')
    store.setDraft('想问的问题')
    useRoundtableStore.getState().undock(viewport)
    let state = useRoundtableStore.getState()
    expect(state.roundtable.docked).toBe(false)
    expect(state.roundtable.participantIds).toEqual(['webcard-1'])
    useRoundtableStore.getState().dock()
    state = useRoundtableStore.getState()
    expect(state.roundtable.docked).toBe(true)
    expect(state.roundtable.participantIds).toEqual(['webcard-1'])
    expect(state.draft).toBe('想问的问题')
  })

  it('浮动移动与缩放都被 clamp 收口', () => {
    const store = useRoundtableStore.getState()
    store.undock(viewport)
    // 拖出窗口。
    useRoundtableStore.getState().moveFloating({ dx: 100000, dy: 100000 }, viewport)
    let state = useRoundtableStore.getState()
    expect(state.roundtable.position.x).toBeLessThanOrEqual(viewport.width - state.roundtable.size.width)
    expect(state.roundtable.position.y).toBeLessThanOrEqual(viewport.height - state.roundtable.size.height)
    // 缩到过小。
    useRoundtableStore.getState().resizeFloating({ dw: -100000, dh: -100000 }, viewport)
    state = useRoundtableStore.getState()
    expect(state.roundtable.size.width).toBe(360)
    expect(state.roundtable.size.height).toBe(240)
  })
})
