import { randomUUID } from 'node:crypto'
import type { Db } from '../database/client'
import { deleteConversation, insertConversation, insertMessage } from '../database/repositories/ai-conversations'
import type {
  AIRoundtableParticipantStatus,
  AIRoundtableTaskResult,
  AIRoundtableTaskSnapshot
} from '../../shared/contracts/roundtable-ai'
import { ROUNDTABLE_AI_MAX_PARTICIPANTS } from '../../shared/contracts/roundtable-ai'
import { type AIAdapterRegistry } from './adapters/registry'
import { createDefaultRegistry } from './adapters/platform-catalog'
import type { AIPlatformAdapter, AIWebCardContext } from './adapters/types'
import { pollUntilAnswerStable, probeWithRetry, type EngineTuning } from './automation/poll-engine'
import { isTerminalTaskState, type AIChatTaskState, type PageProbe } from './automation/types'

/**
 * 圆桌的参与者执行服务（Phase 4.2）：**真实 WebCard 驱动**的多平台并行问答。
 *
 * 与遗留 Multi-AI（ai-chat-service + AgentPageManager）的根本区别：
 * - **身份是 tabId，不是 provider**。同一平台可以有多张卡，每张卡是独立
 *   参与者；状态与回答永不按平台合并。
 * - **页面就是用户拖进来的那张**。通过 BrowserManager.resolveTabForAI 解析
 *   真实 WebContents——绝不创建隐藏副本、绝不 reload、绝不改窗口归属。
 *   Renderer 只传 tabId；平台识别靠 Registry 对实时 URL 的严格主机匹配，
 *   Renderer 无从伪造身份。
 * - WebContents 只在主进程内部使用，绝不跨 IPC；脚本只由 Registry 校验过
 *   的 Adapter 在自己的域名范围内执行。
 *
 * 生命周期与并发安全：
 * - 每个阶段都重新解析 tabId——页面销毁立即终止该参与者（'failed: tab closed'）；
 * - 执行中每轮轮询都检查 URL 归属——跳转到其它网站立即失败，不在新页面
 *   上继续旧 Adapter；
 * - 同一 tabId 不可能并发两个任务（全局单任务 + 单轮内 tabId 唯一）；
 * - 成员被移出圆桌时 `cancelParticipant` 立即终止对应任务。
 */

const TITLE_MAX = 60

/** 主进程内部的页面解析入口（BrowserManager.resolveTabForAI 的最小形状）。 */
export type ParticipantPageResolver = {
  resolve(tabId: string): {
    tabId: string
    webContents: Electron.WebContents
    url: string
    title: string
  } | null
}

export type ParticipantServiceParams = {
  db: Db
  resolver: ParticipantPageResolver
  /** tabId 是否是当前圆桌成员（RoundtableService 的成员表是唯一事实）。 */
  isParticipant: (tabId: string) => boolean
  /** 平台注册中心；缺省用平台目录全量注册。 */
  registry?: AIAdapterRegistry
  /** 快照变化广播（主窗口 + 圆桌独立窗口）。 */
  broadcast: (snapshot: AIRoundtableTaskSnapshot | null) => void
  /** 测试可注入时钟与引擎参数；生产用默认值。 */
  tuning?: EngineTuning
  /** 状态探测的重试参数（describe 用，比任务探测轻）。 */
  describeProbe?: { attempts: number; retryMs: number }
}

type ParticipantRun = {
  tabId: string
  platformId: string
  displayName: string
  adapter: AIPlatformAdapter
  state: AIChatTaskState
  content: string
  note: string
  url: string
  title: string
  cancelled: boolean
}

type ParticipantTaskRecord = {
  taskId: string
  prompt: string
  createdAt: number
  runs: Map<string, ParticipantRun>
}

export class ParticipantService {
  private readonly registry: AIAdapterRegistry
  private current: ParticipantTaskRecord | null = null
  private notify: (snapshot: AIRoundtableTaskSnapshot | null) => void = () => undefined
  /** 本轮任务的讨论记录 id；任务开始时创建。 */
  private currentConversationId: string | null = null
  /** 本轮已落库的参与者（按 tabId 去重——同平台多卡各写各的）。 */
  private persisted = new Set<string>()

  constructor(private readonly params: ParticipantServiceParams) {
    this.registry = params.registry ?? createDefaultRegistry()
    // 广播是缺省通知通道（主窗口 + 圆桌窗口）；测试可用 setNotifier 覆盖。
    this.notify = params.broadcast
  }

