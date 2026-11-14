import { randomUUID } from 'node:crypto'
import type { Db } from '../database/client'
import {
  deleteConversation,
  insertConversation,
  insertMessage,
  selectConversation,
  selectMessages,
  selectRecentConversations,
  type AIConversationRow,
  type AIMessageRow
} from '../database/repositories/ai-conversations'
import { AgentPageManager } from './agent-page-manager'
import { AI_ADAPTERS } from './automation/adapters'
import { TaskCoordinator } from './automation/task-coordinator'
import {
  AI_PROVIDERS,
  isTerminalTaskState,
  type AIAskInput,
  type AIChatTaskSnapshot,
  type AIPlatformStatus,
  type AIProvider,
  type AIProviderResult
} from './automation/types'

/**
 * Multi-AI 的应用服务：平台状态、并行提问、结果落库。
 *
 * 状态推送与 browser-manager 同一手法——主进程是唯一事实来源，
 * 变化即广播，渲染层只画收到的快照。
 *
 * Phase 4.1 起持久化是**增量**的，顺序有意为之：
 * 1. `ask()` 一开始就落 conversation + 用户问题——任务中途崩溃，问题与
 *    参与平台也在库里，不会整轮蒸发；
 * 2. 每个平台的回答一 `completed` 就立刻写库（广播回调里捎带做）——
 *    GPT 已完成而 Claude 还在生成时被杀掉，GPT 的回答不能丢；
 * 3. 任务整体落定后，把剩余的终态（failed / timeout / cancelled /
 *    login_required / unsupported_page / page_unavailable）补写进去。
 *
 * coordinator 允许注入（单测用假页面 + 真 SQLite 验证上面的顺序）；
 * 不传时自己构造生产版。
 */

const TITLE_MAX = 60

export type AIChatServiceDeps = {
  /** 单测注入：假页面 + 假/真 coordinator，不启动 Electron。 */
  coordinator?: TaskCoordinator
}

export class AIChatService {
  private readonly pages: AgentPageManager
  private readonly coordinator: TaskCoordinator
  private notify: () => void = () => {}
  /** 本轮任务的讨论记录 id；任务开始时创建，广播与 ask 返回都带它。 */
  private currentConversationId: string | null = null
  /** 本轮已经落库的平台（增量持久化的去重标记）。 */
  private persisted = new Set<AIProvider>()

  constructor(private readonly db: Db, deps: AIChatServiceDeps = {}) {
    this.pages = new AgentPageManager()
    this.coordinator = deps.coordinator ?? new TaskCoordinator(this.pages)
    this.coordinator.setNotifier(() => this.onTaskProgress())
  }

  setNotifier(fn: () => void): void {
    this.notify = fn
  }

  // MARK: - 平台状态（圆桌平台卡 / Accounts 顶部）

  async platformStatuses(): Promise<AIPlatformStatus[]> {
    const states = this.coordinator.states()
    const out: AIPlatformStatus[] = []
    for (const provider of AI_PROVIDERS) {
      const snap = this.pages.snapshot(provider)
      let login: AIPlatformStatus['login'] = 'unknown'
      let note = ''

      if (snap.alive) {
        try {
          const webContents = this.pages.webContents(provider)
          const probe = (await webContents?.executeJavaScript(AI_ADAPTERS[provider].probeScript())) as {
            loggedIn: boolean
            reason: string
          } | null
          if (probe) {
            login = probe.loggedIn ? 'logged_in' : probe.reason === 'login_page' ? 'logged_out' : 'unknown'
            note = probe.reason
          }
        } catch (error) {
          note = String(error instanceof Error ? error.message : error)
        }
      }

      out.push({
        provider,
        pageAlive: snap.alive,
        url: snap.url,
        title: snap.title,
        login,
        taskState: states.get(provider) ?? 'idle',
        lastNote: note
      })
    }
    return out
  }

  // MARK: - 并行提问

