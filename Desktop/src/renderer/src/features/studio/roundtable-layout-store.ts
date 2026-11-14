import { create } from 'zustand'
import {
  initialRoundtableSnapshot,
  ROUNDTABLE_PANEL_MIN_HEIGHT,
  ROUNDTABLE_PANEL_MIN_WIDTH,
  type RoundtableLayoutSnapshot,
  type RoundtablePanelLayout
} from '@shared/roundtable'
import { api } from '../../shared/api'
import { useRoundtableStore } from './roundtable-store'

/**
 * 圆桌自由布局的渲染层缓存（Phase 4.2 workspace）。
 *
 * 主进程是布局唯一事实来源（广播 roundtable-layout:changed）；拖动 / 缩放
 * 期间**被操作的面板用本地乐观位置**（IPC 往返会抖），落定后以广播为准。
 * 面板内容区 rects 的测量上报是「渲染层测量 → 主进程 setBounds 原生视图」
 * 的唯一路径。
 */

type RoundtableLayoutStore = {
  layout: RoundtableLayoutSnapshot
  hydrated: boolean
  /** 拖动 / 缩放中的面板（该面板位置以本地为准，不追广播回显）。 */
  draggingTabId: string | null
  /** 本地乐观覆盖（tabId → 覆盖布局）。 */
  localOverrides: Record<string, RoundtablePanelLayout>

  hydrate: () => Promise<void>
  applyLayout: (snapshot: RoundtableLayoutSnapshot) => void
  /** 上报面板内容区 rects（宿主窗口相对坐标）。 */
  reportBounds: (rects: Array<{ tabId: string; x: number; y: number; width: number; height: number }>) => void
  move: (tabId: string, x: number, y: number) => Promise<void>
  resize: (
    tabId: string,
    x: number,
    y: number,
    width: number,
    height: number,
    anchor?: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  ) => Promise<void>
  front: (tabId: string) => Promise<void>
  setSnap: (enabled: boolean) => Promise<void>
  setWorkspaceSize: (width: number, height: number) => Promise<void>
  addWeb: (url: string) => Promise<void>
  rebind: (oldTabId: string, url: string) => Promise<void>
  enterWorkspace: () => Promise<void>
  exitWorkspace: () => Promise<void>
  setDragging: (tabId: string | null) => void
}

function withOverride(
  snapshot: RoundtableLayoutSnapshot,
  overrides: Record<string, RoundtablePanelLayout>
): RoundtableLayoutSnapshot {
  const keys = Object.keys(overrides)
  if (keys.length === 0) return snapshot
  return {
    ...snapshot,
    panels: snapshot.panels.map((panel) => overrides[panel.tabId] ?? panel)
  }
}

