/**
 * Studio Home 的动态问候：时间规则与边界计算的**唯一来源**。
 *
 * 设计约束（见需求）：
 * - 严格用**设备本地时间**（`Date.getHours()`），不是 UTC / 服务器时间。
 *   `getHours()` 由 JS 运行时按当前系统时区解释，所以系统改时区后下一次
 *   读取自然就是新时区，不需要自己换算偏移。
 * - 规则集中在这里，返回**稳定的问候语标识**（不是文案）。实际文字由
 *   `i18n/messages/*\/studio.ts` 的 `greeting` 字典按标识取得，切换语言时
 *   标识不变、文案立即跟着变。
 * - 区间用「起始小时」表示，半开 `[startHour, nextStartHour)`，因此不可能
 *   重叠或遗漏；分钟/秒不参与判断，04:59 与 05:00 必然落在相邻两段。
 * - 纯函数、无 DOM、无定时器，方便在 node 环境的单测里逐点验证。
 */

export const GREETING_KEYS = ['lateNight', 'morning', 'midday', 'afternoon', 'evening'] as const
export type GreetingKey = (typeof GREETING_KEYS)[number]

export type GreetingRule = {
  key: GreetingKey
  /** 本地小时，含。 */
  startHour: number
  /** 便于阅读与文档对照的结束小时（含），实现只用 startHour 推导边界。 */
  lastHour: number
}

/** 五段规则，按本地小时升序。改动这里就等于改了全部端与全部测试。 */
export const GREETING_RULES: readonly GreetingRule[] = [
  { key: 'lateNight', startHour: 0, lastHour: 4 }, // 00:00–04:59 夜深了
  { key: 'morning', startHour: 5, lastHour: 10 }, // 05:00–10:59 上午好
  { key: 'midday', startHour: 11, lastHour: 13 }, // 11:00–13:59 中午好
  { key: 'afternoon', startHour: 14, lastHour: 17 }, // 14:00–17:59 下午好
  { key: 'evening', startHour: 18, lastHour: 23 } // 18:00–23:59 晚上好
]

/** 区间边界（本地小时)，升序：0 / 5 / 11 / 14 / 18，再加次日 0 点。 */
export const GREETING_BOUNDARY_HOURS: readonly number[] = GREETING_RULES.map((rule) => rule.startHour)

/**
 * 按设备本地时间返回问候语**标识**。
 *
 * `locale` 只用于签名对齐调用方（组件手里有 locale），不参与判断：问候
 * 由「几点」决定，与界面语言正交，这正是「标识稳定、文案交给 i18n」的前提。
 */
export function getTimeGreeting(date: Date, locale?: string): GreetingKey {
  void locale
  const hour = date.getHours()
  // 从后往前找第一个 startHour <= hour，最后一段自然兜住 18–23。
  for (let index = GREETING_RULES.length - 1; index >= 0; index -= 1) {
    if (hour >= GREETING_RULES[index]!.startHour) return GREETING_RULES[index]!.key
  }
  return GREETING_RULES[0]!.key
}

/**
 * 下一次区间切换的**本地时间**。
 *
 * 用 `new Date(y, m, d, h)` 构造本地时间点，而不是 `+N` 毫秒：跨日/跨月/
 * 跨年由 Date 自己算，夏令时跳变也不会把边界算到错误的一小时上。
 * 若当前已是最后一段，返回次日 00:00。
 */
export function nextGreetingBoundary(date: Date): Date {
  const hour = date.getHours()
  const nextHour = GREETING_BOUNDARY_HOURS.find((boundary) => boundary > hour)
  if (nextHour !== undefined) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), nextHour, 0, 0, 0)
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0)
}

/**
 * 距下一次边界的毫秒数。
 *
 * 下限 1ms 是防御：时间被外部改动、或休眠唤醒后 timeout 迟到时，
 * `target - now` 可能 <= 0，直接给 0 会让定时器在同一 tick 反复空转。
 * 上限 24h 是防御：系统时钟被大幅回拨时，`new Date` 构造出的边界可能
 * 落在很远的未来，宁可一天后重算也不设置一个永不触发的 timer。
 */
export function msUntilNextBoundary(date: Date): number {
  const delta = nextGreetingBoundary(date).getTime() - date.getTime()
  return Math.min(Math.max(delta, 1), 24 * 60 * 60 * 1000)
}
