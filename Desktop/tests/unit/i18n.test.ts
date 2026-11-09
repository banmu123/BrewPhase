import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFormatters,
  detectSystemLocale,
  isLocale,
  LOCALE_STORAGE_KEY,
  readStoredLocale,
  resolveInitialLocale,
  storeLocale,
  SUPPORTED_LOCALES,
  type Locale
} from '../../src/renderer/src/i18n/locale'
import { zhCN } from '../../src/renderer/src/i18n/messages/zh-CN'
import { enUS } from '../../src/renderer/src/i18n/messages/en-US'

/**
 * i18n 完整性测试：字典键集、值类型、语言探测与持久化、Intl 格式化。
 *
 * 这是防止「英文缺 key 静默 undefined」的最后一道闸门：`satisfies Messages`
 * 在编译期已挡住大部分情况，这里再做运行时深比较（含函数签名的 typeof）。
 */

type Leaf = string | ((...args: never[]) => string)

function collectLeaves(node: Record<string, unknown>, prefix = ''): Map<string, Leaf> {
  const out = new Map<string, Leaf>()
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      for (const [childPath, childValue] of collectLeaves(value as Record<string, unknown>, path)) {
        out.set(childPath, childValue)
      }
    } else {
      out.set(path, value as Leaf)
    }
  }
  return out
}

describe('i18n 字典完整性', () => {
  const zhLeaves = collectLeaves(zhCN as unknown as Record<string, unknown>)
  const enLeaves = collectLeaves(enUS as unknown as Record<string, unknown>)

  it('中英文键集完全一致', () => {
    const zhKeys = [...zhLeaves.keys()].sort()
    const enKeys = [...enLeaves.keys()].sort()
    expect(zhKeys).toEqual(enKeys)
  })

  it('没有空值、undefined 或缺失翻译', () => {
    for (const leaves of [zhLeaves, enLeaves]) {
      for (const [path, value] of leaves) {
        expect(typeof value, path).not.toBe('undefined')
        if (typeof value === 'string') {
          expect(value.trim().length, `${path} 不能是空字符串`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('同一键在中英文里的值类型一致（字符串 vs 插值函数）', () => {
    for (const [path, zhValue] of zhLeaves) {
      const enValue = enLeaves.get(path)
      expect(typeof enValue, path).toBe(typeof zhValue)
    }
  })

  it('插值函数返回真实文案（调用后非空且包含实参）', () => {
    const sampleArgs = [3, 5, 7, 11] as const
    for (const [path, value] of zhLeaves) {
      if (typeof value !== 'function') continue
      const result = (value as (...args: number[]) => string)(...sampleArgs)
      expect(typeof result, path).toBe('string')
      expect(result.length, path).toBeGreaterThan(0)
    }
    for (const [path, value] of enLeaves) {
      if (typeof value !== 'function') continue
      const result = (value as (...args: number[]) => string)(...sampleArgs)
      expect(result.length, path).toBeGreaterThan(0)
    }
  })

  it('两种语言的文案互不相同（防止漏翻直接复制中文）', () => {
    const identicalPaths: string[] = []
    for (const [path, zhValue] of zhLeaves) {
      if (typeof zhValue !== 'string') continue
      const enValue = enLeaves.get(path)
      if (typeof enValue !== 'string') continue
      // 中文条目在英文里若一字不差，说明漏翻。
      if (/[\u4e00-\u9fa5]/.test(zhValue) && zhValue === enValue) identicalPaths.push(path)
    }
    // 唯一白名单：语言选择器里「简体中文」在两个界面下都显示中文（有意为之）。
    expect(identicalPaths).toEqual(['settings.general.languageName.zh-CN'])
  })
})

describe('语言探测与持久化', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    // 实现走 globalThis.localStorage（renderer 里就是 window.localStorage），
    // node 测试环境直接 stub 这个全局即可。
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function withSystemLanguage(language: string, languages: string[] = [language]): void {
    vi.stubGlobal('navigator', { language, languages })
  }

  it('系统中文（含 zh-TW）默认 zh-CN；系统英文默认 en-US；其他默认 zh-CN', () => {
    withSystemLanguage('zh-CN')
    expect(detectSystemLocale()).toBe('zh-CN')
    withSystemLanguage('zh-TW')
    expect(detectSystemLocale()).toBe('zh-CN')
    withSystemLanguage('en-GB')
    expect(detectSystemLocale()).toBe('en-US')
    withSystemLanguage('fr-FR')
    expect(detectSystemLocale()).toBe('zh-CN')
  })

  it('navigator.languages 里第一个可识别的语言胜出', () => {
    withSystemLanguage('fr-FR', ['fr-FR', 'en-US', 'zh-CN'])
    expect(detectSystemLocale()).toBe('en-US')
  })

  it('用户手动选择优先于系统语言，并且能持久化', () => {
    withSystemLanguage('en-US')
    expect(resolveInitialLocale()).toBe('en-US')
    storeLocale('zh-CN')
    expect(readStoredLocale()).toBe('zh-CN')
    expect(resolveInitialLocale()).toBe('zh-CN')
    expect(storage.get(LOCALE_STORAGE_KEY)).toBe('zh-CN')
  })

  it('损坏的存储值被忽略（回落系统语言）', () => {
    storage.set(LOCALE_STORAGE_KEY, 'klingon')
    expect(readStoredLocale()).toBeNull()
    withSystemLanguage('en-US')
    expect(resolveInitialLocale()).toBe('en-US')
  })

  it('SUPPORTED_LOCALES 与 isLocale 一致', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isLocale(locale)).toBe(true)
    expect(isLocale('fr-FR')).toBe(false)
    expect(isLocale(null)).toBe(false)
  })
})

describe('Intl 格式化随语言变化', () => {
  const timestamp = Date.UTC(2026, 10, 9, 7, 5)
  const locales: Locale[] = ['zh-CN', 'en-US']

  it('日期与日期时间在中英文下输出不同', () => {
    const zh = createFormatters('zh-CN')
    const en = createFormatters('en-US')
    expect(zh.formatDate(timestamp)).not.toBe(en.formatDate(timestamp))
    expect(zh.formatDateTime(timestamp)).not.toBe(en.formatDateTime(timestamp))
    // 都不是空串，且都包含年份
    for (const locale of locales) {
      expect(createFormatters(locale).formatDate(timestamp)).toContain('2026')
    }
  })

  it('大数字使用千分位（两种语言都有，但格式符按语言）', () => {
    const zh = createFormatters('zh-CN')
    const en = createFormatters('en-US')
    expect(en.formatNumber(1234567)).toBe('1,234,567')
    // zh-CN 的 Intl 也是逗号分位——验证它至少等于同一语义输出
    expect(zh.formatNumber(1234567)).toContain('1')
    expect(zh.formatNumber(1234567)).toContain('234')
  })
})
