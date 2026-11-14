import { describe, expect, it } from 'vitest'
import { AIAdapterRegistry, platformMatcher } from '../../src/main/ai-chat/adapters/registry'
import { createDefaultRegistry } from '../../src/main/ai-chat/adapters/platform-catalog'
import { matchesAllowedHost } from '../../src/main/ai-chat/adapters/host-match'
import type { AIPlatformDescriptor } from '../../src/main/ai-chat/adapters/types'

/**
 * Registry 的识别边界（Phase 4.2）：
 * 1. 严格主机名匹配——精确或子域后缀，相似域名冒充不了平台；
 * 2. 「已识别」≠「可自动交互」——未适配平台绝不能拿到 adapter；
 * 3. 普通网页返回 null，不误识别。
 */

describe('AIAdapterRegistry：URL 识别', () => {
  it('createDefaultRegistry：ChatGPT 与 Claude 正确识别（含子域）', () => {
    const registry = createDefaultRegistry()

    const gpt = registry.resolve('https://chatgpt.com/c/abc')
    expect(gpt?.descriptor.id).toBe('chatgpt')
    expect(gpt?.adapter).toBeDefined()

    const gptSub = registry.resolve('https://eu.chatgpt.com/c/abc')
    expect(gptSub?.descriptor.id).toBe('chatgpt')

    const claude = registry.resolve('https://claude.ai/new')
    expect(claude?.descriptor.id).toBe('claude')
    expect(claude?.adapter).toBeDefined()
  })

  it('相似域名 / 恶意拼接 / 非 http 页面不能冒充平台', () => {
    const registry = createDefaultRegistry()
    expect(registry.resolve('https://chatgpt.com.evil.io/')).toBeNull()
    expect(registry.resolve('https://notchatgpt.com/')).toBeNull()
    expect(registry.resolve('https://evil.example.com/?url=chatgpt.com')).toBeNull()
    expect(registry.resolve('file:///C:/chatgpt.html')).toBeNull()
    expect(registry.resolve('不是 URL')).toBeNull()
  })

  it('已识别但未适配的平台：有描述符、没有 adapter（绝不伪装可用）', () => {
    const registry = createDefaultRegistry()
    const gemini = registry.resolve('https://gemini.google.com/app')
    expect(gemini?.descriptor.id).toBe('gemini')
    expect(gemini?.descriptor.displayName).toBe('Gemini')
    expect(gemini?.adapter).toBeUndefined()
    expect(registry.isAdapted('gemini')).toBe(false)
    expect(registry.isAdapted('chatgpt')).toBe(true)
  })

  it('普通网页（GitHub 等）不会被误识别', () => {
    const registry = createDefaultRegistry()
    expect(registry.resolve('https://github.com/banmu123/BrewPhase')).toBeNull()
    expect(registry.resolve('https://youtube.com/watch?v=1')).toBeNull()
  })

  it('register / unregister / get / has：开放扩展，重复注册被拒', () => {
    const registry = new AIAdapterRegistry()
    const descriptor: AIPlatformDescriptor = {
      id: 'testai',
      displayName: 'TestAI',
      matches: platformMatcher('testai', ['testai.example'])
    }
    expect(registry.has('testai')).toBe(false)
    registry.register(descriptor)
    expect(registry.has('testai')).toBe(true)
    expect(registry.get('testai')?.displayName).toBe('TestAI')
    expect(() => registry.register(descriptor)).toThrow(/already registered/)
    registry.unregister('testai')
    expect(registry.has('testai')).toBe(false)
  })

  it('测试接缝：按段匹配与端口校验（matchesAllowedHost 的显式宿主参数）', () => {
    const host = '127.0.0.1:5177'
    expect(matchesAllowedHost('chatgpt', ['chatgpt.com'], `http://${host}/chatgpt`, host)).toBe(true)
    expect(matchesAllowedHost('chatgpt', ['chatgpt.com'], `http://${host}/chatgpt/sub`, host)).toBe(true)
    expect(matchesAllowedHost('chatgpt', ['chatgpt.com'], `http://${host}/chatgptx`, host)).toBe(false)
    expect(matchesAllowedHost('chatgpt', ['chatgpt.com'], `http://${host}/claude`, host)).toBe(false)
    expect(matchesAllowedHost('chatgpt', ['chatgpt.com'], 'http://127.0.0.1:9999/chatgpt', host)).toBe(false)
    // 接缝关闭（无测试宿主）时一律拒绝。
    expect(matchesAllowedHost('chatgpt', ['chatgpt.com'], `http://${host}/chatgpt`, '')).toBe(false)
  })
})
