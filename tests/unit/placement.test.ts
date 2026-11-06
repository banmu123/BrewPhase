import { describe, expect, it } from 'vitest'
import { contentBounds, intersects, nextNodeOrigin } from '@shared/domain/placement'
import { dayAfterRoast, phaseFor } from '@shared/domain/phase'

const rule = { restMinDays: 2, restMaxDays: 5, peakStartDay: 5, peakEndDay: 21, declineStartDay: 21 }

describe('nextNodeOrigin', () => {
  it('空画布：第一张放在起点', () => {
    expect(nextNodeOrigin({ occupied: [], width: 240, height: 180 })).toEqual({ x: 0, y: 0 })
  })

  it('不压住已有节点', () => {
    const occupied = [{ x: 0, y: 0, width: 240, height: 180 }]
    const origin = nextNodeOrigin({ occupied, width: 240, height: 180 })
    expect(intersects({ ...origin, width: 240, height: 180 }, occupied[0], 8)).toBe(false)
  })

  it('连续添加五张：两两不重叠', () => {
    const occupied: { x: number; y: number; width: number; height: number }[] = []
    for (let index = 0; index < 5; index += 1) {
      const origin = nextNodeOrigin({ occupied, width: 220, height: 170 })
      occupied.push({ ...origin, width: 220, height: 170 })
    }
    for (let a = 0; a < occupied.length; a += 1) {
      for (let b = a + 1; b < occupied.length; b += 1) {
        expect(intersects(occupied[a], occupied[b])).toBe(false)
      }
    }
  })
})

describe('contentBounds', () => {
  it('包住所有节点', () => {
    const bounds = contentBounds([
      { x: -100, y: 0, width: 240, height: 180 },
      { x: 400, y: 300, width: 220, height: 170 }
    ])
    expect(bounds).toEqual({ x: -100, y: 0, width: 720, height: 470 })
  })

  it('空画布没有包围盒', () => {
    expect(contentBounds([])).toBeNull()
  })
})

describe('phaseFor', () => {
  it('四个阶段的边界与 iOS 一致', () => {
    expect(phaseFor(0, rule)).toBe('resting')
    expect(phaseFor(1, rule)).toBe('resting')
    expect(phaseFor(2, rule)).toBe('opening')
    expect(phaseFor(4, rule)).toBe('opening')
    expect(phaseFor(5, rule)).toBe('peak')
    expect(phaseFor(21, rule)).toBe('peak')
    expect(phaseFor(22, rule)).toBe('declining')
  })

  it('没有烘焙日期就没有阶段（不是 Day 0）', () => {
    expect(phaseFor(null, rule)).toBeNull()
    expect(dayAfterRoast(null)).toBeNull()
  })
})

describe('dayAfterRoast', () => {
  it('按自然日算，不按 24 小时算', () => {
    const roast = new Date('2026-11-01T18:00:00').getTime()
    const today = new Date('2026-11-03T09:00:00').getTime()
    expect(dayAfterRoast(roast, today)).toBe(2)
  })

  it('烘焙日期在未来（脏数据）：钳到 0', () => {
    const roast = new Date('2026-11-10T09:00:00').getTime()
    const today = new Date('2026-11-03T09:00:00').getTime()
    expect(dayAfterRoast(roast, today)).toBe(0)
  })
})
