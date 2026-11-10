package com.brewphase.android.domain.engine

import com.brewphase.android.domain.model.BeanStatus

/**
 * 一包豆的库存状态，脱离 Room 存在。
 *
 * 规则全部来自 iOS `Bean.consume / deduct / refund / setRemaining`：
 * 库存永不为负、永不超过总克数；手改库存会抬高总克数（用户比谁都清楚袋里有多少），
 * 并记下盘点时刻。
 */
data class BeanStock(
    val weightG: Double,
    val remainingG: Double,
    val status: BeanStatus,
    val stockCountedAtMillis: Long?,
) {
    fun withConsume(grams: Double): BeanStock {
        val next = minOf(maxOf(remainingG - grams, 0.0), maxOf(weightG, 0.0))
        return copy(remainingG = next)
    }

    /** 扣掉至多 `grams`，返回实际扣掉的克数与新状态。 */
    fun deduct(grams: Double): Pair<BeanStock, Double> {
        if (grams <= 0) return this to 0.0
        val next = withConsume(grams)
        return next to maxOf(remainingG - next.remainingG, 0.0)
    }

    /** 还回 `grams`，返回实际还回去的克数与新状态（受总容量限制）。 */
    fun refund(grams: Double): Pair<BeanStock, Double> {
        if (grams <= 0) return this to 0.0
        val next = withConsume(-grams)
        return next to maxOf(next.remainingG - remainingG, 0.0)
    }

    /**
     * 人工盘点：把剩余量设成 `grams`。
     *
     * 三条规则都在这里，调整页只负责把结果说清楚再调用：
     * 负数按 0；剩余大于总克数就抬高总克数；已经喝完的袋子改出正数时回到「在喝」。
     * 同时记下盘点时刻——从这个数字往后，更早的冲煮记录不再参与回补。
     */
    fun setRemaining(grams: Double, nowMillis: Long): BeanStock {
        val next = maxOf(grams, 0.0)
        val weight = if (next > weightG) next else weightG
        val status = if (next > 0 && status == BeanStatus.Finished) BeanStatus.Active else status
        return copy(
            weightG = weight,
            remainingG = next,
            status = status,
            stockCountedAtMillis = nowMillis,
        )
    }
}

/**
 * 一条冲煮记录在库存这件事上的样子。
 *
 * `stockDeductedG == null` 表示这条记录写于该字段存在之前：没有真相可查，
 * 只能按粉量算，也就是旧行为。
 */
data class BrewStockState(
    val coffeeG: Double,
    val stockDeductedG: Double?,
    val createdAtMillis: Long,
) {
    val appliedStockDeductedG: Double get() = stockDeductedG ?: coffeeG

    /**
     * 这条记录是否已被一次人工盘点结算过。
     *
     * 盘点之后 `remainingG` 是用户称出来的事实；盘之前的冲煮已经包含在那个数字里，
     * 再退一次就是退到一份已经算过它的账上。
     */
    fun isSettledForStock(bean: BeanStock): Boolean {
        val countedAt = bean.stockCountedAtMillis ?: return false
        return createdAtMillis < countedAt
    }
}

/** 新建一次冲煮后，豆子与记录各自该变成什么样。 */
data class NewBrewStock(
    val bean: BeanStock,
    val deductedG: Double,
)

/** 编辑一次冲煮后，库存与实扣量该变成什么样。 */
data class EditBrewStock(
    val bean: BeanStock,
    val deductedG: Double,
)

/**
 * 库存账本：**唯一**的库存写入规则。
 *
 * 界面只负责收集输入，这里负责扣、退、盘点结算。任何编辑器（完整表单、30 秒快记、
 * 以后的导入）都走同一段逻辑，数据不会因为漏了一步而悄悄不一致。
 */
object StockLedger {

    /** 新建冲煮：扣 `coffeeG`，记下**实际**扣掉的量。 */
    fun onBrewCreated(bean: BeanStock, coffeeG: Double): NewBrewStock {
        val (next, actual) = bean.deduct(coffeeG)
        return NewBrewStock(bean = next, deductedG = actual)
    }

    /**
     * 编辑冲煮：按**实扣量的差值**调整库存。
     *
     * 用 `coffeeG` 做差值会把"袋里不够、只扣得掉一部分"的记录算错——那正是库存
     * 凭空变多或变少的地方。已被盘点结算的记录实扣量归零，将来删除也不再退。
     */
    fun onBrewEdited(
        bean: BeanStock,
        previousApplied: Double,
        newCoffeeG: Double,
        settled: Boolean,
    ): EditBrewStock {
        if (settled) {
            return EditBrewStock(bean = bean, deductedG = 0.0)
        }
        val delta = newCoffeeG - previousApplied
        val before = bean.remainingG
        val next = bean.withConsume(delta)
        val actualChange = next.remainingG - before
        val deducted = maxOf(0.0, previousApplied - actualChange)
        return EditBrewStock(bean = next, deductedG = deducted)
    }

    /**
     * 删除冲煮：把当时**实际**扣掉的粉还回去。
     *
     * 已被盘点结算的记录一分不退；旧记录（没有实扣量）按粉量退，与升级前一致。
     * 还完之后如果袋子有货了，状态回到「在喝」。
     */
    fun onBrewDeleted(bean: BeanStock, applied: Double, settled: Boolean): BeanStock {
        if (settled) return bean
        val (refunded, _) = bean.refund(applied)
        return if (refunded.status == BeanStatus.Finished && refunded.remainingG > 0) {
            refunded.copy(status = BeanStatus.Active)
        } else {
            refunded
        }
    }
}
