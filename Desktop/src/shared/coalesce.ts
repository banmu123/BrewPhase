/**
 * 把短时间内的多次触发合并成一次执行。
 *
 * 同步不是「一条事件」：一次同步会先 apply（一个批次），再对每个媒体文件
 * finalize 一次，每条都可能广播 `sync:changed`。如果每次都重新查库，
 * 一次同步会打出 3–5 轮查询，页面还会在中间态反复重排。
 *
 * 用固定窗口合并（不是节流）：窗口内最后一次触发决定执行时机，
 * 保证「最后一次事件之后一定会跑一次」，不会把尾巴丢掉。
 */
export type Coalesced = {
  /** 触发一次（窗口内多次触发只保留最后一次） */
  run: () => void
  /** 取消尚未执行的那一次（组件卸载时用） */
  cancel: () => void
}

export function coalesce(task: () => void, delayMs: number): Coalesced {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    run() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        task()
      }, delayMs)
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
