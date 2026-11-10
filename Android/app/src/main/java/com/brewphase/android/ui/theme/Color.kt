package com.brewphase.android.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * BrewPhase design tokens —— 取自 `BrewPhase/Shared/Theme.swift` 与
 * `docs/design/BrewPhase-Design-System-v1.md`。
 *
 * 原则：颜色只表达状态，不做装饰。页面靠排版、间距与细分隔线建立层次，
 * 所以这里没有一整套鲜艳的 Material 调色板，只有纸、墨和咖啡。
 */
object BpColors {
    val Paper = Color(0xFFF7F7F7)
    val Card = Color(0xFFFFFFFF)
    val Well = Color(0xFFF0EFED)
    val Hairline = Color(0xFFE3E0DC)

    val Ink = Color(0xFF1F1B18)
    val InkSoft = Color(0xFF5C554F)
    val InkFaint = Color(0xFF8C847C)

    val Espresso = Color(0xFF3B2A20)
    val Roast = Color(0xFF6F4A32)
    val Latte = Color(0xFFA9744F)
    val Moss = Color(0xFF5E7155)

    // 状态色：只在阶段与库存告警上出现，且饱和度都压得很低。
    val Resting = Color(0xFF8C847C)
    val Opening = Color(0xFFA9744F)
    val Peak = Color(0xFF5E7155)
    val Declining = Color(0xFF8A6A55)
}

/** 4dp 基准的间距阶梯；不用裸数字写字间距。 */
object BpSpacing {
    val xxs = 2
    val xs = 4
    val s = 8
    val m = 12
    val l = 16
    val xl = 24
    val xxl = 32
    val xxxl = 48
}

object BpRadius {
    val s = 6
    val m = 10
    val l = 14
    val xl = 20
    val pill = 999
}

object BpSize {
    val hairline = 1
    val touchTarget = 48
    val iconS = 16
    val iconM = 20
    val iconL = 24
}
