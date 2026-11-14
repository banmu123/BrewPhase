import type { PageProbe } from './types'

/**
 * 探测与轮询的**共享引擎**（Phase 4.2 从 TaskCoordinator 抽出）。
 *
 * 两条执行路径共用同一套判定，保证行为永不漂移：
 * - 遗留 provider 路径（TaskCoordinator，AgentPageManager 隐藏页）；
 * - 圆桌 tabId 路径（participant-service，真实 WebCard WebContents）。
 *
 * 完成判定不看时间看页面（三条同时成立才算完）：
 * 「停止按钮消失 + 回答文本连续两次一致 + 回答序号晚于提交基线」；
 * 凑不齐就老实报 timeout / failed，不把半截输出伪装成最终回答。
 */

export type ProbeHooks = {
  isCancelled(): boolean
  readProbe(): Promise<PageProbe>
}

/** 轮询路径只消费这三个字段——Adapter 的 poll 结果与完整 PageProbe 都满足。 */
export type PollProbe = { generating: boolean; answer: string; answerSeq: number }

export type PollHooks = {
  isCancelled(): boolean
  /** 当前页面 URL（每次轮询实时读取，导航离场即失败）。 */
  currentURL(): string
  /** 页面是否仍属于本轮 Adapter 的域名范围。 */
  ownsURL(url: string): boolean
  readProbe(): Promise<PollProbe>
}

export type PollOutcome = { state: 'completed' | 'timeout' | 'failed' | 'cancelled'; content: string; note: string }

const POLL_INTERVAL_MS = 900
const STABLE_ROUNDS_REQUIRED = 2
const EMPTY_ANSWER_GRACE_ROUNDS = 4
const TIMEOUT_MS = 180_000
const PROBE_ATTEMPTS = 10
const PROBE_RETRY_MS = 700

export type EngineTuning = {
  pollIntervalMs?: number
  timeoutMs?: number
  probeAttempts?: number
  probeRetryMs?: number
}

/**
 * SPA 首次打开要等 CDN 与框架挂载，输入框不是页面打开就存在的。
 * 探测未就绪时小步重试（login_page 除外——那是确定性结论，不用等）。
 */
export async function probeWithRetry(hooks: ProbeHooks, tuning: EngineTuning = {}): Promise<PageProbe> {
  const attempts = tuning.probeAttempts ?? PROBE_ATTEMPTS
  const retryMs = tuning.probeRetryMs ?? PROBE_RETRY_MS
  let last: PageProbe = { loggedIn: false, reason: 'probe failed', inputReady: false, generating: false, answer: '', answerSeq: 0 }
  for (let i = 0; i < attempts; i += 1) {
    if (hooks.isCancelled()) break
    try {
      const probe = await hooks.readProbe()
      if (probe.inputReady || probe.reason === 'login_page') return probe
      last = probe
    } catch (error) {
      last = { ...last, reason: String(error instanceof Error ? error.message : error) }
    }
    await sleep(retryMs)
  }
  return last
}

/**
 * 轮询到完成：回答序号晚于基线 + 已停止生成 + 文本连续稳定。
 * 每一轮都先检查取消、URL 归属与页面存活（readProbe 抛错 = 页面可能
 * 正在跳转，单轮不判死，由超时兜底）。
 */
export async function pollUntilAnswerStable(
  hooks: PollHooks,
  baseline: number,
  tuning: EngineTuning = {}
): Promise<PollOutcome> {
  const pollIntervalMs = tuning.pollIntervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = tuning.timeoutMs ?? TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let lastAnswer = ''
  let stableRounds = 0
  let emptyRounds = 0

  while (Date.now() < deadline) {
    if (hooks.isCancelled()) {
      return { state: 'cancelled', content: '', note: 'cancelled by user' }
    }

    const url = hooks.currentURL()
    if (!hooks.ownsURL(url)) {
      return { state: 'failed', content: '', note: `page navigated away: ${url}` }
    }

    let probe: PollProbe
    try {
      probe = await hooks.readProbe()
    } catch {
      // 单轮执行失败不判死：页面可能正在跳转。连续失败由超时兜底。
      await sleep(pollIntervalMs)
      continue
    }

    const isNewAnswer = probe.answerSeq > baseline
    if (isNewAnswer && !probe.generating && probe.answer.length > 0) {
      if (probe.answer === lastAnswer) {
        stableRounds += 1
      } else {
        stableRounds = 0
        lastAnswer = probe.answer
      }
      if (stableRounds >= STABLE_ROUNDS_REQUIRED) {
        return { state: 'completed', content: probe.answer, note: '' }
      }
      emptyRounds = 0
    } else if (isNewAnswer && !probe.generating && probe.answer.length === 0) {
      // 已有新回答出现、已停止生成、却提取不到文本：多半是改版。
      emptyRounds += 1
      if (emptyRounds >= EMPTY_ANSWER_GRACE_ROUNDS) {
        return { state: 'failed', content: '', note: 'answer_empty (layout may have changed)' }
      }
    } else {
      stableRounds = 0
      emptyRounds = 0
      if (isNewAnswer && probe.answer.length > 0) lastAnswer = probe.answer
    }

    await sleep(pollIntervalMs)
  }

  return {
    state: 'timeout',
    content: lastAnswer,
    note: `no stable completion within ${Math.round(timeoutMs / 1000)}s`
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
