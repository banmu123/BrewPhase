package com.brewphase.android.domain.engine

/**
 * 一次冲煮的配方，脱离任何记录存在。
 *
 * 「复制上次参数」复制的就是这七个值：没有判断、没有日期。
 */
data class BrewRecipe(
    val method: String = "",
    val grinder: String = "",
    val grindSize: String = "",
    val waterTemp: Double = 0.0,
    val coffeeG: Double = 0.0,
    val waterG: Double = 0.0,
    val timeSeconds: Int = 0,
) {
    val ratioValue: Double get() = BrewMath.ratioValue(coffeeG, waterG)
    val timeText: String get() = BrewMath.formatTime(timeSeconds)

    val isEmpty: Boolean
        get() = method.isBlank() && grinder.isBlank() && grindSize.isBlank() &&
            waterTemp <= 0 && coffeeG <= 0 && waterG <= 0 && timeSeconds <= 0
}

/** 校验消息是强类型：文案（含中英文）属于界面，不属于引擎。 */
sealed interface BrewIssue {
    data object MissingDose : BrewIssue
    data object MissingWater : BrewIssue
    data object MissingTemperature : BrewIssue
    data object MissingTime : BrewIssue
}

sealed interface BeanIssue {
    data object MissingName : BeanIssue
    data object MissingRoastDate : BeanIssue
    data object WeightNotPositive : BeanIssue
    data object NegativeRemaining : BeanIssue
    data class RemainingOverWeight(val correctedWeightG: Double) : BeanIssue
}

data class Validation<I>(
    val blocking: List<I> = emptyList(),
    val hints: List<I> = emptyList(),
) {
    val canSave: Boolean get() = blocking.isEmpty()
    val isEmpty: Boolean get() = blocking.isEmpty() && hints.isEmpty()
}

/** 编辑器校验后可能被"顺手改好"的值。 */
data class BeanValidationResult(
    val validation: Validation<BeanIssue>,
    val weightG: Double,
    val remainingG: Double,
)

/**
 * 一次冲煮需要的全部算术。纯函数，所以粉水比、时间解析和库存扣减都能脱离
 * 数据库与界面做测试。
 */
object BrewMath {

    fun ratioValue(coffeeG: Double, waterG: Double): Double =
        if (coffeeG > 0 && waterG > 0) waterG / coffeeG else 0.0

    /** 给定粉量与 1:x 比例，需要多少水。 */
    fun water(coffeeG: Double, ratio: Double): Double =
        if (coffeeG > 0 && ratio > 0) Math.round(coffeeG * ratio).toDouble() else 0.0

    /** 给定水量与 1:x 比例，需要多少粉（保留一位小数）。 */
    fun coffee(waterG: Double, ratio: Double): Double =
        if (waterG > 0 && ratio > 0) Math.round((waterG / ratio) * 10.0) / 10.0 else 0.0

    /** `155` → `2:35`；不足一分钟渲染成 `0:45`。 */
    fun formatTime(seconds: Int): String {
        if (seconds <= 0) return ""
        return "%d:%02d".format(seconds / 60, seconds % 60)
    }

    /**
     * 接受 `2:35`、`2.35`、`155`、`1:05`。读不出来就返回 null。
     *
     * 刻意宽容：这是日记，不是实验室记录仪。全角数字/冒号/句点一并收下——
     * 中文键盘上这些是常态，读者没有理由为键盘的宽度付账。
     */
    fun parseTime(text: String): Int? {
        val narrow = toHalfWidth(text).trim()
        if (narrow.isEmpty()) return null

        if (narrow.contains(':')) {
            val parts = narrow.split(':')
            if (parts.size != 2) return null
            val m = parts[0].trim().toIntOrNull() ?: return null
            val s = parts[1].trim().toIntOrNull() ?: return null
            if (m < 0 || s < 0 || s >= 60) return null
            return m * 60 + s
        }

        narrow.toIntOrNull()?.let { return if (it >= 0) it else null }

        // `2.35` 读作 2 分 35 秒——赶时间的人就是这么打的。
        narrow.toDoubleOrNull()?.let { value ->
            val minutes = value.toInt()
            val seconds = Math.round((value - minutes) * 100.0).toInt()
            if (seconds >= 60) return null
            return minutes * 60 + seconds
        }

        return null
    }

    /** 冲煮之后的剩余克数，夹在 [0, total]。 */
    fun remainingAfter(current: Double, dose: Double, total: Double): Double =
        minOf(maxOf(current - dose, 0.0), maxOf(total, 0.0))

    fun clampScore(value: Int): Int = value.coerceIn(0, 5)

    fun validate(recipe: BrewRecipe): Validation<BrewIssue> {
        val blocking = mutableListOf<BrewIssue>()
        val hints = mutableListOf<BrewIssue>()
        if (recipe.coffeeG <= 0) blocking += BrewIssue.MissingDose
        if (recipe.coffeeG > 0 && recipe.waterG <= 0) hints += BrewIssue.MissingWater
        if (recipe.waterTemp <= 0) hints += BrewIssue.MissingTemperature
        if (recipe.timeSeconds <= 0) hints += BrewIssue.MissingTime
        return Validation(blocking, hints)
    }

    /**
     * 豆子编辑器的校验。
     *
     * 有些"错误"替用户改好更合适：剩余量比总克数还多时，真实袋子确实可能比标称重，
     * 那就相信用户，把总克数抬高，而不是把输入砍掉。
     */
    fun validateBean(
        name: String,
        roastDate: java.time.LocalDate?,
        weightG: Double,
        remainingG: Double,
    ): BeanValidationResult {
        val blocking = mutableListOf<BeanIssue>()
        val hints = mutableListOf<BeanIssue>()
        var weight = weightG
        var remaining = remainingG

        if (name.isBlank()) blocking += BeanIssue.MissingName
        if (roastDate == null) blocking += BeanIssue.MissingRoastDate
        if (weightG <= 0) blocking += BeanIssue.WeightNotPositive
        if (remainingG < 0) {
            blocking += BeanIssue.NegativeRemaining
            remaining = 0.0
        }
        if (weightG > 0 && remainingG > weightG) {
            hints += BeanIssue.RemainingOverWeight(correctedWeightG = remainingG)
            weight = remainingG
        }

        return BeanValidationResult(
            validation = Validation(blocking, hints),
            weightG = weight,
            remainingG = remaining,
        )
    }

    /**
     * ICU 的 Fullwidth-Halfwidth 变换在 Android 上最接近的等价物：
     * `２：３５` → `2:35`、`２．５` → `2.5`、全角空格 → 半角空格。
     */
    internal fun toHalfWidth(text: String): String = buildString(text.length) {
        for (ch in text) {
            when {
                ch.code == 0x3000 -> append(' ')
                ch.code in 0xFF01..0xFF5E -> append((ch.code - 0xFEE0).toChar())
                else -> append(ch)
            }
        }
    }
}
