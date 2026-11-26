import { describe, expect, it } from 'vitest'
import {
  JOURNEY_NODE_SIZE,
  collapsedGroupHeight,
  journeyGroupRect,
  layoutJourneyEvents,
  type JourneyLayoutEdge,
  type JourneyLayoutEvent
} from '@shared/domain/journey-layout'

/**
 * Journey 确定性布局（R6-4.1 §8）的纯函数单测。
 *
 * 这里守住三件事：
 * 1. **确定性**——同一份输入永远得到同一份坐标（重开画布不能跳位）；
 * 2. **sequence 是主轴**——列号随 sequence 单调，永不重叠；
 * 3. **只有非相邻的分叉关系才换行**——时间上相邻的节点不会因为挨着就分叉，
 *    业务 Edge 与时间顺序必须分得开。
 */

const SIZE = JOURNEY_NODE_SIZE

function events(...specs: Array<[id: string, sequence: number, type?: string]>): JourneyLayoutEvent[] {
  return specs.map(([id, sequence, eventType]) => ({
    id,
    sequence,
    eventType: eventType ?? 'execution'
  }))
}

describe('layoutJourneyEvents', () => {
  it('空输入返回空数组', () => {
    expect(layoutJourneyEvents([], [])).toEqual([])
  })

  it('单个事件落在原点', () => {
    const nodes = layoutJourneyEvents(events(['a', 1]))
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ eventId: 'a', x: 0, y: 0, column: 0, row: 0 })
  })

  it('列号由 sequence 决定，与传入顺序无关（确定性）', () => {
    const forward = layoutJourneyEvents(events(['a', 1], ['b', 2], ['c', 3]))
    const shuffled = layoutJourneyEvents(events(['c', 3], ['a', 1], ['b', 2]))
    expect(shuffled).toEqual(forward)
    expect(forward.map((node) => node.column)).toEqual([0, 1, 2])
  })

  it('同一份输入重复计算逐字节相同（重开画布不跳位）', () => {
    const input = events(['a', 1], ['b', 2], ['c', 3], ['d', 4])
    const edges: JourneyLayoutEdge[] = [
      { fromEventId: 'b', toEventId: 'a', relationshipType: 'depends_on' },
      { fromEventId: 'd', toEventId: 'b', relationshipType: 'revises' }
    ]
    const first = layoutJourneyEvents(input, edges)
    const second = layoutJourneyEvents(input, edges)
    expect(second).toEqual(first)
  })

  it('列号唯一：任意两行不重叠', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5])
    )
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlap, `节点 ${a.eventId} 与 ${b.eventId} 重叠`).toBe(false)
      }
    }
  })

  it('无边时全部留在主干（row 0）', () => {
    const nodes = layoutJourneyEvents(events(['a', 1], ['b', 2], ['c', 3]))
    expect(nodes.every((node) => node.row === 0)).toBe(true)
  })

  it('depends_on 是主干关系：不换行', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2], ['c', 3]),
      [{ fromEventId: 'c', toEventId: 'a', relationshipType: 'depends_on' }]
    )
    expect(nodes.every((node) => node.row === 0)).toBe(true)
  })

  it('非相邻的 revises 触发分叉：起点换到目标的下一行', () => {
    // a(1) b(2) c(3) d(4)，d 修订 a → 非相邻 → d 换行
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2], ['c', 3], ['d', 4]),
      [{ fromEventId: 'd', toEventId: 'a', relationshipType: 'revises' }]
    )
    const byId = new Map(nodes.map((node) => [node.eventId, node]))
    expect(byId.get('d')!.row).toBe(1)
    expect(byId.get('a')!.row).toBe(0)
    expect(byId.get('b')!.row).toBe(0)
  })

  it('相邻的 branch_from 不换行（它就是普通下一步）', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2]),
      [{ fromEventId: 'b', toEventId: 'a', relationshipType: 'branch_from' }]
    )
    expect(nodes.every((node) => node.row === 0)).toBe(true)
  })

  it('retries 分叉后再分叉：行号继续累加', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]),
      [
        { fromEventId: 'c', toEventId: 'a', relationshipType: 'retries' },
        { fromEventId: 'e', toEventId: 'a', relationshipType: 'retries' }
      ]
    )
    const byId = new Map(nodes.map((node) => [node.eventId, node]))
    expect(byId.get('c')!.row).toBe(1)
    // e 也指向 a（row 0）→ row 1；两条都指 a 时取 max，不会跳到 2
    expect(byId.get('e')!.row).toBe(1)
    expect(byId.get('b')!.row).toBe(0)
    expect(byId.get('d')!.row).toBe(0)
  })

  it('边的两端不在结果里时被忽略（不抛错）', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2]),
      [{ fromEventId: 'ghost', toEventId: 'a', relationshipType: 'revises' }]
    )
    expect(nodes).toHaveLength(2)
    expect(nodes.every((node) => node.row === 0)).toBe(true)
  })

  it('分叉节点与主干节点不重叠', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2], ['c', 3], ['d', 4]),
      [{ fromEventId: 'd', toEventId: 'a', relationshipType: 'revises' }]
    )
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlap, `${a.eventId} 与 ${b.eventId} 重叠`).toBe(false)
      }
    }
  })

  it('列间距与行间距至少留出空隙', () => {
    const nodes = layoutJourneyEvents(
      events(['a', 1], ['b', 2], ['c', 3]),
      [{ fromEventId: 'c', toEventId: 'a', relationshipType: 'revises' }]
    )
    const [first, second] = nodes
    expect(second.x - (first.x + first.width)).toBeGreaterThan(0)
    const rowOne = nodes.find((node) => node.row === 1)!
    const rowZero = nodes.find((node) => node.row === 0)!
    expect(rowOne.y - (rowZero.y + rowZero.height)).toBeGreaterThan(0)
  })

  it('节点尺寸是统一默认值', () => {
    const nodes = layoutJourneyEvents(events(['a', 1], ['b', 2]))
    for (const node of nodes) {
      expect(node.width).toBe(SIZE.width)
      expect(node.height).toBe(SIZE.height)
    }
  })
})

describe('journeyGroupRect', () => {
  it('无节点时给出可点选的最小尺寸（不是 0×0）', () => {
    const rect = journeyGroupRect([])
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('包围盒盖住全部节点 + 留白', () => {
    const nodes = layoutJourneyEvents(events(['a', 1], ['b', 2], ['c', 3]))
    const rect = journeyGroupRect(nodes)
    const maxRight = Math.max(...nodes.map((node) => node.x + node.width))
    const maxBottom = Math.max(...nodes.map((node) => node.y + node.height))
    expect(rect.width).toBeGreaterThan(maxRight)
    expect(rect.height).toBeGreaterThan(maxBottom)
  })

  it('含分叉时高度跟着长（分叉节点在下一行）', () => {
    const flat = journeyGroupRect(layoutJourneyEvents(events(['a', 1], ['b', 2])))
    const forked = journeyGroupRect(
      layoutJourneyEvents(
        events(['a', 1], ['b', 2], ['c', 3], ['d', 4]),
        [{ fromEventId: 'd', toEventId: 'a', relationshipType: 'revises' }]
      )
    )
    expect(forked.height).toBeGreaterThan(flat.height)
  })
})

describe('collapsedGroupHeight', () => {
  it('折叠后只剩标题栏高度', () => {
    expect(collapsedGroupHeight()).toBeLessThan(
      journeyGroupRect(layoutJourneyEvents(events(['a', 1], ['b', 2]))).height
    )
  })
})
