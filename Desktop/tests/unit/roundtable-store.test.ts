import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * store 在 import 时就会取 `globalThis.brewphase`；用 vi.hoisted 在模块加载前
 * 放一个最小桥，避免 node 环境没有 preload。只实现本文件会用到的两个动作。
 */
vi.hoisted(() => {
  ;(globalThis as unknown as { brewphase: unknown }).brewphase = {
    browserTabs: {
      createShelfTab: async () => ({}),
      closeTab: async () => ({})
    }
  }
})

const { resetRoundtableStoreForTesting, useRoundtableStore } = await import(
  '../../src/renderer/src/features/studio/roundtable-store'
)

/**
 * 圆桌 store 的关系语义（Phase 2）：卡片来自真实标签，store 只管顺序与
 * 参与者引用。join / leave / 对账的边界是这里最重要的断言对象。
 */

const viewport = { width: 1200, height: 800 }

describe('roundtable store', () => {
  beforeEach(() => {
    resetRoundtableStoreForTesting()
  })

  it('初始：没有卡片、圆桌停靠、无参与者', () => {
    const state = useRoundtableStore.getState()
    expect(state.cardOrder).toEqual([])
    expect(state.roundtable.docked).toBe(true)
    expect(state.roundtable.participantTabIds).toEqual([])
  })

  it('syncTabs：顺序保留、新标签追加、关闭的标签被摘掉', () => {
    const store = useRoundtableStore.getState()
    store.syncTabs(['tab-1', 'tab-2'])
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-2'])
    useRoundtableStore.getState().syncTabs(['tab-1', 'tab-2', 'tab-3'])
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-2', 'tab-3'])
    useRoundtableStore.getState().syncTabs(['tab-3', 'tab-1'])
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-3'])
  })

  it('加入与移除：只建立/解除引用；标签消失时自动清座', () => {
    const store = useRoundtableStore.getState()
    store.syncTabs(['tab-1', 'tab-2'])
    store.joinRoundtable('tab-1')
    store.joinRoundtable('tab-2')
    store.joinRoundtable('tab-1')
    expect(useRoundtableStore.getState().roundtable.participantTabIds).toEqual(['tab-1', 'tab-2'])

    useRoundtableStore.getState().leaveRoundtable('tab-1')
    expect(useRoundtableStore.getState().roundtable.participantTabIds).toEqual(['tab-2'])
    // 卡片顺序不受影响。
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-2'])

    // 关闭 tab-2 后对账：参与者清空。
    useRoundtableStore.getState().syncTabs(['tab-1'])
    expect(useRoundtableStore.getState().roundtable.participantTabIds).toEqual([])
  })

  it('关闭卡片：顺序与圆桌引用一起清理（真实关闭走 IPC）', async () => {
    const store = useRoundtableStore.getState()
    store.syncTabs(['tab-1', 'tab-2'])
    store.joinRoundtable('tab-1')
    await useRoundtableStore.getState().closeCard('tab-1')
    const state = useRoundtableStore.getState()
    expect(state.cardOrder).toEqual(['tab-2'])
    expect(state.roundtable.participantTabIds).toEqual([])
  })

  it('卡片架内排序只动顺序，不改 tabId', () => {
    const store = useRoundtableStore.getState()
    store.syncTabs(['tab-1', 'tab-2'])
    useRoundtableStore.getState().moveCard('tab-2', 'tab-1')
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-2', 'tab-1'])
  })

  it('选中与拖动态互不干扰；标签消失时一起清空', () => {
    const store = useRoundtableStore.getState()
    store.syncTabs(['tab-1'])
    store.selectTab('tab-1')
    store.setDraggingTab('tab-1')
    let state = useRoundtableStore.getState()
    expect(state.selectedTabId).toBe('tab-1')
    expect(state.draggingTabId).toBe('tab-1')
    store.setDraggingTab(null)
    expect(useRoundtableStore.getState().selectedTabId).toBe('tab-1')

    state.syncTabs([])
    state = useRoundtableStore.getState()
    expect(state.selectedTabId).toBeNull()
    expect(state.draggingTabId).toBeNull()
  })

  it('拖出 → 归位：参与者与草稿保留', () => {
    const store = useRoundtableStore.getState()
    store.syncTabs(['tab-1'])
    store.joinRoundtable('tab-1')
    store.setDraft('想问的问题')
    useRoundtableStore.getState().undock(viewport)
    let state = useRoundtableStore.getState()
    expect(state.roundtable.docked).toBe(false)
    expect(state.roundtable.participantTabIds).toEqual(['tab-1'])
    useRoundtableStore.getState().dock()
    state = useRoundtableStore.getState()
    expect(state.roundtable.docked).toBe(true)
    expect(state.roundtable.participantTabIds).toEqual(['tab-1'])
    expect(state.draft).toBe('想问的问题')
  })

  it('浮动移动与缩放都被 clamp 收口', () => {
    const store = useRoundtableStore.getState()
    store.undock(viewport)
    useRoundtableStore.getState().moveFloating({ dx: 100000, dy: 100000 }, viewport)
    let state = useRoundtableStore.getState()
    expect(state.roundtable.position.x).toBeLessThanOrEqual(viewport.width - state.roundtable.size.width)
    expect(state.roundtable.position.y).toBeLessThanOrEqual(viewport.height - state.roundtable.size.height)
    useRoundtableStore.getState().resizeFloating({ dw: -100000, dh: -100000 }, viewport)
    state = useRoundtableStore.getState()
    expect(state.roundtable.size.width).toBe(360)
    expect(state.roundtable.size.height).toBe(240)
  })
})
