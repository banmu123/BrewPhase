import type { FetchResult } from './metadata-security'
import type { TextFetcher } from './metadata-normalizer'

/**
 * 自动化测试专用的元数据夹具（`BREWPHASE_METADATA_FIXTURE=1` 时启用）。
 *
 * E2E 要求「所有外部站点请求必须 mock，不依赖真实公网」——而元数据抓取发生在
 * **主进程**，Playwright 的 `page.route` 拦不到。所以留一个显式的环境开关：
 * 打开后 GitHub 仓库 API 返回固定响应，其余地址一律失败（验证优雅降级）。
 *
 * 生产运行不会设置这个变量；真机/真实用户路径仍然走 `safeFetchText`
 * （DNS 连接级校验 + 逐跳重定向校验，强度不变）。
 */
export function activeMetadataFixture(): TextFetcher | undefined {
  if (process.env.BREWPHASE_METADATA_FIXTURE !== '1') return undefined
  return async (url: string): Promise<FetchResult> => {
    const parsed = new URL(url)
    if (parsed.hostname === 'api.github.com') {
      const match = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/)
      if (match) {
        const [, owner, repo] = match
        return {
          url,
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            full_name: `${owner}/${repo}`,
            description: 'Fixture coffee studio',
            language: 'Swift',
            stargazers_count: 42,
            forks_count: 7,
            license: { spdx_id: 'MIT' },
            owner: { login: owner }
          })
        }
      }
    }
    // 其他地址一律当作抓取失败：测试「失败降级」而不是伪造成功
    throw new Error(`fixture: no route for ${parsed.hostname}${parsed.pathname}`)
  }
}
