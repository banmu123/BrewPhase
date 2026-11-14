import type { AIPlatformDescriptor } from './types'
import { AIAdapterRegistry } from './registry'
import { claudeAdapter, CLAUDE_ALLOWED_HOSTS } from './platforms/claude'
import { chatgptAdapter, CHATGPT_ALLOWED_HOSTS } from './platforms/chatgpt'
import { platformMatcher } from './registry'

/**
 * 平台目录（Phase 4.2）：所有「认识」的 AI 平台都在这里登记。
 *
 * - ChatGPT / Claude：**已适配**（adapter 就绪），是本阶段仅有的两条
 *   真实自动化路径。
 * - Gemini / Grok / DeepSeek：**只登记描述符，不提供 adapter**——识别出
 *   这类网页时 UI 明确显示「已识别 · 尚未适配」，绝不假装能自动提问。
 *   未来接入新平台 = 在 platforms/ 下加一个 adapter + 在这里登记一行，
 *   圆桌核心与调度器零改动。
 */
export const AI_PLATFORM_CATALOG: AIPlatformDescriptor[] = [
  {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    matches: platformMatcher('chatgpt', CHATGPT_ALLOWED_HOSTS),
    adapter: chatgptAdapter
  },
  {
    id: 'claude',
    displayName: 'Claude',
    matches: platformMatcher('claude', CLAUDE_ALLOWED_HOSTS),
    adapter: claudeAdapter
  },
  // —— 已识别、尚未适配（本阶段明确不做自动化，见规格 §13）——
  {
    id: 'gemini',
    displayName: 'Gemini',
    matches: platformMatcher('gemini', ['gemini.google.com'])
  },
  {
    id: 'grok',
    displayName: 'Grok',
    matches: platformMatcher('grok', ['grok.com', 'x.com'])
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    matches: platformMatcher('deepseek', ['chat.deepseek.com'])
  }
]

/** 生产用的默认注册中心：目录全量注册。 */
export function createDefaultRegistry(): AIAdapterRegistry {
  const registry = new AIAdapterRegistry()
  for (const descriptor of AI_PLATFORM_CATALOG) {
    registry.register(descriptor)
  }
  return registry
}
