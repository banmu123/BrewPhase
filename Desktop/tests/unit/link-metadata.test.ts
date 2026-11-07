import { describe, expect, it } from 'vitest'
import { parseLink } from '../../src/shared/link-parser'
import {
  assertAllowedUrl,
  isPublicAddress,
  isPublicIPv4,
  isPublicIPv6
} from '../../src/main/metadata/metadata-security'
import {
  extractHtmlMetadata,
  normalizeThumbnail,
  stripHtml
} from '../../src/main/metadata/metadata-normalizer'
import { resolveMetadata, resolveMetadataDeduped } from '../../src/main/metadata/metadata-resolver'
import type { TextFetcher } from '../../src/main/metadata/metadata-normalizer'

/** 可编程 fetcher：按 URL 片段返回 mock 响应，记录调用次数。 */
function mockFetcher(routes: Array<{ match: string; body: string; contentType?: string; finalUrl?: string }>): TextFetcher & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (url: string) => {
    calls.push(url)
    const route = routes.find((entry) => url.includes(entry.match))
    if (!route) throw new Error(`mock: no route for ${url}`)
    return {
      url: route.finalUrl ?? url,
      status: 200,
      contentType: route.contentType ?? 'application/json',
      body: route.body
    }
  }) as unknown as TextFetcher & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

describe('安全层：IP 分类', () => {
  it('IPv4：私有/回环/链路本地/云元数据全部拒绝，公网放行', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
      expect(isPublicIPv4(address), address).toBe(false)
    }
    expect(isPublicIPv4('8.8.8.8')).toBe(true)
    expect(isPublicIPv4('1.1.1.1')).toBe(true)
  })

  it('IPv6：loopback/ULA/link-local/组播拒绝，映射地址按 IPv4 判', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPublicIPv6(address), address).toBe(false)
    }
    expect(isPublicIPv6('2606:4700:4700::1111')).toBe(true)
  })

  it('isPublicAddress 按地址形态分流', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('::1')).toBe(false)
  })
})

describe('安全层：URL 预检', () => {
  it('拒绝 localhost/.local/.internal 与私有 IP 字面量', () => {
    expect(() => assertAllowedUrl('http://localhost:8080/x')).toThrow()
    expect(() => assertAllowedUrl('http://foo.localhost/x')).toThrow()
    expect(() => assertAllowedUrl('http://printer.local/x')).toThrow()
    expect(() => assertAllowedUrl('http://metadata.google.internal/x')).toThrow()
    expect(() => assertAllowedUrl('http://127.0.0.1/x')).toThrow()
    expect(() => assertAllowedUrl('http://192.168.1.10/x')).toThrow()
    expect(() => assertAllowedUrl('http://[::1]/x')).toThrow()
  })

  it('拒绝非 http(s) 协议，公网地址放行', () => {
    expect(() => assertAllowedUrl('javascript:alert(1)')).toThrow()
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow()
    expect(() => assertAllowedUrl('ftp://example.com/x')).toThrow()
    expect(assertAllowedUrl('https://example.com/a?b=1').hostname).toBe('example.com')
  })
})

describe('归一化：HTML 元数据', () => {
  it('OG 优先，twitter/标准 HTML 回退', () => {
    const html = `
      <html><head>
        <title>页面标题</title>
        <meta name="description" content="标准描述">
        <meta property="og:title" content="OG 标题">
        <meta content="https://img.example.com/a.jpg" property="og:image">
        <meta name="og:site_name" content="示例站">
      </head></html>`
    const metadata = extractHtmlMetadata(html)
    expect(metadata.title).toBe('OG 标题')
    expect(metadata.description).toBe('标准描述')
    expect(metadata.image).toBe('https://img.example.com/a.jpg')
    expect(metadata.siteName).toBe('示例站')
  })

  it('没有 OG 时用 title 标签；HTML 实体会解码', () => {
    const metadata = extractHtmlMetadata('<title>咖啡 &amp; 茶</title>')
    expect(metadata.title).toBe('咖啡 & 茶')
    expect(metadata.image).toBeNull()
  })

  it('stripHtml 取纯文本并保留段落换行', () => {
    expect(stripHtml('<p>第一段</p><p>第二段 &amp; 尾巴</p>')).toBe('第一段\n第二段 & 尾巴')
  })

  it('缩略图只接受 https', () => {
    expect(normalizeThumbnail('https://x.com/a.jpg')).toBe('https://x.com/a.jpg')
    expect(normalizeThumbnail('http://x.com/a.jpg')).toBeNull()
    expect(normalizeThumbnail('data:image/png;base64,AA')).toBeNull()
    expect(normalizeThumbnail(null)).toBeNull()
  })
})