export const useRoundtableLayoutStore = create<RoundtableLayoutStore>((set, get) => ({
  layout: {
    roundtableId: 'roundtable-main',
    panels: [],
    activeTabId: null,
    snapEnabled: true,
    workspace: { width: 0, height: 0 },
    updatedAt: 0,
    version: -1
  },
  hydrated: false,
  draggingTabId: null,
  localOverrides: {},

  hydrate: async () => {
    try {
      const layout = await api.roundtableWorkspace.layout()
      set({ layout, hydrated: true, localOverrides: {} })
    } catch (error) {
      console.error('[roundtable-layout] hydrate failed', error)
      set({ hydrated: true })
    }
  },

  applyLayout: (snapshot) => {
    const dragging = get().draggingTabId
    const overrides = get().localOverrides
    // 被拖动的面板以本地乐观位置为准（广播回显会跟不上指针）。
    const filtered = dragging
      ? Object.fromEntries(Object.entries(overrides).filter(([key]) => key === dragging))
      : {}
    set({ layout: withOverride(snapshot, filtered), localOverrides: filtered, hydrated: true })
  },

  reportBounds: (rects) => {
    void api.roundtableWorkspace.reportBounds(rects).catch(() => undefined)
  },

  move: async (tabId, x, y) => {
    const current = get().layout.panels.find((panel) => panel.tabId === tabId)
    if (current) {
      set((state) => ({
        localOverrides: {
          ...state.localOverrides,
          [tabId]: { ...current, x, y }
        }
      }))
    }
    try {
      set({ layout: withOverride(await api.roundtableWorkspace.move(tabId, x, y), get().localOverrides) })
    } catch (error) {
      console.error('[roundtable-layout] move failed', error)
    }
  },

  resize: async (tabId, x, y, width, height, anchor) => {
    const current = get().layout.panels.find((panel) => panel.tabId === tabId)
    if (current) {
      set((state) => ({
        localOverrides: {
          ...state.localOverrides,
          [tabId]: { ...current, x, y, width: Math.max(ROUNDTABLE_PANEL_MIN_WIDTH, width), height: Math.max(ROUNDTABLE_PANEL_MIN_HEIGHT, height) }
        }
      }))
    }
    try {
      set({ layout: withOverride(await api.roundtableWorkspace.resize(tabId, x, y, width, height, anchor), get().localOverrides) })
    } catch (error) {
      console.error('[roundtable-layout] resize failed', error)
    }
  },

  front: async (tabId) => {
    try {
      set({ layout: await api.roundtableWorkspace.front(tabId) })
    } catch (error) {
      console.error('[roundtable-layout] front failed', error)
    }
  },

  setSnap: async (enabled) => {
    try {
      set({ layout: await api.roundtableWorkspace.setSnap(enabled) })
    } catch (error) {
      console.error('[roundtable-layout] snap failed', error)
    }
  },

  setWorkspaceSize: async (width, height) => {
    try {
      set({ layout: await api.roundtableWorkspace.setWorkspaceSize(width, height) })
    } catch (error) {
      console.error('[roundtable-layout] workspace size failed', error)
    }
  },

  addWeb: async (url) => {
    try {
      const snapshot = await api.roundtableWorkspace.addWeb(url)
      useRoundtableStore.getState().applySnapshot(snapshot)
      // 新成员的默认布局随后由广播送达。
    } catch (error) {
      console.error('[roundtable-layout] add web failed', error)
      throw error
    }
  },

  rebind: async (oldTabId, url) => {
    try {
      const snapshot = await api.roundtableWorkspace.rebind(oldTabId, url)
      set({ layout: snapshot })
      useRoundtableStore.getState().applySnapshot(await api.roundtable.state())
    } catch (error) {
      console.error('[roundtable-layout] rebind failed', error)
      throw error
    }
  },

  enterWorkspace: async () => {
    try {
      const snapshot = await api.roundtableWorkspace.enter()
      useRoundtableStore.getState().applySnapshot(snapshot)
    } catch (error) {
      console.error('[roundtable-layout] enter workspace failed', error)
    }
  },

  exitWorkspace: async () => {
    try {
      const snapshot = await api.roundtableWorkspace.exit()
      useRoundtableStore.getState().applySnapshot(snapshot)
    } catch (error) {
      console.error('[roundtable-layout] exit workspace failed', error)
    }
  },

  setDragging: (tabId) => set({ draggingTabId: tabId, localOverrides: tabId ? get().localOverrides : {} })
}))

/** 主进程布局广播 → store。App 挂载时订阅一次（两个窗口都会走到）。 */
export function subscribeRoundtableLayout(): () => void {
  return api.roundtableWorkspace.onLayout((snapshot) => {
    useRoundtableLayoutStore.getState().applyLayout(snapshot)
  })
}

/** E2E / 单测用。 */
export function resetRoundtableLayoutStoreForTesting(): void {
  useRoundtableLayoutStore.setState({
    layout: {
      roundtableId: 'roundtable-main',
      panels: [],
      activeTabId: null,
      snapEnabled: true,
      workspace: { width: 0, height: 0 },
      updatedAt: 0,
      version: -1
    },
    hydrated: false,
    draggingTabId: null,
    localOverrides: {}
  })
}

/** 初始快照占位（保留导出以防测试需要完整快照形状）。 */
export const emptyRoundtableSnapshot = initialRoundtableSnapshot
