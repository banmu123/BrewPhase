import { describe, expect, it } from 'vitest'
import { parseLink } from '../../src/shared/link-parser'
import {
  assertAllowedUrl,
  createGuardedLookup,
  ipv4FromMappedIPv6,
  isPublicAddress,
  isPublicIPv4,
  isPublicIPv6,
  safeFetchText,
  type RequestOnce
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

describe('安全层：DNS 校验与重定向（注入）', () => {
  const OPTS = { accept: 'text/html', maxBytes: 1024, allowedTypes: ['text/html'] }

  it('DNS 返回私有 IP → 连接被拒（DNS rebinding 语义：校验的就是实际连接 IP）', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => {
      callback(null, [{ address: '10.0.0.8', family: 4 }])
    })
    await expect(
      new Promise((resolve, reject) => {
        guarded('evil.example', { all: true }, (error, address) => (error ? reject(error) : resolve(address)))
      })
    ).rejects.toThrow('blocked private address')
  })

  it('DNS 混合私有与公网 → 只回填公网地址', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => {
      callback(null, [
        { address: '192.168.1.2', family: 4 },
        { address: '93.184.216.34', family: 4 }
      ])
    })
    const address = await new Promise<string>((resolve, reject) => {
      guarded('mixed.example', { all: false }, (error, resolved) =>
        error ? reject(error) : resolve(String(resolved))
      )
    })
    expect(address).toBe('93.184.216.34')
  })

  it('DNS 只有 IPv6 loopback → 拒绝', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => {
      callback(null, [{ address: '::1', family: 6 }])
    })
    await expect(
      new Promise((resolve, reject) => {
        guarded('v6.example', { all: true }, (error, address) => (error ? reject(error) : resolve(address)))
      })
    ).rejects.toThrow('blocked private address')
  })

  it('重定向到私有 IP → 第二跳预检拒绝', async () => {
    const fakeRequest: RequestOnce = async () => ({
      status: 301,
      headers: { location: 'http://127.0.0.1/admin' },
      body: Buffer.alloc(0)
    })
    await expect(safeFetchText('https://example.com/start', OPTS, fakeRequest)).rejects.toThrow(
      'private address blocked'
    )
  })

  it('重定向到 localhost 域名 → 拒绝', async () => {
    const fakeRequest: RequestOnce = async () => ({
      status: 302,
      headers: { location: 'http://localhost:47821/api/status' },
      body: Buffer.alloc(0)
    })
    await expect(safeFetchText('https://example.com/start', OPTS, fakeRequest)).rejects.toThrow('host not allowed')
  })

  it('超过 3 次重定向 → too many redirects', async () => {
    const fakeRequest: RequestOnce = async (url) => ({
      status: 302,
      headers: { location: `https://example.com/hop-${url.pathname.length}` },
      body: Buffer.alloc(0)
    })
    await expect(safeFetchText('https://example.com/a', OPTS, fakeRequest)).rejects.toThrow('too many redirects')
  })

  it('3xx 但缺少 Location → 明确报错', async () => {
    const fakeRequest: RequestOnce = async () => ({ status: 302, headers: {}, body: Buffer.alloc(0) })
    await expect(safeFetchText('https://example.com/a', OPTS, fakeRequest)).rejects.toThrow('redirect without location')
  })

  it('相对 Location 按当前地址解析，且逐跳重新校验', async () => {
    let calls = 0
    const fakeRequest: RequestOnce = async () => {
      calls += 1
      if (calls === 1) {
        return { status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) }
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>ok</title>') }
    }
    const result = await safeFetchText('https://example.com/first', OPTS, fakeRequest)
    expect(result.url).toBe('https://example.com/next')
    expect(result.body).toContain('ok')
  })

  it('Content-Type 不在白名单 → 拒绝（非 HTML 不解析）', async () => {
    const fakeRequest: RequestOnce = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}')
    })
    await expect(safeFetchText('https://example.com/a', OPTS, fakeRequest)).rejects.toThrow('content-type not allowed')
  })
})

