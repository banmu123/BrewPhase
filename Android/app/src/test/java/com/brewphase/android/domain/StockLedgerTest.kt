package com.brewphase.android.domain

import com.brewphase.android.domain.engine.BeanStock
import com.brewphase.android.domain.engine.StockLedger
import com.brewphase.android.domain.model.BeanStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 库存账本：全应用唯一的扣/退规则。
 *
 * 最关键的三条：
 * 1. 只扣得掉多少就记多少（`stockDeductedG` 不等于 `coffeeG`）；
 * 2. 编辑按**实扣量差额**调整；
 * 3. 盘点之前的记录不再参与自动退粉。
 */
class StockLedgerTest {

    private fun stock(remaining: Double, weight: Double = 250.0, countedAt: Long? = null) =
        BeanStock(weightG = weight, remainingG = remaining, status = BeanStatus.Active, stockCountedAtMillis = countedAt)

    @Test
    fun `new brew deducts the dose and records it`() {
        val result = StockLedger.onBrewCreated(stock(250.0), 18.0)
        assertEquals(232.0, result.bean.remainingG, 0.0001)
        assertEquals(18.0, result.deductedG, 0.0001)
    }

    @Test
    fun `a nearly empty bag only deducts what is left`() {
        val result = StockLedger.onBrewCreated(stock(5.0), 18.0)
        assertEquals(0.0, result.bean.remainingG, 0.0001)
        assertEquals(5.0, result.deductedG, 0.0001)
    }

    @Test
    fun `deleting refunds the actual deducted grams, not the dose`() {
        val bean = stock(0.0)
        val next = StockLedger.onBrewDeleted(bean, applied = 5.0, settled = false)
        assertEquals(5.0, next.remainingG, 0.0001)
    }

    @Test
    fun `deleting a settled brew refunds nothing`() {
        val bean = stock(120.0)
        val next = StockLedger.onBrewDeleted(bean, applied = 18.0, settled = true)
        assertEquals(120.0, next.remainingG, 0.0001)
    }

    @Test
    fun `refund is capped by the bag capacity`() {
        val bean = stock(250.0)
        val next = StockLedger.onBrewDeleted(bean, applied = 30.0, settled = false)
        assertEquals(250.0, next.remainingG, 0.0001)
    }

    @Test
    fun `editing a brew adjusts by the difference`() {
        // 原来扣了 18g，改成 20g：只多扣 2g。
        val result = StockLedger.onBrewEdited(stock(232.0), previousApplied = 18.0, newCoffeeG = 20.0, settled = false)
        assertEquals(230.0, result.bean.remainingG, 0.0001)
        assertEquals(20.0, result.deductedG, 0.0001)
    }

    @Test
    fun `editing downwards refunds the difference`() {
        val result = StockLedger.onBrewEdited(stock(232.0), previousApplied = 18.0, newCoffeeG = 15.0, settled = false)
        assertEquals(235.0, result.bean.remainingG, 0.0001)
        assertEquals(15.0, result.deductedG, 0.0001)
    }

    @Test
    fun `editing a settled brew does not move stock`() {
        val bean = stock(100.0)
        val result = StockLedger.onBrewEdited(bean, previousApplied = 18.0, newCoffeeG = 25.0, settled = true)
        assertEquals(100.0, result.bean.remainingG, 0.0001)
        assertEquals(0.0, result.deductedG, 0.0001)
    }

    @Test
    fun `manual stock take records the count time and never goes negative`() {
        val bean = stock(80.0).setRemaining(-10.0, nowMillis = 1_000)
        assertEquals(0.0, bean.remainingG, 0.0001)
        assertEquals(1_000L, bean.stockCountedAtMillis)
    }

    @Test
    fun `manual stock take raises the bag weight when needed`() {
        val bean = stock(10.0, weight = 200.0).setRemaining(260.0, nowMillis = 1)
        assertEquals(260.0, bean.weightG, 0.0001)
        assertEquals(260.0, bean.remainingG, 0.0001)
    }

    @Test
    fun `stock take brings a finished bag back to active`() {
        val finished = BeanStock(250.0, 0.0, BeanStatus.Finished, null)
        val bean = finished.setRemaining(30.0, nowMillis = 1)
        assertEquals(BeanStatus.Active, bean.status)
    }

    @Test
    fun `settled check compares record creation against the count time`() {
        val counted = stock(100.0, countedAt = 5_000)
        assertTrue(com.brewphase.android.domain.engine.BrewStockState(18.0, 18.0, 4_000).isSettledForStock(counted))
        assertFalse(com.brewphase.android.domain.engine.BrewStockState(18.0, 18.0, 6_000).isSettledForStock(counted))
        // 从没盘点过：所有记录都参与回补。
        assertFalse(
            com.brewphase.android.domain.engine.BrewStockState(18.0, 18.0, 4_000)
                .isSettledForStock(stock(100.0, countedAt = null)),
        )
    }

    @Test
    fun `legacy record without stockDeducted falls back to the dose`() {
        val legacy = com.brewphase.android.domain.engine.BrewStockState(18.0, null, 1_000)
        assertEquals(18.0, legacy.appliedStockDeductedG, 0.0001)
    }
}
