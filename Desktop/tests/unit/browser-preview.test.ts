import { describe, expect, it } from 'vitest'
import {
  BrowserPreviewService,
  type PreviewCaptureResult
} from '../../src/main/browser/browser-preview'
import type { BrowserPreviewEvent } from '../../src/shared/contracts/browser'

/**
 * 缩略图调度器：不碰 electron，用假时钟与假采集器验证
 * 「合并、节流、单并发、失败保留旧图、关闭清理」五条规则。
 */

type Timer = { id: number; run: () => void; at: number }

function harness(options: {
  capture?: (tabId: string) => Promise<PreviewCaptureResult | null>
  maxEntries?: number
}) {
  let now = 0
  let timerSeq = 0
  const timers = new Map<number, Timer>()
  const events: BrowserPreviewEvent[] = []
  const calls: string[] = []

  const service = new BrowserPreviewService({
    capture: async (tabId) => {
      calls.push(tabId)
      return options.capture ? options.capture(tabId) : { dataUrl: `data:${tabId}`, width: 640, height: 400 }
    },
    emit: (event) => events.push(event),
    now: () => now,
    setTimer: (run, ms) => {
      timerSeq += 1
      timers.set(timerSeq, { id: timerSeq, run, at: now + ms })
      return timerSeq
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    debounceMs: 700,
    minIntervalMs: 2_000,
    maxEntries: options.maxEntries ?? 12
  })

  const flush = async (): Promise<void> => {
    // 让 drain 里的 await 链跑完（采集器是立即 resolve 的）。
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms
    for (;;) {
      const due = [...timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.delete(due.id)
      now = due.at
      due.run()
      await flush()
    }
    now = target
    await flush()
  }

  return { service, events, calls, advance, flush, now: () => now }
}

describe('BrowserPreviewService', () => {
  it('同一标签的连续事件合并成一次采集', async () => {
    const h = harness({})
    h.service.schedule('tab-1')
    await h.advance(300)
    h.service.schedule('tab-1')
    await h.advance(300)
    h.service.schedule('tab-1')
    await h.advance(700)
    expect(h.calls).toEqual(['tab-1'])
    expect(h.service.list()).toHaveLength(1)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ kind: 'update', preview: { tabId: 'tab-1' } })
  })

  it('采集失败保留最后一张有效预览，不广播空值', async () => {
    let fail = false
    const h = harness({
      capture: async (tabId) =>
        fail ? null : { dataUrl: `data:${tabId}:v1`, width: 640, height: 400 }
    })
    h.service.schedule('tab-1')
    await h.advance(700)
    expect(h.service.get('tab-1')?.dataUrl).toBe('data:tab-1:v1')

    fail = true
    await h.service.refresh('tab-1')
    expect(h.service.get('tab-1')?.dataUrl).toBe('data:tab-1:v1')
    expect(h.events.filter((event) => event.kind === 'update')).toHaveLength(1)
  })

  it('采集抛异常也不清缓存', async () => {
    let explode = false
    const h = harness({
      capture: async (tabId) => {
        if (explode) throw new Error('display surface unavailable')
        return { dataUrl: `data:${tabId}`, width: 640, height: 400 }
      }
    })
    h.service.schedule('tab-1')
    await h.advance(700)
    explode = true
    await h.service.refresh('tab-1')
    expect(h.service.get('tab-1')).not.toBeNull()
  })

  it('同一标签的最小采集间隔：早到的事件延后，不丢', async () => {
    const h = harness({})
    h.service.schedule('tab-1')
    await h.advance(700)
    expect(h.calls).toHaveLength(1)

    // 刚采过：再排一次应被延后到 minInterval 之后。
    h.service.schedule('tab-1')
    await h.advance(700)
    expect(h.calls).toHaveLength(1)

    await h.advance(1_300)
    expect(h.calls).toHaveLength(2)
  })

  it('一次只跑一个采集（并发 1）', async () => {
    let running = 0
    let maxRunning = 0
    const h = harness({
      capture: async (tabId) => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        await new Promise<void>((resolve) => setImmediate(resolve))
        running -= 1
        return { dataUrl: `data:${tabId}`, width: 640, height: 400 }
      }
    })
    h.service.schedule('tab-1')
    h.service.schedule('tab-2')
    await h.advance(700)
    // 两个标签的 debounce 同时到点；drain 逐个处理。
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.flush()
    expect(h.calls.sort()).toEqual(['tab-1', 'tab-2'])
    expect(maxRunning).toBe(1)
  })

  it('forget：清缓存并广播 clear；prune 只清不存在的标签', async () => {
    const h = harness({})
    h.service.schedule('tab-1')
    h.service.schedule('tab-2')
    await h.advance(700)
    expect(h.service.list()).toHaveLength(2)

    h.service.forget('tab-1')
    expect(h.service.get('tab-1')).toBeNull()
    expect(h.events.at(-1)).toEqual({ kind: 'clear', tabId: 'tab-1' })

    h.service.prune(['tab-2'])
    expect(h.service.list().map((preview) => preview.tabId)).toEqual(['tab-2'])
  })

  it('超过上限按最旧淘汰', async () => {
    const h = harness({ maxEntries: 2 })
    for (const id of ['tab-1', 'tab-2', 'tab-3']) {
      h.service.schedule(id)
      await h.advance(700)
      await h.advance(1_400)
    }
    const ids = h.service.list().map((preview) => preview.tabId)
    expect(ids).toHaveLength(2)
    expect(ids).toContain('tab-3')
    expect(ids).not.toContain('tab-1')
  })
})
