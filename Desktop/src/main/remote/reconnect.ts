import { REMOTE_BACKOFF_RESET_MS } from '../../shared/contracts/remote'

/**
 * 重连退避（纯函数，无定时器、无 IO）。
 *
 * 序列与协议 §10.1 一致：`[500ms, 1s, 2s, 5s, 10s, 20s, 40s, 60s]`，之后封顶 60s，
 * 每次 ±20% 抖动。抖动是**必须**的：一整批设备在同一个 Cloud 部署后同时掉线时，
 * 没有抖动就是一堵同步的墙。
 */

const BACKOFF_STEPS_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000] as const
const MAX_BACKOFF_MS = 60_000
/** 首次重连延迟必须落在文档承诺的区间内（验收项）。 */
export const FIRST_RETRY_RANGE_MS = [500, 1_000] as const

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.max(0, Math.min(attempt - 1, BACKOFF_STEPS_MS.length - 1))
  const base = BACKOFF_STEPS_MS[index] ?? MAX_BACKOFF_MS
  // attempt 超出序列长度后不再按步长涨，直接封顶 + 抖动。
  const clamped = Math.min(base, MAX_BACKOFF_MS)
  const jitter = 1 + (clamp01(random()) - 0.5) * 0.4 // ±20%
  return Math.max(1, Math.round(clamped * jitter))
}

/**
 * 「稳定期重置」判定。
 *
 * 没有这一条时，一台稳定运行三天的设备抖动一次仍会从第 N 档退避开始
 * （可能 60 秒）。条件取「连接存活 ≥ 60 秒 **且** 收到过至少一次 `pong`」——
 * 只有 join 没有 pong 说明通道是半开的，不该算稳定。
 */
export function shouldResetBackoff(input: {
  connectedAtMono: number
  lastPongAtMono: number | null
  nowMono: number
}): boolean {
  if (input.lastPongAtMono === null) return false
  if (input.lastPongAtMono < input.connectedAtMono) return false
  return input.nowMono - input.connectedAtMono >= REMOTE_BACKOFF_RESET_MS
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}
