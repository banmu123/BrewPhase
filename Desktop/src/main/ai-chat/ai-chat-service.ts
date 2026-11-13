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
import { AI_PROVIDERS, type AIAskInput, type AIPlatformStatus, type AIProvider } from './automation/types'

/**
 * AI Workspace 的应用服务：平台状态、并行提问、结果落库。
 *
 * 状态推送与 browser-manager 同一手法——主进程是唯一事实来源，
 * 变化即广播，渲染层只画收到的快照。
 */

const TITLE_MAX = 60

export class AIChatService {
  private readonly pages: AgentPageManager
  private readonly coordinator: TaskCoordinator
  private notify: () => void = () => {}

  constructor(private readonly db: Db) {
    this.pages = new AgentPageManager()
    this.coordinator = new TaskCoordinator(this.pages)
    this.coordinator.setNotifier(() => this.notify())
  }

  setNotifier(fn: () => void): void {
    this.notify = fn
  }

  // MARK: - 平台状态（Accounts / Multi-AI 顶部）

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

  async ask(input: AIAskInput): Promise<{ conversationId: string; snapshot: Awaited<ReturnType<TaskCoordinator['ask']>> }> {
    const snapshot = await this.coordinator.ask(input)
    const conversationId = this.saveTask(input, snapshot)
    return { conversationId, snapshot }
  }

  cancel(): void {
    this.coordinator.cancel()
  }

  isBusy(): boolean {
    return this.coordinator.isBusy()
  }

  lastTask(): ReturnType<TaskCoordinator['snapshot']> {
    return this.coordinator.snapshot()
  }

  /** 打开登录页：后台页面直接去平台主页；用户随后可在 Accounts 确认状态。 */
  async openLogin(provider: AIProvider): Promise<void> {
    await this.pages.openHome(provider)
  }

  /** 在内置浏览器浮窗里打开平台（查看原网页用）——只把 URL 交给调用方。 */
  viewURL(provider: AIProvider): string {
    return this.pages.snapshot(provider).url || (provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new')
  }

  dispose(): void {
    this.pages.disposeAll()
  }

  // MARK: - 持久化

  private saveTask(input: AIAskInput, snapshot: Awaited<ReturnType<TaskCoordinator['ask']>>): string {
    const now = Date.now()
    const id = randomUUID()
    const providers = input.providers.join(',')

    insertConversation(this.db, {
      id,
      title: input.prompt.length > TITLE_MAX ? `${input.prompt.slice(0, TITLE_MAX)}…` : input.prompt,
      prompt: input.prompt,
      providers,
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

    for (const result of snapshot.results) {
      insertMessage(this.db, {
        id: randomUUID(),
        conversationId: id,
        provider: result.provider,
        role: 'assistant',
        content: result.content,
        status: result.state === 'completed' ? 'completed' : result.state,
        metadata: JSON.stringify({ note: result.note, url: result.url }),
        createdAt: now + 1
      })
    }
    return id
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
