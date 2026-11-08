/**
 * Resolver 后台任务队列（Phase 3.2）。
 *
 * 为什么要有它：iOS 同步进来的链接没有本地预览，需要在**事务提交之后**补抓。
 * 但一次首轮同步可能带进来几十条链接，逐条并发请求外部平台既慢又容易被限流。
 *
 * 规则：
 * - `recordId + urlString` 是任务的幂等键：排队中或执行中的同一任务不会重复入队；
 * - 并发数固定（默认 2），其余排队；抓取失败不重试（状态由 record_metadata
 *   收敛到 failed，用户手动刷新才重来）；
 * - **网络请求永远在 SQLite 事务之外**：队列的唯一入口是 `applyBatch()` 返回
 *   之后（或应用启动扫描 pending），执行体自己开短事务写状态；
 * - `drain()` 只给测试用，生产不等待。
 */

export type ResolveJob = {
  recordId: string
  /** 入队时的 URL；执行前用它和记录当前 URL 比对，变了就作废 */
  urlString: string
}

export type ResolveQueueOptions = {
  /** 同时进行的抓取数上限（≥1） */
  concurrency: number
  /** 执行体：只负责抓取 + 写本地派生表，不碰同步列 */
  run: (job: ResolveJob) => Promise<void>
  /** 每个任务结束（成功或失败）都会回调一次，用于通知界面刷新 */
  onSettled?: (job: ResolveJob) => void
}

function keyOf(job: ResolveJob): string {
  return `${job.recordId}\u001F${job.urlString}`
}

export class ResolveQueue {
  private readonly queued: ResolveJob[] = []
  private readonly keys = new Set<string>()
  private active = 0
  private idleWaiters: Array<() => void> = []

  constructor(private readonly options: ResolveQueueOptions) {
    if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
      throw new Error('concurrency must be >= 1')
    }
  }

  /** 入队；同一 recordId + URL 已在队列/执行中则返回 false（幂等）。 */
  enqueue(job: ResolveJob): boolean {
    const key = keyOf(job)
    if (this.keys.has(key)) return false
    this.keys.add(key)
    this.queued.push({ recordId: job.recordId, urlString: job.urlString })
    this.pump()
    return true
  }

  get pending(): number {
    return this.queued.length
  }

  get running(): number {
    return this.active
  }

  /** 队列排空后 resolve（测试用）。 */
  drain(): Promise<void> {
    if (this.active === 0 && this.queued.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  private pump(): void {
    while (this.active < this.options.concurrency && this.queued.length > 0) {
      const job = this.queued.shift() as ResolveJob
      const key = keyOf(job)
      this.active += 1
      // 同步启动执行体（enqueue 之后立刻进入 running），错误统一收敛，
      // 不允许一个任务的失败把队列卡死。
      let running: Promise<void>
      try {
        running = Promise.resolve(this.options.run(job))
      } catch (error) {
        running = Promise.reject(error)
      }
      void running
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1
          this.keys.delete(key)
          try {
            this.options.onSettled?.(job)
          } catch {
            // 通知失败不影响队列
          }
          this.pump()
          if (this.active === 0 && this.queued.length === 0) {
            const waiters = this.idleWaiters
            this.idleWaiters = []
            for (const waiter of waiters) waiter()
          }
        })
    }
  }
}
