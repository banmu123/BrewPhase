package com.brewphase.android.domain.engine

import com.brewphase.android.domain.model.BrewRecord

/** 设置里那四个默认值。 */
data class BrewDefaults(
    val method: String = "V60",
    val doseG: Double = 15.0,
    val waterG: Double = 240.0,
    val waterTemp: Double = 92.0,
) {
    val asRecipe: BrewRecipe
        get() = BrewRecipe(
            method = method,
            coffeeG = doseG,
            waterG = waterG,
            waterTemp = waterTemp,
        )
}

data class PrefillBasis(
    val id: String,
    val dateMillis: Long,
    val summary: String,
    val score: Int,
    val sameBean: Boolean,
)

/**
 * 这一杯的预填从哪来。
 *
 * 三个来源的优先级是刻意的：同一包豆上一次 → 任何豆子的上一次 → 用户默认值。
 * 中间那一档不是凑数：换了一包新豆，冲法（器具、粉量、水温）通常还是沿用习惯的
 * 那一套，让人从零重填只是无谓的劳动。
 */
data class BrewPrefill(
    val source: Source,
    val recipe: BrewRecipe,
    val timeText: String,
    val basis: PrefillBasis?,
) {
    enum class Source { LastBrewOfSameBean, LastBrewAnyBean, UserDefaults }

    val hasHistory: Boolean get() = basis != null
    val isBareDefault: Boolean get() = source == Source.UserDefaults
}

object BrewPrefillBuilder {

    fun prefill(
        beanBrews: List<BrewRecord>,
        allBrews: List<BrewRecord>,
        method: String? = null,
        defaults: BrewDefaults = BrewDefaults(),
    ): BrewPrefill {
        val wanted = method?.trim() ?: ""

        fun matches(brew: BrewRecord): Boolean =
            wanted.isEmpty() || brew.recipe.method.trim().equals(wanted, ignoreCase = true)

        beanBrews.firstOrNull { matches(it) }?.let {
            return from(it, BrewPrefill.Source.LastBrewOfSameBean, wanted, sameBean = true)
        }
        allBrews.firstOrNull { matches(it) }?.let {
            return from(it, BrewPrefill.Source.LastBrewAnyBean, wanted, sameBean = false)
        }
        // 同一包豆有记录、但都不是这个冲法：退到"同一包豆最近一次"，
        // 借它的粉量与水温，冲法保持用户刚选的那个。
        beanBrews.firstOrNull()?.let {
            return from(it, BrewPrefill.Source.LastBrewOfSameBean, wanted, sameBean = true)
        }
        allBrews.firstOrNull()?.let {
            return from(it, BrewPrefill.Source.LastBrewAnyBean, wanted, sameBean = false)
        }

        val recipe = defaults.asRecipe.copy(
            method = if (wanted.isEmpty()) defaults.method else wanted,
        )
        return BrewPrefill(
            source = BrewPrefill.Source.UserDefaults,
            recipe = recipe,
            timeText = "",
            basis = null,
        )
    }

    private fun from(
        brew: BrewRecord,
        source: BrewPrefill.Source,
        method: String,
        sameBean: Boolean,
    ): BrewPrefill {
        val recipe = brew.recipe.copy(
            method = if (method.isNotEmpty()) method else brew.recipe.method,
        )
        val summaryParts = buildList {
            if (recipe.method.isNotBlank()) add(recipe.method)
            if (recipe.coffeeG > 0 || recipe.waterG > 0) {
                add("${fmt(recipe.coffeeG)}g / ${fmt(recipe.waterG)}g")
            }
            if (recipe.waterTemp > 0) add("${recipe.waterTemp.toInt()}°C")
            if (recipe.timeSeconds > 0) add(BrewMath.formatTime(recipe.timeSeconds))
        }
        return BrewPrefill(
            source = source,
            recipe = recipe,
            timeText = BrewMath.formatTime(brew.recipe.timeSeconds),
            basis = PrefillBasis(
                id = brew.id,
                dateMillis = brew.dateMillis,
                summary = summaryParts.joinToString(" · "),
                score = brew.score,
                sameBean = sameBean,
            ),
        )
    }

    private fun fmt(value: Double): String =
        if (value % 1.0 == 0.0) value.toInt().toString() else "%.1f".format(value)
}