describe('GitHub provider（mock API）', () => {
  it('成功：仓库名/描述/语言/stars/forks/license + 官方 og 图', async () => {
    const fetcher = mockFetcher([
      {
        match: 'api.github.com/repos/banmu123/BrewPhase',
        body: JSON.stringify({
          full_name: 'banmu123/BrewPhase',
          description: 'Coffee studio',
          language: 'Swift',
          stargazers_count: 12,
          forks_count: 3,
          license: { spdx_id: 'MIT' },
          owner: { login: 'banmu123' }
        })
      }
    ])
    const resolved = await resolveMetadata(parseLink('https://github.com/banmu123/BrewPhase'), fetcher)
    expect(resolved.status).toBe('success')
    expect(resolved.contentId).toBe('banmu123/BrewPhase')
    expect(resolved.repositoryStars).toBe(12)
    expect(resolved.repositoryForks).toBe(3)
    expect(resolved.repositoryLanguage).toBe('Swift')
    expect(resolved.repositoryLicense).toBe('MIT')
    expect(resolved.thumbnailUrl).toContain('opengraph.githubassets.com')
  })

  it('限流/不存在：保留仓库身份，统计留空，状态 failed 不伪造', async () => {
    const fetcher = mockFetcher([]) // 任何请求都抛错（模拟 403/网络失败）
    const resolved = await resolveMetadata(parseLink('https://github.com/banmu123/BrewPhase'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.contentId).toBe('banmu123/BrewPhase')
    expect(resolved.repositoryStars).toBeNull()
    expect(resolved.repositoryForks).toBeNull()
    expect(resolved.thumbnailUrl).toContain('opengraph.githubassets.com')
  })
})

describe('YouTube provider（mock oEmbed）', () => {
  it('成功：标题/频道/oEmbed 缩略图', async () => {
    const fetcher = mockFetcher([
      {
        match: 'youtube.com/oembed',
        body: JSON.stringify({
          title: 'Coffee Basics',
          author_name: 'James Hoffmann',
          thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
        })
      }
    ])
    const resolved = await resolveMetadata(parseLink('https://youtu.be/dQw4w9WgXcQ'), fetcher)
    expect(resolved.status).toBe('success')
    expect(resolved.title).toBe('Coffee Basics')
    expect(resolved.authorName).toBe('James Hoffmann')
    expect(resolved.thumbnailUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('oEmbed 失败：仍保留官方可构造的缩略图，不伪造标题', async () => {
    const fetcher = mockFetcher([])
    const resolved = await resolveMetadata(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.title).toBeNull()
    expect(resolved.thumbnailUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })
})

describe('Bilibili provider（mock 网页）', () => {
  const html = `<html><head>
    <meta property="og:title" content="手冲咖啡入门_哔哩哔哩_bilibili">
    <meta property="og:image" content="https://i0.hdslb.com/bfs/archive/cover.jpg">
    <meta name="author" content="咖啡师小张">
  </head></html>`

  it('OG 解析：标题去后缀、封面、UP 主', async () => {
    const fetcher = mockFetcher([{ match: 'bilibili.com/video/BV1xx411c7mD', body: html, contentType: 'text/html' }])
    const resolved = await resolveMetadata(parseLink('https://www.bilibili.com/video/BV1xx411c7mD'), fetcher)
    expect(resolved.status).toBe('success')
    expect(resolved.title).toBe('手冲咖啡入门')
    expect(resolved.thumbnailUrl).toBe('https://i0.hdslb.com/bfs/archive/cover.jpg')
    expect(resolved.authorName).toBe('咖啡师小张')
  })

  it('短链：跟随重定向后的最终地址提取 BV 号', async () => {
    const fetcher = mockFetcher([
      {
        match: 'b23.tv/abc',
        body: html,
        contentType: 'text/html',
        finalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy'
      }
    ])
    const resolved = await resolveMetadata(parseLink('https://b23.tv/abc'), fetcher)
    expect(resolved.contentId).toBe('BV1xx411c7mD')
    expect(resolved.title).toBe('手冲咖啡入门')
  })

  it('访问失败：failed，不伪造封面与标题', async () => {
    const fetcher = mockFetcher([])
    const resolved = await resolveMetadata(parseLink('https://www.bilibili.com/video/BV1xx411c7mD'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.title).toBeNull()
    expect(resolved.thumbnailUrl).toBeNull()
  })
})

describe('X provider（mock oEmbed）', () => {
  it('成功：作者名 + 纯文本正文（HTML 被剥离）', async () => {
    const fetcher = mockFetcher([
      {
        match: 'publish.twitter.com/oembed',
        body: JSON.stringify({
          author_name: '半木',
          html: '<blockquote><p>刚烘完一壶耶加雪菲，茉莉花香明显。</p>&mdash; 半木 (@banmu) <a href="https://x.com/banmu/status/1">November 8, 2026</a></blockquote>'
        })
      }
    ])
    const resolved = await resolveMetadata(parseLink('https://x.com/banmu/status/1234567890'), fetcher)
    expect(resolved.status).toBe('success')
    expect(resolved.authorName).toBe('半木')
    expect(resolved.description).toContain('茉莉花香')
    expect(resolved.description).not.toContain('<')
    expect(resolved.description).not.toContain('— 半木')
  })

  it('失败：保留 URL 里解析出的 @作者，正文留空', async () => {
    const fetcher = mockFetcher([])
    const resolved = await resolveMetadata(parseLink('https://x.com/banmu/status/1234567890'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.authorName).toBe('@banmu')
    expect(resolved.description).toBeNull()
  })
})

describe('通用网页 provider', () => {
  it('只有 title 也能成功；没有封面留空', async () => {
    const fetcher = mockFetcher([
      { match: 'blog.example.com', body: '<html><head><title>咖啡品尝入门</title></head></html>', contentType: 'text/html' }
    ])
    const resolved = await resolveMetadata(parseLink('https://blog.example.com/post/1'), fetcher)
    expect(resolved.status).toBe('success')
    expect(resolved.title).toBe('咖啡品尝入门')
    expect(resolved.thumbnailUrl).toBeNull()
    expect(resolved.sourceName).toBe('blog.example.com')
  })

  it('空页面：failed 但保留域名', async () => {
    const fetcher = mockFetcher([{ match: 'blog.example.com', body: '<html></html>', contentType: 'text/html' }])
    const resolved = await resolveMetadata(parseLink('https://blog.example.com/post/1'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.sourceName).toBe('blog.example.com')
  })

  it('抓取异常（超时/超限/非 HTML）：failed 不抛出', async () => {
    const fetcher = mockFetcher([])
    const resolved = await resolveMetadata(parseLink('https://blog.example.com/post/1'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.errorMessage).toBeTruthy()
  })
})

describe('resolver 边界', () => {
  it('无效 URL 直接 failed，不调用 fetcher', async () => {
    const fetcher = mockFetcher([])
    const resolved = await resolveMetadata(parseLink('javascript:alert(1)'), fetcher)
    expect(resolved.status).toBe('failed')
    expect(fetcher.calls).toHaveLength(0)
  })

  it('同 URL 并发只发一次请求（合并）', async () => {
    const fetcher = mockFetcher([
      { match: 'blog.example.com', body: '<title>并发</title>', contentType: 'text/html' }
    ])
    const url = 'https://blog.example.com/dedupe'
    const [first, second] = await Promise.all([
      resolveMetadataDeduped(url, fetcher),
      resolveMetadataDeduped(url, fetcher)
    ])
    expect(first.title).toBe('并发')
    expect(second.title).toBe('并发')
    expect(fetcher.calls).toHaveLength(1)
  })
})
