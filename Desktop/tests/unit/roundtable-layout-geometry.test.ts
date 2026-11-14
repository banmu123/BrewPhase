import { describe, expect, it } from 'vitest'
import {
  clampPanelIntoWorkspace,
  collectSnapEdges,
  defaultPanelLayout,
  findFreePanelSpot,
  rectsIntersect,
  resolveMoveWithoutOverlap,
  resolveResizeWithoutOverlap,
  snapPanelPosition,
  type RoundtablePanelLayout
} from '../../src/shared/roundtable'

/**
 * 自由布局的几何纯函数（Phase 4.2 workspace）：
 * 1. 默认布局级联错位、绝不超出工作区；
 * 2. clamp 保证面板可再找到（至少 KEEP_VISIBLE 留在工作区内）；
 * 3. 吸附是辅助而非限制——超过阈值就不吸；
 * 4. 防重叠（产品规则）：拖动推出去、缩放被挡住、新成员找空位；
 * 5. 被围死时如实返回 null（调用方保持原状），绝不产生重叠。
 */

const WS = { width: 1200, height: 800 }

function panel(tabId: string, over: Partial<RoundtablePanelLayout> = {}): RoundtablePanelLayout {
  return { tabId, url: '', x: 0, y: 0, width: 400, height: 300, z: 1, ...over }
}

describe('defaultPanelLayout', () => {
  it('级联错位：不同序号得到不同位置', () => {
    const first = defaultPanelLayout('tab-1', 0, WS)
    const second = defaultPanelLayout('tab-2', 1, WS)
    expect(first.x).toBeLessThan(second.x)
    expect(first.y).toBeLessThan(second.y)
  })

  it('小工作区：默认尺寸收缩到工作区内且不小于最小尺寸', () => {
    const small = { width: 480, height: 320 }
    const panel = defaultPanelLayout('tab-1', 0, small)
    expect(panel.width).toBeLessThanOrEqual(small.width)
    expect(panel.height).toBeLessThanOrEqual(small.height)
    expect(panel.x).toBeGreaterThanOrEqual(0)
    expect(panel.y).toBeGreaterThanOrEqual(0)
  })
})

describe('clampPanelIntoWorkspace', () => {
  it('宽度不超过工作区；位置保证至少 KEEP_VISIBLE 可见', () => {
    const huge = panel('tab-1', { x: 500, y: 700, width: 2000, height: 1500 })
    const clamped = clampPanelIntoWorkspace(huge, WS)
    expect(clamped.width).toBeLessThanOrEqual(WS.width)
    expect(clamped.height).toBeLessThanOrEqual(WS.height)
    // 右侧溢出：x 必须留下可见宽度（180）。
    expect(clamped.x).toBeLessThanOrEqual(WS.width - 180)
    expect(clamped.x + clamped.width).toBeGreaterThan(180)
  })

  it('完全不超出工作区的面板原样保留', () => {
    const inside = panel('tab-1', { x: 100, y: 100, width: 400, height: 300 })
    expect(clampPanelIntoWorkspace(inside, WS)).toEqual(inside)
  })
})

describe('snapPanelPosition', () => {
  it('吸附到工作区左上角（阈值内）', () => {
    const edges = collectSnapEdges([], 'tab-1', WS)
    const snapped = snapPanelPosition({ x: 5, y: 6 }, { width: 400, height: 300 }, edges)
    expect(snapped).toEqual({ x: 0, y: 0 })
  })

  it('吸附到另一个面板的右边缘（左=右-宽）', () => {
    const other = panel('tab-2', { x: 500, y: 0, width: 300, height: 300 })
    const edges = collectSnapEdges([other], 'tab-1', WS)
    // 面板左缘距 other 右缘 5px（在阈值内）→ 吸附成紧贴。
    const snapped = snapPanelPosition({ x: 805, y: 100 }, { width: 400, height: 300 }, edges)
    expect(snapped?.x).toBe(800)
  })

  it('超过阈值不吸附（辅助而非限制）', () => {
    const edges = collectSnapEdges([], 'tab-1', WS)
    const snapped = snapPanelPosition({ x: 30, y: 30 }, { width: 400, height: 300 }, edges)
    expect(snapped).toBeNull()
  })

  it('collectSnapEdges 不包含自己', () => {
    const self = panel('tab-1', { x: 200, y: 200 })
    const edges = collectSnapEdges([self], 'tab-1', WS)
    expect(edges.left).toEqual([0])
    expect(edges.right).toEqual([WS.width])
  })
})

describe('rectsIntersect', () => {
  it('相交判定：共享边不算重叠', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(rectsIntersect(a, { x: 100, y: 0, width: 50, height: 50 })).toBe(false)
    expect(rectsIntersect(a, { x: 99, y: 0, width: 50, height: 50 })).toBe(true)
    expect(rectsIntersect(a, { x: 0, y: 100, width: 50, height: 50 })).toBe(false)
    expect(rectsIntersect(a, { x: 50, y: 50, width: 50, height: 50 })).toBe(true)
  })
})

