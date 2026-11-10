package com.brewphase.android.domain.engine

import com.brewphase.android.core.DateMath
import com.brewphase.android.domain.model.BeanPhase
import com.brewphase.android.domain.model.BeanSnapshot
import java.time.LocalDate

/**
 * 这包豆现在在哪、界面该怎么说。
 *
 * 与 iOS `PhaseReading` 字段一一对应——多端同时读同一批数据时，阶段、还剩几天、
 * 轨道位置都必须是同一个答案。
 */
data class PhaseReading(
    val dayAfterRoast: Int?,
    val phase: BeanPhase,
    /** 阶段实际读取的那一天（密封期已折算之后）。开封晚的豆子会小于 `dayAfterRoast`。 */
    val effectiveDay: Int,
    /** 密封期为这包豆"买回来"的天数；开封早于窗口开启时为 0。 */
    val sealedShiftDays: Int,
    val restEndDay: Int,
    val peakStartDay: Int,
    val peakEndDay: Int,
    val restMinDays: Int,
    val restMaxDays: Int,
    val daysUntilPeakStart: Int,
    /** 窗口还剩几天；已过则为负。 */
    val daysUntilWindowEnd: Int,
    val progress: Double,
    val trackSegments: List<TrackSegment>,
    val problem: Problem?,
    val usesDefaultRule: Boolean,
) {
    enum class Problem { MissingRoastDate, RoastDateInFuture }

    val isInWindow: Boolean get() = phase.isInWindow
}

/**
 * 「这包豆算第几天、处在哪一段」的唯一真相来源。
 *
 * 没有状态、没有自己的时钟、不碰数据库：给它快照、规则和日期，它返回读数。
 * 所有边界情况因此都只是几行单测，而不是要去界面上复现的 bug。
 */
object PhaseEngine {

    /** 密封期每天折算成多少天。0.5 是刻意的中间值：袋子里确实还在老化，只是没那么快。 */
    const val SEALED_DAY_WEIGHT = 0.5

    data class Boundaries(val restEnd: Int, val peakStart: Int, val peakEnd: Int)

    fun boundaries(rule: PhaseRuleData): Boundaries {
        val n = rule.normalized()
        val peakStart = maxOf(1, n.peakStartDay)
        val restEnd = minOf(maxOf(n.restMinDays, 1), maxOf(peakStart - 1, 1))
        val peakEnd = maxOf(peakStart + 1, maxOf(n.peakEndDay, n.declineStartDay))
        return Boundaries(restEnd = restEnd, peakStart = peakStart, peakEnd = peakEnd)
    }

    /** 烘焙后第 `day` 天落在哪个阶段。 */
    fun phase(dayAfterRoast: Int, rule: PhaseRuleData): BeanPhase {
        val b = boundaries(rule)
        return when {
            dayAfterRoast < b.restEnd -> BeanPhase.Resting
            dayAfterRoast < b.peakStart -> BeanPhase.Opening
            dayAfterRoast < b.peakEnd -> BeanPhase.Peak
            else -> BeanPhase.Declining
        }
    }

    /**
     * 折算密封期之后，阶段该按哪一天读。
     *
     * 只有**晚于窗口开启日**的那段密封时间才算折扣：浅烘豆第 3 天开封，一天也没
     * 耽误，因为它的窗口本来就还没开始。折扣是随时间长出来的，不是一次性补的——
     * 读数不能倒退，而且今天还封着的豆子不能先花掉它还没挣到的折扣。
     */
    fun effectiveDay(dayAfterRoast: Int, openDayAfterRoast: Int?, rule: PhaseRuleData): Int {
        if (openDayAfterRoast == null) return dayAfterRoast
        val peakStart = boundaries(rule).peakStart
        val sealedPastWindowStart = maxOf(0, minOf(dayAfterRoast, openDayAfterRoast) - peakStart)
        val discount = Math.round(sealedPastWindowStart * SEALED_DAY_WEIGHT).toInt()
        return maxOf(0, dayAfterRoast - discount)
    }

    /** 烘焙到开封隔了几天；缺任一日期就是 null。 */
    fun openDayAfterRoast(bean: BeanSnapshot): Int? {
        val roast = bean.roastDate ?: return null
        val open = bean.openDate ?: return null
        return DateMath.daysBetween(roast, open)
    }

    /** 某一天这包豆处在哪个阶段（风味时间线用它上色）。 */
    fun phase(dayAfterRoast: Int, bean: BeanSnapshot, rule: PhaseRuleData): BeanPhase {
        val effective = effectiveDay(dayAfterRoast, openDayAfterRoast(bean), rule)
        return phase(effective, rule)
    }

    /** 到第 `day` 天为止，密封期一共为这包豆争取了多少天。 */
    fun sealedShiftDays(dayAfterRoast: Int, openDayAfterRoast: Int?, rule: PhaseRuleData): Int =
        dayAfterRoast - effectiveDay(dayAfterRoast, openDayAfterRoast, rule)

