import { randomUUID } from 'node:crypto'
import {
  AI_ADAPTERS,
  type PlatformAdapter
} from './adapters'
import type {
  AIAskInput,
  AIChatTaskSnapshot,
  AIChatTaskState,
  AIProvider,
  AIProviderResult,
  PageProbe
} from './types'
import { isTerminalTaskState } from './types'
import type { AgentPageManager } from '../agent-page-manager'

/**
 * 并行任务调度。
 *
 * 规则只有三条，但每条都是硬的：
 * 1. **一个时刻只有一个 Multi-AI 任务**——防重复提交靠它，不靠 UI 禁用按钮；
 * 2. **平台之间互不依赖**——各自独立 async 执行、独立超时、独立失败，
 *    GPT 成功绝不因为 Claude 失败而被丢弃；
 * 3. **完成判定不看时间看页面**——「停止按钮消失 + 回答文本连续两次一致 +
 *    回答序号晚于提交基线」三条同时成立才算完，凑不齐就老实报 timeout /
 *    empty，不把半截输出伪装成最终回答。
 */

const POLL_INTERVAL_MS = 900
const STABLE_ROUNDS_REQUIRED = 2
const EMPTY_ANSWER_GRACE_ROUNDS = 4
const TIMEOUT_MS = 180_000

/** 调度参数；只有测试会传，生产用默认值。 */
export type CoordinatorTuning = {
  pollIntervalMs?: number
  timeoutMs?: number
}

type ProviderRun = {
  state: AIChatTaskState
  result: AIProviderResult
  cancelled: boolean
}

type TaskRecord = {
  taskId: string
  prompt: string
  createdAt: number
  providers: AIProvider[]
  runs: Map<AIProvider, ProviderRun>
}

/** AgentPageManager 的最小形状；单测用它注入 fake 页面（不启动 Electron）。 */
export type AgentPagesLike = {
  snapshot(provider: AIProvider): { provider: AIProvider; alive: boolean; url: string; title: string }
  ownsURL(provider: AIProvider, url: string): boolean
  webContents(provider: AIProvider): Electron.WebContents | null
  ensurePage(provider: AIProvider, url: string): Promise<Electron.WebContents>
}

export class TaskCoordinator {
  private current: TaskRecord | null = null
  private notify: () => void = () => {}

  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(
    private readonly pages: AgentPagesLike,
    private readonly adapters: Record<AIProvider, PlatformAdapter> = AI_ADAPTERS,
    tuning: CoordinatorTuning = {}
  ) {
    this.pollIntervalMs = tuning.pollIntervalMs ?? POLL_INTERVAL_MS
    this.timeoutMs = tuning.timeoutMs ?? TIMEOUT_MS
  }

  setNotifier(fn: () => void): void {
    this.notify = fn
  }

  isBusy(): boolean {
    return this.current !== null && [...this.current.runs.values()].some((run) => !isTerminalTaskState(run.state))
  }

  snapshot(): AIChatTaskSnapshot | null {
    const record = this.current
    if (!record) return null
    return {
      taskId: record.taskId,
      prompt: record.prompt,
      createdAt: record.createdAt,
      results: record.providers.map((provider) => {
        const run = record.runs.get(provider)
        return run ? run.result : { provider, state: 'idle' as const, content: '', note: '', url: '' }
      })
    }
  }

  /** 每个平台当前的状态（无任务时 idle）。给状态条与轮询用。 */
  states(): Map<AIProvider, AIChatTaskState> {
    const states = new Map<AIProvider, AIChatTaskState>()
    const record = this.current
    for (const provider of ['chatgpt', 'claude'] as const) {
      const run = record?.runs.get(provider)
      states.set(provider, run && !isTerminalTaskState(run.state) ? run.state : 'idle')
    }
    return states
  }

  cancel(): void {
    const record = this.current
    if (!record) return
    for (const run of record.runs.values()) {
      if (!isTerminalTaskState(run.state)) {
        run.cancelled = true
        this.apply(record, run, 'cancelled', '', 'cancelled by user')
      }
    }
    this.notify()
  }

  /** 入口：一次真正的并行提问。调用方（IPC）负责先做输入校验。 */
  async ask(input: AIAskInput): Promise<AIChatTaskSnapshot> {
    if (this.isBusy()) {
      throw new Error('another multi-ai task is still running')
    }

    const record: TaskRecord = {
      taskId: randomUUID(),
      prompt: input.prompt,
      createdAt: Date.now(),
      providers: [...input.providers],
      runs: new Map()
    }
    for (const provider of input.providers) {
      record.runs.set(provider, {
        state: 'checking',
        result: { provider, state: 'checking', content: '', note: '', url: '' },
        cancelled: false
      })
    }
    this.current = record
    this.notify()

    // 平台之间没有先后：两个 async 同时推进，谁失败谁自己负责。
    await Promise.allSettled(input.providers.map((provider) => this.runProvider(record, provider)))
    this.notify()
    return this.snapshot()!
  }

  // MARK: - 单平台执行

