package com.brewphase.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightScheme = lightColorScheme(
    primary = BpColors.Espresso,
    onPrimary = Color.White,
    primaryContainer = BpColors.Well,
    onPrimaryContainer = BpColors.Ink,
    secondary = BpColors.Roast,
    onSecondary = Color.White,
    secondaryContainer = BpColors.Well,
    onSecondaryContainer = BpColors.Ink,
    tertiary = BpColors.Moss,
    onTertiary = Color.White,
    background = BpColors.Paper,
    onBackground = BpColors.Ink,
    surface = BpColors.Card,
    onSurface = BpColors.Ink,
    surfaceVariant = BpColors.Well,
    onSurfaceVariant = BpColors.InkSoft,
    surfaceTint = Color.Transparent,
    outline = BpColors.Hairline,
    outlineVariant = BpColors.Hairline,
    error = Color(0xFF9B4A3F),
    onError = Color.White,
)

/**
 * V1 只有浅色主题：深色需要重新校一遍咖啡色相（Espresso 在深底上会糊成黑块），
 * 没校过就不假装支持。`isSystemInDarkTheme()` 因此故意不读——见
 * `docs/KNOWN_LIMITATIONS.md`。
 */
@Composable
fun BrewPhaseTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightScheme,
        typography = BpTypography,
        content = content,
    )
}
