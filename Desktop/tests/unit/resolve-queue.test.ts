import { describe, expect, it } from 'vitest'
import { ResolveQueue, type ResolveJob } from '../../src/main/metadata/resolve-queue'

/** 可手动放行的执行体：用来观察并发与排队状态。 */
function controllable() {
  const gates = new Map<string, () => void>()
  let active = 0
  let peak = 0
  const started: string[] = []
  const finished: string[] = []
  const run = async (job: ResolveJob): Promise<void> => {
    active += 1
    peak = Math.max(peak, active)
    started.push(job.recordId)
    await new Promise<void>((resolve) => gates.set(job.recordId, resolve))
    active -= 1
  }
  const release = (recordId: string): void => {
    gates.get(recordId)?.()
    gates.delete(recordId)
  }
  return {
    run,
    release,
    started,
    finished,
    get peak() {
      return peak
    },
    get active() {
      return active
    }
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('ResolveQueue（Phase 3.2）', () => {
  it('并发上限被守住：5 个任务同时入队，最多 2 个在跑', async () => {
    const harness = controllable()
    const queue = new ResolveQueue({ concurrency: 2, run: harness.run })

    for (let index = 0; index < 5; index += 1) {
      queue.enqueue({ recordId: `r${index}`, urlString: 'https://example.com/' })
    }

    expect(queue.running).toBe(2)
    expect(queue.pending).toBe(3)

    while (queue.running > 0 || queue.pending > 0) {
      for (const id of [...harness.started]) {
        if (harness.active > 0) harness.release(id)
      }
      await flush()
    }

    expect(harness.peak).toBe(2)
    expect(harness.started).toHaveLength(5)
  })

  it('同一个 recordId + URL 只跑一次（幂等）', async () => {
    const harness = controllable()
    const queue = new ResolveQueue({ concurrency: 2, run: harness.run })
    const job = { recordId: 'r1', urlString: 'https://example.com/a' }

    expect(queue.enqueue(job)).toBe(true)
    expect(queue.enqueue(job)).toBe(false)
    // 执行中重复入队也返回 false
    expect(queue.enqueue({ ...job })).toBe(false)

    harness.release('r1')
    await queue.drain()
    expect(harness.started).toEqual(['r1'])
  })

  it('同一记录换了 URL → 视为不同任务（旧任务作废由执行体自己判断）', async () => {
    const harness = controllable()
    // 并发 1：确保两个任务先后执行，能分别放行（同 recordId 的 gate 会互相覆盖）
    const queue = new ResolveQueue({ concurrency: 1, run: harness.run })
    queue.enqueue({ recordId: 'r1', urlString: 'https://example.com/old' })
    queue.enqueue({ recordId: 'r1', urlString: 'https://example.com/new' })
    expect(queue.pending).toBe(1)

    harness.release('r1')
    await flush()
    harness.release('r1')
    await queue.drain()

    expect(harness.started).toEqual(['r1', 'r1'])
  })

  it('任务抛错不影响后续任务，队列继续跑', async () => {
    const calls: string[] = []
    const queue = new ResolveQueue({
      concurrency: 1,
      run: async (job) => {
        calls.push(job.recordId)
        if (job.recordId === 'boom') throw new Error('network down')
      }
    })
    queue.enqueue({ recordId: 'boom', urlString: 'u' })
    queue.enqueue({ recordId: 'ok', urlString: 'u' })
    await queue.drain()
    expect(calls).toEqual(['boom', 'ok'])
  })

  it('每个任务结束都会回调 onSettled（成功与失败都算）', async () => {
    const settled: string[] = []
    const queue = new ResolveQueue({
      concurrency: 2,
      run: async (job) => {
        if (job.recordId === 'bad') throw new Error('nope')
      },
      onSettled: (job) => settled.push(job.recordId)
    })
    queue.enqueue({ recordId: 'good', urlString: 'u' })
    queue.enqueue({ recordId: 'bad', urlString: 'u' })
    await queue.drain()
    expect(settled.sort()).toEqual(['bad', 'good'])
  })

  it('drain 在没有任务时立即返回；并发参数非法直接报错', async () => {
    const queue = new ResolveQueue({ concurrency: 1, run: async () => undefined })
    await expect(queue.drain()).resolves.toBeUndefined()
    expect(() => new ResolveQueue({ concurrency: 0, run: async () => undefined })).toThrow(
      'concurrency must be >= 1'
    )
  })
})