  setNotifier(fn: (snapshot: AIRoundtableTaskSnapshot | null) => void): void {
    this.notify = fn
  }

  isBusy(): boolean {
    return this.current !== null && [...this.current.runs.values()].some((run) => !isTerminalTaskState(run.state))
  }

  /** 当前（或最近一次）任务快照；带 conversationId。 */
  lastTask(): AIRoundtableTaskSnapshot | null {
    const record = this.current
    if (!record) return null
    return this.snapshotOf(record)
  }

  // MARK: - 成员识别（不执行任务；成员卡的状态来源）

  /** 逐个识别圆桌成员：平台、能力、登录态。URL/标题实时读取。 */
  async describeParticipants(tabIds: readonly string[]): Promise<AIRoundtableParticipantStatus[]> {
    const statuses: AIRoundtableParticipantStatus[] = []
    const record = this.current
    for (const tabId of tabIds) {
      const run = record?.runs.get(tabId)
      const taskState = run && !isTerminalTaskState(run.state) ? run.state : 'idle'

      const page = this.params.resolver.resolve(tabId)
      if (!page) {
        statuses.push({
          tabId,
          platformId: null,
          platformName: null,
          adapted: false,
          login: 'unavailable',
          taskState,
          url: '',
          title: '',
          note: 'page unavailable'
        })
        continue
      }

      const resolved = this.registry.resolve(page.url)
      if (!resolved) {
        statuses.push({
          tabId,
          platformId: null,
          platformName: null,
          adapted: false,
          login: 'unknown',
          taskState,
          url: page.url,
          title: page.title,
          note: ''
        })
        continue
      }

      const { descriptor, adapter } = resolved
      if (!adapter) {
        statuses.push({
          tabId,
          platformId: descriptor.id,
          platformName: descriptor.displayName,
          adapted: false,
          login: 'unknown',
          taskState,
          url: page.url,
          title: page.title,
          note: 'not adapted'
        })
        continue
      }

      const probe = await this.probeQuietly(adapter, { tabId, webContents: page.webContents, url: page.url, title: page.title })
      statuses.push({
        tabId,
        platformId: descriptor.id,
        platformName: descriptor.displayName,
        adapted: true,
        login: probe.loggedIn ? 'logged_in' : probe.reason === 'login_page' ? 'logged_out' : 'unknown',
        taskState,
        url: page.url,
        title: page.title,
        note: probe.reason
      })
    }
    return statuses
  }

  // MARK: - 并行提问（tabId 驱动）

  /**
   * 一轮圆桌任务：同一份问题并行发给所有「可自动交互」的成员。
   * 普通资料 / 未适配 / 页面不可用的成员不参与（也绝不报成失败）；
   * 一个可参与的成员都没有时明确报错，不伪造回答。
   */
  async ask(input: { prompt: string; participantTabIds: string[] }): Promise<{ conversationId: string; snapshot: AIRoundtableTaskSnapshot }> {
    if (this.isBusy()) {
      throw new Error('another roundtable task is still running')
    }
    if (input.participantTabIds.length > ROUNDTABLE_AI_MAX_PARTICIPANTS) {
      throw new Error(`too many participants (max ${ROUNDTABLE_AI_MAX_PARTICIPANTS})`)
    }

    // 成员校验：Renderer 只能引用当前圆桌的真实成员。
    const strangers = input.participantTabIds.filter((tabId) => !this.params.isParticipant(tabId))
    if (strangers.length > 0) {
      throw new Error(`not roundtable participants: ${strangers.join(', ')}`)
    }

    // 能力筛选：主进程按实时 URL 识别——普通资料 / 未适配 / 已销毁的页面不参与。
    const capable: Array<{ run: ParticipantRun; context: AIWebCardContext }> = []
    const skipped: string[] = []
    for (const tabId of [...new Set(input.participantTabIds)]) {
      const matched = this.matchParticipant(tabId)
      if (matched) capable.push(matched)
      else skipped.push(tabId)
    }
    if (capable.length === 0) {
      throw new Error('no capable ai participants (need a signed-in supported ai page in the roundtable)')
    }

    // 问题先行落库（与遗留路径同一纪律）：中途崩溃，这轮问题也在库里。
    const conversationId = this.createConversation(input.prompt, capable.map((item) => item.run.platformId))
    this.currentConversationId = conversationId

    const record: ParticipantTaskRecord = {
      taskId: randomUUID(),
      prompt: input.prompt,
      createdAt: Date.now(),
      runs: new Map()
    }
    for (const item of capable) {
      item.run.state = 'checking'
      record.runs.set(item.run.tabId, item.run)
    }
    this.current = record
    this.persisted = new Set()
    this.notify(this.snapshotOf(record))

    // 参与者之间没有先后：全部同时推进，谁失败谁自己负责。
    await Promise.allSettled(capable.map((item) => this.runParticipant(record, item.run, item.context)))
    this.persistTaskResults(record)
    this.notify(this.snapshotOf(record))
    return { conversationId, snapshot: this.snapshotOf(record) }
  }

