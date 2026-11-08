import { create } from 'zustand'

export type ModuleKey = 'coffee' | 'records' | 'canvas' | 'settings'

type AppState = {
  module: ModuleKey
  setModule: (module: ModuleKey) => void
  /**
   * 跨页打开原记录：画布双击节点 → 切到 Records 并选中它。
   * RecordsPage 消费后立即清空，避免下次进入又跳回同一条。
   */
  openRecordId: string | null
  openRecord: (id: string) => void
  consumeOpenRecord: () => string | null
}

/**
 * 界面状态只留**导航**这一件事。业务数据不进全局 store：每个页面自己取、
 * 自己刷新，避免「同一个字段在两处缓存，改了一处另一处还是旧的」。
 */
export const useAppStore = create<AppState>((set, get) => ({
  module: 'coffee',
  setModule: (module) => set({ module }),
  openRecordId: null,
  openRecord: (id) => set({ module: 'records', openRecordId: id }),
  consumeOpenRecord: () => {
    const id = get().openRecordId
    if (id) set({ openRecordId: null })
    return id
  }
}))
