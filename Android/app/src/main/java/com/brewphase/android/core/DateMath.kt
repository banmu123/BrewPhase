package com.brewphase.android.core

import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * 全应用唯一的日期算术。
 *
 * 与 iOS `DateMath` 语义一致：所有"相差几天"都在**日历日**上算，而不是
 * `millis / 86400000`。烘焙日期填"今天"就必须读作 Day 0，不管现在是几点、
 * 也不管有没有跨夏令时。
 */
object DateMath {

    val zone: ZoneId get() = ZoneId.systemDefault()

    fun today(clock: Clock = Clock.systemDefaultZone()): LocalDate = LocalDate.now(clock)

    /** `to - from`，按日历日。负数表示 to 在过去。 */
    fun daysBetween(from: LocalDate, to: LocalDate): Int =
        ChronoUnit.DAYS.between(from, to).toInt()

    fun fromEpochMillis(millis: Long, zone: ZoneId = this.zone): LocalDate =
        Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()

    /** 某个日历日的 00:00，转成 epoch millis（存库与跨端协议都用它）。 */
    fun startOfDayMillis(date: LocalDate, zone: ZoneId = this.zone): Long =
        date.atStartOfDay(zone).toInstant().toEpochMilli()

    fun dayMillis(date: LocalDate, hour: Int, minute: Int = 0, zone: ZoneId = this.zone): Long =
        date.atTime(hour, minute).atZone(zone).toInstant().toEpochMilli()

    /** epoch millis → 当天 00:00 的 millis；用于按天聚合。 */
    fun startOfDayMillis(millis: Long, zone: ZoneId = this.zone): Long =
        startOfDayMillis(fromEpochMillis(millis, zone), zone)
}