  cancel(): void {
    const record = this.current
    if (!record) return
    for (const run of record.runs.values()) {
      if (!isTerminalTaskState(run.state)) {
        // cancelled 标志驱动轮询循环退出；state 只是展示。
        run.cancelled = true
        this.apply(record, run, 'cancelled', '', 'cancelled by user')
      }
    }
    this.notify(this.snapshotOf(record))
  }

  /** 单个成员被移出圆桌 / 关闭时：立即终止它的任务，不动别人。 */
  cancelParticipant(tabId: string): void {
    const record = this.current
    if (!record) return
    const run = record.runs.get(tabId)
    if (!run || isTerminalTaskState(run.state)) return
    run.cancelled = true
    this.apply(record, run, 'cancelled', '', 'removed from roundtable')
    this.notify(this.snapshotOf(record))
  }

  // MARK: - 单参与者执行

  private async runParticipant(record: ParticipantTaskRecord, run: ParticipantRun, context: AIWebCardContext): Promise<void> {
    try {
      // checking：登录没登录、输入框能不能用。每一步都重新解析——
      // 页面随时可能被用户关掉或导航走。
      const probe = await this.probeForTask(run, context)
      if (run.cancelled) {
        this.apply(record, run, 'cancelled')
        return
      }
      if (!probe.loggedIn) {
        if (probe.reason === 'login_page') {
          this.apply(record, run, 'login_required', '', 'login required')
        } else {
          this.apply(record, run, 'unsupported_page', '', probe.reason || 'input not found')
        }
        return
      }
      if (!probe.inputReady && !probe.generating) {
        this.apply(record, run, 'unsupported_page', '', 'composer not ready')
        return
      }

      // sending：写入并提交，拿回答基线（基线在 Adapter 内部、点击前统计）。
      if (run.cancelled) {
        this.apply(record, run, 'cancelled')
        return
      }
      this.apply(record, run, 'sending')
      const live = this.requireContext(run)
      const submit = await run.adapter.submit(live, record.prompt)
      if (!submit.ok) {
        this.apply(record, run, 'failed', '', submit.reason || 'submit failed')
        return
      }
      if (run.cancelled) {
        this.apply(record, run, 'cancelled')
        return
      }

      // generating：轮询到「停止按钮消失 + 文本稳定 + 序号晚于基线」。
      this.apply(record, run, 'generating')
      const outcome = await pollUntilAnswerStable(
        {
          isCancelled: () => run.cancelled,
          currentURL: () => this.requireContext(run).url,
          ownsURL: (url) => run.adapter.matches(url),
          readProbe: async () => await run.adapter.poll(this.requireContext(run))
        },
        submit.baseline,
        this.params.tuning
      )
      this.apply(record, run, outcome.state, outcome.content, outcome.note)
    } catch (error) {
      // 页面销毁 / 导航中 / 进程崩溃：只算这一位参与者的事。
      this.apply(record, run, 'failed', '', String(error instanceof Error ? error.message : error))
    }
  }

  /** 任务用探测：完整重试（SPA 挂载可能很慢），未登录页是确定性结论。 */
  private async probeForTask(run: ParticipantRun, context: AIWebCardContext): Promise<PageProbe> {
    return probeWithRetry(
      {
        isCancelled: () => run.cancelled,
        readProbe: async () => await run.adapter.probe(this.requireContext(run))
      },
      this.params.tuning
    )
  }

  /** describe 用的轻探测：少量重试，失败也只是「状态未知」，不炸 UI。 */
  private async probeQuietly(adapter: AIPlatformAdapter, context: AIWebCardContext): Promise<PageProbe> {
    const tuning = this.params.describeProbe ?? { attempts: 2, retryMs: 400 }
    return probeWithRetry(
      {
        isCancelled: () => false,
        readProbe: async () => await adapter.probe(context)
      },
      { probeAttempts: tuning.attempts, probeRetryMs: tuning.retryMs }
    )
  }