    /**
     * 阶段时钟第一次走到 `target` 的那一天（[effectiveDay] 的反函数）。
     *
     * 提醒之所以还能在正确的早晨响起，靠的就是它：有密封期时偏移不是常数，因为
     * 折扣在豆子还封着的时候仍在累积。所以这里向前走——但步数可证很短：折扣
     * 不会超过 `maxDiscount`，`target + maxDiscount` 一定满足目标。
     */
    fun dayReaching(target: Int, rule: PhaseRuleData, openDayAfterRoast: Int?): Int {
        if (openDayAfterRoast == null) return maxOf(0, target)
        val peakStart = boundaries(rule).peakStart
        val maxDiscount = Math.round(maxOf(0, openDayAfterRoast - peakStart) * SEALED_DAY_WEIGHT).toInt()

        // target 可能为负（"你本该从哪天开始"这种回望），两端都夹住，区间不会倒置。
        val first = maxOf(0, target)
        val last = maxOf(first, target + maxDiscount)
        for (day in first..last) {
            if (effectiveDay(day, openDayAfterRoast, rule) >= target) return day
        }
        return last
    }

    /**
     * 一次性读出界面需要的全部结论。
     *
     * 没有烘焙日期时**不猜** Day 0，而是明说不知道。
     */
    fun reading(
        bean: BeanSnapshot,
        rule: PhaseRuleData? = null,
        today: LocalDate = DateMath.today(),
    ): PhaseReading {
        val resolved = (rule ?: DefaultPhaseRules.data(bean.roastLevel)).normalized()
        val usesDefaultRule = rule == null
        val b = boundaries(resolved)

        val roastDate = bean.roastDate
        if (roastDate == null) {
            return PhaseReading(
                dayAfterRoast = null,
                phase = BeanPhase.Resting,
                effectiveDay = 0,
                sealedShiftDays = 0,
                restEndDay = b.restEnd,
                peakStartDay = b.peakStart,
                peakEndDay = b.peakEnd,
                restMinDays = resolved.restMinDays,
                restMaxDays = resolved.restMaxDays,
                daysUntilPeakStart = b.peakStart,
                daysUntilWindowEnd = b.peakEnd,
                progress = 0.0,
                trackSegments = segments(b.restEnd, b.peakStart, b.peakEnd),
                problem = PhaseReading.Problem.MissingRoastDate,
                usesDefaultRule = usesDefaultRule,
            )
        }

        val rawDay = DateMath.daysBetween(roastDate, today)
        val day = maxOf(0, rawDay)

        // 豆子的真实年龄照实显示（"Day 16"两种算法都一样），
        // 但阶段要按咖啡实际经历的老化程度来读——密封过一段的，读数会更年轻。
        val openDay = openDayAfterRoast(bean)
        val phaseDay = effectiveDay(day, openDay, resolved)
        val shift = day - phaseDay
        val phase = phase(phaseDay, resolved)

        // 轨道尾部固定给衰减期留一段，过了窗口的豆子仍有个位置可站，而不是一直贴边。
        val tail = maxOf(7, (b.peakEnd - b.peakStart) / 2)
        val span = (b.peakEnd + tail).toDouble()
        val progress = minOf(maxOf(phaseDay / span, 0.0), 1.0)

        return PhaseReading(
            dayAfterRoast = day,
            phase = phase,
            effectiveDay = phaseDay,
            sealedShiftDays = shift,
            restEndDay = b.restEnd,
            peakStartDay = b.peakStart,
            peakEndDay = b.peakEnd,
            restMinDays = resolved.restMinDays,
            restMaxDays = resolved.restMaxDays,
            daysUntilPeakStart = maxOf(0, b.peakStart - phaseDay),
            daysUntilWindowEnd = b.peakEnd - phaseDay,
            progress = progress,
            trackSegments = segments(b.restEnd, b.peakStart, b.peakEnd),
            problem = if (rawDay < 0) PhaseReading.Problem.RoastDateInFuture else null,
            usesDefaultRule = usesDefaultRule,
        )
    }

    private fun segments(restEnd: Int, peakStart: Int, peakEnd: Int): List<TrackSegment> {
        val tail = maxOf(7, (peakEnd - peakStart) / 2)
        val span = (peakEnd + tail).toDouble()
        val restFrac = restEnd / span
        val startFrac = peakStart / span
        val endFrac = peakEnd / span
        return listOf(
            TrackSegment(BeanPhase.Resting, 0.0, restFrac),
            TrackSegment(BeanPhase.Opening, restFrac, startFrac),
            TrackSegment(BeanPhase.Peak, startFrac, endFrac),
            TrackSegment(BeanPhase.Declining, endFrac, 1.0),
        ).filter { it.width > 0.0001 }
    }

    /** 没有烘焙日期的豆子无法判断，也不该被推荐。 */
    fun isJudgeable(bean: BeanSnapshot): Boolean = bean.roastDate != null
}
