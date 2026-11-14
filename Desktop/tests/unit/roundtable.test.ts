import { describe, expect, it } from 'vitest'
import {
  addBlankCard,
  addParticipant,
  blankWebCard,
  cardBadgeText,
  cardDisplayName,
  clampRoundtable,
  closeCard,
  domainOf,
  dockRoundtable,
  initialRoundtable,
  isJoinableCard,
  reorderCards,
  reorderParticipants,
  removeParticipant,
  undockRoundtable,
  type Roundtable,
  type WebCard
} from '../../src/shared/roundtable'

/**
 * 网页卡片架 + 圆桌的领域规则（规格 §3 / §4 / §5）。
 * 全部是纯函数：状态关系（加入 ≠ 关闭）是这里最重要的断言对象。
 */

function ready(id: string, title: string, url: string): WebCard {
  return { id, title, url, status: 'ready' }
}

function empty(id: string): WebCard {
  return blankWebCard(id)
}

describe('卡片基础', () => {
  it('初始卡片是空白卡', () => {
    const card = empty('c1')
    expect(card.status).toBe('empty')
    expect(isJoinableCard(card)).toBe(false)
  })

  it('空白卡不可加入圆桌，就绪卡可以', () => {
    expect(isJoinableCard(ready('c1', 'GPT', 'https://chatgpt.com'))).toBe(true)
    // 只有 URL 没有 status 的中间态也不算（防御 updateCard 半提交）。
    expect(isJoinableCard({ ...empty('c2'), url: 'https://a.com' })).toBe(false)
  })

  it('域名提取与展示名兜底', () => {
    expect(domainOf('https://chatgpt.com/c/1')).toBe('chatgpt.com')
    expect(domainOf('不是地址')).toBe('不是地址')
    expect(cardDisplayName(empty('c1'), '未命名')).toBe('未命名')
    expect(cardDisplayName(ready('c2', ' Claude ', 'https://claude.ai'), 'x')).toBe('Claude')
    expect(cardDisplayName({ ...empty('c3'), url: 'https://x.com' }, 'x')).toBe('x.com')
  })

  it('徽标文字：favicon 优先，其次首字母，空白卡用占位', () => {
    expect(cardBadgeText({ ...ready('c1', 'GPT', 'u'), favicon: 'G' }, 'n')).toBe('G')
    expect(cardBadgeText(ready('c2', 'ChatGPT', 'u'), 'n')).toBe('C')
    expect(cardBadgeText(empty('c3'), 'n')).toBe('·')
  })
})

describe('规格 §5：三种操作的边界', () => {
  const cards = [ready('a', 'A', 'https://a.com'), ready('b', 'B', 'https://b.com')]

  it('加入圆桌：建立参与关系，卡片仍在架上', () => {
    const table = addParticipant(initialRoundtable(), 'a')
    expect(table.participantIds).toEqual(['a'])
    expect(cards).toHaveLength(2)
  })

  it('重复加入幂等：同一张卡只占一个座位', () => {
    const once = addParticipant(initialRoundtable(), 'a')
    const twice = addParticipant(once, 'a')
    expect(twice.participantIds).toEqual(['a'])
    expect(twice).toBe(once)
  })

  it('移除参与者：解除关系，卡片保留', () => {
    const table = addParticipant(addParticipant(initialRoundtable(), 'a'), 'b')
    const after = removeParticipant(table, 'a')
    expect(after.participantIds).toEqual(['b'])
  })

  it('关闭卡片：架与圆桌一起摘掉（关网页 ≠ 留讨论位）', () => {
    const table = addParticipant(addParticipant(initialRoundtable(), 'a'), 'b')
    const result = closeCard(cards, table, 'a')
    expect(result.cards.map((card) => card.id)).toEqual(['b'])
    expect(result.roundtable.participantIds).toEqual(['b'])
  })

  it('关闭未参与讨论的卡片：圆桌不动', () => {
    const table = addParticipant(initialRoundtable(), 'a')
    const result = closeCard(cards, table, 'b')
    expect(result.cards.map((card) => card.id)).toEqual(['a'])
    expect(result.roundtable.participantIds).toEqual(['a'])
  })
})