describe('DNS lookup 回调契约（§第三轮 1）', () => {
  const addresses = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]

  function invoke(lookupFn: ReturnType<typeof createGuardedLookup>, all: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      ;(lookupFn as unknown as (host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => void)(
        'example.com',
        all ? { all: true } : {},
        (error: unknown, second: unknown, third: unknown) => {
          if (error) reject(error)
          else resolve(all ? second : { address: second, family: third })
        }
      )
    })
  }

  it('options.all === true → 返回 {address, family} 数组（autoSelectFamily 契约）', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => callback(null, addresses))
    const result = (await invoke(guarded, true)) as Array<{ address: string; family: number }>
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual(addresses)
  })

  it('options.all !== true → 返回单个地址 + family', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => callback(null, addresses))
    const result = (await invoke(guarded, false)) as { address: string; family: number }
    expect(result.address).toBe('93.184.216.34')
    expect(result.family).toBe(4)
  })

  it('DNS 失败：两种模式都把错误传出去', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => callback(new Error('nxdomain'), []))
    await expect(invoke(guarded, true)).rejects.toThrow('nxdomain')
    await expect(invoke(guarded, false)).rejects.toThrow('nxdomain')
  })

  it('全部地址私有：两种模式都报 blocked private address', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) =>
      callback(null, [{ address: '192.168.1.9', family: 4 }])
    )
    await expect(invoke(guarded, true)).rejects.toThrow('blocked private address')
    await expect(invoke(guarded, false)).rejects.toThrow('blocked private address')
  })

  it('all:true 时只回填安全地址（私有项被过滤）', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) =>
      callback(null, [
        { address: '10.0.0.2', family: 4 },
        { address: '93.184.216.34', family: 4 }
      ])
    )
    const result = (await invoke(guarded, true)) as Array<{ address: string }>
    expect(result.map((entry) => entry.address)).toEqual(['93.184.216.34'])
  })
})

describe('IPv4-mapped IPv6 绕过（§第三轮 2）', () => {
  it('点分与十六进制映射都按 IPv4 规则拒绝私有地址', () => {
    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:7f00:1'
    ]) {
      expect(isPublicIPv6(address), address).toBe(false)
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('公网映射地址通过（十六进制与点分一致）', () => {
    expect(ipv4FromMappedIPv6('::ffff:7f00:1')).toBe('127.0.0.1')
    expect(ipv4FromMappedIPv6('::ffff:808:808')).toBe('8.8.8.8')
    expect(isPublicIPv6('::ffff:8.8.8.8')).toBe(true)
    expect(isPublicIPv6('::ffff:808:808')).toBe(true)
  })

  it('URL 直接使用映射地址 → 预检拒绝', () => {
    expect(() => assertAllowedUrl('http://[::ffff:7f00:1]/x')).toThrow()
    expect(() => assertAllowedUrl('http://[::ffff:127.0.0.1]/x')).toThrow()
    expect(() => assertAllowedUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data')).toThrow()
  })

  it('DNS 返回映射地址 → 连接被拒', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) =>
      callback(null, [{ address: '::ffff:7f00:1', family: 6 }])
    )
    await expect(
      new Promise((resolve, reject) => {
        guarded('rebind.example', { all: true }, (error, address) => (error ? reject(error) : resolve(address)))
      })
    ).rejects.toThrow('blocked private address')
  })
})

describe('相对 OG 图片（§第三轮 4）', () => {
  it('相对/协议相对地址按最终 URL 解析成 https', () => {
    expect(normalizeThumbnail('/images/cover.jpg', 'https://blog.example.com/post/1')).toBe(
      'https://blog.example.com/images/cover.jpg'
    )
    expect(normalizeThumbnail('//cdn.example.com/a.jpg', 'https://blog.example.com/post/1')).toBe(
      'https://cdn.example.com/a.jpg'
    )
    expect(normalizeThumbnail('cover.jpg', 'https://blog.example.com/post/1')).toBe(
      'https://blog.example.com/post/cover.jpg'
    )
  })

  it('base 是 http 时相对图仍是 http → 拒绝；data: 拒绝', () => {
    expect(normalizeThumbnail('/a.jpg', 'http://blog.example.com/post/1')).toBeNull()
    expect(normalizeThumbnail('data:image/png;base64,AA', 'https://blog.example.com/')).toBeNull()
  })

  it('generic provider 用最终 URL 解析相对 og:image', async () => {
    const fetcher = mockFetcher([
      {
        match: 'blog.example.com',
        body: '<meta property="og:image" content="/images/cover.jpg"><title>相对图</title>',
        contentType: 'text/html'
      }
    ])
    const resolved = await resolveMetadata(parseLink('https://blog.example.com/post/1'), fetcher)
    expect(resolved.thumbnailUrl).toBe('https://blog.example.com/images/cover.jpg')
  })
})

