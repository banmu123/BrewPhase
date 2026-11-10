package com.brewphase.android.domain.engine

import com.brewphase.android.core.DateMath
import com.brewphase.android.domain.model.ReminderKind
import java.time.LocalDate

/** 一条"应该存在"的提醒，交给 Android 通知调度之前的样子。 */
data class PlannedReminder(
    val kind: ReminderKind,
    val fireAtMillis: Long,
    /** 本机通知 ID。跨端只同步意图，ID 由每台设备自己算，绝不复用 iOS 的 identifier。 */
    val androidNotificationId: Int,
)

/**
 * 只负责算出"什么时候提醒"，别的什么都不做。
 *
 * 刻意保持纯函数：调度一旦进了系统的 NotificationManager 就很难调试，而这里
 * 的日期算术要能被单测直接读。逐行移植自 iOS `NotificationPlanner`。
 */
object NotificationPlanner {

    /** 提醒落在当天上午 9 点，而不是用户当初添加豆子的那个钟点。 */
    const val FIRE_HOUR = 9

    /** "将尽"提醒提前几天。 */
    const val CLOSING_LEAD_DAYS = 2

    fun plan(
        beanId: String,
        roastDate: LocalDate,
        openDate: LocalDate?,
        rule: PhaseRuleData,
        estimate: ConsumptionEstimate,
        disabled: Set<ReminderKind> = emptySet(),
        now: LocalDate = DateMath.today(),
    ): List<PlannedReminder> {
        val bounds = PhaseEngine.boundaries(rule)
        val openDay = openDate?.let { DateMath.daysBetween(roastDate, it) }

        // 提醒发生在某个**日历**早晨，但它指向的是阶段时钟上的一个点，而阶段时钟
        // 在豆子还封着时走得更慢。所以每个偏移都要过一遍反函数。
        fun fireDay(target: Int): Int = PhaseEngine.dayReaching(target, rule, openDay)

        val peakEndDay = fireDay(bounds.peakEnd)
        val halfway = fireDay(bounds.peakStart + maxOf(1, (bounds.peakEnd - bounds.peakStart) / 2))

        val wanted = mutableListOf<Pair<ReminderKind, Int>>(
            ReminderKind.RestComplete to fireDay(bounds.restEnd),
            ReminderKind.WindowOpens to fireDay(bounds.peakStart),
            ReminderKind.WindowHalfway to halfway,
            ReminderKind.WindowEnding to peakEndDay - CLOSING_LEAD_DAYS,
        )

        // 优先饮用不是固定偏移：它落在"你得从这天开始喝快一点"的那天，
        // 而且只在数字确实说明这包喝不完窗口时才出现。
        val currentDay = maxOf(0, DateMath.daysBetween(roastDate, now))
        val currentEffectiveDay = PhaseEngine.effectiveDay(currentDay, openDay, rule)
        val remainingWindow = bounds.peakEnd - currentEffectiveDay
        if (estimate.brewsRemaining > 1 &&
            estimate.daysRemaining > remainingWindow &&
            remainingWindow > 0
        ) {
            // 永远不在过去：提醒一个已经过去的时刻只是噪音，最早落到明天。
            val dayToStart = maxOf(
                fireDay(bounds.peakEnd - estimate.daysRemaining),
                currentDay + 1,
            )
            if (dayToStart < peakEndDay) wanted += ReminderKind.BrewPriority to dayToStart
        }

        val nowMillis = DateMath.dayMillis(now, FIRE_HOUR)
        val seen = mutableSetOf<ReminderKind>()
        val planned = mutableListOf<PlannedReminder>()

        for ((kind, day) in wanted.sortedBy { it.second }) {
            if (kind in disabled || kind in seen) continue
            seen += kind
            val fireAt = DateMath.dayMillis(roastDate.plusDays(day.toLong()), FIRE_HOUR)
            if (fireAt <= nowMillis) continue
            planned += PlannedReminder(
                kind = kind,
                fireAtMillis = fireAt,
                androidNotificationId = notificationId(beanId, kind),
            )
        }

        return planned
    }

    /**
     * 稳定的本机通知 ID：同一个 bean + 同一种提醒永远得到同一个整数，
     * 重排时是精确覆盖，而不是"把这个豆的通知全删了再看"。
     */
    fun notificationId(beanId: String, kind: ReminderKind): Int =
        ("brewphase.bean.$beanId.${kind.raw}").hashCode()

    fun allNotificationIds(beanId: String): List<Int> =
        ReminderKind.entries.map { notificationId(beanId, it) }
}
