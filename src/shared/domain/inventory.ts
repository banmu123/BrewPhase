/**
 * 库存规则的**纯函数**实现。
 *
 * 逐条对应 iOS `BrewRecorder`（docs/DATA_MODEL_MAPPING.md §3）：
 * 1. 新建冲煮：按粉量扣，袋里不够就只扣得掉多少，`applied` 记录实扣量；
 * 2. 编辑冲煮：按「新粉量 − 原实扣量」的差值调整库存，再用实际变动量修正实扣量；
 * 3. 删除冲煮：退**实扣量**，不是粉量——袋里不够时两者不等；
 * 4. 已被人工盘点结算的冲煮（创建时间早于盘点时刻）：一分不动。
 *
 * 这些规则不写在 repository 里，是因为它们最容易写错、也最值得单测。
 */

export type StockDeduction = {
  /** 扣完之后的剩余量，永不为负。 */
  remainingG: number
  /** 实际扣掉的克数；袋里不够时小于请求量。 */
  appliedG: number
}

export function deductStock(remainingG: number, requestedG: number): StockDeduction {
  const remaining = Math.max(0, remainingG)
  const requested = Math.max(0, requestedG)
  const applied = Math.min(remaining, requested)
  return { remainingG: round3(remaining - applied), appliedG: round3(applied) }
}

/** 退粉：不做上限钳制——盘点之后重量本来就可能与「总量」不一致。 */
export function refundStock(remainingG: number, amountG: number): number {
  return round3(Math.max(0, remainingG) + Math.max(0, amountG))
}

/**
 * 这条冲煮是否已被一次**人工盘点**结算过。
 *
 * 盘点是一次重新计数：盘之前记的冲煮已经包含在这个数字里，再对它们退粉就是
 * 把粉退到一份已经算过它的账上。所以「冲煮创建时间早于盘点时刻」= 已结算。
 */
export function isSettledForStock(brewCreatedAt: number, stockCountedAt: number | null): boolean {
  if (stockCountedAt == null) return false
  return brewCreatedAt < stockCountedAt
}

/** 旧记录没有 `stockDeductedG`：只能按粉量退，与升级前的行为一致。 */
export function appliedDeduction(brew: { stockDeductedG: number | null; coffeeG: number }): number {
  return brew.stockDeductedG ?? brew.coffeeG
}

/**
 * 编辑一条冲煮时的库存调整。
 *
 * `previousAppliedG` 必须在写入新粉量**之前**读出——顺序反了，差值永远是 0，
 * 改粉量不动库存（iOS 端踩过这个坑，注释写在那里）。
 */
export function adjustForEdit(params: {
  remainingG: number
  nextCoffeeG: number
  previousAppliedG: number
}): StockDeduction {
  const { remainingG, nextCoffeeG, previousAppliedG } = params
  const delta = Math.max(0, nextCoffeeG) - Math.max(0, previousAppliedG)
  const remaining = Math.max(0, remainingG)

  // 库存的**实际**变动：粉量变大时受剩余量限制，变小时全额退回。
  const remainingChange = delta >= 0 ? -deductStock(remaining, delta).appliedG : -delta
  // 实扣量按实际变动修正，而不是直接写成新粉量——袋里不够时两者不等。
  const appliedG = Math.max(0, previousAppliedG - remainingChange)
  return { remainingG: round3(remaining + remainingChange), appliedG: round3(appliedG) }
}

/** 三次小数足够：咖啡秤的分辨率远到不了 0.0005g，浮点噪声不该落库。 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
