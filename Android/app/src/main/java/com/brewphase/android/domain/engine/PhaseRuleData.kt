package com.brewphase.android.domain.engine

import com.brewphase.android.domain.model.RoastLevel

/**
 * 一包豆的风味窗口，作为**值**存在。
 *
 * 引擎读它、数据库存它、测试手搓它。这里没有一个常量是"规则本身"：
 * 下面 `DefaultPhaseRules` 只是应用播种时的默认值，用户改过之后一切以库里的为准。
 */
data class PhaseRuleData(
    val roastLevel: RoastLevel,
    val restMinDays: Int,
    val restMaxDays: Int,
    val peakStartDay: Int,
    val peakEndDay: Int,
    val declineStartDay: Int,
    val enabled: Boolean,
) {
    /**
     * 把用户手改的规则夹回能算的范围内。
     *
     * 编辑页允许输入任何数字，所以"胡说八道"在这里被安静地收掉，而不是等到
     * 日期计算时才炸：窗口不能先结束再开始，衰减点不能早于黄金窗口。
     * `restMaxDays` 被夹在 `[restMinDays, peakStartDay]`——它描述的是排气**结束**
     * 的时间（"排气期 3–7 天"），所以不可能晚于黄金窗口开启那天。
     */
    fun normalized(): PhaseRuleData {
        val restMin = maxOf(0, restMinDays)
        val peakStart = maxOf(1, peakStartDay)
        val restMax = minOf(maxOf(restMaxDays, restMin), peakStart)
        val peakEnd = maxOf(peakStart + 1, peakEndDay)
        val declineStart = maxOf(peakStart + 1, declineStartDay)
        return copy(
            restMinDays = restMin,
            restMaxDays = restMax,
            peakStartDay = peakStart,
            peakEndDay = peakEnd,
            declineStartDay = declineStart,
        )
    }

    fun matchesDefaults(): Boolean = this == DefaultPhaseRules.data(roastLevel)
}

/**
 * iOS §7 出货时的风味窗口。都是**估算**，界面必须这么说，永远不用"过期"这个词。
 */
object DefaultPhaseRules {

    fun data(level: RoastLevel): PhaseRuleData = when (level) {
        RoastLevel.Light -> PhaseRuleData(
            roastLevel = level, restMinDays = 3, restMaxDays = 7,
            peakStartDay = 7, peakEndDay = 28, declineStartDay = 28, enabled = true,
        )

        RoastLevel.Medium -> PhaseRuleData(
            roastLevel = level, restMinDays = 2, restMaxDays = 5,
            peakStartDay = 5, peakEndDay = 21, declineStartDay = 21, enabled = true,
        )

        RoastLevel.MediumDark -> PhaseRuleData(
            roastLevel = level, restMinDays = 1, restMaxDays = 3,
            peakStartDay = 3, peakEndDay = 14, declineStartDay = 14, enabled = true,
        )

        RoastLevel.Dark -> PhaseRuleData(
            roastLevel = level, restMinDays = 1, restMaxDays = 3,
            peakStartDay = 3, peakEndDay = 14, declineStartDay = 14, enabled = true,
        )

        // 拼配的排气期比黄金窗口还长：排气窗口故意与黄金窗口开头重叠，
        // 于是拼配"打开"就直接进黄金期，不经过 Opening。
        RoastLevel.EspressoBlend -> PhaseRuleData(
            roastLevel = level, restMinDays = 5, restMaxDays = 14,
            peakStartDay = 7, peakEndDay = 21, declineStartDay = 21, enabled = true,
        )
    }

    val all: List<PhaseRuleData> = RoastLevel.pickerOrder.map { data(it) }
}

/** 阶段轨道上的一段。start/end 是 0…1 的轨道空间，不是天数。 */
data class TrackSegment(
    val phase: com.brewphase.android.domain.model.BeanPhase,
    val start: Double,
    val end: Double,
) {
    val width: Double get() = maxOf(0.0, end - start)
    val mid: Double get() = (start + end) / 2.0
}
