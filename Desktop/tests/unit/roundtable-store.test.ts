import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * store 在 import 时就会取 `globalThis.brewphase`；用 vi.hoisted 在模块加载前
 * 放一个最小桥，避免 node 环境没有 preload。快照动作按用例需要可变。
 */
const bridge = vi.hoisted(() => {
  const calls: { join: string[]; leave: string[]; drafts: string[] } = {
    join: [],
    leave: [],
    drafts: []
  }
  const brewphase = {
    browserTabs: {
      createShelfTab: async () => ({}),
      closeTab: async () => ({})
    },
    roundtable: {
      state: async () => ({ id: 'roundtable-main', participantTabIds: [], draft: '', detached: false, updatedAt: 0, version: 0 }),
      join: async (tabId: string) => {
        calls.join.push(tabId)
        return { id: 'roundtable-main', participantTabIds: [tabId], draft: '', detached: false, updatedAt: 1, version: 1 }
      },
      leave: async (tabId: string) => {
        calls.leave.push(tabId)
        return { id: 'roundtable-main', participantTabIds: [], draft: '', detached: false, updatedAt: 2, version: 2 }
      },
      setDraft: async (draft: string) => {
        calls.drafts.push(draft)
        return { id: 'roundtable-main', participantTabIds: [], draft, detached: false, updatedAt: 3, version: 42 }
      },
      detach: async () => ({ id: 'roundtable-main', participantTabIds: [], draft: '', detached: true, updatedAt: 4, version: 9 }),
      dock: async () => ({ id: 'roundtable-main', participantTabIds: [], draft: '', detached: false, updatedAt: 5, version: 10 }),
      focus: async () => ({ id: 'roundtable-main', participantTabIds: [], draft: '', detached: true, updatedAt: 6, version: 11 }),
      dragBegin: async () => true,
      dragDropHandled: async () => null,
      dragEnd: async () => null,
      onSnapshot: () => () => undefined
    },
    browserDrag: {
      begin: async () => true,
      dropHandled: async () => null,
      end: async () => null,
      onFrame: () => () => undefined
    }
  }
  ;(globalThis as unknown as { brewphase: unknown }).brewphase = brewphase
  return { calls }
})

const { resetRoundtableStoreForTesting, subscribeBrowserDragFrames, useRoundtableStore } = await import(
  '../../src/renderer/src/features/studio/roundtable-store'
)

/**
 * 圆桌 store 的渲染层语义（Phase 3）：store 只是主进程快照的缓存 + 架子
 * 顺序的本地偏好。所有圆桌动作都发意图给主进程，拿回的快照立即落地。
 */