describe('IPv6 特殊用途地址（§第四轮 一，IANA 登记段）', () => {
  const BLOCKED = [
    ['::', '未指定'],
    ['::1', 'loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback（十六进制）'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback（点分）'],
    ['64:ff9b::1', '64:ff9b::/96 NAT64 WKP'],
    ['64:ff9b:1::1', '64:ff9b:1::/48 本地 NAT64（RFC 8215）'],
    ['64:ff9b:1:ffff::abcd', '本地 NAT64 段内'],
    ['100::1', '100::/64 discard-only'],
    ['100::ffff:ffff:ffff:ffff', 'discard-only 段末'],
    ['2001::1', '2001::/23 Teredo 段'],
    ['2001:0:ffff::1', '2001::/23 段内'],
    ['2001:1ff:ffff::1', '2001::/23 段边界内'],
    ['2001:2::1', '2001:2::/48 benchmarking'],
    ['2001:10::1', 'ORCHID'],
    ['2001:20::1', 'ORCHIDv2'],
    ['2001:db8::1', '2001:db8::/32 文档'],
    ['2002::1', '2002::/16 6to4'],
    ['2002:7f00:1::1', '6to4 内嵌 127.0.0.1'],
    ['3fff::1', '3fff::/20 文档'],
    ['3fff:0fff:ffff::1', '3fff::/20 段边界内'],
    ['fc00::1', 'ULA fc00::/7'],
    ['fd12:3456:789a::1', 'ULA fd00::/8'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local + zone id'],
    ['febf:ffff::1', 'link-local 段末'],
    ['ff02::1', '组播'],
    ['5f00::1', '5f00::/16 SRv6 SIDs'],
    ['fec0::1', '废弃的 site-local fec0::/10']
  ] as const

  it('特殊用途/非全球单播地址全部拒绝', () => {
    for (const [address, note] of BLOCKED) {
      expect(isPublicAddress(address), `${address} (${note})`).toBe(false)
      expect(isPublicIPv6(address), `${address} (${note})`).toBe(false)
    }
  })

  it('正常公网 IPv6 放行（不误伤 2001:4860::、2606:4700:: 等）', () => {
    const PUBLIC = [
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '2a00:1450:4001:80b::200e',
      '2400:cb00::1',
      '2606:4700:4700:0000:0000:0000:0000:1111',
      '2a03:2880:f10c:83:face:b00c:0:25de'
    ]
    for (const address of PUBLIC) expect(isPublicIPv6(address), address).toBe(true)
  })

  it('2001::/23 与 2001:db8::/32 的边界两侧判定正确', () => {
    // 2001::/23 段内（第二组 ≤ 0x01ff）→ 拒绝
    expect(isPublicIPv6('2001:0:0:0:0:0:0:1')).toBe(false)
    expect(isPublicIPv6('2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(false)
    // 段外（第二组 ≥ 0x0200）→ 放行，且 2001:db8::/32 单独拒绝
    expect(isPublicIPv6('2001:200::1')).toBe(true)
    expect(isPublicIPv6('2001:db8::1')).toBe(false)
    expect(isPublicIPv6('2001:dba::1')).toBe(true)
    // 3fff::/20 文档段的边界（第二组 > 0x0fff 即段外）
    expect(isPublicIPv6('3fff:0fff:ffff::1')).toBe(false)
    expect(isPublicIPv6('3fff:1000::1')).toBe(true)
    // 2000::/3 边界
    expect(isPublicIPv6('2000:ffff::1')).toBe(true)
    expect(isPublicIPv6('4000::1')).toBe(false)
    expect(isPublicIPv6('1fff::1')).toBe(false)
  })

  it('URL 字面量预检：特殊用途 IPv6 直接拒绝', () => {
    for (const url of [
      'http://[::1]/',
      'http://[::ffff:7f00:1]/',
      'http://[64:ff9b:1::1]/x',
      'http://[64:ff9b::a00:1]/x',
      'http://[100::1]/',
      'http://[2001:db8::1]/',
      'http://[2002:7f00:1::]/',
      'http://[fd00::1]/'
    ]) {
      expect(() => assertAllowedUrl(url), url).toThrow('private address blocked')
    }
    // 正常公网 IPv6 字面量仍可访问
    expect(assertAllowedUrl('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]')
  })

  it('DNS 返回特殊用途 IPv6 → 连接被拒（与 URL 预检同一套规则）', async () => {
    for (const address of ['64:ff9b:1::1', '2001:db8::1', '2002::1', '100::1']) {
      const guarded = createGuardedLookup((_host, _opts, callback) =>
        callback(null, [{ address, family: 6 }])
      )
      await expect(
        new Promise((resolve, reject) => {
          guarded('rebind.example', { all: true }, (error, result) =>
            error ? reject(error) : resolve(result)
          )
        }),
        address
      ).rejects.toThrow('blocked private address')
    }
  })

  it('重定向目标为特殊用途 IPv6 → 第二跳预检拒绝', async () => {
    const fakeRequest: RequestOnce = async () => ({
      status: 302,
      headers: { location: 'http://[64:ff9b:1::1]/internal' },
      body: Buffer.alloc(0)
    })
    await expect(
      safeFetchText('https://example.com/start', { accept: 'text/html', maxBytes: 1024, allowedTypes: ['text/html'] }, fakeRequest)
    ).rejects.toThrow('private address blocked')
  })

  it('IPv4-mapped 的十六进制/点分/完整写法统一按 IPv4 规则', () => {
    expect(ipv4FromMappedIPv6('::ffff:7f00:1')).toBe('127.0.0.1')
    expect(ipv4FromMappedIPv6('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(ipv4FromMappedIPv6('0:0:0:0:0:ffff:7f00:1')).toBe('127.0.0.1')
    expect(ipv4FromMappedIPv6('::ffff:a9fe:a9fe')).toBe('169.254.169.254')
    expect(isPublicIPv6('::ffff:a9fe:a9fe')).toBe(false)
    expect(isPublicIPv6('::ffff:808:808')).toBe(true)
    expect(ipv4FromMappedIPv6('2001:4860::1')).toBeNull()
  })
})

describe('GitHub Gist 元数据（§第四轮 五）', () => {
  const gistUrl = 'https://gist.github.com/banmu123/aa11bb22cc33dd44ee55ff6677889900'

  it('解析出 gist 身份（不是 owner/repo），并走 Gist API', async () => {
    const parsed = parseLink(gistUrl)
    expect(parsed.provider).toBe('github')
    expect(parsed.subresource).toBe('gist')
    expect(parsed.contentId).toBe('aa11bb22cc33dd44ee55ff6677889900')
    expect(parsed.repositoryOwner).toBeNull()

    const fetcher = mockFetcher([
      {
        match: 'api.github.com/gists/',
        body: JSON.stringify({
          id: 'aa11bb22cc33dd44ee55ff6677889900',
          description: '一个 SQL 片段',
          files: { 'query.sql': {}, 'notes.md': {} },
          owner: { login: 'banmu123' }
        })
      }
    ])
    const resolved = await resolveMetadata(parsed, fetcher)
    expect(fetcher.calls[0]).toContain('api.github.com/gists/aa11bb22cc33dd44ee55ff6677889900')
    expect(resolved.status).toBe('success')
    expect(resolved.title).toBe('一个 SQL 片段')
    expect(resolved.description).toBe('query.sql · notes.md')
    expect(resolved.authorName).toBe('banmu123')
    expect(resolved.sourceName).toBe('GitHub Gist')
    // Gist 没有这些指标，也没有可靠封面 → 留空，绝不复用仓库字段
    expect(resolved.repositoryStars).toBeNull()
    expect(resolved.repositoryForks).toBeNull()
    expect(resolved.repositoryLanguage).toBeNull()
    expect(resolved.thumbnailUrl).toBeNull()
  })

  it('无描述 → 用文件名当标题（可用信息，不是编造）', async () => {
    const fetcher = mockFetcher([
      {
        match: 'api.github.com/gists/',
        body: JSON.stringify({ files: { 'brew.md': {} }, owner: { login: 'someone' } })
      }
    ])
    const resolved = await resolveMetadata(parseLink(gistUrl), fetcher)
    expect(resolved.status).toBe('success')
    expect(resolved.title).toBe('brew.md')
    expect(resolved.description).toBeNull()
  })

  it('Gist API 失败（限流/不存在）→ failed 但保留身份，不伪造数据', async () => {
    const fetcher = (async () => {
      throw new Error('unexpected status 403')
    }) as unknown as TextFetcher
    const resolved = await resolveMetadata(parseLink(gistUrl), fetcher)
    expect(resolved.status).toBe('failed')
    expect(resolved.contentId).toBe('aa11bb22cc33dd44ee55ff6677889900')
    expect(resolved.errorMessage).toContain('403')
    expect(resolved.thumbnailUrl).toBeNull()
  })
})
