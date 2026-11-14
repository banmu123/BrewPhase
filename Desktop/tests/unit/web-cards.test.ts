import { describe, expect, it } from 'vitest'
import type { BrowserTabInfo } from '../../src/shared/contracts/browser'
import {
  cardBadgeText,
  cardDisplayName,
  domainOf,
  isCardAwaitingAddress,
  isCardJoinable,
  moveCardBefore,
  presentationOf,
  reconcileCardOrder,
  sortTabsByOrder,
  toWebCardModels
} from '../../src/shared/web-cards'

/**
 * 卡片派生模型（Phase 2）：卡片 = 真实标签。
 *
 * 这些函数是「UI 认不认得出真实网页」的全部规则，必须保持纯函数：
 * 顺序只影响展示，tabId 永远是身份。
 */

function tab(id: string, patch: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id,
    url: `https://${id}.example.com/`,
    title: id.toUpperCase(),
    loading: false,
    progress: 1,
    error: null,
    windowId: 1,
    detached: false,
    parked: false,
    active: false,
    ...patch
  }
}

describe('展示形态', () => {
  it('独立窗口优先于主窗口展开', () => {
    expect(presentationOf({ detached: true, active: false })).toBe('detached')
    expect(presentationOf({ detached: true, active: true })).toBe('detached')
    expect(presentationOf({ detached: false, active: true })).toBe('expanded-in-main')
    expect(presentationOf({ detached: false, active: false })).toBe('shelved')
  })
})

describe('架子顺序对账', () => {
  it('保留仍然存在的标签顺序，新标签按主进程顺序追加', () => {
    expect(reconcileCardOrder(['tab-3', 'tab-1'], ['tab-1', 'tab-2', 'tab-3'])).toEqual([
      'tab-3',
      'tab-1',
      'tab-2'
    ])
  })

  it('关闭的标签自动消失，重复项去重', () => {
    expect(reconcileCardOrder(['tab-1', 'tab-1', 'tab-9', 'tab-2'], ['tab-2', 'tab-1'])).toEqual([
      'tab-1',
      'tab-2'
    ])
  })

  it('空顺序 = 主进程顺序', () => {
    expect(reconcileCardOrder([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('按顺序排列标签；顺序外的标签排在末尾', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(sortTabsByOrder(tabs, ['c', 'a']).map((item) => item.id)).toEqual(['c', 'a', 'b'])
    // 不改原数组。
    expect(tabs.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('moveCardBefore：插到锚点前；null = 末尾；未知锚点保持原序', () => {
    expect(moveCardBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveCardBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(moveCardBefore(['a', 'b'], 'a', 'zzz')).toEqual(['a', 'b'])
    expect(moveCardBefore(['a', 'b'], 'zzz', 'a')).toEqual(['a', 'b'])
  })
})

describe('卡片身份', () => {
  it('域名提取与展示名兜底', () => {
    expect(domainOf('https://chatgpt.com/c/1')).toBe('chatgpt.com')
    expect(domainOf('不是地址')).toBe('不是地址')
    expect(domainOf('')).toBe('')
    expect(cardDisplayName({ title: '', url: '' }, '未命名')).toBe('未命名')
    expect(cardDisplayName({ title: ' Claude ', url: 'https://claude.ai' }, 'x')).toBe('Claude')
    expect(cardDisplayName({ title: '', url: 'https://x.com' }, 'x')).toBe('x.com')
  })

  it('徽标：首字母；空地址用占位点', () => {
    expect(cardBadgeText({ title: 'ChatGPT', url: 'https://chatgpt.com' }, 'n')).toBe('C')
    expect(cardBadgeText({ title: '', url: 'https://x.com' }, 'n')).toBe('x')
    expect(cardBadgeText({ title: '', url: '' }, 'n')).toBe('·')
  })

  it('只有有地址的标签可进圆桌；空地址进入输入态', () => {
    expect(isCardJoinable({ url: 'https://a.com' })).toBe(true)
    expect(isCardJoinable({ url: '   ' })).toBe(false)
    expect(isCardAwaitingAddress({ url: '' })).toBe(true)
    expect(isCardAwaitingAddress({ url: 'https://a.com' })).toBe(false)
  })
})

describe('toWebCardModels', () => {
  it('顺序、形态、圆桌参与都来自输入，不复制网页状态', () => {
    const tabs = [
      tab('tab-1', { active: true, title: 'ChatGPT' }),
      tab('tab-2', { detached: true }),
      tab('tab-3', { loading: true })
    ]
    const models = toWebCardModels(tabs, ['tab-3', 'tab-1'], ['tab-1'])
    expect(models.map((item) => item.tabId)).toEqual(['tab-3', 'tab-1', 'tab-2'])
    expect(models[0].presentation).toBe('shelved')
    expect(models[1].presentation).toBe('expanded-in-main')
    expect(models[1].inRoundtable).toBe(true)
    expect(models[2].presentation).toBe('detached')
    expect(models[0].loading).toBe(true)
  })
})
