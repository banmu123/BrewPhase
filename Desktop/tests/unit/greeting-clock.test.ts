import { describe, expect, it } from 'vitest'
import { createGreetingClock, type GreetingClockEnv } from '../../src/shared/greeting-clock'
import type { GreetingKey } from '../../src/shared/greeting'

/**
 * 动态问候的更新调度：用可注入的假时钟，把「跨区间 / 页面切换 / 重新获得
 * 焦点 / 休眠唤醒 / 卸载清理 / 重复焦点」全部变成确定性的同步断言。
 *
 * 这里刻意不依赖 jsdom 或 React 渲染：项目单测跑在 node 环境，调度器本身
 * 就与 DOM 解耦，所以监听与定时器数量可以直接数出来。
 */

type FakeTimer = { callback: () => void; delay: number; cancelled: boolean }

function harness(startAt: Date) {
  let now = startAt
  const timers: FakeTimer[] = []
  const wakeListeners = new Set<() => void>()
  let subscribeCalls = 0
  let unsubscribeCalls = 0
  const changes: GreetingKey[] = []

  const activeTimers = (): FakeTimer[] => timers.filter((timer) => !timer.cancelled)

  const env: GreetingClockEnv = {
    now: () => now,
    setTimer: (callback, delay) => {
      const timer: FakeTimer = { callback, delay, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    subscribe: (onWake) => {
      subscribeCalls += 1
      wakeListeners.add(onWake)
      return () => {
        unsubscribeCalls += 1
        wakeListeners.delete(onWake)
      }
    }
  }

  const clock = createGreetingClock((key) => changes.push(key), env)

  return {
    clock,
    changes,
    timers,
    activeTimers,
    get subscribeCalls() {
      return subscribeCalls
    },
    get unsubscribeCalls() {
      return unsubscribeCalls
    },
    get wakeCount() {
      return wakeListeners.size
    },
    setNow: (value: Date) => {
      now = value
    },
    /** 模拟窗口重新获得焦点 / visibilitychange / pageshow / 最小化恢复。 */
    wake: () => {
      for (const listener of [...wakeListeners]) listener()
    },
    /** 触发当前唯一那个 pending timeout（模拟到达时段边界或休眠后迟到）。 */
    fireBoundary: () => {
      const pending = activeTimers()
      expect(pending, '触发前应该有且仅有一个 pending timer').toHaveLength(1)
      pending[0]!.callback()
    }
  }
}

function local(hour: number, minute = 0, day = 13, month = 10, year = 2026): Date {
  return new Date(year, month, day, hour, minute, 0, 0)
}

describe('首次启动', () => {
  it('首帧就按当前时段通知一次，并安排到下一边界的单次 timeout', () => {
    const h = harness(local(9, 30))
    expect(h.changes).toEqual([])

    expect(h.clock.start()).toBe('morning')
    expect(h.changes).toEqual(['morning'])
    expect(h.subscribeCalls).toBe(1)
    expect(h.activeTimers()).toHaveLength(1)
    // 09:30 → 11:00 = 90 分钟，不是 1 秒 / 1 分钟轮询。
    expect(h.activeTimers()[0]!.delay).toBe(90 * 60 * 1000)
  })

  it('重复 start 幂等：不叠加监听，也不产生第二个 timer', () => {
    const h = harness(local(9, 30))
    h.clock.start()
    h.clock.start()
    h.clock.start()

    expect(h.subscribeCalls).toBe(1)
    expect(h.wakeCount).toBe(1)
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.changes).toEqual(['morning'])
  })
})

describe('应用持续开启并跨越时间区间', () => {
  it('到达 11:00 自动更新为「中午好」，并安排下一段（14:00）', () => {
    const h = harness(local(9, 30))
    h.clock.start()
    expect(h.clock.current()).toBe('morning')

    h.setNow(local(11, 0))
    h.fireBoundary()

    expect(h.changes).toEqual(['morning', 'midday'])
    expect(h.clock.current()).toBe('midday')
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.activeTimers()[0]!.delay).toBe(3 * 60 * 60 * 1000)
  })

  it('连续跨过多段（18:00 → 次日 00:00）逐段更新，始终只有一个 timer', () => {
    const h = harness(local(17, 0))
    h.clock.start()
    expect(h.changes).toEqual(['afternoon'])

    h.setNow(local(18, 0))
    h.fireBoundary()
    expect(h.changes).toEqual(['afternoon', 'evening'])
    expect(h.activeTimers()).toHaveLength(1)

    h.setNow(local(0, 0, 14))
    h.fireBoundary()
    expect(h.changes).toEqual(['afternoon', 'evening', 'lateNight'])
    expect(h.activeTimers()).toHaveLength(1)

    h.setNow(local(5, 0, 14))
    h.fireBoundary()
    expect(h.changes.at(-1)).toBe('morning')
    expect(h.activeTimers()).toHaveLength(1)
  })

  it('边界触发但时段未变时不重复通知，仍重排下一次', () => {
    const h = harness(local(9, 30))
    h.clock.start()
    const before = h.activeTimers()[0]!

    h.clock.refresh('boundary')
    expect(h.changes).toEqual(['morning'])
    expect(before.cancelled).toBe(true)
    expect(h.activeTimers()).toHaveLength(1)
  })
})

