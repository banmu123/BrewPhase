/**
 * Studio Home 的动态问候 hook。
 *
 * 只做三件事：首帧算一次、把浏览器/窗口事件接到 `createGreetingClock`、
 * 卸载时清理。时间规则与调度细节都在 `src/shared/`，页面里没有任何
 * `if (hour < 5)` 之类的重复判断，也不在渲染过程中创建定时器。
 *
 * 文案不在这里：`getTimeGreeting` 返回的是稳定标识，`StudioHome` 用
 * `t.studio.greeting[key]` 取字，所以切换语言会随 I18nProvider 一起重渲染，
 * 问候立即换成另一种语言，不需要重新算时间。
 */

import { useEffect, useState } from 'react'
import { createGreetingClock, type GreetingClockEnv } from '@shared/greeting-clock'
import { getTimeGreeting, type GreetingKey } from '@shared/greeting'

// 与 theme.ts 同一套约定：renderer 代码也会被 node 侧 tsconfig 收进去编译，
// 因此 DOM 只用最小结构类型，不写 `Document` / `Window` 这些 DOM lib 类型。
type WakeTarget = {
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
  hidden?: boolean
}

function getDocument(): WakeTarget | null {
  return (globalThis as unknown as { document?: WakeTarget }).document ?? null
}

function getWindow(): WakeTarget | null {
  return (globalThis as unknown as { window?: WakeTarget }).window ?? null
}

/** 唤醒事件源：覆盖后台回前台、最小化恢复、休眠唤醒、系统时间/时区改动后的切回。 */
function subscribeToWake(onWake: () => void): () => void {
  const doc = getDocument()
  const win = getWindow()
  const onVisibility = (): void => {
    // 隐藏时不需要刷新，回到前台那一次才校正。
    if (!doc?.hidden) onWake()
  }
  const onFocus = (): void => onWake()
  const onPageShow = (): void => onWake()

  doc?.addEventListener?.('visibilitychange', onVisibility)
  win?.addEventListener?.('focus', onFocus)
  win?.addEventListener?.('pageshow', onPageShow)
  return () => {
    doc?.removeEventListener?.('visibilitychange', onVisibility)
    win?.removeEventListener?.('focus', onFocus)
    win?.removeEventListener?.('pageshow', onPageShow)
  }
}

function browserClockEnv(): GreetingClockEnv {
  return {
    now: () => new Date(),
    setTimer: (callback, delayMs) => {
      const handle = globalThis.setTimeout(callback, delayMs)
      return () => globalThis.clearTimeout(handle)
    },
    subscribe: subscribeToWake
  }
}

export function useTimeGreeting(): GreetingKey {
  // 首帧同步算一次，保证第一屏就是正确时段，不会先闪一下固定标题。
  const [key, setKey] = useState<GreetingKey>(() => getTimeGreeting(new Date()))

  useEffect(() => {
    const clock = createGreetingClock(setKey, browserClockEnv())
    clock.start()
    return () => clock.stop()
  }, [])

  return key
}
