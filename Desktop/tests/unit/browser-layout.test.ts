import { describe, expect, it } from 'vitest'
import {
  BROWSER_TOP_INSET,
  clampBrowserBounds,
  defaultBrowserBounds,
  fitBrowserBounds,
  isUsableBrowserBounds,
  moveBrowserBounds,
  resizeBrowserBounds
} from '@shared/browser-layout'
import { BROWSER_MIN_HEIGHT, BROWSER_MIN_WIDTH } from '@shared/contracts/browser'

/**
 * 浮窗几何。这些函数同时被渲染层（算位置）和主进程（clamp 后写进
 * WebContentsView）调用，所以断言要覆盖「越界」「最小尺寸」「锚定边不漂移」
 * 与「不盖住顶栏」。
 */

const VIEWPORT = { width: 1200, height: 760 }

describe('clampBrowserBounds', () => {
  it('尺寸不小于最小宽高', () => {
    const result = clampBrowserBounds({ x: 10, y: 10, width: 100, height: 100 }, VIEWPORT)
    expect(result.width).toBe(BROWSER_MIN_WIDTH)
    expect(result.height).toBe(BROWSER_MIN_HEIGHT)
  })

  it('尺寸不超过窗口，位置被推回可视区', () => {
    const result = clampBrowserBounds({ x: 5000, y: 5000, width: 5000, height: 5000 }, VIEWPORT)
    expect(result.width).toBe(VIEWPORT.width)
    expect(result.height).toBe(VIEWPORT.height)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
  })

  it('负坐标收回边界；纵向不得盖住顶栏', () => {
    const result = clampBrowserBounds({ x: -80, y: -40, width: 600, height: 400 }, VIEWPORT)
    expect(result.x).toBe(0)
    expect(result.y).toBe(BROWSER_TOP_INSET)
  })

  it('窗口比最小尺寸还小时不产生负的可用空间', () => {
    const tiny = { width: 320, height: 200 }
    const result = clampBrowserBounds({ x: 0, y: 0, width: 900, height: 700 }, tiny)
    expect(result.width).toBe(BROWSER_MIN_WIDTH)
    expect(result.height).toBe(BROWSER_MIN_HEIGHT)
    expect(result.x).toBe(0)
    // 窗口装不下「顶栏 + 最小高度」时让底部对齐，而不是把浮窗顶出窗口。
    expect(result.y).toBe(0)
  })
})

describe('defaultBrowserBounds', () => {
  it('居中、约 82%，且避开顶栏', () => {
    const result = defaultBrowserBounds(VIEWPORT)
    expect(result.width).toBe(Math.round(VIEWPORT.width * 0.82))
    expect(result.height).toBe(Math.round(VIEWPORT.height * 0.82))
    expect(result.x).toBe(Math.round((VIEWPORT.width - result.width) / 2))
    expect(result.y).toBeGreaterThanOrEqual(64)
  })

  it('小窗口下退到最小尺寸而不是负数', () => {
    const result = defaultBrowserBounds({ width: 500, height: 400 })
    expect(result.width).toBeGreaterThanOrEqual(BROWSER_MIN_WIDTH)
    expect(result.height).toBeGreaterThanOrEqual(BROWSER_MIN_HEIGHT)
    expect(result.x).toBeGreaterThanOrEqual(0)
    expect(result.y).toBeGreaterThanOrEqual(0)
  })
})

describe('moveBrowserBounds', () => {
  const start = { x: 100, y: 100, width: 600, height: 400 }

  it('正常位移直接生效', () => {
    expect(moveBrowserBounds(start, 40, -30, VIEWPORT)).toEqual({
      x: 140,
      y: 70,
      width: 600,
      height: 400
    })
  })

  it('拖到右/下边停住，不会被甩出窗口', () => {
    const right = moveBrowserBounds(start, 9999, 9999, VIEWPORT)
    expect(right.x).toBe(VIEWPORT.width - 600)
    expect(right.y).toBe(VIEWPORT.height - 400)
  })

  it('拖到左/上边停住（上边停在顶栏下沿）', () => {
    const left = moveBrowserBounds(start, -9999, -9999, VIEWPORT)
    expect(left.x).toBe(0)
    expect(left.y).toBe(BROWSER_TOP_INSET)
  })
})

describe('resizeBrowserBounds', () => {
  const start = { x: 200, y: 150, width: 600, height: 400 }

  it('e 只改宽度，左边缘不动', () => {
    const result = resizeBrowserBounds(start, 100, 50, 'e', VIEWPORT)
    expect(result.x).toBe(200)
    expect(result.width).toBe(700)
    expect(result.height).toBe(400)
  })

  it('s 只改高度，上边缘不动', () => {
    const result = resizeBrowserBounds(start, 100, 100, 's', VIEWPORT)
    expect(result.y).toBe(150)
    expect(result.height).toBe(500)
  })

  it('w 改宽度且右边缘锚定（拖到最小也不漂移）', () => {
    const result = resizeBrowserBounds(start, 5000, 0, 'w', VIEWPORT)
    expect(result.width).toBe(BROWSER_MIN_WIDTH)
    expect(result.x + result.width).toBe(start.x + start.width)
  })

  it('n 改高度且下边缘锚定', () => {
    const result = resizeBrowserBounds(start, 0, 5000, 'n', VIEWPORT)
    expect(result.height).toBe(BROWSER_MIN_HEIGHT)
    expect(result.y + result.height).toBe(start.y + start.height)
  })

  it('四角同时改宽高', () => {
    const se = resizeBrowserBounds(start, 60, 40, 'se', VIEWPORT)
    expect(se.width).toBe(660)
    expect(se.height).toBe(440)
    expect(se.x).toBe(200)
    expect(se.y).toBe(150)

    const nw = resizeBrowserBounds(start, -40, -30, 'nw', VIEWPORT)
    expect(nw.width).toBe(640)
    expect(nw.height).toBe(430)
    expect(nw.x + nw.width).toBe(start.x + start.width)
    expect(nw.y + nw.height).toBe(start.y + start.height)
  })

  it('放大不会超出窗口：宽度被窗口右边缘截住', () => {
    const result = resizeBrowserBounds(start, 9999, 0, 'e', VIEWPORT)
    expect(result.x + result.width).toBeLessThanOrEqual(VIEWPORT.width)
  })

  it('缩小到最小尺寸后继续拖，尺寸不再变', () => {
    const once = resizeBrowserBounds(start, -9999, -9999, 'nw', VIEWPORT)
    const twice = resizeBrowserBounds(once, -9999, -9999, 'nw', VIEWPORT)
    expect(twice.width).toBe(once.width)
    expect(twice.height).toBe(once.height)
  })
})

describe('fitBrowserBounds / isUsableBrowserBounds', () => {
  it('窗口变小后把浮窗收回来', () => {
    const stored = { x: 400, y: 300, width: 900, height: 600 }
    const fitted = fitBrowserBounds(stored, { width: 800, height: 500 })
    expect(fitted.width).toBeLessThanOrEqual(800)
    expect(fitted.height).toBeLessThanOrEqual(500)
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(800)
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(500)
  })

  it('保存的布局：尺寸够大才算可用', () => {
    expect(isUsableBrowserBounds(null)).toBe(false)
    expect(isUsableBrowserBounds({ x: 0, y: 0, width: 200, height: 200 })).toBe(false)
    expect(isUsableBrowserBounds({ x: 0, y: 0, width: 600, height: 400 })).toBe(true)
    expect(isUsableBrowserBounds({ x: Number.NaN, y: 0, width: 600, height: 400 })).toBe(false)
  })
})
