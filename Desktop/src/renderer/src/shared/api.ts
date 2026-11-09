import type { RendererApi } from '@shared/contracts'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入；renderer 拿不到任何其他 Node 能力。 */
    brewphase: RendererApi
  }
}

export const api = window.brewphase

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
