import { describe, expect, it } from 'vitest'
import { adjustForEdit, appliedDeduction, deductStock, isSettledForStock, refundStock } from '@shared/domain/inventory'

/**
 * 库存规则的单测。这些数字都来自 iOS `BrewRecorder` 的真实行为：
 * 「袋里只有 5g 时记一杯 18g」这种边界，写错一次就是库存凭空多出 13g。
 */
describe('deductStock', () => {
  it('袋里够：按粉量扣，实扣量等于粉量', () => {
    expect(deductStock(200, 15)).toEqual({ remainingG: 185, appliedG: 15 })
  })

  it('袋里不够：只扣得掉剩下的，实扣量跟着变小', () => {
    expect(deductStock(5, 18)).toEqual({ remainingG: 0, appliedG: 5 })
  })

  it('剩余量为负（脏数据）时不会把库存扣成负数', () => {
    expect(deductStock(-3, 15)).toEqual({ remainingG: 0, appliedG: 0 })
  })

  it('浮点噪声收敛到三位小数', () => {
    expect(deductStock(0.3, 0.1)).toEqual({ remainingG: 0.2, appliedG: 0.1 })
  })
})

describe('refundStock', () => {
  it('退粉是加法，不做「总量」上限钳制', () => {
    // 盘点之后重量本来就可能与标称总量不一致，按总量钳制会把用户称出来的数字改掉。
    expect(refundStock(12, 18)).toBe(30)
  })
})

describe('isSettledForStock', () => {
  it('盘点之前创建的冲煮 = 已结算', () => {
    expect(isSettledForStock(1_000, 2_000)).toBe(true)
  })

  it('盘点之后创建的冲煮 = 未结算', () => {
    expect(isSettledForStock(3_000, 2_000)).toBe(false)
  })

  it('从没盘点过：所有记录都参与自动退粉', () => {
    expect(isSettledForStock(1_000, null)).toBe(false)
  })
})

describe('appliedDeduction', () => {
  it('新记录用实扣量；旧记录（null）退回粉量', () => {
    expect(appliedDeduction({ stockDeductedG: 5, coffeeG: 18 })).toBe(5)
    expect(appliedDeduction({ stockDeductedG: null, coffeeG: 18 })).toBe(18)
  })
})

describe('adjustForEdit', () => {
  it('粉量变大：只扣差额，实扣量按实际变动更新', () => {
    const result = adjustForEdit({ remainingG: 100, nextCoffeeG: 20, previousAppliedG: 15 })
    expect(result).toEqual({ remainingG: 95, appliedG: 20 })
  })

  it('粉量变大但袋里不够：只扣得掉剩下的', () => {
    const result = adjustForEdit({ remainingG: 3, nextCoffeeG: 20, previousAppliedG: 15 })
    expect(result).toEqual({ remainingG: 0, appliedG: 18 })
  })

  it('粉量变小：差额全额退回，实扣量跟着减少', () => {
    const result = adjustForEdit({ remainingG: 100, nextCoffeeG: 10, previousAppliedG: 15 })
    expect(result).toEqual({ remainingG: 105, appliedG: 10 })
  })

  it('粉量没变：库存与实扣量都不动', () => {
    const result = adjustForEdit({ remainingG: 100, nextCoffeeG: 15, previousAppliedG: 15 })
    expect(result).toEqual({ remainingG: 100, appliedG: 15 })
  })
})
