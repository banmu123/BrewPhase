/**
 * 更新提醒的判定与「稍后提醒」记忆。
 *
 * 分工刻意做窄：
 * - **要不要提醒**只由主进程的检查结果 + 用户暂缓版本决定，不复制任何版本判断逻辑
 *   （比较直接复用 `@shared/contracts` 的 `compareVersions`）；
 * - 提醒本身在 App 里由状态推导，广播与启动 Promise 给的是同一份结果，
 *   所以不会叠出第二个 Banner——这里不需要「弹过没有」的计数器。
 * - 暂缓版本只是界面偏好，跟主题/语言一样放 localStorage：不进 SQLite、
 *   不走 Cloud，也不需要主进程同意（主进程只管检查，不管打扰节奏）。
 */
import { compareVersions, type UpdateCheckResult } from '@shared/contracts'

/** 只存一个版本号字符串；值就是用户点「稍后提醒」时看到的 latestVersion。 */
export const UPDATE_DISMISSED_KEY = 'brewphase.desktop.update.dismissedVersion'

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 走 `globalThis` 而不是 `window`：与 theme / locale 同一套写法，
 * 渲染层有 DOM、单测里没有，这样两边都能 import 本模块。
 */
function currentStorage(): StorageLike | null {
  const candidate = (globalThis as unknown as { localStorage?: StorageLike }).localStorage
  return candidate ?? null
}

/** 读暂缓版本；没有、空串、存储不可用（隐私模式）都按「没有暂缓」处理。 */
export function readDismissedUpdateVersion(store: StorageLike | null = currentStorage()): string | null {
  try {
    const raw = store?.getItem(UPDATE_DISMISSED_KEY)
    const value = typeof raw === 'string' ? raw.trim() : ''
    return value || null
  } catch {
    return null
  }
}

/** 记住暂缓的版本；写不进去只影响「下次是否再提醒」，不影响本次关闭。 */
export function rememberDismissedUpdateVersion(
  version: string,
  store: StorageLike | null = currentStorage()
): void {
  const value = typeof version === 'string' ? version.trim() : ''
  if (!value) return
  try {
    store?.setItem(UPDATE_DISMISSED_KEY, value)
  } catch {
    // 隐私模式 / 配额满：静默降级，不打扰用户。
  }
}

/**
 * 现在该不该弹提醒？四个条件缺一不可：
 * 1. 检查结果是 `available`（up-to-date / unavailable / 还没查过都不弹）；
 * 2. 有 latestVersion；
 * 3. 有本平台可下载的资产（`downloadUrl` 非空）——Stage 1 已保证 available
 *    必然带资产，这里再守一次，避免别处构造的结果把提醒点开却下不了；
 * 4. 这个版本没被暂缓过：只有**更高**的版本才允许再次打扰。
 *
 * 判断是纯函数：同一份结果反复调用返回值相同，因此广播和 Promise 回调
 * 各自触发一次也只会在界面上渲染出同一个 Banner。
 */
export function shouldAnnounceUpdate(
  result: UpdateCheckResult | null,
  dismissedVersion: string | null
): result is UpdateCheckResult & { latestVersion: string } {
  if (!result || result.status !== 'available') return false
  if (!result.latestVersion) return false
  if (!result.downloadUrl) return false
  const dismissed = typeof dismissedVersion === 'string' ? dismissedVersion.trim() : ''
  if (!dismissed) return true
  return compareVersions(result.latestVersion, dismissed) > 0
}