  /** 每次脚本执行前重新解析：页面没了就立刻终止，绝不在死页面上继续。 */
  private requireContext(run: ParticipantRun): AIWebCardContext {
    const page = this.params.resolver.resolve(run.tabId)
    if (!page) throw new Error('tab closed')
    if (!run.adapter.matches(page.url)) {
      throw new Error(`page navigated away: ${page.url}`)
    }
    return { tabId: run.tabId, webContents: page.webContents, url: page.url, title: page.title }
  }

  /** 按实时 URL 识别成员；返回可执行的参与者（未适配 / 普通资料返回 null）。 */
  private matchParticipant(tabId: string): { run: ParticipantRun; context: AIWebCardContext } | null {
    const page = this.params.resolver.resolve(tabId)
    if (!page) return null
    const resolved = this.registry.resolve(page.url)
    if (!resolved?.adapter) return null
    const adapter = resolved.adapter
    return {
      run: {
        tabId,
        platformId: adapter.id,
        displayName: adapter.displayName,
        adapter,
        state: 'idle',
        content: '',
        note: '',
        url: page.url,
        title: page.title,
        cancelled: false
      },
      context: { tabId, webContents: page.webContents, url: page.url, title: page.title }
    }
  }

  // MARK: - 状态与持久化

  private snapshotOf(record: ParticipantTaskRecord): AIRoundtableTaskSnapshot {
    return {
      taskId: record.taskId,
      prompt: record.prompt,
      createdAt: record.createdAt,
      conversationId: this.currentConversationId ?? undefined,
      results: [...record.runs.values()].map((run) => ({
        tabId: run.tabId,
        platformId: run.platformId,
        displayName: run.displayName,
        state: run.state,
        content: run.content,
        note: run.note,
        url: run.url,
        title: run.title
      }))
    }
  }

  private apply(record: ParticipantTaskRecord, run: ParticipantRun, state: AIChatTaskState, content = '', note = ''): void {
    run.state = state
    run.content = content
    run.note = note
    const page = this.params.resolver.resolve(run.tabId)
    if (page) {
      run.url = page.url
      run.title = page.title
    }
    void record
    // 增量持久化挂在广播回调里：平台一完成就落库（见 persistTaskResults）。
    this.persistTaskResults(record)
    this.notify(this.snapshotOf(record))
  }

  /** 把快照里所有「终态且未落库」的参与者结果写进消息表（按 tabId 去重）。 */
  private persistTaskResults(record: ParticipantTaskRecord): void {
    const conversationId = this.currentConversationId
    if (!conversationId) return
    for (const run of record.runs.values()) {
      if (!isTerminalTaskState(run.state) || this.persisted.has(run.tabId)) continue
      try {
        insertMessage(this.params.db, {
          id: randomUUID(),
          conversationId,
          provider: run.platformId,
          role: 'assistant',
          content: run.content,
          status: run.state,
          metadata: JSON.stringify({ note: run.note, url: run.url, tabId: run.tabId, displayName: run.displayName }),
          createdAt: Date.now()
        })
        this.persisted.add(run.tabId)
      } catch (error) {
        // 记录缺失可以接受，任务失败不行。
        console.error('[participant] persist failed', run.tabId, error)
      }
    }
  }

  private createConversation(prompt: string, platformIds: string[]): string {
    const now = Date.now()
    const id = randomUUID()
    insertConversation(this.params.db, {
      id,
      title: prompt.length > TITLE_MAX ? `${prompt.slice(0, TITLE_MAX)}…` : prompt,
      prompt,
      providers: [...new Set(platformIds)].join(','),
      now
    })
    insertMessage(this.params.db, {
      id: randomUUID(),
      conversationId: id,
      provider: 'user',
      role: 'user',
      content: prompt,
      status: 'completed',
      metadata: '',
      createdAt: now
    })
    return id
  }

  /** 任务中断（忙时竞态等）：撤掉刚建的空记录，不留孤儿。 */
  discardCurrentConversation(): void {
    const conversationId = this.currentConversationId
    this.currentConversationId = null
    if (!conversationId) return
    try {
      deleteConversation(this.params.db, conversationId)
    } catch {
      // ignore
    }
  }
}
