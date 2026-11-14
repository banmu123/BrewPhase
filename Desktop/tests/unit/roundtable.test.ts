import { describe, expect, it } from 'vitest'
import {
  addParticipant,
  clampRoundtable,
  dockRoundtable,
  initialRoundtable,
  removeParticipant,
  reorderParticipants,
  retainParticipants,
  undockRoundtable,
  type Roundtable
} from '../../src/shared/roundtable'

/**
 * 圆桌领域规则（Phase 2：参与者是真实 tabId）。
 *
 * 最重要的断言仍是关系边界：加入 ≠ 打开，移除 ≠ 关闭。网页本身的生死在
 * BrowserTabManager，圆桌只持有引用。
 */

describe('规格 §5：三种操作的边界', () => {
  it('加入圆桌：只记录 tabId 引用', () => {
    const table = addParticipant(initialRoundtable(), 'tab-1')
    expect(table.participantTabIds).toEqual(['tab-1'])
  })

  it('重复加入幂等：同一个标签只占一个座位', () => {
    const once = addParticipant(initialRoundtable(), 'tab-1')
    const twice = addParticipant(once, 'tab-1')
    expect(twice.participantTabIds).toEqual(['tab-1'])
    expect(twice).toBe(once)
  })

  it('移除参与者：只解除关系，不返回任何“关闭”语义', () => {
    const table = addParticipant(addParticipant(initialRoundtable(), 'tab-1'), 'tab-2')
    const after = removeParticipant(table, 'tab-1')
    expect(after.participantTabIds).toEqual(['tab-2'])
    // 原值不可变：调用方仍持有完整引用。
    expect(table.participantTabIds).toEqual(['tab-1', 'tab-2'])
  })

  it('标签关闭后的对账：只保留仍然存在的 tabId', () => {
    let table: Roundtable = initialRoundtable()
    for (const id of ['tab-1', 'tab-2', 'tab-3']) table = addParticipant(table, id)
    const after = retainParticipants(table, ['tab-3', 'tab-1'])
    expect(after.participantTabIds).toEqual(['tab-1', 'tab-3'])
  })

  it('对账无变化时返回原对象（避免无意义重渲染）', () => {
    const table = addParticipant(initialRoundtable(), 'tab-1')
    expect(retainParticipants(table, ['tab-1'])).toBe(table)
  })
})

describe('参与者排序', () => {
  it('插到目标前面，源在目标前时不产生 off-by-one', () => {
    let table: Roundtable = initialRoundtable()
    for (const id of ['a', 'b', 'c']) table = addParticipant(table, id)
    expect(reorderParticipants(table, 'c', 'a').participantTabIds).toEqual(['c', 'a', 'b'])
    expect(reorderParticipants(table, 'a', 'b').participantTabIds).toEqual(['a', 'b', 'c'])
  })

  it('拖到自己或未知 ID：不变', () => {
    const table = addParticipant(initialRoundtable(), 'a')
    expect(reorderParticipants(table, 'a', 'a')).toBe(table)
    expect(reorderParticipants(table, 'a', 'zzz')).toBe(table)
  })
})

describe('停靠 / 浮动几何（规格 §4）', () => {
  it('初始圆桌停靠、无参与者', () => {
    const table = initialRoundtable()
    expect(table.docked).toBe(true)
    expect(table.participantTabIds).toEqual([])
  })

  it('拖出与归位：参与者保留，几何保留', () => {
    const table = addParticipant(initialRoundtable(), 'tab-1')
    const floated = undockRoundtable(table)
    expect(floated.docked).toBe(false)
    expect(floated.participantTabIds).toEqual(['tab-1'])
    const docked = dockRoundtable(floated)
    expect(docked.docked).toBe(true)
    expect(docked.participantTabIds).toEqual(['tab-1'])
  })

  it('重复拖出 / 归位幂等', () => {
    const floated = undockRoundtable(initialRoundtable())
    expect(undockRoundtable(floated)).toBe(floated)
    const docked = dockRoundtable(floated)
    expect(dockRoundtable(docked)).toBe(docked)
  })

  it('clamp：先钳尺寸再钳位置；不能压顶栏、不能出窗口', () => {
    const viewport = { width: 1000, height: 700 }
    const a = clampRoundtable({ x: 5000, y: 5000 }, { width: 400, height: 300 }, viewport)
    expect(a.position.x).toBeLessThanOrEqual(viewport.width - a.size.width)
    expect(a.position.y).toBeLessThanOrEqual(viewport.height - a.size.height)

    const b = clampRoundtable({ x: -50, y: -50 }, { width: 400, height: 300 }, viewport)
    expect(b.position.x).toBe(0)
    expect(b.position.y).toBeGreaterThanOrEqual(0)

    const c = clampRoundtable({ x: 10, y: 100 }, { width: 10, height: 10 }, viewport)
    expect(c.size.width).toBe(360)
    expect(c.size.height).toBe(240)

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
