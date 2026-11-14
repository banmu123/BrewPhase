import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { selectMessages } from '../../src/main/database/repositories/ai-conversations'
import { ParticipantService, type ParticipantPageResolver } from '../../src/main/ai-chat/participant-service'
import { AIAdapterRegistry, platformMatcher } from '../../src/main/ai-chat/adapters/registry'
import type { AIPlatformAdapter, AIWebCardContext } from '../../src/main/ai-chat/adapters/types'

/**
 * 圆桌参与者执行服务的行为测试（Phase 4.2）：
 * 1. **tabId 是身份**——同平台两张卡是两个独立参与者，回答不合并；
 * 2. 能力筛选在主进程——普通网页 / 未识别 / 已销毁页面不参与，也不报失败；
 * 3. 一个参与者失败不影响其他成员；取消能终止单个成员；
 * 4. 持久化按 tabId 去重（增量），metadata 带 tabId / displayName。
 *
 * Adapter 用假的 context 实现（probe/submit/poll 直接返回数据）——这里测的是
 * 服务与调度行为，不是平台脚本；真实 Adapter 脚本由遗留 adapter 测试与
 * E2E 本地夹具页在真实 Chromium 里验证。
 */

type FakePage = {
  tabId: string
  url: string
  title: string
  /** 每次轮询的回答队列（耗尽后沿用最后一次，模拟稳定页面）。 */
  answers: string[]
  generating: boolean[]
  lastAnswer: string
  lastGenerating: boolean
  loggedIn: boolean
  loginPage?: boolean
  inputReady: boolean
  submitOk: boolean
  destroyed: boolean
}

class FakeWorld {
  pages = new Map<string, FakePage>()
  /** 已发生的提交（tabId → 次数），验证并行与真实写入。 */
  submissions = new Map<string, number>()
  lastPrompt: string | null = null

  addPage(page: FakePage): void {
    this.pages.set(page.tabId, page)
  }

  closePage(tabId: string): void {
    const page = this.pages.get(tabId)
    if (!page) return
    page.destroyed = true
    this.pages.delete(tabId)
  }

  resolver: ParticipantPageResolver = {
    resolve: (tabId) => {
      const page = this.pages.get(tabId)
      if (!page || page.destroyed) return null
      return { tabId: page.tabId, webContents: page as unknown as Electron.WebContents, url: page.url, title: page.title }
    }
  }
}

function fakeAdapterFor(world: FakeWorld, platformId: string, host: string): AIPlatformAdapter {
  return {
    id: platformId,
    displayName: platformId.toUpperCase(),
    allowedHosts: [host],
    homeURL: `https://${host}/`,
    matches(url) {
      return platformMatcher(platformId, [host])(url)
    },
    async probe(context: AIWebCardContext) {
      const page = world.pages.get(context.tabId)
      if (!page) throw new Error('tab closed')
      return {
        loggedIn: page.loggedIn && !page.loginPage,
        reason: page.loginPage ? 'login_page' : '',
        inputReady: page.inputReady,
        generating: false,
        answer: '',
        answerSeq: 0
      }
    },
    async submit(context, prompt) {
      const page = world.pages.get(context.tabId)
      if (!page) throw new Error('tab closed')
      world.submissions.set(context.tabId, (world.submissions.get(context.tabId) ?? 0) + 1)
      world.lastPrompt = prompt
      return page.submitOk ? { ok: true, reason: '', baseline: 0 } : { ok: false, reason: 'send_button_not_found', baseline: 0 }
    },
    async poll(context) {
      const page = world.pages.get(context.tabId)
      if (!page) throw new Error('tab closed')
      const answer = page.answers.shift() ?? page.lastAnswer
      const generating = page.generating.shift() ?? page.lastGenerating
      page.lastAnswer = answer
      page.lastGenerating = generating
      return { generating, answer, answerSeq: answer ? 1 : 0 }
    }
  }
}

function makeRegistry(world: FakeWorld): AIAdapterRegistry {
  const registry = new AIAdapterRegistry()
  registry.register({
    id: 'chatgpt',
    displayName: 'ChatGPT',
    matches: platformMatcher('chatgpt', ['fixture.test']),
    adapter: fakeAdapterFor(world, 'chatgpt', 'fixture.test')
  })
  return registry
}

