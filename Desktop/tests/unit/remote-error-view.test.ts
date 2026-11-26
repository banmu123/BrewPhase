import { describe, expect, it } from 'vitest'
import { formatLastError, shouldHighlightLastError } from '../../src/renderer/src/features/settings/remote-error-view'
import { zhCN } from '../../src/renderer/src/i18n/messages/zh-CN'
import { enUS } from '../../src/renderer/src/i18n/messages/en-US'

/**
 * 设置页「最近错误」的展示规则（Phase 1.3.3-A-R1）。
 *
 * 这一层只有两个函数，但它们是**唯一**决定「空值显示什么」的地方：
 * 仓库没有 renderer 测试设施（无 jsdom / testing-library），组件里的
 * `?? null` 一旦写错就没人拦得住——所以规则必须落在可测的纯函数上。
 */

describe('formatLastError：空值必须归一成明确的空状态', () => {
  it('null / undefined / 空串 / 纯空白 → 空状态文案', () => {
    // 这四个是最容易退化的输入：任何一个漏判，页面就会出现字面量
    // `null`、`undefined` 或一个空白格。
    expect(formatLastError(null, '无')).toBe('无')
    expect(formatLastError(undefined, '无')).toBe('无')
    expect(formatLastError('', '无')).toBe('无')
    expect(formatLastError('   ', '无')).toBe('无')
  })

  it('真实错误原样返回（不 trim、不截断、不改写）', () => {
    expect(formatLastError('websocket error', '无')).toBe('websocket error')
    expect(formatLastError('failed to open socket', '无')).toBe('failed to open socket')
    expect(formatLastError('heartbeat timeout', '无')).toBe('heartbeat timeout')
    // 首尾空白保留：trim 会掩盖「错误文案被意外加了空白」这类问题。
    expect(formatLastError('  x  ', '无')).toBe('  x  ')
  })

  it('错误文案里的 null 字样不会被误判成空值', () => {
    // 字符串 "null" 是合法错误文案（例如某个 JSON 字段为 null 的描述），
    // 只有真正的 null 才走空状态。
    expect(formatLastError('null', '无')).toBe('null')
    expect(formatLastError('undefined', '无')).toBe('undefined')
  })

  it('空状态文案由调用方决定（中英切换）', () => {
    expect(formatLastError(null, 'None')).toBe('None')
    expect(formatLastError(null, '—')).toBe('—')
  })
})

describe('shouldHighlightLastError：只有「开着且有错」才提示', () => {
  it('开关关闭时不提示（残留错误不该变成告警噪音）', () => {
    expect(shouldHighlightLastError({ enabled: false, lastError: 'websocket error' })).toBe(false)
  })

  it('开关打开且有错 → 提示', () => {
    expect(shouldHighlightLastError({ enabled: true, lastError: 'websocket error' })).toBe(true)
  })

  it('开关打开但无错 → 不提示（空状态走列表行，不走 callout）', () => {
    expect(shouldHighlightLastError({ enabled: true, lastError: null })).toBe(false)
    expect(shouldHighlightLastError({ enabled: true, lastError: '' })).toBe(false)
    expect(shouldHighlightLastError({ enabled: true, lastError: '   ' })).toBe(false)
  })
})

describe('中英文案完整且成对', () => {
  const KEYS = ['lastError', 'noError', 'reconnectAttempt', 'lastErrorHint'] as const

  it('zh-CN 与 en-US 都有这些键，且都不是空串', () => {
    for (const key of KEYS) {
      const zh = (zhCN.settings.remote as Record<string, unknown>)[key]
      const en = (enUS.settings.remote as Record<string, unknown>)[key]
      expect(zh, `zh-CN 缺 ${key}`).toBeTypeOf('string')
      expect(en, `en-US 缺 ${key}`).toBeTypeOf('string')
      expect(String(zh).length, `zh-CN.${key} 为空`).toBeGreaterThan(0)
      expect(String(en).length, `en-US.${key} 为空`).toBeGreaterThan(0)
    }
  })

  it('中英文案不相同（不是漏翻的占位）', () => {
    for (const key of KEYS) {
      const zh = String((zhCN.settings.remote as Record<string, unknown>)[key])
      const en = String((enUS.settings.remote as Record<string, unknown>)[key])
      // lastErrorHint 这类长句中英必然不同；短文案如「无」/「None」也不同。
      expect(zh, `${key} 中英相同，疑似漏翻`).not.toBe(en)
    }
  })
})