describe('roundtable store（快照缓存）', () => {
  beforeEach(() => {
    resetRoundtableStoreForTesting()
  })

  it('初始：空架子、空快照（主进程事实来源尚未拉取）', () => {
    const state = useRoundtableStore.getState()
    expect(state.cardOrder).toEqual([])
    expect(state.snapshot.detached).toBe(false)
    expect(state.snapshot.participantTabIds).toEqual([])
    expect(state.hydrated).toBe(false)
  })

  it('hydrate：用主进程快照覆盖本地缓存', async () => {
    await useRoundtableStore.getState().hydrate()
    const state = useRoundtableStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.snapshot.id).toBe('roundtable-main')
  })

  it('syncTabs：架子顺序保留、新标签追加、关闭的标签被摘掉；本地选择同步清理', () => {
    useRoundtableStore.getState().syncTabs(['tab-1', 'tab-2'])
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-2'])
    useRoundtableStore.getState().syncTabs(['tab-1', 'tab-2', 'tab-3'])
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-2', 'tab-3'])
    useRoundtableStore.getState().syncTabs(['tab-3', 'tab-1'])
    // 对账保留旧顺序：幸存标签按架上既有的先后排，新标签追加在末尾。
    expect(useRoundtableStore.getState().cardOrder).toEqual(['tab-1', 'tab-3'])

    useRoundtableStore.getState().selectTab('tab-2')
    useRoundtableStore.getState().syncTabs(['tab-3', 'tab-1'])
    expect(useRoundtableStore.getState().selectedTabId).toBeNull()
  })

  it('joinRoundtable：发意图给主进程，用返回快照落地（不再本地拼参与者）', async () => {
    await useRoundtableStore.getState().joinRoundtable('tab-9')
    expect(bridge.calls.join).toEqual(['tab-9'])
    expect(useRoundtableStore.getState().snapshot.participantTabIds).toEqual(['tab-9'])
  })

  it('leaveRoundtable：主进程返回的快照才是新状态', async () => {
    await useRoundtableStore.getState().leaveRoundtable('tab-1')
    expect(bridge.calls.leave).toEqual(['tab-1'])
    expect(useRoundtableStore.getState().snapshot.participantTabIds).toEqual([])
  })

  it('setDraft：发给主进程，用返回快照对齐输入框（后写者胜出）', async () => {
    useRoundtableStore.setState({ snapshot: { id: 'roundtable-main', participantTabIds: [], draft: '', detached: false, updatedAt: 0, version: 7 } })
    await useRoundtableStore.getState().setDraft('hello')
    expect(bridge.calls.drafts).toEqual(['hello'])
    expect(useRoundtableStore.getState().snapshot.draft).toBe('hello')
    expect(useRoundtableStore.getState().snapshot.version).toBe(42)
  })

  it('detachRoundtable / dockRoundtable：主进程裁定 detached，store 只跟随', async () => {
    await useRoundtableStore.getState().detachRoundtable()
    expect(useRoundtableStore.getState().snapshot.detached).toBe(true)
    await useRoundtableStore.getState().dockRoundtable()
    expect(useRoundtableStore.getState().snapshot.detached).toBe(false)
  })

  it('applySnapshot：广播到达时无条件落地（另一窗口的更新立即可见）', () => {
    useRoundtableStore.getState().applySnapshot({
      id: 'roundtable-main',
      participantTabIds: ['tab-5'],
      draft: 'from other window',
      detached: true,
      updatedAt: 99,
      version: 42
    })
    const state = useRoundtableStore.getState()
    expect(state.snapshot.version).toBe(42)
    expect(state.snapshot.draft).toBe('from other window')
    expect(state.snapshot.detached).toBe(true)
  })

  it('拖拽帧：webcard 会话结束清 draggingTab；roundtable 会话记 draggingRoundtable', () => {
    type Frame = { active: boolean; kind: 'webcard' | 'roundtable'; tabId: string | null; outside: boolean }
    const holder: { listener: ((frame: Frame) => void) | null } = { listener: null }
    const brewphase = (globalThis as unknown as { brewphase: { browserDrag: { onFrame: (fn: never) => () => void } } }).brewphase
    const original = brewphase.browserDrag.onFrame
    brewphase.browserDrag.onFrame = ((fn: never) => {
      holder.listener = fn
      return () => undefined
    }) as never
    const unsubscribe = subscribeBrowserDragFrames()
    const emit = (frame: Frame): void => holder.listener?.(frame)

    emit({ active: true, kind: 'webcard', tabId: 'tab-1', outside: false })
    useRoundtableStore.getState().setDraggingTab('tab-1')
    emit({ active: true, kind: 'webcard', tabId: 'tab-1', outside: true })
    expect(useRoundtableStore.getState().dragOutside).toBe(true)

    emit({ active: false, kind: 'webcard', tabId: 'tab-1', outside: true })
    expect(useRoundtableStore.getState().dragOutside).toBe(false)
    expect(useRoundtableStore.getState().draggingTabId).toBeNull()

    emit({ active: true, kind: 'roundtable', tabId: null, outside: false })
    expect(useRoundtableStore.getState().draggingRoundtable).toBe(true)
    emit({ active: false, kind: 'roundtable', tabId: null, outside: false })
    expect(useRoundtableStore.getState().draggingRoundtable).toBe(false)

    unsubscribe()
    brewphase.browserDrag.onFrame = original
  })
})