function makePage(world: FakeWorld, tabId: string, overrides: Partial<FakePage> = {}): FakePage {
  const page: FakePage = {
    tabId,
    url: 'https://fixture.test/chat',
    title: `fixture ${tabId}`,
    answers: [],
    generating: [],
    lastAnswer: '',
    lastGenerating: true,
    loggedIn: true,
    inputReady: true,
    submitOk: true,
    destroyed: false,
    ...overrides
  }
  world.addPage(page)
  return page
}

describe('ParticipantService：真实 WebCard 驱动的并行问答', () => {
  let dir = ''
  let handle: DatabaseHandle
  let world: FakeWorld
  let service: ParticipantService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-participant-'))
    handle = openDatabase(join(dir, 'brewphase.db'))
    world = new FakeWorld()
    service = new ParticipantService({
      db: handle.db,
      resolver: world.resolver,
      isParticipant: (tabId) => tabId.startsWith('tab-'),
      registry: makeRegistry(world),
      broadcast: () => undefined,
      tuning: { pollIntervalMs: 1, timeoutMs: 1_500, probeAttempts: 2, probeRetryMs: 1 }
    })
  })

  afterEach(() => {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一问题并行发给两个 tabId；同平台两卡产生两份独立回答', async () => {
    makePage(world, 'tab-1', { answers: ['卡一的回答', '卡一的回答'], generating: [true, false, false] })
    makePage(world, 'tab-2', { answers: ['卡二的回答', '卡二的回答'], generating: [true, false, false] })

    const { snapshot } = await service.ask({ prompt: '同一个问题', participantTabIds: ['tab-1', 'tab-2'] })

    expect(snapshot.results).toHaveLength(2)
    expect(snapshot.results.map((item) => item.tabId).sort()).toEqual(['tab-1', 'tab-2'])
    expect(snapshot.results.every((item) => item.state === 'completed')).toBe(true)
    expect(snapshot.results.map((item) => item.content).sort()).toEqual(['卡一的回答', '卡二的回答'])
    // 两个 tabId 各真实提交了一次同一份 prompt。
    expect(world.submissions.get('tab-1')).toBe(1)
    expect(world.submissions.get('tab-2')).toBe(1)
    expect(world.lastPrompt).toBe('同一个问题')
  })

  it('一个参与者失败，其他成员的回答不丢', async () => {
    makePage(world, 'tab-1', { answers: ['好的回答', '好的回答'], generating: [true, false, false] })
    makePage(world, 'tab-2', { submitOk: false })

    const { snapshot } = await service.ask({ prompt: '有人翻车', participantTabIds: ['tab-1', 'tab-2'] })
    const byId = Object.fromEntries(snapshot.results.map((item) => [item.tabId, item]))
    expect(byId['tab-1'].state).toBe('completed')
    expect(byId['tab-1'].content).toBe('好的回答')
    expect(byId['tab-2'].state).toBe('failed')
  })

  it('已销毁页面在提交时被过滤；一个 AI 成员都没有时明确报错', async () => {
    makePage(world, 'tab-1', { answers: ['回答', '回答'], generating: [false, false] })
    const { snapshot } = await service.ask({ prompt: '只有一位 AI', participantTabIds: ['tab-1'] })
    expect(snapshot.results).toHaveLength(1)

    // 不存在的 tabId：成员校验通过（stub 是 startsWith('tab-')），但解析不到
    // 页面 → 被能力筛选排除 → 一个能跑的都没有 → 明确报错，不伪造回答。
    await expect(service.ask({ prompt: '没有 AI', participantTabIds: ['tab-9'] })).rejects.toThrow(/no capable ai participants/)
  })

  it('非圆桌成员的 tabId 被拒绝（Renderer 无法伪造身份）', async () => {
    makePage(world, 'intruder-1')
    await expect(service.ask({ prompt: '越权', participantTabIds: ['intruder-1'] })).rejects.toThrow(/not roundtable participants/)
  })

  it('任务进行中页面被关闭：对应参与者立即失败，其他成员不受影响', async () => {
    makePage(world, 'tab-1', { answers: ['活着', '活着'], generating: [true, false, false] })
    makePage(world, 'tab-2', { answers: [], generating: [true, true, true, true, true, true, true, true, true] })

    const running = service.ask({ prompt: '有人退场', participantTabIds: ['tab-1', 'tab-2'] })
    // 让轮询先跑几拍，再关闭 tab-2。
    await new Promise((resolve) => setTimeout(resolve, 30))
    world.closePage('tab-2')
    const { snapshot } = await running

    const byId = Object.fromEntries(snapshot.results.map((item) => [item.tabId, item]))
    expect(byId['tab-1'].state).toBe('completed')
    expect(byId['tab-2'].state).toBe('failed')
    expect(byId['tab-2'].note).toContain('tab closed')
  })

  it('cancelParticipant 只终止一个成员；忙时拒绝新任务', async () => {
    makePage(world, 'tab-1', { answers: [], generating: [true, true, true, true, true, true, true, true, true] })
    makePage(world, 'tab-2', { answers: [], generating: [true, true, true, true, true, true, true, true, true] })

    const running = service.ask({ prompt: '慢慢想', participantTabIds: ['tab-1', 'tab-2'] })
    await expect(service.ask({ prompt: '重复提交', participantTabIds: ['tab-1'] })).rejects.toThrow(/still running/)

    service.cancelParticipant('tab-1')
    const { snapshot } = await running
    const byId = Object.fromEntries(snapshot.results.map((item) => [item.tabId, item]))
    expect(byId['tab-1'].state).toBe('cancelled')
    expect(byId['tab-2'].state).toBe('timeout') // 没人管它，跑到超时
  })

  it('持久化按 tabId 去重：同平台两卡各写一条，metadata 带 tabId', async () => {
    makePage(world, 'tab-1', { answers: ['甲', '甲'], generating: [true, false, false] })
    makePage(world, 'tab-2', { answers: ['乙', '乙'], generating: [true, false, false] })

    const { conversationId, snapshot } = await service.ask({ prompt: '落库', participantTabIds: ['tab-1', 'tab-2'] })
    expect(snapshot.conversationId).toBe(conversationId)

    const messages = selectMessages(handle.db, conversationId)
    const assistant = messages.filter((message) => message.role === 'assistant')
    expect(assistant).toHaveLength(2)
    const metas = assistant.map((message) => JSON.parse(message.metadata) as { tabId: string; displayName: string })
    expect(metas.map((meta) => meta.tabId).sort()).toEqual(['tab-1', 'tab-2'])
    expect(metas.every((meta) => meta.displayName === 'CHATGPT')).toBe(true)
    // provider 列存平台 id（不是 tabId）。
    expect(assistant.every((message) => message.provider === 'chatgpt')).toBe(true)
    // 每张卡只写一次（增量去重）：广播多次也不重复。
    expect(assistant.filter((message) => JSON.parse(message.metadata).tabId === 'tab-1')).toHaveLength(1)
  })

  it('describeParticipants：登录 → 可参与；登录页 → 需要登录；普通网页 → 资料；销毁 → 不可用', async () => {
    makePage(world, 'tab-1')
    makePage(world, 'tab-2', { loginPage: true, loggedIn: false })
    makePage(world, 'tab-3', { url: 'https://github.com/x' })
    makePage(world, 'tab-4')
    world.closePage('tab-4')

    const statuses = await service.describeParticipants(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    const byId = Object.fromEntries(statuses.map((status) => [status.tabId, status]))

    expect(byId['tab-1'].adapted).toBe(true)
    expect(byId['tab-1'].platformName).toBe('ChatGPT')
    expect(byId['tab-1'].login).toBe('logged_in')
    expect(byId['tab-2'].login).toBe('logged_out')
    expect(byId['tab-2'].platformId).toBe('chatgpt')
    expect(byId['tab-3'].platformId).toBeNull()
    expect(byId['tab-3'].adapted).toBe(false)
    expect(byId['tab-4'].login).toBe('unavailable')
  })
})
