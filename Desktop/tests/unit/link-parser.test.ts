import { describe, expect, it } from 'vitest'
import { parseLink, providerLabel } from '../../src/shared/link-parser'

describe('GitHub', () => {
  it('仓库首页与 www 变体', () => {
    const parsed = parseLink('https://github.com/banmu123/BrewPhase')
    expect(parsed.valid).toBe(true)
    expect(parsed.provider).toBe('github')
    expect(parsed.contentId).toBe('banmu123/BrewPhase')
    expect(parsed.repositoryOwner).toBe('banmu123')
    expect(parsed.repositoryName).toBe('BrewPhase')
    expect(parsed.subresource).toBe('repo')
    expect(parseLink('https://www.github.com/banmu123/BrewPhase').contentId).toBe('banmu123/BrewPhase')
  })

  it('子页面区分：tree / issues / pull 不当作仓库首页', () => {
    expect(parseLink('https://github.com/banmu123/BrewPhase/tree/main').subresource).toBe('tree')
    expect(parseLink('https://github.com/banmu123/BrewPhase/issues/123').subresource).toBe('issues')
    expect(parseLink('https://github.com/banmu123/BrewPhase/pull/7').subresource).toBe('pull')
    // 子页面仍带仓库身份
    expect(parseLink('https://github.com/banmu123/BrewPhase/issues/123').contentId).toBe('banmu123/BrewPhase')
  })

  it('gist 与非仓库页面', () => {
    const gist = parseLink('https://gist.github.com/banmu/abc123')
    expect(gist.provider).toBe('github')
    expect(gist.subresource).toBe('gist')
    const home = parseLink('https://github.com/explore')
    expect(home.provider).toBe('github')
    expect(home.contentId).toBeNull()
  })
})

describe('YouTube', () => {
  it('watch / youtu.be / shorts / embed / nocookie', () => {
    expect(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ').contentId).toBe('dQw4w9WgXcQ')
    expect(parseLink('https://youtu.be/dQw4w9WgXcQ').contentId).toBe('dQw4w9WgXcQ')
    expect(parseLink('https://youtube.com/shorts/dQw4w9WgXcQ').contentId).toBe('dQw4w9WgXcQ')
    expect(parseLink('https://youtube.com/embed/dQw4w9WgXcQ').contentId).toBe('dQw4w9WgXcQ')
    expect(parseLink('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ').contentId).toBe('dQw4w9WgXcQ')
  })

  it('缺视频 ID 时仍是 YouTube 但 contentId 为空', () => {
    expect(parseLink('https://www.youtube.com/feed/subscriptions').contentId).toBeNull()
  })
})

describe('Bilibili', () => {
  it('BV / av / read / b23 短链', () => {
    expect(parseLink('https://www.bilibili.com/video/BV1xx411c7mD').contentId).toBe('BV1xx411c7mD')
    expect(parseLink('https://bilibili.com/video/av170001').contentId).toBe('av170001')
    expect(parseLink('https://www.bilibili.com/read/cv123456').contentId).toBe('cv123456')
    const short = parseLink('https://b23.tv/abcdefg')
    expect(short.provider).toBe('bilibili')
    expect(short.shortLink).toBe(true)
    expect(short.contentId).toBeNull()
  })
})

describe('X', () => {
  it('x.com 与 twitter.com 的动态，提取作者与动态 ID', () => {
    const x = parseLink('https://x.com/banmu/status/1234567890123456789')
    expect(x.provider).toBe('x')
    expect(x.contentId).toBe('1234567890123456789')
    expect(x.authorHint).toBe('banmu')
    expect(parseLink('https://twitter.com/banmu/status/1234567890123456789').provider).toBe('x')
  })
})

describe('通用网页与非法输入', () => {
  it('普通网页归 generic 且 valid', () => {
    const parsed = parseLink('https://blog.example.com/post/1?utm_source=x&id=7')
    expect(parsed.valid).toBe(true)
    expect(parsed.provider).toBe('generic')
    expect(parsed.canonicalUrl).not.toContain('utm_source')
    expect(parsed.originalUrl).toContain('utm_source')
  })

  it('非法 URL / 非 http(s) 协议判无效', () => {
    expect(parseLink('not a url').valid).toBe(false)
    expect(parseLink('').valid).toBe(false)
    expect(parseLink('javascript:alert(1)').valid).toBe(false)
    expect(parseLink('file:///etc/passwd').valid).toBe(false)
    expect(parseLink('data:text/html,hello').valid).toBe(false)
  })

  it('恶意相似域名不误配', () => {
    expect(parseLink('https://notgithub.com/a/b').provider).toBe('generic')
    expect(parseLink('https://fakeyoutube.com/watch?v=dQw4w9WgXcQ').provider).toBe('generic')
    expect(parseLink('https://bilibili.com.evil.example/video/BV1xx411c7mD').provider).toBe('generic')
    expect(parseLink('https://x.com.evil.example/a/status/12345').provider).toBe('generic')
  })

  it('原始 URL 原样保留，canonicalUrl 去锚点', () => {
    const parsed = parseLink('https://github.com/banmu123/BrewPhase#readme')
    expect(parsed.originalUrl).toContain('#readme')
    expect(parsed.canonicalUrl).not.toContain('#')
  })

  it('平台展示名', () => {
    expect(providerLabel.github).toBe('GitHub')
    expect(providerLabel.youtube).toBe('YouTube')
    expect(providerLabel.bilibili).toBe('哔哩哔哩')
    expect(providerLabel.x).toBe('X')
    expect(providerLabel.generic).toBe('网页')
  })
})

describe('X 动态 ID 边界（§第四轮 真实网络 smoke 发现）', () => {
  it('早期推文的短 ID 也能识别（status/20 就是第一条推文）', () => {
    const parsed = parseLink('https://x.com/jack/status/20')
    expect(parsed.provider).toBe('x')
    expect(parsed.contentId).toBe('20')
    expect(parsed.authorHint).toBe('jack')
  })

  it('现代雪花 ID 正常识别', () => {
    const parsed = parseLink('https://twitter.com/elonmusk/status/1585841080431337472?s=20')
    expect(parsed.provider).toBe('x')
    expect(parsed.contentId).toBe('1585841080431337472')
    expect(parsed.authorHint).toBe('elonmusk')
  })

  it('非数字 / 非 status 路径不冒充动态', () => {
    expect(parseLink('https://x.com/jack').contentId).toBeNull()
    expect(parseLink('https://x.com/jack/status/photos').contentId).toBeNull()
    expect(parseLink('https://x.com/jack/status/12345678901234567890123').contentId).toBeNull()
  })
})
