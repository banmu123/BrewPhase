import type { AIProvider } from './types'

/**
 * 遗留 Multi-AI（AI Workspace）的 PlatformAdapter 形状。
 *
 * Phase 4.2 起脚本与域名匹配的**唯一实现**迁到 `../adapters/`（Registry +
 * platforms/），本文件只保留旧接口形状并转发——遗留路径（MultiAI / Accounts
 * 组件 + provider 型 TaskCoordinator）行为不变；圆桌的新执行链路
 * （participant-service）不经过这里。
 */

export type PlatformAdapter = {
  provider: AIProvider
  /** 允许自动化的域名（host 精确或以其结尾）。其余一律 unsupported_page。 */
  readonly allowedHosts: readonly string[]
  /** 打开登录 / 主页用的入口地址。 */
  readonly homeURL: string
  /** 页面是否属于本平台（按 URL）。 */
  ownsURL: (url: string) => boolean
  /** 探测：登录态 + 输入框可用性。 */
  probeScript: () => string
  /** 写入问题并提交。返回提交时「已有回答数」作为基线，供完成判定比对。 */
  submitScript: (prompt: string) => string
  /** 轮询：是否在生成 + 最后一条回答文本。 */
  pollScript: () => string
}

// 脚本与域名的唯一实现（测试接缝 BREWPHASE_AI_TEST_HOST 也在那里）。
export {
  aiTestOrigin,
  matchesAllowedHost as ownsProviderURL,
  AI_TEST_HOST
} from '../adapters/host-match'
import { matchesAllowedHost } from '../adapters/host-match'
import { chatgptScripts, CHATGPT_ALLOWED_HOSTS, chatgptAdapter } from '../adapters/platforms/chatgpt'
import { claudeScripts, CLAUDE_ALLOWED_HOSTS, claudeAdapter } from '../adapters/platforms/claude'

const CHATGPT: PlatformAdapter = {
  provider: 'chatgpt',
  allowedHosts: CHATGPT_ALLOWED_HOSTS,
  homeURL: chatgptAdapter.homeURL,
  ownsURL(url) {
    return matchesAllowedHost('chatgpt', this.allowedHosts, url)
  },
  ...chatgptScripts
}

const CLAUDE: PlatformAdapter = {
  provider: 'claude',
  allowedHosts: CLAUDE_ALLOWED_HOSTS,
  homeURL: claudeAdapter.homeURL,
  ownsURL(url) {
    return matchesAllowedHost('claude', this.allowedHosts, url)
  },
  ...claudeScripts
}

export const AI_ADAPTERS: Record<AIProvider, PlatformAdapter> = {
  chatgpt: CHATGPT,
  claude: CLAUDE
}
