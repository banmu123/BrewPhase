import { create } from 'zustand'

export type ModuleKey = 'coffee' | 'records' | 'canvas' | 'settings'

type AppState = {
  module: ModuleKey
  setModule: (module: ModuleKey) => void
}

/**
 * 界面状态只留**导航**这一件事。业务数据不进全局 store：每个页面自己取、
 * 自己刷新，避免「同一个字段在两处缓存，改了一处另一处还是旧的」。
 */
export const useAppStore = create<AppState>((set) => ({
  module: 'coffee',
  setModule: (module) => set({ module })
}))
