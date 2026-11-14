import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { selectConversation, selectMessages } from '../../src/main/database/repositories/ai-conversations'
import { AIChatService } from '../../src/main/ai-chat/ai-chat-service'
import type { TaskCoordinator } from '../../src/main/ai-chat/automation/task-coordinator'
import type { AIAskInput, AIChatTaskSnapshot, AIProvider, AIProviderResult } from '../../src/main/ai-chat/automation/types'

/**
 * AIChatService 的持久化时序（Phase 4.1.6）：
 * 1. 问题先行——ask() 一开始 conversation + 用户消息就在库里；
 * 2. 增量——某平台一 completed，它的回答立刻落库，不等其它平台；
 * 3. 收尾——任务落定后剩余终态（failed/cancelled/timeout…）也入记录；
 * 4. 忙时拒绝——抛错不落孤儿 conversation。
 *
 * coordinator 用可控的 fake（测试自己推进状态、自己触发 notifier），
 * 库是真实的 SQLite（mkdtemp + openDatabase），验证的是真实落库顺序。
 */

function result(provider: AIProvider, state: AIProviderResult['state'], content = '', note = ''): AIProviderResult {
  return { provider, state, content, note, url: `https://fixture.test/${provider}` }
}

class FakeCoordinator {
  notifier: () => void = () => {}
  /** ask() 挂在 gate 上：测试手动放行，模拟「另一个平台还在生成」。 */
  private gate: Promise<void> | null = null
  private releaseGate: (() => void) | null = null
  current: AIChatTaskSnapshot | null = null
  askError: Error | null = null
  busy = false

  setNotifier(fn: () => void): void {
    this.notifier = fn
  }

  isBusy(): boolean {
    return this.busy
  }

  snapshot(): AIChatTaskSnapshot | null {
    return this.current
  }

  states(): Map<AIProvider, AIProviderResult['state']> {
    return new Map()
  }

  cancel(): void {}

  async ask(input: AIAskInput): Promise<AIChatTaskSnapshot> {
    if (this.askError) throw this.askError
    if (this.gate === null) {
      this.gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve
      })
    }
    this.current = {
      taskId: 'task-1',
      prompt: input.prompt,
      createdAt: 1,
      results: input.providers.map((provider) => result(provider, 'checking'))
    }
    await this.gate
    return this.current
  }

  /** 测试推演：改写某平台状态并触发服务层的增量持久化。 */
  update(provider: AIProvider, next: AIProviderResult): void {
    const snapshot = this.current
    if (!snapshot) return
    this.current = {
      ...snapshot,
      results: snapshot.results.map((item) => (item.provider === provider ? next : item))
    }
    this.notifier()
  }

  release(): void {
    this.releaseGate?.()
  }
}

describe('AIChatService：增量持久化', () => {
  let dir = ''
  let handle: DatabaseHandle
  let coordinator: FakeCoordinator
  let service: AIChatService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-ai-chat-'))
    handle = openDatabase(join(dir, 'brewphase.db'))
    coordinator = new FakeCoordinator()
    service = new AIChatService(handle.db, {
      coordinator: coordinator as unknown as TaskCoordinator
    })
  })

  afterEach(() => {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ask() 一开始问题就落库；平台完成即写库，不等其它平台', async () => {
    const running = service.ask({ prompt: '如何设计一个 AI 工作空间？', providers: ['chatgpt', 'claude'] })

    // gate 还挂着（Claude 还在「生成」）：问题与用户消息必须已经在库里。
    const conversationRow = handle.sqlite
      .prepare('select id, prompt, providers from ai_conversations')
      .get() as { id: string; prompt: string; providers: string }
    expect(conversationRow.prompt).toBe('如何设计一个 AI 工作空间？')
    expect(conversationRow.providers).toBe('chatgpt,claude')
    const userRows = handle.sqlite
      .prepare("select count(*) as n from ai_messages where role = 'user'")
      .get() as { n: number }
    expect(userRows.n).toBe(1)

    // GPT 先完成：它的回答立刻入记录。
    coordinator.update('chatgpt', result('chatgpt', 'completed', 'GPT 的完整回答'))
    const gptRows = handle.sqlite
      .prepare("select count(*) as n from ai_messages where provider = 'chatgpt' and status = 'completed'")
      .get() as { n: number }
    expect(gptRows.n).toBe(1)

    // 放行：Claude 以 failed 收场——失败状态也保留，GPT 的回答不受影响。
    coordinator.update('claude', result('claude', 'failed', '', 'submit failed'))
    coordinator.release()
    const { conversationId, snapshot } = await running

    expect(snapshot.results.find((item) => item.provider === 'chatgpt')?.content).toBe('GPT 的完整回答')
    const claudeRows = handle.sqlite
      .prepare("select count(*) as n from ai_messages where provider = 'claude' and status = 'failed'")
      .get() as { n: number }
    expect(claudeRows.n).toBe(1)
    const detail = service.conversation(conversationId)
    expect(detail?.conversation.prompt).toBe('如何设计一个 AI 工作空间？')
    expect(detail?.messages).toHaveLength(3) // user + chatgpt + claude

    // 广播快照带 conversationId，圆桌 UI 用它关联记录。
    expect(service.lastTask()?.conversationId).toBe(conversationId)
  })

  it('取消任务：cancelled 状态保留在讨论记录里', async () => {
    const running = service.ask({ prompt: '慢慢讨论', providers: ['chatgpt'] })
    // 生成中被用户取消：从未 completed，也照样留下一条 cancelled 记录。
    coordinator.update('chatgpt', result('chatgpt', 'generating', ''))
    coordinator.update('chatgpt', result('chatgpt', 'cancelled', '', 'cancelled by user'))
    coordinator.release()
    const { conversationId, snapshot } = await running

    expect(snapshot.results[0].state).toBe('cancelled')
    const assistantRows = selectMessages(handle.db, conversationId).filter((row) => row.role === 'assistant')
    expect(assistantRows).toHaveLength(1)
    expect(assistantRows[0].status).toBe('cancelled')
    expect(assistantRows[0].provider).toBe('chatgpt')
  })

  it('忙时拒绝：抛错且不留孤儿 conversation', async () => {
    coordinator.busy = true
    coordinator.askError = new Error('another multi-ai task is still running')
    await expect(service.ask({ prompt: '重复提交', providers: ['chatgpt'] })).rejects.toThrow(/still running/)
    const conversations = handle.sqlite.prepare('select count(*) as n from ai_conversations').get() as { n: number }
    expect(conversations.n).toBe(0)
    const messages = handle.sqlite.prepare('select count(*) as n from ai_messages').get() as { n: number }
    expect(messages.n).toBe(0)
  })

  it('同一轮里同一平台不会重复写库（增量去重）', async () => {
    const running = service.ask({ prompt: '去重', providers: ['chatgpt'] })
    coordinator.update('chatgpt', result('chatgpt', 'completed', '答案'))
    coordinator.update('chatgpt', result('chatgpt', 'completed', '答案'))
    coordinator.release()
    await running
    const rows = handle.sqlite
      .prepare("select count(*) as n from ai_messages where provider = 'chatgpt' and role = 'assistant'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('selectConversation 能按 id 读回本轮记录（圆桌关联讨论记录的前提）', async () => {
    const running = service.ask({ prompt: '记录', providers: ['claude'] })
    coordinator.update('claude', result('claude', 'completed', 'Claude 的回答'))
    coordinator.release()
    const { conversationId } = await running
    const row = selectConversation(handle.db, conversationId)
    expect(row?.prompt).toBe('记录')
    const messages = selectMessages(handle.db, conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })
})
