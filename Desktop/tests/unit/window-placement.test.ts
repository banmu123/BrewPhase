import { describe, expect, it } from 'vitest'
import { fitRectIntoBounds } from '../../src/shared/window-placement'

/**
 * 多窗口摆放几何（Phase 3）。
 *
 * Electron 的屏幕坐标是虚拟桌面坐标系：扩展显示器在主显示器左边或上方时，
 * 坐标是**负的**。Phase 2 的浮窗用 `Math.max(0, …)` 修正位置，多显示器下
 * 窗口会落到主显示器——这里的用例就是那些真实会翻车的排列。
 */

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }

describe('fitRectIntoBounds：常规显示器', () => {
  it('窗口贴着落点居中', () => {
    const rect = fitRectIntoBounds({ x: 960, y: 540 }, 680, 540, WORK_AREA)
    expect(rect).toEqual({ x: 960 - 340, y: 540 - 270, width: 680, height: 540 })
  })

  it('落点靠近右边缘：收进工作区，不出屏', () => {
    const rect = fitRectIntoBounds({ x: 1900, y: 900 }, 680, 540, WORK_AREA)
    expect(rect.x).toBe(1920 - 680)
    expect(rect.y).toBe(1080 - 540)
  })

  it('落点缺省：居中在工作区里', () => {
    const rect = fitRectIntoBounds(null, 680, 540, WORK_AREA)
    expect(rect.x).toBe(Math.round((1920 - 680) / 2))
    expect(rect.y).toBe(Math.round((1080 - 540) / 2))
  })

  it('窗口比工作区还大：贴齐工作区左上角', () => {
    const rect = fitRectIntoBounds({ x: 100, y: 100 }, 2400, 1300, WORK_AREA)
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(0)
    expect(rect.width).toBe(2400)
    expect(rect.height).toBe(1300)
  })
})

describe('fitRectIntoBounds：负坐标显示器（规格 §5 的核心场景）', () => {
  it('副屏在主屏左侧：x = -1920 起步，落点在副屏就留在副屏', () => {
    const leftDisplay = { x: -1920, y: 0, width: 1920, height: 1080 }
    const rect = fitRectIntoBounds({ x: -1000, y: 400 }, 680, 540, leftDisplay)
    expect(rect.x).toBe(-1000 - 340)
    expect(rect.y).toBe(400 - 270)
    // 绝不允许 Math.max(0,…) 把窗口拽回主屏。
    expect(rect.x).toBeLessThan(0)
  })

  it('副屏在主屏上方：y 为负；窗口收进该屏的 workArea', () => {
    const topDisplay = { x: 0, y: -1080, width: 2560, height: 1440 }
    const rect = fitRectIntoBounds({ x: 800, y: -1040 }, 680, 540, topDisplay)
    expect(rect.x).toBe(800 - 340)
    // 落点离屏幕顶边只有 40px，居中会越界：钳到该屏顶边（仍然在这块屏上）。
    expect(rect.y).toBe(topDisplay.y)
    expect(rect.y).toBeGreaterThanOrEqual(topDisplay.y)
    expect(rect.y + rect.height).toBeLessThanOrEqual(topDisplay.y + topDisplay.height)
  })

  it('落点在负坐标屏幕的边缘：窗口完整可见，不跑到更左/更上', () => {
    const leftDisplay = { x: -1920, y: 0, width: 1920, height: 1080 }
    const rect = fitRectIntoBounds({ x: -1900, y: 60 }, 680, 540, leftDisplay)
    expect(rect.x).toBe(leftDisplay.x)
    expect(rect.y).toBe(leftDisplay.y)
  })

  it('dock/菜单栏占用的 workArea 同样适用（非零起点）', () => {
    const docked = { x: 0, y: 25, width: 1512, height: 960 }
    const rect = fitRectIntoBounds({ x: 1500, y: 1000 }, 680, 540, docked)
    expect(rect.x).toBe(1512 - 680)
    expect(rect.y).toBe(25 + 960 - 540)
    expect(rect.y).toBeGreaterThanOrEqual(docked.y)
  })
})
