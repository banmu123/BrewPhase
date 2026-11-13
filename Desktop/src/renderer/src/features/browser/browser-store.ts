import { create } from 'zustand'
import type { BookmarkTree, BrowserOpenInput, BrowserState } from '@shared/contracts'
import { api } from '../../shared/api'

/**
 * 浏览器浮窗的**渲染层状态**。
 *
 * 它是一份缓存而不是真相：真实状态在主进程的 BrowserManager 里，这里只保存
 * 最近一次广播的快照。所有动作都是「发意图 → 等广播」，不在本地猜测结果——
 * 否则地址栏会在导航失败时先跳到新地址、再跳回来。
 *
 * 放在全局 store 而不是组件里，是因为入口有三个（顶栏、Records、未来的
 * Personal Desk / Canvas），它们必须操作**同一个**浏览器实例。
 */

const EMPTY_STATE: BrowserState = {
  tabs: [],
  activeTabId: null,
  visible: false,
  alive: false,
  url: '',
  startPage: true,
  title: '',
  loading: false,
  progress: 0,
  canGoBack: false,
  canGoForward: false,
  error: null,
  layout: null,
  lastVisit: null,
  recent: []
}

type BrowserStore = {
  state: BrowserState
  /** 本地书签树；`null` 表示还没加载（起始页显示加载态）。 */
  bookmarks: BookmarkTree | null
  /** 是否已经从主进程取到过一次真实状态。 */
  hydrated: boolean
  hydrate: () => Promise<void>
  loadBookmarks: () => Promise<void>
  open: (input?: BrowserOpenInput) => Promise<void>
  hide: () => Promise<void>
  close: () => Promise<void>
  /** 标签管理（可拆卸窗口 Phase 0.5）。 */
  create: () => Promise<void>
  activateTab: (tabId: string) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  showStart: () => Promise<void>
  showCurrentPage: () => Promise<void>
  navigate: (input: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  stop: () => Promise<void>
  openExternal: (url?: string) => Promise<void>
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
}

function report(error: unknown): void {
  // 浏览器动作失败不该把整页打崩：记录到控制台，界面保持上一个已知状态。
  console.error('[browser] action failed', error)
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  state: EMPTY_STATE,
  bookmarks: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const state = await api.browser.state()
      set({ state, hydrated: true })
    } catch (error) {
      report(error)
      set({ hydrated: true })
    }
  },

  loadBookmarks: async () => {
    try {
      set({ bookmarks: await api.browser.bookmarks() })
    } catch (error) {
      report(error)
    }
  },

  showStart: async () => {
    try {
      set({ state: await api.browser.showStart() })
      // 设置页刚导入完可能已经变了：每次回起始页都重新读一次本地树。
      set({ bookmarks: await api.browser.bookmarks() })
    } catch (error) {
      report(error)
    }
  },

  showCurrentPage: async () => {
    try {
      set({ state: await api.browser.showCurrentPage() })
    } catch (error) {
      report(error)
    }
  },

  open: async (input) => {
    try {
      const state = await api.browser.open(input)
      set({ state })
    } catch (error) {
      report(error)
    }
  },

  hide: async () => {
    try {
      set({ state: await api.browser.hide() })
    } catch (error) {
      report(error)
    }
  },

  create: async () => {
    try {
      set({ state: await api.browserTabs.create() })
    } catch (error) {
      report(error)
    }
  },
  activateTab: async (tabId) => {
    try {
      set({ state: await api.browserTabs.activate(tabId) })
    } catch (error) {
      report(error)
    }
  },
  closeTab: async (tabId) => {
    try {
      set({ state: await api.browserTabs.closeTab(tabId) })
    } catch (error) {
      report(error)
    }
  },
  close: async () => {
    try {
      set({ state: await api.browser.close() })
    } catch (error) {
      report(error)
    }
  },

  navigate: async (input) => {
    try {
      set({ state: await api.browser.navigate(input) })
    } catch (error) {
      report(error)
    }
  },

  back: async () => {
    try {
      set({ state: await api.browser.back() })
    } catch (error) {
      report(error)
    }
  },

  forward: async () => {
    try {
      set({ state: await api.browser.forward() })
    } catch (error) {
      report(error)
    }
  },

  reload: async () => {
    try {
      set({ state: await api.browser.reload() })
    } catch (error) {
      report(error)
    }
  },

  stop: async () => {
    try {
      set({ state: await api.browser.stop() })
    } catch (error) {
      report(error)
    }
  },

  openExternal: async (url) => {
    try {
      await api.browser.openExternal(url ?? (get().state.url || undefined))
    } catch (error) {
      report(error)
    }
  },

  setBounds: async (bounds) => {
    try {
      await api.browser.setBounds(bounds)
    } catch (error) {
      report(error)
    }
  }
}))

/** 主进程广播 → store。返回解绑函数；在 App 挂载时调一次即可。 */
export function subscribeBrowserState(): () => void {
  return api.browser.onChanged((state) => {
    useBrowserStore.setState({ state, hydrated: true })
  })
}
