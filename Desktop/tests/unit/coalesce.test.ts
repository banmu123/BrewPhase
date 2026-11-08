import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesce } from '../../src/shared/coalesce'

/**
 * 同步事件合并器：一次同步可能连发多条 `sync:changed`（apply + 每个媒体
 * finalize），Records 页面只应该查一轮库。
 */
describe('coalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('窗口内多次触发只执行一次', () => {
    const task = vi.fn()
    const merged = coalesce(task, 150)
    for (let index = 0; index < 5; index += 1) merged.run()
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('每次触发都把窗口往后推：连续事件只在最后一次之后执行', () => {
    const task = vi.fn()
    const merged = coalesce(task, 150)
    merged.run()
    vi.advanceTimersByTime(100)
    merged.run()
    vi.advanceTimersByTime(100)
    merged.run()
    // 累计 200ms > 150ms，但窗口一直被续上，此时仍未执行
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('窗口结束后再次触发会重新执行（不吞掉后续同步）', () => {
    const task = vi.fn()
    const merged = coalesce(task, 150)
    merged.run()
    vi.advanceTimersByTime(150)
    merged.run()
    vi.advanceTimersByTime(150)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('cancel 之后不再执行（组件卸载）', () => {
    const task = vi.fn()
    const merged = coalesce(task, 150)
    merged.run()
    merged.cancel()
    vi.advanceTimersByTime(1000)
    expect(task).not.toHaveBeenCalled()
  })

  it('cancel 是幂等的', () => {
    const task = vi.fn()
    const merged = coalesce(task, 150)
    merged.cancel()
    merged.cancel()
    vi.advanceTimersByTime(1000)
    expect(task).not.toHaveBeenCalled()
  })
})
