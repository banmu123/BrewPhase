import { create } from 'zustand'
import type { BrowserPreview, BrowserPreviewEvent } from '@shared/contracts'
import { api } from '../../shared/api'

/**
 * 网页缩略图的渲染层缓存（Phase 2）。
 *
 * 真相在主进程：这里只是一份「最近一次采集成功」的本地副本，供卡片 `<img>`
 * 与圆桌参与者展示。它不参与网页身份、不持久化、不写数据库——标签关闭时
 * 主进程会广播 clear，这里同步删掉。
 *
 * 为什么单独一个 store：`browser:changed` 每次加载进度都会广播，缩略图有
 * 几十 KB，不能搭在同一个快照里；卡片与圆桌又都需要读同一张图。
 */

type PreviewStore = {
  previews: Record<string, BrowserPreview>
  hydrated: boolean
  hydrate: () => Promise<void>
  /** 卡片挂载时没有预览 → 请主进程采集一次（主进程自己节流）。 */
  request: (tabId: string) => void
  applyEvent: (event: BrowserPreviewEvent) => void
  clear: () => void
}

export const useBrowserPreviewStore = create<PreviewStore>((set, get) => ({
  previews: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const list = await api.browserPreviews.list()
      const previews: Record<string, BrowserPreview> = {}
      for (const preview of list) previews[preview.tabId] = preview
      set({ previews, hydrated: true })
    } catch (error) {
      console.error('[browser-preview] hydrate failed', error)
      set({ hydrated: true })
    }
  },

  request: (tabId) => {
    if (get().previews[tabId]) return
    void api.browserPreviews.request(tabId).catch(() => undefined)
  },

  applyEvent: (event) => {
    if (event.kind === 'clear') {
      set((state) => {
        if (!(event.tabId in state.previews)) return state
        const next = { ...state.previews }
        delete next[event.tabId]
        return { previews: next }
      })
      return
    }
    set((state) => ({ previews: { ...state.previews, [event.preview.tabId]: event.preview } }))
  },

  clear: () => set({ previews: {}, hydrated: false })
}))

/** 主进程广播 → store。App 挂载时调一次，返回解绑函数。 */
export function subscribeBrowserPreviews(): () => void {
  return api.browserPreviews.onChanged((event) => {
    useBrowserPreviewStore.getState().applyEvent(event)
  })
}
