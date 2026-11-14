import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskCoordinator, type AgentPagesLike } from '../../src/main/ai-chat/automation/task-coordinator'
import type { PlatformAdapter } from '../../src/main/ai-chat/automation/adapters'
import type { AIProvider, PageProbe } from '../../src/main/ai-chat/automation/types'

/**
 * Multi-AI 调度器的行为测试。
 *
 * 不启动 Electron：WebContents 用一个按脚本内容路由的 fake 代替
 * （脚本里有什么关键字就回什么数据），Adapter 也用假的——这里测的是
 * 调度与状态机，不是平台选择器。
 *
 * 三个必须守住的承诺：
 * 1. 双平台真并行，一个失败不丢另一个的结果；
 * 2. 忙时拒绝新任务（防重复提交靠这个，不靠 UI 按钮 disable）；
 * 3. 完成判定看「停止按钮消失 + 文本稳定 + 序号晚于基线」，不看时间。
 */

const URL_BY_PROVIDER: Record<AIProvider, string> = {
  chatgpt: 'https://chatgpt.com/c/1',
  claude: 'https://claude.ai/chat/1'
}

type FakeWorld = {
  /** 每个平台下一次 poll 的回答内容。 */
  answers: Record<AIProvider, string[]>
  /** 每个平台 poll 时是否还在生成。 */
  generating: Record<AIProvider, boolean[]>
  /** 提交动作的干预（默认成功）。 */
  submitOverride?: Partial<Record<AIProvider, { ok: boolean; reason: string }>>
  /** probe 的干预（默认登录且就绪）。 */
  probeOverride?: Partial<Record<AIProvider, { loggedIn: boolean; reason: string; inputReady: boolean }>>
  /** 收集真实提交的脚本（验 prompt 原样到达、是否被提交过）。 */
  submittedScripts?: string[]
}

function fakeWebContents(provider: AIProvider, world: FakeWorld) {
  const url = URL_BY_PROVIDER[provider]
  let submitCount = 0
  let lastPoll = { answer: '', generating: true }
  return {
    getURL: () => url,
    isDestroyed: () => false,
    executeJavaScript: (script: string): Promise<unknown> => {
      if (script.includes('probeScript-marker') || script.includes('__bpPick')) {
        const override = world.probeOverride?.[provider]
        if (override) return Promise.resolve(override)
        return Promise.resolve({ loggedIn: true, reason: '', inputReady: true, generating: false, answer: '', answerSeq: 0 })
      }
      if (script.includes('baseline')) {
        // 提交脚本：返回基线并登记一次真实提交
        world.submittedScripts?.push(script)
        submitCount += 1
        const override = world.submitOverride?.[provider]
        if (override) return Promise.resolve({ ...override, baseline: 0 })
        return Promise.resolve({ ok: true, reason: '', baseline: 0 })
      }
      if (script.includes('poll-marker') || script.includes('poll')) {
        // 队列耗尽后沿用最后一次的值：真实页面停止生成后会一直停在最终文本上，
        // 这里模拟同样的「稳定」行为，避免把『数据读完』误当『页面变空』。
        const answer = world.answers[provider].shift() ?? lastPoll.answer
        const generating = world.generating[provider].shift() ?? lastPoll.generating
        lastPoll = { answer, generating }
        const probe: PageProbe = {
          loggedIn: true,
          reason: '',
          inputReady: false,
          generating,
          answer,
          answerSeq: answer ? 1 : 0
        }
        return Promise.resolve(probe)
      }
      return Promise.resolve(null)
    },
    submissions: () => submitCount
  } as unknown as Electron.WebContents & { submissions: () => number }
}

function fakePages(world: FakeWorld, counts: Map<AIProvider, number>): AgentPagesLike {
  return {
    snapshot: (provider) => ({
      provider,
      alive: counts.has(provider),
      url: counts.has(provider) ? URL_BY_PROVIDER[provider] : '',
      title: ''
    }),
    ownsURL: (provider, url) => url.startsWith(URL_BY_PROVIDER[provider].split('/c')[0].split('/chat')[0]),
    webContents: (provider) => (counts.has(provider) ? fakeWebContents(provider, world) : null),
    ensurePage: async (provider) => {
      counts.set(provider, (counts.get(provider) ?? 0) + 1)
      return fakeWebContents(provider, world)
    }
  }
}

/** 假 Adapter：脚本里埋 marker，fake webContents 据此路由。 */
function fakeAdapter(provider: AIProvider): PlatformAdapter {
  return {
    provider,
    allowedHosts: ['example.test'],
    homeURL: `https://example.test/${provider}`,
    ownsURL: (url) => URL_BY_PROVIDER[provider].startsWith(url.split('/c')[0].split('/chat')[0]) || url.includes('example.test'),
    probeScript: () => `/* probeScript-marker ${provider} */`,
    submitScript: (prompt) => `/* submit with baseline ${provider} */ ${JSON.stringify(prompt)}`,
    pollScript: () => `/* poll-marker ${provider} */`
  }
}

function makeAdapters(): Record<AIProvider, PlatformAdapter> {
  return { chatgpt: fakeAdapter('chatgpt'), claude: fakeAdapter('claude') }
}