describe('窗口重新获得焦点 / 后台回前台 / 最小化恢复', () => {
  it('切回前台时按当前时间校正（模拟在别的页面待过了时段边界）', () => {
    const h = harness(local(10, 30))
    h.clock.start()
    expect(h.clock.current()).toBe('morning')

    // 页面切走 → 切回时已经 14:20；focus / visibilitychange 唤醒。
    h.setNow(local(14, 20))
    h.wake()

    expect(h.changes).toEqual(['morning', 'afternoon'])
    expect(h.clock.current()).toBe('afternoon')
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.activeTimers()[0]!.delay).toBe((3 * 60 + 40) * 60 * 1000)
  })

  it('系统休眠唤醒：timeout 迟到且跨了多段，一次唤醒就校正到正确时段', () => {
    const h = harness(local(22, 30))
    h.clock.start()
    expect(h.changes).toEqual(['evening'])

    // 休眠到次日 09:00，迟到的 timeout 触发时按「当前时间」重算。
    h.setNow(local(9, 0, 14))
    h.fireBoundary()
    expect(h.changes).toEqual(['evening', 'morning'])
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.activeTimers()[0]!.delay).toBe(2 * 60 * 60 * 1000)

    // 即使没有 focus 事件，迟到回调自己也能收敛；再醒来只是重排不误报。
    h.wake()
    expect(h.changes).toEqual(['evening', 'morning'])
    expect(h.activeTimers()).toHaveLength(1)
  })

  it('系统时区变更后，唤醒时按新时区重算并重新安排边界', () => {
    const h = harness(local(23, 30))
    h.clock.start()
    expect(h.clock.current()).toBe('evening')

    // 模拟系统时区/时钟被改动：now() 返回另一个本地时间。
    h.setNow(local(3, 15, 14))
    h.wake()
    expect(h.changes).toEqual(['evening', 'lateNight'])
    expect(h.activeTimers()).toHaveLength(1)
    // 03:15 → 05:00
    expect(h.activeTimers()[0]!.delay).toBe((1 * 60 + 45) * 60 * 1000)
  })

  it('多次获得焦点不会产生重复监听或多个定时器', () => {
    const h = harness(local(9, 30))
    h.clock.start()

    for (let round = 0; round < 12; round += 1) h.wake()

    expect(h.subscribeCalls).toBe(1)
    expect(h.wakeCount).toBe(1)
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.timers.filter((timer) => timer.cancelled)).toHaveLength(12)
    expect(h.changes).toEqual(['morning'])
  })

  it('唤醒不会打断「之后仍按边界自动更新」', () => {
    const h = harness(local(10, 50))
    h.clock.start()
    h.wake() // 10:50，仍是上午，重排到 11:00
    expect(h.activeTimers()[0]!.delay).toBe(10 * 60 * 1000)

    h.setNow(local(11, 0))
    h.fireBoundary()
    expect(h.changes).toEqual(['morning', 'midday'])
  })
})

describe('页面切换（组件卸载 / 重新挂载）', () => {
  it('stop 后重新 start 用当前时间重算，而不是沿用旧问候', () => {
    const h = harness(local(8, 0))
    h.clock.start()
    expect(h.changes).toEqual(['morning'])

    // 离开 Studio Home：卸载。
    h.clock.stop()
    // 进入别的空间期间跨过了 11:00。
    h.setNow(local(15, 10))
    // 回到 Studio Home：新组件、新 clock 的 start 立即算当前时段。
    const fresh = harness(local(15, 10))
    expect(fresh.clock.start()).toBe('afternoon')
    expect(fresh.changes).toEqual(['afternoon'])
  })
})

describe('组件卸载后清理', () => {
  it('stop 取消 timer 并解绑所有监听', () => {
    const h = harness(local(9, 30))
    h.clock.start()
    h.clock.stop()

    expect(h.activeTimers()).toHaveLength(0)
    expect(h.wakeCount).toBe(0)
    expect(h.unsubscribeCalls).toBe(1)
  })

  it('stop 之后迟到的 timeout / 唤醒不再通知，也不再新建 timer', () => {
    const h = harness(local(9, 30))
    h.clock.start()
    h.clock.stop()

    h.setNow(local(15, 0))
    // 取消后不该再有可触发的 timer；即使手工调用已保存的回调也无效。
    expect(h.activeTimers()).toHaveLength(0)
    h.wake()
    h.clock.refresh('manual')

    expect(h.changes).toEqual(['morning'])
    expect(h.activeTimers()).toHaveLength(0)
    expect(h.timers).toHaveLength(1)
  })

  it('重复 stop 幂等，不会重复解绑', () => {
    const h = harness(local(9, 30))
    h.clock.start()
    h.clock.stop()
    h.clock.stop()
    expect(h.unsubscribeCalls).toBe(1)
  })
})
