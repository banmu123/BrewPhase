/**
 * 动态问候的更新调度器（与 React / DOM 解耦，便于 node 环境单测）。
 *
 * 只有两类触发源：
 * 1. **单次 timeout**：精确到下一个时段边界，触发后计算新问候并安排下一段。
 *    不存在每秒/每分钟轮询；系统休眠让 timeout 迟到时，回调里依然按
 *    「当前时间」重算并安排下一段，不会补发一堆过期任务。
 * 2. **唤醒事件**：`visibilitychange` / `focus` / `pageshow` / 最小化恢复。
 *    这些事件本身不携带时间，所以一律重新读取 `now()` 校正状态——这一步
 *    同时兜住休眠唤醒、系统时钟调整、系统时区变更（OS 改时区通常伴随切回
 *    应用，届时 focus/visibility 必然触发）。
 *
 * 不变式：
 * - 任意时刻最多 **1 个** pending timer；`schedule()` 先取消旧的。
 * - `subscribe()` 只在 `start()` 里调用一次；重复 start 不叠加监听。
 * - `stop()` 取消 timer 与事件订阅；之后所有回调都无效。
 * - 问候标识没变时不通知，避免无意义重渲染（文案由 i18n 单独负责）。
 */

import {
  getTimeGreeting,
  msUntilNextBoundary,
  type GreetingKey
} from './greeting'

export type GreetingRefreshReason = 'start' | 'boundary' | 'wake' | 'manual'

export type GreetingClockEnv = {
  now: () => Date
  /** 安排一次性任务，返回取消函数。 */
  setTimer: (callback: () => void, delayMs: number) => () => void
  /** 注册唤醒事件，返回取消订阅函数。 */
  subscribe: (onWake: () => void) => () => void
}

export type GreetingClock = {
  /** 计算首帧问候、注册事件、安排第一个 timeout。幂等。 */
  start: () => GreetingKey
  /** 卸载时清理；之后不再有 timer 或监听。 */
  stop: () => void
  /** 任何唤醒/边界事件都走这里：重算 + 重排，必要时通知。 */
  refresh: (reason: GreetingRefreshReason) => GreetingKey
  current: () => GreetingKey
}

export function createGreetingClock(
  onChange: (key: GreetingKey) => void,
  env: GreetingClockEnv
): GreetingClock {
  let current: GreetingKey = getTimeGreeting(env.now())
  let cancelTimer: (() => void) | null = null
  let unsubscribe: (() => void) | null = null
  let running = false

  const schedule = (date: Date): void => {
    // 先清旧再设新：多次 focus 也只可能有 1 个 pending timer。
    cancelTimer?.()
    let cancel: () => void = () => {}
    cancel = env.setTimer(() => {
      // 触发后立即把自己从 pending 里摘掉。休眠唤醒时 timeout 会迟到，
      // 不摘的话旧 handle 会残留，stop() 也清不到一个「已经跑过」的任务。
      cancelTimer = null
      cancel()
      refresh('boundary')
    }, msUntilNextBoundary(date))
    cancelTimer = cancel
  }

  function refresh(reason: GreetingRefreshReason): GreetingKey {
    // stop() 之后迟到的 timer / 事件一律忽略。
    if (!running && reason !== 'start') return current
    const date = env.now()
    const next = getTimeGreeting(date)
    // 无论问候有没有变，都要按当前时间重排：休眠/改时区后旧 timer 的
    // 目标时刻可能已经不对，只靠「标识变了才更新」会漏掉这一步。
    schedule(date)
    if (next !== current) {
      current = next
      onChange(next)
    }
    return current
  }

  return {
    start() {
      if (running) return current
      running = true
      const date = env.now()
      current = getTimeGreeting(date)
      schedule(date)
      unsubscribe = env.subscribe(() => refresh('wake'))
      onChange(current)
      return current
    },
    stop() {
      running = false
      cancelTimer?.()
      cancelTimer = null
      unsubscribe?.()
      unsubscribe = null
    },
    refresh,
    current: () => current
  }
}