describe('Multi-AI 并行调度', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('双平台同时提问：都完成，各自拿到自己的回答', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: ['GPT 的回答', 'GPT 的回答'], claude: ['Claude 的回答', 'Claude 的回答'] },
      generating: { chatgpt: [true, false, false], claude: [true, false, false] }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 1, timeoutMs: 5_000 })

    const snapshot = await coordinator.ask({ prompt: '如何煮好一杯手冲？', providers: ['chatgpt', 'claude'] })

    const byProvider = Object.fromEntries(snapshot.results.map((r) => [r.provider, r]))
    expect(byProvider.chatgpt.state).toBe('completed')
    expect(byProvider.chatgpt.content).toBe('GPT 的回答')
    expect(byProvider.claude.state).toBe('completed')
    expect(byProvider.claude.content).toBe('Claude 的回答')
  })

  it('一个平台失败，另一个的回答不能丢', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: ['GPT 的回答', 'GPT 的回答'], claude: ['', ''] },
      generating: { chatgpt: [true, false, false], claude: [false, false, false, false, false] },
      probeOverride: { claude: { loggedIn: false, reason: 'login_page', inputReady: false } }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 1, timeoutMs: 5_000 })

    const snapshot = await coordinator.ask({ prompt: '同一个问题', providers: ['chatgpt', 'claude'] })
    const byProvider = Object.fromEntries(snapshot.results.map((r) => [r.provider, r]))

    expect(byProvider.chatgpt.state).toBe('completed')
    expect(byProvider.chatgpt.content).toBe('GPT 的回答')
    expect(byProvider.claude.state).toBe('login_required')
  })

  it('任务进行中拒绝新的 ask（防重复提交）', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: [], claude: [] },
      generating: { chatgpt: [true, true, true, true, true], claude: [true, true, true, true, true] }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 30, timeoutMs: 60_000 })

    const first = coordinator.ask({ prompt: '第一个任务', providers: ['chatgpt'] })
    // 第一个还没结束（一直 generating）时，第二个必须被拒
    await expect(coordinator.ask({ prompt: '第二个任务', providers: ['chatgpt'] })).rejects.toThrow(/still running/)
    coordinator.cancel()
    await first
  })

  it('用户取消后状态是 cancelled，不再轮询', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: [], claude: [] },
      generating: { chatgpt: [true, true, true, true], claude: [] }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 20, timeoutMs: 60_000 })

    const running = coordinator.ask({ prompt: '慢慢想', providers: ['chatgpt'] })
    coordinator.cancel()
    const snapshot = await running
    expect(snapshot.results[0].state).toBe('cancelled')
  })

  it('一直生成不出结果时按超时收场，不伪装成功', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: [], claude: [] },
      generating: { chatgpt: [true, true, true, true], claude: [] }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 5, timeoutMs: 60 })

    const snapshot = await coordinator.ask({ prompt: '永不完成', providers: ['chatgpt'] })
    expect(snapshot.results[0].state).toBe('timeout')
    expect(snapshot.results[0].content).toBe('')
  })

  it('生成过程中文本反复变化：以最终稳定版本为准', async () => {
    const world: FakeWorld = {
      // 第一轮流式半句，第二轮完整句，第三轮停止且文本不再变
      answers: { chatgpt: ['第一', '完整回答', '完整回答', '完整回答'], claude: [] },
      generating: { chatgpt: [true, true, false, false], claude: [] }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 1, timeoutMs: 5_000 })

    const snapshot = await coordinator.ask({ prompt: '写一句', providers: ['chatgpt'] })
    expect(snapshot.results[0].content).toBe('完整回答')
    expect(snapshot.results[0].state).toBe('completed')
  })

  it('只选一个平台：只提交给选中的那家，另一家的页面完全不被触碰', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: ['GPT 的回答', 'GPT 的回答'], claude: [] },
      generating: { chatgpt: [true, false, false], claude: [] }
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 1, timeoutMs: 5_000 })

    const snapshot = await coordinator.ask({ prompt: '只问 GPT', providers: ['chatgpt'] })
    expect(snapshot.results).toHaveLength(1)
    expect(snapshot.results[0].provider).toBe('chatgpt')
    expect(counts.has('claude')).toBe(false)
  })

  it('同一份问题原样到达每个平台（并行不串改）', async () => {
    const world: FakeWorld = {
      answers: { chatgpt: ['A', 'A'], claude: ['B', 'B'] },
      generating: { chatgpt: [true, false, false], claude: [true, false, false] },
      submittedScripts: []
    }
    const counts = new Map<AIProvider, number>()
    const coordinator = new TaskCoordinator(fakePages(world, counts), makeAdapters(), { pollIntervalMs: 1, timeoutMs: 5_000 })

    const prompt = '同一个问题：圆桌的并行规则是什么？'
    await coordinator.ask({ prompt, providers: ['chatgpt', 'claude'] })
    expect(world.submittedScripts).toHaveLength(2)
    // submitScript 用 JSON.stringify 注入 prompt：两个平台的脚本都包含原样的字面量。
    for (const script of world.submittedScripts!) {
      expect(script).toContain(JSON.stringify(prompt))
    }
  })
})
