import type { RendererApi } from '@shared/contracts'

/**
 * preload 注入的桥。
 *
 * 用 `globalThis` + 最小结构类型而不是 `window`：单元测试走
 * `tsconfig.node.json`，那里没有 DOM lib；只要从测试能 import 到本模块，
 * 写 `window` 就会在 typecheck 阶段炸掉（渲染层自己有 DOM，不需要声明）。
 */
const scope = globalThis as unknown as { brewphase: RendererApi }

export const api = scope.brewphase

/** 时间统一以 epoch 毫秒传递，界面这一层负责格式化。 */
export function formatDate(value: number | null): string {
  if (value == null) return '—'
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function toEpoch(dateInput: string): number | null {
  if (!dateInput) return null
  const parsed = new Date(`${dateInput}T09:00:00`).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function toDateInput(value: number | null): string {
  if (value == null) return ''
  const date = new Date(value)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function ratioText(coffeeG: number, waterG: number): string {
  if (!coffeeG || !waterG) return '—'
  return `1:${(waterG / coffeeG).toFixed(1)}`
}