describe('排序', () => {
  it('卡片架内拖动：插到目标前面（源在目标前时保持原序）', () => {
    const cards = [ready('a', 'A', 'u'), ready('b', 'B', 'u'), ready('c', 'C', 'u')]
    expect(reorderCards(cards, 'c', 'a').map((x) => x.id)).toEqual(['c', 'a', 'b'])
    // a 本来就在 b 前：把 a 拖到 b 前是 no-op，不能变成「挪到 b 后」。
    expect(reorderCards(cards, 'a', 'b').map((x) => x.id)).toEqual(['a', 'b', 'c'])
    // 从后往前拖到末位同理。
    expect(reorderCards(cards, 'a', 'c').map((x) => x.id)).toEqual(['b', 'a', 'c'])
  })

  it('参与者在圆桌内拖动：同一语义', () => {
    let table: Roundtable = initialRoundtable()
    for (const id of ['a', 'b', 'c']) table = addParticipant(table, id)
    expect(reorderParticipants(table, 'c', 'a').participantIds).toEqual(['c', 'a', 'b'])
    expect(reorderParticipants(table, 'a', 'b').participantIds).toEqual(['a', 'b', 'c'])
  })

  it('拖到自己或未知 ID：不变（幂等）', () => {
    const cards = [ready('a', 'A', 'u'), ready('b', 'B', 'u')]
    expect(reorderCards(cards, 'a', 'a')).toBe(cards)
    expect(reorderCards(cards, 'a', 'zzz')).toBe(cards)
  })
})

describe('停靠 / 浮动几何（规格 §4）', () => {
  it('初始圆桌停靠、无参与者', () => {
    const table = initialRoundtable()
    expect(table.docked).toBe(true)
    expect(table.participantIds).toEqual([])
  })

  it('拖出与归位：参与者保留，几何保留', () => {
    let table = addParticipant(initialRoundtable(), 'a')
    const floated = undockRoundtable(table)
    expect(floated.docked).toBe(false)
    expect(floated.participantIds).toEqual(['a'])
    const docked = dockRoundtable(floated)
    expect(docked.docked).toBe(true)
    // 归位不重新初始化：参与者还在。
    expect(docked.participantIds).toEqual(['a'])
  })

  it('重复拖出 / 归位幂等', () => {
    const floated = undockRoundtable(initialRoundtable())
    expect(undockRoundtable(floated)).toBe(floated)
    const docked = dockRoundtable(floated)
    expect(dockRoundtable(docked)).toBe(docked)
  })

  it('clamp：先钳尺寸再钳位置；不能压顶栏、不能出窗口', () => {
    const viewport = { width: 1000, height: 700 }
    // 拖出窗口右下：位置收回。
    const a = clampRoundtable({ x: 5000, y: 5000 }, { width: 400, height: 300 }, viewport)
    expect(a.position.x).toBeLessThanOrEqual(viewport.width - a.size.width)
    expect(a.position.y).toBeLessThanOrEqual(viewport.height - a.size.height)
    // 负坐标：拉回 0。
    const b = clampRoundtable({ x: -50, y: -50 }, { width: 400, height: 300 }, viewport)
    expect(b.position.x).toBe(0)
    // y 不小于 0，也不盖顶栏（top inset 52 被更低的 maxY 覆盖时以 0 为准）。
    expect(b.position.y).toBeGreaterThanOrEqual(0)
    // 尺寸过小：抬到最小值。
    const c = clampRoundtable({ x: 10, y: 100 }, { width: 10, height: 10 }, viewport)
    expect(c.size.width).toBe(360)
    expect(c.size.height).toBe(240)
    // 尺寸过大：压回窗口。
    const d = clampRoundtable({ x: 0, y: 60 }, { width: 9999, height: 9999 }, viewport)
    expect(d.size.width).toBeLessThanOrEqual(viewport.width)
    expect(d.size.height).toBeLessThanOrEqual(viewport.height)
  })

  it('顶栏保护：窗口够高时 y 不小于 52', () => {
    const viewport = { width: 1000, height: 700 }
    const r = clampRoundtable({ x: 100, y: 0 }, { width: 400, height: 300 }, viewport)
    expect(r.position.y).toBe(52)
  })
})

describe('添加卡片', () => {
  it('追加一张空白卡到末尾', () => {
    const cards = [ready('a', 'A', 'u')]
    const next = addBlankCard(cards, 'b')
    expect(next).toHaveLength(2)
    expect(next[1].status).toBe('empty')
    // 原数组不被修改。
    expect(cards).toHaveLength(1)
  })
})
