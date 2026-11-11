import { describe, expect, it } from 'vitest'
import {
  MAX_DESCRIPTION,
  MAX_SELECTED_TEXT,
  MAX_TITLE,
  appNotRunning,
  clampText,
  internalError,
  isSupportedUrl,
  normalizePayload,
  parseResponse,
  type PagePayload
} from '../src/shared/protocol'

const SAMPLE: PagePayload = {
  title: '标题',
  url: 'https://example.com/a',
  domain: 'example.com',
  faviconUrl: null,
  description: '描述',
  selectedText: ''
}

describe('Chrome Companion 协议', () => {
  it('只接受 http / https 地址', () => {
    expect(isSupportedUrl('https://example.com')).toBe(true)
    expect(isSupportedUrl('http://127.0.0.1:8080/x')).toBe(true)
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'chrome://settings', '', 'not a url']) {
      expect(isSupportedUrl(url)).toBe(false)
    }
  })

  it('normalizePayload 截断字段并补出域名', () => {
    const page = normalizePayload({
      title: `  ${'t'.repeat(MAX_TITLE + 10)}  `,
      url: 'https://www.example.com/articles/1?x=1',
      faviconUrl: 'https://example.com/favicon.ico',
      description: 'd'.repeat(MAX_DESCRIPTION + 5),
      selectedText: 's'.repeat(MAX_SELECTED_TEXT + 5)
    })

    expect(page.title).toHaveLength(MAX_TITLE)
    expect(page.description).toHaveLength(MAX_DESCRIPTION)
    expect(page.selectedText).toHaveLength(MAX_SELECTED_TEXT)
    expect(page.domain).toBe('example.com')
    expect(page.url).toContain('https://www.example.com/articles/1')
  })

  it('没有选中文字时保持空串，不伪造内容', () => {
    const page = normalizePayload({
      title: '只有网页',
      url: 'https://example.com',
      faviconUrl: '',
      description: '',
      selectedText: '   '
    })
    expect(page.selectedText).toBe('')
    expect(page.faviconUrl).toBeNull()
  })

  it('parseResponse 只接受已知错误码，并补齐空 requestId', () => {
    const ok = parseResponse(
      { version: 1, requestId: '', success: true, code: 'OK', data: { recordId: 'r-1' } },
      'fallback-id'
    )
    expect(ok?.requestId).toBe('fallback-id')
    expect(ok?.data?.recordId).toBe('r-1')

    expect(parseResponse({ code: 'SOMETHING_ELSE' }, 'x')).toBeNull()
    expect(parseResponse('not an object', 'x')).toBeNull()
    expect(parseResponse(null, 'x')).toBeNull()
  })

  it('Desktop 未运行与内部错误都带明确错误码，不是 success', () => {
    expect(appNotRunning('r-1')).toMatchObject({
      requestId: 'r-1',
      success: false,
      code: 'APP_NOT_RUNNING'
    })
    expect(internalError('r-2', 'timeout')).toMatchObject({
      requestId: 'r-2',
      success: false,
      code: 'INTERNAL_ERROR'
    })
  })

  it('clampText 不改短文本，只截断超长文本', () => {
    expect(clampText('短文本', 10)).toBe('短文本')
    expect(clampText('1234567890x', 10)).toBe('1234567890')
  })

  it('样例 payload 的字段名与 Desktop 契约一致', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(
      ['description', 'domain', 'faviconUrl', 'selectedText', 'title', 'url'].sort()
    )
  })
})
