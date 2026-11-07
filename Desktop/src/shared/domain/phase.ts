import type { BeanPhase, PhaseRule } from '../contracts'

/**
 * 风味阶段是**派生**的：由烘焙日 + 阶段规则算出，不落库。
 *
 * 与 iOS `BeanPhase` 的四个阶段一字不差：养豆期 / 风味打开 / 黄金风味期 /
 * 风味衰减。存储里没有 `dayAfterRoast` 这种冗余字段——烘焙日期改了之后，
 * 冗余字段会与真相分叉。
 */

export type PhaseWindow = Pick<
  PhaseRule,
  'restMinDays' | 'restMaxDays' | 'peakStartDay' | 'peakEndDay' | 'declineStartDay'
>

/** 烘焙后第几天。没有烘焙日期就是 null（界面显示「—」，不是 0）。 */
export function dayAfterRoast(roastDate: number | null, now: number = Date.now()): number | null {
  if (roastDate == null) return null
  const start = startOfDay(roastDate)
  const today = startOfDay(now)
  const days = Math.floor((today - start) / 86_400_000)
  return Math.max(0, days)
}

export function phaseFor(day: number | null, rule: PhaseWindow): BeanPhase | null {
  if (day == null) return null
  if (day < rule.restMinDays) return 'resting'
  if (day < rule.peakStartDay) return 'opening'
  if (day <= rule.peakEndDay) return 'peak'
  return 'declining'
}

export const PHASE_LABELS: Record<BeanPhase, { title: string; hint: string }> = {
  resting: { title: '养豆期', hint: '正在养豆' },
  opening: { title: '风味打开', hint: '风味开始打开' },
  peak: { title: '黄金风味期', hint: '现在喝' },
  declining: { title: '风味衰减', hint: '建议优先饮用' }
}

/** iOS `DefaultPhaseRules` 的默认窗口，数字逐个对过。 */
export const DEFAULT_PHASE_RULES: Array<PhaseWindow & { roastLevel: string }> = [
  { roastLevel: 'light', restMinDays: 3, restMaxDays: 7, peakStartDay: 7, peakEndDay: 28, declineStartDay: 28 },
  { roastLevel: 'medium', restMinDays: 2, restMaxDays: 5, peakStartDay: 5, peakEndDay: 21, declineStartDay: 21 },
  { roastLevel: 'mediumDark', restMinDays: 1, restMaxDays: 3, peakStartDay: 3, peakEndDay: 14, declineStartDay: 14 },
  { roastLevel: 'dark', restMinDays: 1, restMaxDays: 3, peakStartDay: 3, peakEndDay: 14, declineStartDay: 14 },
  { roastLevel: 'espressoBlend', restMinDays: 5, restMaxDays: 14, peakStartDay: 7, peakEndDay: 21, declineStartDay: 21 }
]

export function defaultRuleFor(roastLevel: string) {
  return DEFAULT_PHASE_RULES.find((rule) => rule.roastLevel === roastLevel) ?? DEFAULT_PHASE_RULES[1]
}

/** 界面上的阶段进度条：把四个阶段铺成 0–1 的区间，当前阶段高亮。 */
export function phaseProgress(day: number | null, rule: PhaseWindow): { start: number; end: number } | null {
  if (day == null) return null
  const total = Math.max(rule.peakEndDay + 7, 1)
  return { start: Math.min(1, day / total), end: Math.min(1, (day + 1) / total) }
}

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
