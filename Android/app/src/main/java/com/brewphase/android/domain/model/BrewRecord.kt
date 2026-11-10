package com.brewphase.android.domain.model

import com.brewphase.android.domain.engine.BrewMath
import com.brewphase.android.domain.engine.BrewRecipe

/** 五项感官评价。都是 0…5，0 表示没填。 */
data class TasteProfile(
    val acidity: Int = 0,
    val sweetness: Int = 0,
    val bitterness: Int = 0,
    val body: Int = 0,
    val aftertaste: Int = 0,
) {
    val hasDetail: Boolean
        get() = acidity > 0 || sweetness > 0 || bitterness > 0 || body > 0 || aftertaste > 0
}

/**
 * 一次冲煮。
 *
 * `ratio` 是**派生**的，绝不存储：把比例和粉水一起存下来，就是邀请三个数字将来
 * 互相矛盾。
 */
data class BrewRecord(
    val id: String,
    val beanId: String,
    val dateMillis: Long,
    val recipe: BrewRecipe,
    val score: Int,
    val taste: TasteProfile,
    val flavorTags: List<String>,
    val notes: String,
    val createdAtMillis: Long,
    val stockDeductedG: Double?,
) {
    val ratioValue: Double get() = BrewMath.ratioValue(recipe.coffeeG, recipe.waterG)
    val ratioText: String
        get() {
            val r = ratioValue
            return if (r > 0) "1:%.1f".format(r) else ""
        }

    val timeText: String get() = BrewMath.formatTime(recipe.timeSeconds)

    /** 撤销这条记录时该退回的克数。旧记录没有实扣量，退回粉量本身。 */
    val appliedStockDeductedG: Double get() = stockDeductedG ?: recipe.coffeeG

    /** 值不值得在风味时间线上占一个节点：没分、没标签、没备注就是噪声。 */
    val hasTimelineMaterial: Boolean
        get() = score > 0 || flavorTags.isNotEmpty() || notes.isNotBlank()
}

/** 一次品鉴。`source` 区分手写与冲煮镜像。 */
data class TastingRecord(
    val id: String,
    val beanId: String,
    val dateMillis: Long,
    val dayAfterRoast: Int,
    val flavorTags: List<String>,
    val score: Int,
    val notes: String,
    val source: TastingSource,
    val brewId: String?,
    val createdAtMillis: Long,
) {
    val isMirror: Boolean get() = source == TastingSource.Brew
}