describe('resolveMoveWithoutOverlap', () => {
  const size = { width: 200, height: 150 }

  it('无相交时原样返回（幂等）', () => {
    const others = [panel('tab-2', { x: 500, y: 0 })]
    expect(resolveMoveWithoutOverlap({ x: 0, y: 0 }, size, others, WS)).toEqual({ x: 0, y: 0 })
  })

  it('拖到别人身上：沿最近方向推出去', () => {
    const other = panel('tab-2', { x: 200, y: 0, width: 400, height: 300 })
    // 候选 (300, 50) 与 other 相交；向上推 (300, -150) 会被 clamp 且仍相交，
    // 向下推 (300, 300) 不相交且距离最近。
    const resolved = resolveMoveWithoutOverlap({ x: 300, y: 50 }, size, [other], WS)
    expect(resolved).not.toBeNull()
    const rect = { x: resolved!.x, y: resolved!.y, width: size.width, height: size.height }
    expect(rectsIntersect(rect, other)).toBe(false)
    // 推出的位置留在工作区内。
    expect(resolved!.x).toBeGreaterThanOrEqual(-size.width + 180)
    expect(resolved!.y).toBeGreaterThanOrEqual(-size.height + 120)
  })

  it('两个障碍物：迭代解析到全部避开', () => {
    const left = panel('tab-2', { x: 0, y: 0, width: 300, height: 300 })
    const below = panel('tab-3', { x: 0, y: 300, width: 300, height: 300 })
    // 候选 (150, 150) 同时压住两个面板。
    const resolved = resolveMoveWithoutOverlap({ x: 150, y: 150 }, size, [left, below], WS)
    expect(resolved).not.toBeNull()
    const rect = { x: resolved!.x, y: resolved!.y, width: size.width, height: size.height }
    expect(rectsIntersect(rect, left)).toBe(false)
    expect(rectsIntersect(rect, below)).toBe(false)
  })

  it('被围死：返回 null（调用方保持原位，绝不重叠）', () => {
    // 四面围死，中间缝隙 (300..900, 300..500) 只有 600 宽——候选 700 宽放不进
    // 任何缝隙，四个推出方向全部无效。
    const others = [
      panel('top', { x: 0, y: 0, width: WS.width, height: 300 }),
      panel('bottom', { x: 0, y: 500, width: WS.width, height: 300 }),
      panel('left', { x: 0, y: 300, width: 300, height: 200 }),
      panel('right', { x: 900, y: 300, width: 300, height: 200 })
    ]
    const resolved = resolveMoveWithoutOverlap({ x: 350, y: 350 }, { width: 700, height: 200 }, others, WS)
    expect(resolved).toBeNull()
  })
})

describe('resolveResizeWithoutOverlap', () => {
  it('向东长宽被邻居挡住：停在其左缘，锚定边不动', () => {
    const other = panel('tab-2', { x: 800, y: 0, width: 300, height: 300 })
    const resolved = resolveResizeWithoutOverlap({ x: 0, y: 0, width: 1000, height: 300 }, 'se', [other])
    expect(resolved).toEqual({ x: 0, y: 0, width: 800, height: 300 })
  })

  it('向北长高被上邻居挡住：停在其下缘，底边不动（且不小于最小高度）', () => {
    const other = panel('tab-2', { x: 0, y: 50, width: 300, height: 150 }) // 下缘 200
    // 底边固定在 600，顶边想伸到 0——被邻居挡回 200，高度 400 ≥ 最小高度。
    const resolved = resolveResizeWithoutOverlap({ x: 0, y: 0, width: 300, height: 600 }, 'nw', [other])
    expect(resolved).toEqual({ x: 0, y: 200, width: 300, height: 400 })
  })

  it('缩到极小：clamp 到最小尺寸（无邻居时不阻止缩小）', () => {
    const resolved = resolveResizeWithoutOverlap({ x: 0, y: 0, width: 50, height: 50 }, 'se', [])
    // 解析器只挡「会重叠」的方向；最小尺寸由调用方 clamp 前保证。
    expect(resolved).toEqual({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('可用空间小于最小宽：返回 null（保持原 rect）', () => {
    const other = panel('tab-2', { x: 200, y: 0, width: 300, height: 300 })
    // 向东拉到 200 就撞邻居，而最小宽 320 > 200 → 无法满足。
    const resolved = resolveResizeWithoutOverlap({ x: 0, y: 0, width: 1000, height: 300 }, 'se', [other])
    expect(resolved).toBeNull()
  })

  it('w 锚点：右边缘定死，向左扩被挡时停在其右缘', () => {
    const other = panel('tab-2', { x: 0, y: 0, width: 200, height: 300 }) // 右缘 200
    // 候选 x=50（意图再往左），右缘固定 800。
    const resolved = resolveResizeWithoutOverlap({ x: 50, y: 0, width: 750, height: 300 }, 'w', [other])
    expect(resolved).toEqual({ x: 200, y: 0, width: 600, height: 300 })
  })
})

describe('findFreePanelSpot', () => {
  it('种子位可用：直接用', () => {
    const spot = findFreePanelSpot({ x: 24, y: 16 }, { width: 400, height: 300 }, [], WS)
    expect(spot).toEqual({ x: 24, y: 16 })
  })

  it('种子位被占：扫描到第一个空位且不与任何面板相交', () => {
    const occupied = panel('tab-1', { x: 0, y: 0, width: 560, height: 420 })
    const spot = findFreePanelSpot({ x: 60, y: 48 }, { width: 560, height: 420 }, [occupied], WS)
    expect(spot).not.toBeNull()
    const rect = { x: spot!.x, y: spot!.y, width: 560, height: 420 }
    expect(rectsIntersect(rect, occupied)).toBe(false)
    expect(spot!.x).toBeGreaterThanOrEqual(0)
    expect(spot!.x + 560).toBeLessThanOrEqual(WS.width)
    expect(spot!.y + 420).toBeLessThanOrEqual(WS.height)
  })

  it('工作区放不下该尺寸：返回 null', () => {
    const walls = [
      panel('a', { x: 0, y: 0, width: WS.width, height: 200 }),
      panel('b', { x: 0, y: 200, width: WS.width, height: 600 })
    ]
    const spot = findFreePanelSpot({ x: 24, y: 16 }, { width: 400, height: 300 }, walls, WS)
    expect(spot).toBeNull()
  })
})
