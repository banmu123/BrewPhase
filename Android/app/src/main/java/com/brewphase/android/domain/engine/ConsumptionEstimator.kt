package com.brewphase.android.domain.engine

import com.brewphase.android.core.DateMath
import com.brewphase.android.domain.model.BrewSample
import java.time.LocalDate

/**
 * 这包豆消失得有多快，以及这对窗口意味着什么。
 *
 * 要点是稳定、可解释，而不是聪明：一个平均粉量、一个平均频率、两次除法。
 * 还没记录过就通过 `usedDefaults` 说出来，而不是假装有数据。
 */
data class ConsumptionEstimate(
    val averageDoseG: Double,
    val brewsPerDay: Double,
    val brewsRemaining: Int,
    val daysRemaining: Int,
    val sampleCount: Int,
    val usedDefaults: Boolean,
) {
    companion object {
        val unknown = ConsumptionEstimate(
            averageDoseG = 15.0,
            brewsPerDay = 1.0,
            brewsRemaining = 0,
            daysRemaining = 0,
            sampleCount = 0,
            usedDefaults = true,
        )
    }
}

object ConsumptionEstimator {

    const val DEFAULT_DOSE_G = 15.0

    /** 参与平均的最近冲煮数。 */
    const val DOSE_WINDOW = 5

    fun estimate(
        remainingG: Double,
        samples: List<BrewSample>,
        defaultDoseG: Double = DEFAULT_DOSE_G,
        today: LocalDate = DateMath.today(),
    ): ConsumptionEstimate {
        val usable = samples.filter { it.coffeeG > 0 }.sortedBy { it.date }

        var usedDefaults = true
        val recent = usable.takeLast(DOSE_WINDOW)
        val dose = if (recent.isNotEmpty()) {
            usedDefaults = false
            recent.sumOf { it.coffeeG } / recent.size
        } else {
            maxOf(1.0, defaultDoseG)
        }

        // 频率：记录跨度内平均每天几杯。一天只记了一杯就是"一天一杯"，
        // 而不是"无限多杯"，所以 span 至少是 1。
        var rate = 1.0
        if (usable.size >= 2) {
            val first = usable.first()
            val last = usable.last()
            val span = maxOf(1, DateMath.daysBetween(first.date, last.date) + 1)
            rate = usable.size.toDouble() / span
        }
        rate = rate.coerceIn(0.2, 4.0)

        if (remainingG <= 0) {
            return ConsumptionEstimate(
                averageDoseG = dose,
                brewsPerDay = rate,
                brewsRemaining = 0,
                daysRemaining = 0,
                sampleCount = usable.size,
                usedDefaults = usedDefaults,
            )
        }

        // 剩得比一次粉量还少，不是"大约还能冲一杯"，而是零——说能冲就是在许一个
        // 做不出来的愿。
        val brews = if (remainingG < dose) 0 else maxOf(1, Math.round(remainingG / dose).toInt())
        val days = maxOf(1, Math.ceil(remainingG / (dose * rate)).toInt())

        return ConsumptionEstimate(
            averageDoseG = dose,
            brewsPerDay = rate,
            brewsRemaining = brews,
            daysRemaining = days,
            sampleCount = usable.size,
            usedDefaults = usedDefaults,
        )
    }
}
