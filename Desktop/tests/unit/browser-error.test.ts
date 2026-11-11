import { describe, expect, it } from 'vitest'
import type { BrowserLoadError } from '@shared/contracts'
import { browserErrorKey, isRetryableError } from '../../src/renderer/src/features/browser/browser-error'

/**
 * 错误码 → 文案 key。主进程只送 code/kind/reason，翻译在这一层做；
 * 这条分界线一旦破了（主进程塞中文），中英切换就会混排。
 */

function error(overrides: Partial<BrowserLoadError>): BrowserLoadError {
  return { code: 0, description: '', url: 'https://a.com', ...overrides }
}

describe('browserErrorKey', () => {
  it('输入阶段被拦下的三种原因优先于任何 code', () => {
    expect(browserErrorKey(error({ reason: 'blocked-scheme', code: -105 }))).toBe('blockedScheme')
    expect(browserErrorKey(error({ reason: 'empty' }))).toBe('emptyInput')
    expect(browserErrorKey(error({ reason: 'malformed' }))).toBe('malformed')
  })

  it('渲染进程崩溃单独一类', () => {
    expect(browserErrorKey(error({ kind: 'crash', code: -1 }))).toBe('crashed')
  })

  it('常见网络错误按族归并', () => {
    expect(browserErrorKey(error({ code: -105 }))).toBe('notFound') // NAME_NOT_RESOLVED
    expect(browserErrorKey(error({ code: -106 }))).toBe('offline') // INTERNET_DISCONNECTED
    expect(browserErrorKey(error({ code: -21 }))).toBe('offline') // NETWORK_CHANGED
    expect(browserErrorKey(error({ code: -7 }))).toBe('timeout') // TIMED_OUT
    expect(browserErrorKey(error({ code: -118 }))).toBe('timeout') // CONNECTION_TIMED_OUT
    expect(browserErrorKey(error({ code: -102 }))).toBe('refused') // CONNECTION_REFUSED
  })

  it('证书族（-200..-299）统一按安全问题处理', () => {
    expect(browserErrorKey(error({ code: -200 }))).toBe('certificate')
    expect(browserErrorKey(error({ code: -202 }))).toBe('certificate')
    expect(browserErrorKey(error({ code: -207 }))).toBe('certificate')
  })

  it('未知错误落到 generic，而不是把错误码当文案显示', () => {
    expect(browserErrorKey(error({ code: -9999 }))).toBe('generic')
  })
})

describe('isRetryableError', () => {
  it('输入错误重试同一串没有意义', () => {
    expect(isRetryableError(error({ reason: 'blocked-scheme' }))).toBe(false)
    expect(isRetryableError(error({ reason: 'empty' }))).toBe(false)
    expect(isRetryableError(error({ reason: 'malformed' }))).toBe(false)
  })

  it('网络与崩溃类可以重试', () => {
    expect(isRetryableError(error({ code: -105 }))).toBe(true)
    expect(isRetryableError(error({ kind: 'crash', code: -1 }))).toBe(true)
  })
})
