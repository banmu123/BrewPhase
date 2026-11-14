import { describe, expect, it } from 'vitest'
import {
  AI_ADAPTERS,
  aiTestOrigin,
  ownsProviderURL,
  type PlatformAdapter
} from '../../src/main/ai-chat/automation/adapters'
import { AI_PROVIDERS } from '../../src/main/ai-chat/automation/types'

/**
 * 平台 Adapter 的硬约束（Phase 4.1.4）：
 * 1. 域名白名单只放平台自家 + （测试接缝的）本地夹具前缀；
 * 2. submitScript 里**基线统计必须在点击发送之前**——AI 响应快时，
 *    基线取晚了会把本轮回答计入旧基线，完成判定就永远不成立；
 * 3. 写入校验存在（input_write_failed）——没写进去就点发送只会重发上一轮；
 * 4. 用户文本只经 JSON.stringify 注入，绝无脚本注入面。
 *
 * 选择器的 DOM 行为由 E2E 本地夹具页在真实 Chromium 里验证；这里守的是
 * 脚本的结构约束，不模拟 DOM。
 */

const DANGEROUS_PROMPT = '"; alert(1); document.write("</script>")'

describe('域名白名单 ownsProviderURL', () => {
  const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com'] as const

  it('平台自家域名与子域名放行', () => {
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, 'https://chatgpt.com/')).toBe(true)
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, 'https://eu.chatgpt.com/c/abc')).toBe(true)
  })

  it('其它平台与陌生域名拒绝', () => {
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, 'https://claude.ai/new')).toBe(false)
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, 'https://evil.example.com/chatgpt.com')).toBe(false)
  })

  it('测试接缝：只认测试宿主的端口与按段路径前缀', () => {
    const host = '127.0.0.1:5177'
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, `http://${host}/chatgpt`, host)).toBe(true)
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, `http://${host}/chatgpt/sub`, host)).toBe(true)
    // 冒名路径 / 同端口但别的平台 / 同宿主但别的端口，都拒绝。
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, `http://${host}/chatgptx`, host)).toBe(false)
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, `http://${host}/claude`, host)).toBe(false)
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, 'http://127.0.0.1:9999/chatgpt', host)).toBe(false)
    // 接缝关闭（无测试宿主）时一律拒绝。
    expect(ownsProviderURL('chatgpt', CHATGPT_HOSTS, `http://${host}/chatgpt`, '')).toBe(false)
  })

  it('aiTestOrigin：夹具入口按平台区分；宿主为空时无接缝', () => {
    expect(aiTestOrigin('chatgpt', '')).toBeNull()
    expect(aiTestOrigin('chatgpt', '127.0.0.1:5177')).toBe('http://127.0.0.1:5177/chatgpt')
    expect(aiTestOrigin('claude', '127.0.0.1:5177')).toBe('http://127.0.0.1:5177/claude')
  })

  it('每个平台拥有独立的 adapter', () => {
    expect(Object.keys(AI_ADAPTERS).sort()).toEqual([...AI_PROVIDERS].sort())
  })
})

describe('submitScript 的提交时序', () => {
  const adapters: Array<[string, PlatformAdapter]> = [
    ['chatgpt', AI_ADAPTERS.chatgpt],
    ['claude', AI_ADAPTERS.claude]
  ]

  for (const [name, adapter] of adapters) {
    it(`${name}：回答基线在点击发送之前统计`, () => {
      const script = adapter.submitScript('问题')
      const baselineAt = script.indexOf('const baseline')
      // HELPERS 里也有 __bpClickFirst 的定义；提交脚本里的**调用**是最后一次出现。
      const clickAt = script.lastIndexOf('__bpClickFirst(')
      expect(baselineAt).toBeGreaterThan(-1)
      expect(clickAt).toBeGreaterThan(baselineAt)
    })

    it(`${name}：写入结果校验存在（没写进去不点发送）`, () => {
      const script = adapter.submitScript('问题')
      expect(script).toContain('input_write_failed')
      expect(script).toContain('__bpNormalize')
    })

    it(`${name}：用户文本经 JSON.stringify 注入，无脚本注入面`, () => {
      const script = adapter.submitScript(DANGEROUS_PROMPT)
      // 唯一允许的出现形式是 JSON 字符串字面量（引号已转义）；
      // 模板拼接漏转义会让原文裸露成代码——这里守住这一点。
      expect(script).toContain(JSON.stringify(DANGEROUS_PROMPT))
    })
  }

  it('probeScript / pollScript 不嵌入用户文本', () => {
    for (const adapter of [AI_ADAPTERS.chatgpt, AI_ADAPTERS.claude]) {
      expect(adapter.probeScript()).not.toContain(DANGEROUS_PROMPT)
      expect(adapter.pollScript()).not.toContain(DANGEROUS_PROMPT)
    }
  })

  it('脚本自包含且永远返回 JSON 对象', () => {
    for (const adapter of [AI_ADAPTERS.chatgpt, AI_ADAPTERS.claude]) {
      expect(adapter.probeScript()).toContain('return {')
      expect(adapter.submitScript('x')).toContain('return {')
      expect(adapter.pollScript()).toContain('return {')
    }
  })

  it('生产环境（无测试宿主）homeURL 指向真实平台', () => {
    // 单测进程没有 BREWPHASE_AI_TEST_HOST；如果 CI 环境意外带了，这个断言提示接缝泄漏。
    expect(AI_ADAPTERS.chatgpt.homeURL).toBe('https://chatgpt.com/')
    expect(AI_ADAPTERS.claude.homeURL).toBe('https://claude.ai/new')
  })
})
