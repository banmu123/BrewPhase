import type { AIProvider } from '../automation/types'

/**
 * 平台域名匹配与 E2E 测试接缝（Phase 4.2 起是唯一的实现处；
 * 旧 automation/adapters.ts 从这里 re-export，保持历史测试与行为不变）。
 *
 * 匹配规则是**严格主机名**：精确相等或以其为后缀（`.allowed`），解析失败
 * 一律拒绝——相似域名（`chatgpt.com.evil.io`、`notchatgpt.com`）冒充不了平台。
 *
 * 测试接缝：`BREWPHASE_AI_TEST_HOST=127.0.0.1:<port>` 时，`http://<host>/
 * <platformId>` 前缀也被认作该平台——E2E 用本地夹具页跑真实自动化链路，
 * 不碰外网。生产环境不设置该变量，接缝完全不存在。
 */

/** E2E 测试宿主（127.0.0.1:port）。空串表示生产环境，无接缝。 */
export const AI_TEST_HOST = (process.env.BREWPHASE_AI_TEST_HOST ?? '').trim()

/** 测试宿主下某平台的夹具入口 URL；生产环境返回 null。 */
export function aiTestOrigin(platformId: string, testHost: string = AI_TEST_HOST): string | null {
  if (!testHost) return null
  return `http://${testHost}/${platformId}`
}

/**
 * 纯函数的主机判定（单测直接驱动，不依赖环境变量）：
 * 平台自家域名（精确或子域）+（可选）测试宿主下按段匹配的 `/<platformId>` 前缀。
 */
export function matchesAllowedHost(platformId: string, allowedHosts: readonly string[], url: string, testHost = AI_TEST_HOST): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const onPlatform = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    if (onPlatform) return true
    if (testHost && host === testHost.split(':')[0].toLowerCase()) {
      // 端口也必须一致，避免同宿主其它服务被误认成平台页面；
      // 路径必须按段匹配（/chatgpt2 不能冒充 chatgpt）。
      const port = testHost.split(':')[1] ?? '80'
      const prefix = `/${platformId}`
      const path = parsed.pathname.toLowerCase()
      return parsed.port === port && (path === prefix || path.startsWith(`${prefix}/`))
    }
    return false
  } catch {
    return false
  }
}

/** 兼容旧引用：ChatGPT / Claude 的历史 provider id 列表。 */
export const LEGACY_AI_PROVIDERS: readonly AIProvider[] = ['chatgpt', 'claude']