  private async runProvider(record: TaskRecord, provider: AIProvider): Promise<void> {
    const run = record.runs.get(provider)
    if (!run) return
    const adapter: PlatformAdapter = this.adapters[provider]

    try {
      // —— checking：页面在不在、登录没登录、输入框能不能用 ——
      this.apply(record, run, 'checking')

      const existing = this.pages.snapshot(provider)
      const targetURL = existing.url || adapter.homeURL
      let webContents
      try {
        webContents = await this.pages.ensurePage(provider, targetURL)
      } catch (error) {
        this.apply(record, run, 'unsupported_page', '', `open page failed: ${String(error)}`)
        return
      }

      const currentURL = webContents.getURL()
      if (!adapter.ownsURL(currentURL)) {
        this.apply(record, run, 'unsupported_page', '', `unexpected page: ${currentURL}`)
        return
      }

      const probe = await this.probeWithRetry(run, adapter, webContents)
      if (run.cancelled) {
        this.apply(record, run, 'cancelled')
        return
      }
      if (!probe.loggedIn) {
        if (probe.reason === 'login_page') {
          this.apply(record, run, 'login_required', '', 'login required')
        } else {
          // 页面在平台上但找不到输入框：多半是改版或加载未完成。
          this.apply(record, run, 'unsupported_page', '', probe.reason || 'input not found')
        }
        return
      }
      if (!probe.inputReady && !probe.generating) {
        this.apply(record, run, 'unsupported_page', '', 'composer not ready')
        return
      }

      // —— sending：写入并提交，拿回答基线 ——
      if (run.cancelled) {
        this.apply(record, run, 'cancelled')
        return
      }

      this.apply(record, run, 'sending')
      const submit = (await webContents.executeJavaScript(adapter.submitScript(record.prompt))) as {
        ok: boolean
        reason: string
        baseline: number
      }
      if (!submit.ok) {
        this.apply(record, run, 'failed', '', submit.reason || 'submit failed')
        return
      }
      if (run.cancelled) {
        this.apply(record, run, 'cancelled')
        return
      }

      // —— generating：轮询到「停止按钮消失 + 文本稳定」——
      this.apply(record, run, 'generating')
      const outcome = await this.pollUntilDone(record, run, adapter, webContents, submit.baseline)
      this.apply(record, run, outcome.state, outcome.content, outcome.note)
    } catch (error) {
      // executeJavaScript 抛错（页面跳转中、进程崩溃等）都算这一家的事。
      this.apply(record, run, 'failed', '', String(error instanceof Error ? error.message : error))
    }
  }

  /**
   * SPA 首次打开要等 CDN 与框架挂载，输入框不是 loadURL 返回就存在的。
   * 探测未就绪时小步重试（login_page 除外——那是确定性结论，不用等）。
   */
  private async probeWithRetry(
    run: ProviderRun,
    adapter: PlatformAdapter,
    webContents: Electron.WebContents
  ): Promise<PageProbe> {
    const attempts = 10
    let last: PageProbe = { loggedIn: false, reason: 'probe failed', inputReady: false, generating: false, answer: '', answerSeq: 0 }
    for (let i = 0; i < attempts; i += 1) {
      if (run.cancelled) break
      try {
        const probe = (await webContents.executeJavaScript(adapter.probeScript())) as PageProbe
        if (probe.inputReady || probe.reason === 'login_page') return probe
        last = probe
      } catch (error) {
        last = { ...last, reason: String(error instanceof Error ? error.message : error) }
      }
      await sleep(700)
    }
    return last
  }

  private async pollUntilDone(
    record: TaskRecord,
    run: ProviderRun,
    adapter: PlatformAdapter,
    webContents: Electron.WebContents,
    baseline: number
  ): Promise<{ state: AIChatTaskState; content: string; note: string }> {
    const deadline = Date.now() + this.timeoutMs
    let lastAnswer = ''
    let stableRounds = 0
    let emptyRounds = 0

    while (Date.now() < deadline) {
      if (run.cancelled) {
        return { state: 'cancelled', content: '', note: 'cancelled by user' }
      }

      const url = webContents.getURL()
      if (!adapter.ownsURL(url)) {
        return { state: 'failed', content: '', note: `page navigated away: ${url}` }
      }

      let probe: PageProbe
      try {
        probe = (await webContents.executeJavaScript(adapter.pollScript())) as PageProbe
      } catch (error) {
        // 单轮执行失败不判死：页面可能正在跳转。连续失败由超时兜底。
        void error
        await sleep(this.pollIntervalMs)
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

      await sleep(this.pollIntervalMs)
    }

    return {
      state: 'timeout',
      content: lastAnswer,
      note: `no stable completion within ${Math.round(this.timeoutMs / 1000)}s`
    }
  }

  // MARK: - 状态与结果

  private apply(
    record: TaskRecord,
    run: ProviderRun,
    state: AIChatTaskState,
    content = '',
    note = ''
  ): void {
    run.state = state
    run.result = {
      provider: run.result.provider,
      state,
      content,
      note,
      url: this.pages.snapshot(run.result.provider).url
    }
    void record
    this.notify()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
