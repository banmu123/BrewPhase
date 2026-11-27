import { create } from 'zustand'
import type { UpdateState } from '@shared/contracts'
import { api } from '../../shared/api'
import {
  readDismissedUpdateVersion,
  rememberDismissedUpdateVersion,
  shouldShowUpdateBanner
} from './update-notice'

/**
 * 更新状态的渲染层镜像。
 *
 * 真相在主进程（UpdateService）：这里只保存广播来的那一份，以及两件纯界面的事
 * ——用户暂缓过的版本号、以及由两者推导出的「提醒条要不要显示」。
 * 不复制任何版本判断：派生全部走 `update-notice.ts` 的纯函数。
 *
 * 用 zustand 而不是 App 的 useState：下载进度每秒会推几次，只有真正关心
 * 进度的组件（提醒条 / 设置页）需要重渲染，Studio 桌面不该跟着抖。
 */

type UpdateStore = {
  state: UpdateState | null
  dismissedVersion: string | null
  /** 提醒条是否显示（下载/安装阶段也显示，见 shouldShowUpdateBanner）。 */
  bannerVisible: boolean
  apply: (next: UpdateState | null) => void
  hydrate: () => Promise<void>
  check: (force?: boolean) => Promise<void>
  download: () => Promise<void>
  postpone: () => void
}

function derive(
  state: UpdateState | null,
  dismissedVersion: string | null
): { bannerVisible: boolean } {
  return { bannerVisible: shouldShowUpdateBanner(state, dismissedVersion) }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  state: null,
  dismissedVersion: readDismissedUpdateVersion(),
  bannerVisible: false,

  apply: (next) => {
    set({ state: next, ...derive(next, get().dismissedVersion) })
  },

  /** 挂载时同步一次；随后由主进程广播推动。 */
  hydrate: async () => {
    try {
      get().apply(await api.update.state())
    } catch {
      // 拿不到状态就让界面停在「还没检查过」，不影响应用使用。
    }
    await get().check()
  },

  check: async (force) => {
    try {
      get().apply(await api.update.check(force === true))
    } catch {
      // 失败由主进程落成 error 状态并经广播回来；这里只兜底不抛。
    }
  },

  download: async () => {
    try {
      get().apply(await api.update.download())
    } catch {
      // 同上：主进程会把失败写进状态。
    }
  },

  /** 「稍后提醒」：记住版本号并立刻收起；更高版本仍会重新提醒。 */
  postpone: () => {
    const version = get().state?.latestVersion
    if (!version) return
    rememberDismissedUpdateVersion(version)
    set({ dismissedVersion: version, ...derive(get().state, version) })
  }
}))

/** 订阅主进程广播；返回取消函数（页面切换不重复注册）。 */
export function subscribeUpdateState(): () => void {
  return api.update.onChanged((next) => {
    useUpdateStore.getState().apply(next)
  })
}
