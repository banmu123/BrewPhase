import { describe, expect, it } from 'vitest'
import { parseLink } from '../../src/shared/link-parser'
import { resolveMetadata } from '../../src/main/metadata/metadata-resolver'
import type { ResolvedLinkMetadata } from '../../src/main/metadata/metadata-normalizer'

/**
 * 真实网络 smoke（§第四轮 六）。
 *
 * **不参与普通测试**：只有 `METADATA_LIVE_SMOKE=1` + `pnpm test:live` 才跑。
 * 目的不是替代 mock 单测，而是回答「这套安全网络层在真实网络上到底通不通」——
 * 单测全绿也可能因为 lookup/证书/UA/地区限制而全线抓不到。
 *
 * 约束：
 * - 只用公开、无需登录的地址；不带 Cookie / Authorization（安全层本来就不发）；
 * - 不碰用户数据库与媒体目录（这里只调 resolveMetadata，纯函数 + 网络）；
 * - 平台接口有波动：YouTube / Bilibili / X 只做「成功或优雅降级」的断言，
 *   真正硬性要求的是 GitHub 与普通网页两条主路径；
 * - 失败时打印可读原因（不含任何凭据——本来就没有）。
 */

const enabled = process.env.METADATA_LIVE_SMOKE === '1'

/** 把抓取层的技术错误翻成一句能指导排查的话（只在 smoke 输出里用）。 */
function hintFor(message: string | undefined): string {
  const text = message ?? ''
  if (text.includes('blocked private address')) {
    return '目标域名被解析到内网地址并被安全层拦截——若你开着 VPN/代理的分流 DNS（api.github.com → 127.0.0.1），这是预期行为，请关掉代理再跑'
  }
  if (text.includes('request timeout')) return '连接或读取超时（网络不可达，或站点在该地区被限制）'
  if (text.includes('ENOTFOUND')) return '域名解析失败（域名不存在 / DNS 不可用）'
  if (text.includes('content-type not allowed')) return '返回内容类型不在白名单（可能需要登录或被风控拦截）'
  if (text.includes('unexpected status')) return 'HTTP 状态非 2xx（可能是限流 / 需要登录 / 页面不存在）'
  return ''
}

function log(label: string, resolved: ResolvedLinkMetadata): void {
  const detail =
    resolved.status === 'success'
      ? `title=${JSON.stringify(resolved.title)}`
      : `error=${JSON.stringify(resolved.errorMessage ?? 'unknown')}`
  const hint = resolved.status === 'failed' ? hintFor(resolved.errorMessage) : ''
  // eslint-disable-next-line no-console
  console.info(`[live] ${label}: ${resolved.status} · ${detail}${hint ? `\n        ↳ ${hint}` : ''}`)
}

/** 平台接口可能被地区/风控拦：只要求「不抛错、形状正确、失败有原因」。 */
async function softResolve(
  label: string,
  url: string,
  allowed: ResolvedLinkMetadata['provider'][]
): Promise<ResolvedLinkMetadata> {
  const parsed = parseLink(url)
  expect(parsed.valid, `${label}: 本地解析失败`).toBe(true)
  expect(allowed, `${label}: provider 识别错误 → ${parsed.provider}`).toContain(parsed.provider)
  const resolved = await resolveMetadata(parsed)
  log(label, resolved)
  expect(['success', 'failed']).toContain(resolved.status)
  if (resolved.status === 'failed') {
    expect(resolved.errorMessage, `${label}: 失败必须带原因`).toBeTruthy()
    expect(resolved.repositoryStars, `${label}: 失败时不得伪造统计`).toBeNull()
  } else {
    expect(resolved.title, `${label}: 成功必须有标题`).toBeTruthy()
  }
  return resolved
}

describe.skipIf(!enabled)('真实网络 smoke（METADATA_LIVE_SMOKE=1）', () => {
  it('普通网页：example.com 的 OG/HTML 元数据', async () => {
    const resolved = await resolveMetadata(parseLink('https://example.com/'))
    log('generic/example.com', resolved)
    expect(resolved.status).toBe('success')
    expect(resolved.title?.toLowerCase()).toContain('example')
  })

  it('GitHub 公开仓库 API', async () => {
    const resolved = await resolveMetadata(parseLink('https://github.com/microsoft/vscode'))
    log('github/microsoft-vscode', resolved)
    expect(resolved.status).toBe('success')
    expect(resolved.title).toBeTruthy()
    expect(typeof resolved.repositoryStars).toBe('number')
    expect(resolved.repositoryLanguage).toBeTruthy()
  })

  it('GitHub Gist 公开 API（§第四轮 五）', async () => {
    const resolved = await resolveMetadata(parseLink('https://gist.github.com/octocat/6cad326836d38bd3a7ae'))
    log('github-gist/octocat', resolved)
    // 公开 Gist 可能被删：允许 failed，但失败也要有原因、不伪造
    if (resolved.status === 'failed') {
      expect(resolved.errorMessage).toBeTruthy()
      expect(resolved.repositoryStars).toBeNull()
    } else {
      expect(resolved.title).toBeTruthy()
      expect(resolved.sourceName).toBe('GitHub Gist')
      expect(resolved.repositoryStars).toBeNull()
    }
  })

  it('YouTube 公开 oEmbed（地区/风控可能拦，允许优雅降级）', async () => {
    await softResolve('youtube/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', ['youtube'])
  })

  it('Bilibili 视频页 OG（允许优雅降级）', async () => {
    await softResolve('bilibili/BV1GJ411x7h7', 'https://www.bilibili.com/video/BV1GJ411x7h7', ['bilibili'])
  })

  it('X 公开 oEmbed（允许优雅降级）', async () => {
    await softResolve('x/jack-status-20', 'https://x.com/jack/status/20', ['x'])
  })

  it('失败降级：不存在的域名不抛错、状态为 failed 且无伪造数据', async () => {
    const resolved = await resolveMetadata(parseLink('https://this-domain-should-not-exist-brewphase.invalid/'))
    log('failure/unknown-domain', resolved)
    expect(resolved.status).toBe('failed')
    expect(resolved.errorMessage).toBeTruthy()
    expect(resolved.thumbnailUrl).toBeNull()
    expect(resolved.repositoryStars).toBeNull()
  })
})