  async ask(input: AIAskInput): Promise<{ conversationId: string; snapshot: AIChatTaskSnapshot }> {
    if (this.coordinator.isBusy()) {
      throw new Error('another multi-ai task is still running')
    }

    // 问题先行落库：即使进程当场被杀，这轮问题与参与平台也有记录可查。
    const conversationId = this.createConversation(input)
    this.currentConversationId = conversationId
    this.persisted = new Set()

    let snapshot: AIChatTaskSnapshot
    try {
      snapshot = await this.coordinator.ask(input)
    } catch (error) {
      // 真没跑起来（忙等竞态等）：撤掉刚建的空记录，不留孤儿。
      deleteConversation(this.db, conversationId)
      this.currentConversationId = null
      throw error
    }
    this.persistTaskResults(snapshot)
    return { conversationId, snapshot: this.withConversation(snapshot) }
  }

  cancel(): void {
    this.coordinator.cancel()
  }

  isBusy(): boolean {
    return this.coordinator.isBusy()
  }

  /** 当前（或最近一次）任务快照；带 conversationId，供广播与 hydration。 */
  lastTask(): AIChatTaskSnapshot | null {
    const snapshot = this.coordinator.snapshot()
    return snapshot ? this.withConversation(snapshot) : null
  }

  /** 打开登录页：后台页面直接去平台主页；用户随后可确认状态。 */
  async openLogin(provider: AIProvider): Promise<void> {
    await this.pages.openHome(provider)
  }

  /** 在内置浏览器浮窗里打开平台（登录 / 查看原网页用）——只把 URL 交给调用方。 */
  viewURL(provider: AIProvider): string {
    return this.pages.snapshot(provider).url || (provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new')
  }

  dispose(): void {
    this.pages.disposeAll()
  }

  // MARK: - 增量持久化（广播回调驱动）

  /**
   * 每次任务状态变化都检查一遍：已 completed 且尚未落库的回答立刻写库。
   * 写库失败绝不打断任务——记录缺失可以接受，任务失败不行。
   */
  private onTaskProgress(): void {
    try {
      const snapshot = this.coordinator.snapshot()
      if (!snapshot) return
      this.persistTaskResults(snapshot)
    } finally {
      this.notify()
    }
  }

  /** 把快照里所有「终态且未落库」的平台结果写进消息表；completed 之外也保留状态。 */
  private persistTaskResults(snapshot: AIChatTaskSnapshot): void {
    const conversationId = this.currentConversationId
    if (!conversationId) return
    for (const result of snapshot.results) {
      if (!isTerminalTaskState(result.state) || this.persisted.has(result.provider)) continue
      this.insertResultMessage(conversationId, result)
      this.persisted.add(result.provider)
    }
  }

  private insertResultMessage(conversationId: string, result: AIProviderResult): void {
    insertMessage(this.db, {
      id: randomUUID(),
      conversationId,
      provider: result.provider,
      role: 'assistant',
      content: result.content,
      status: result.state,
      metadata: JSON.stringify({ note: result.note, url: result.url }),
      createdAt: Date.now()
    })
  }

  // MARK: - 会话创建（问题先行）

  private createConversation(input: AIAskInput): string {
    const now = Date.now()
    const id = randomUUID()
    insertConversation(this.db, {
      id,
      title: input.prompt.length > TITLE_MAX ? `${input.prompt.slice(0, TITLE_MAX)}…` : input.prompt,
      prompt: input.prompt,
      providers: input.providers.join(','),
      now
    })
    insertMessage(this.db, {
      id: randomUUID(),
      conversationId: id,
      provider: 'user',
      role: 'user',
      content: input.prompt,
      status: 'completed',
      metadata: '',
      createdAt: now
    })
    return id
  }

  private withConversation(snapshot: AIChatTaskSnapshot): AIChatTaskSnapshot {
    return { ...snapshot, conversationId: this.currentConversationId ?? snapshot.conversationId }
  }

  // MARK: - 会话读取

  recentConversations(limit: number): AIConversationRow[] {
    return selectRecentConversations(this.db, limit)
  }

  conversation(id: string): { conversation: AIConversationRow; messages: AIMessageRow[] } | null {
    const conversation = selectConversation(this.db, id)
    if (!conversation) return null
    return { conversation, messages: selectMessages(this.db, id) }
  }

  removeConversation(id: string): boolean {
    return deleteConversation(this.db, id)
  }
}
