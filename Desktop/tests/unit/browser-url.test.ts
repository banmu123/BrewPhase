import { describe, expect, it } from 'vitest'
import {
  canOpenInBrowser,
  displayURL,
  isAllowedBrowserURL,
  looksLikeHost,
  normalizeBrowserURL,
  resolveBrowserInput,
  searchURL,
  SEARCH_ENGINES
} from '@shared/browser-url'

/**
 * 地址栏解析。这层是**安全边界**的一半：它决定什么能进网页容器。
 * 断言按「输入 → 分类 → 最终 URL」三段写，任何一条被放宽都会红。
 */

describe('完整 URL', () => {
  it('https / http 原样通过并规范化', () => {
    expect(resolveBrowserInput('https://example.com')).toEqual({
      kind: 'url',
      url: 'https://example.com/'
    })
    expect(resolveBrowserInput('http://example.com/a?b=1')).toEqual({
      kind: 'url',
      url: 'http://example.com/a?b=1'
    })
  })

  it('大小写协议与首尾空白都能处理', () => {
    expect(resolveBrowserInput('  HTTPS://Example.COM/Path  ')).toEqual({
      kind: 'url',
      url: 'https://example.com/Path'
    })
  })
})

describe('裸域名', () => {
  it('普通域名补 https', () => {
    expect(resolveBrowserInput('example.com')).toEqual({
      kind: 'url',
      url: 'https://example.com/'
    })
    expect(resolveBrowserInput('github.com/banmu123/BrewPhase')).toEqual({
      kind: 'url',
      url: 'https://github.com/banmu123/BrewPhase'
    })
  })

  it('localhost 与 IP 补 http（这类地址通常没有证书）', () => {
    expect(resolveBrowserInput('localhost:3000')).toEqual({
      kind: 'url',
      url: 'http://localhost:3000/'
    })
    expect(resolveBrowserInput('127.0.0.1:8080/x')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:8080/x'
    })
    expect(resolveBrowserInput('192.168.1.4')).toEqual({
      kind: 'url',
      url: 'http://192.168.1.4/'
    })
  })

  it('非法标签不会被当成域名（否则会把畸形输入送去导航）', () => {
    expect(looksLikeHost('-bad.com')).toBe(false)
    expect(looksLikeHost('a..com')).toBe(false)
    expect(looksLikeHost('example')).toBe(false)
    expect(looksLikeHost('example.c')).toBe(false)
    expect(looksLikeHost('256.1.1.1')).toBe(false)
    expect(looksLikeHost('example.com/path')).toBe(true)
  })
})

describe('搜索', () => {
  it('普通关键词走搜索，不当作域名', () => {
    const result = resolveBrowserInput('coffee brewing ratio')
    expect(result.kind).toBe('search')
    if (result.kind === 'search') {
      expect(result.query).toBe('coffee brewing ratio')
      expect(result.url).toBe('https://www.google.com/search?q=coffee%20brewing%20ratio')
    }
  })

  it('中文关键词按 URL 编码', () => {
    const result = resolveBrowserInput('咖啡豆')
    expect(result.kind).toBe('search')
    if (result.kind === 'search') expect(result.url).toContain(encodeURIComponent('咖啡豆'))
  })

  it('搜索引擎可替换：默认 Google，但不是唯一选项', () => {
    const duck = SEARCH_ENGINES.find((engine) => engine.id === 'duckduckgo')!
    expect(searchURL('coffee', duck)).toBe('https://duckduckgo.com/?q=coffee')
    const viaDuck = resolveBrowserInput('coffee', duck)
    expect(viaDuck.kind).toBe('search')
    if (viaDuck.kind === 'search') expect(viaDuck.url).toContain('duckduckgo.com')
  })
})

describe('危险协议被拦在容器外', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'about:blank',
    'chrome://settings',
    'vbscript:msgbox(1)',
    'ftp://example.com/file'
  ])('%s 不会被导航，也不会退化成搜索', (input) => {
    const result = resolveBrowserInput(input)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.reason).toBe('blocked-scheme')
  })

  it('空输入是 empty，不是搜索空串', () => {
    expect(resolveBrowserInput('   ')).toEqual({ kind: 'invalid', reason: 'empty' })
  })
})

describe('URL 工具', () => {
  it('isAllowedBrowserURL 只认 http/https', () => {
    expect(isAllowedBrowserURL('https://a.com')).toBe(true)
    expect(isAllowedBrowserURL('http://a.com')).toBe(true)
    expect(isAllowedBrowserURL('javascript:alert(1)')).toBe(false)
    expect(isAllowedBrowserURL('file:///tmp/x')).toBe(false)
    expect(isAllowedBrowserURL('not a url')).toBe(false)
  })

  it('normalizeBrowserURL 对不可解析的地址返回 null', () => {
    expect(normalizeBrowserURL('https://a.com')).toBe('https://a.com/')
    expect(normalizeBrowserURL('a.com')).toBeNull()
    expect(normalizeBrowserURL('')).toBeNull()
  })

  it('displayURL 去掉根路径的尾斜杠，保留查询与锚点', () => {
    expect(displayURL('https://a.com/')).toBe('https://a.com')
    expect(displayURL('https://a.com/p?q=1#h')).toBe('https://a.com/p?q=1#h')
    expect(displayURL('')).toBe('')
  })

  it('canOpenInBrowser 与地址栏同一套白名单（Records 入口用）', () => {
    expect(canOpenInBrowser('https://github.com/x')).toBe(true)
    expect(canOpenInBrowser('javascript:alert(1)')).toBe(false)
    expect(canOpenInBrowser('')).toBe(false)
  })
})
