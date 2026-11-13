import { create } from 'zustand'

/** `studio` 是默认首页；三个空间只从首页内容入口进入，不再是全局菜单。 */
export type ModuleKey = 'studio' | 'coffee' | 'records' | 'canvas' | 'ai' | 'settings'
export type SettingsCategory = 'general' | 'sync' | 'browser' | 'chrome' | 'mcp'
/** 顶栏「快速添加」要打开的表单：由目标页面自己消费，避免复制业务表单。 */
export type CreateKind = 'bean' | 'text' | 'link' | 'canvas'

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
  /**
   * 跨页直达设置分类：引导页「打开设备同步设置」→ 设置页直接开在 sync。
   * 同一个「打开 + 消费」约定；谁消费谁清空。
   */
  openSettingsCategory: SettingsCategory | null
  openSettings: (category: SettingsCategory) => void
  /** 设置页「重新打开接入向导」：直接进 AI 分支，不走欢迎页。 */
  agentOnboarding: boolean
  openAgentOnboarding: () => void
  closeAgentOnboarding: () => void
  consumeOpenSettings: () => SettingsCategory | null
  /** 顶栏快速添加 → 切到对应空间并请求打开它已有的新建表单。 */
  pendingCreate: CreateKind | null
  requestCreate: (kind: CreateKind) => void
  consumeCreate: () => CreateKind | null
}

/**
 * 界面状态只留**导航**这一件事。业务数据不进全局 store：每个页面自己取、
 * 自己刷新，避免「同一个字段在两处缓存，改了一处另一处还是旧的」。
 */
export const useAppStore = create<AppState>((set, get) => ({
  module: 'studio',
  setModule: (module) => set({ module }),
  openRecordId: null,
  openRecord: (id) => set({ module: 'records', openRecordId: id }),
  consumeOpenRecord: () => {
    const id = get().openRecordId
    if (id) set({ openRecordId: null })
    return id
  },
  openSettingsCategory: null,
  openSettings: (category) => set({ module: 'settings', openSettingsCategory: category }),
  agentOnboarding: false,
  openAgentOnboarding: () => set({ agentOnboarding: true }),
  closeAgentOnboarding: () => set({ agentOnboarding: false }),
  consumeOpenSettings: () => {
    const category = get().openSettingsCategory
    if (category) set({ openSettingsCategory: null })
    return category
  },
  pendingCreate: null,
  requestCreate: (kind) =>
    set({
      module: kind === 'bean' ? 'coffee' : kind === 'canvas' ? 'canvas' : 'records',
      pendingCreate: kind
    }),
  consumeCreate: () => {
    const kind = get().pendingCreate
    if (kind) set({ pendingCreate: null })
    return kind
  }
}))
