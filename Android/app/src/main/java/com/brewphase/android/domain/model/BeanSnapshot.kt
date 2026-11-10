package com.brewphase.android.domain.model

import java.time.LocalDate

/**
 * 引擎真正需要的东西。
 *
 * 传值类型进来，而不是把 Room 实体塞给引擎：PhaseEngine 因此可以脱离数据库
 * 单测，也不需要知道 SQLite 长什么样。字段与 iOS `BeanSnapshot` 对齐。
 */
data class BeanSnapshot(
    val id: String,
    val name: String,
    val roaster: String,
    val roastLevel: RoastLevel,
    val roastDate: LocalDate?,
    val openDate: LocalDate?,
    val weightG: Double,
    val remainingG: Double,
    val imagePath: String?,
    val flavorTags: List<String>,
    val status: BeanStatus,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
    val stockCountedAtMillis: Long? = null,
    val isSample: Boolean = false,
) {
    /** 「喝完了吗」的唯一判据：声明过 finished，或剩余量归零。 */
    val isFinished: Boolean get() = status == BeanStatus.Finished || remainingG <= 0.0

    /** 相对烘焙日期的第几天；没有烘焙日期时是 null，而不是 0。 */
    fun dayAfterRoast(on: LocalDate): Int? {
        val roast = roastDate ?: return null
        return com.brewphase.android.core.DateMath.daysBetween(roast, on)
    }
}

/** 冲煮样本，供消耗估算使用。 */
data class BrewSample(
    val date: LocalDate,
    val coffeeG: Double,
    val waterG: Double,
)
