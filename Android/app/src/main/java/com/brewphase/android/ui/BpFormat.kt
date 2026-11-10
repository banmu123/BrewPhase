package com.brewphase.android.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.text.DateFormat
import java.util.Date

/**
 * 日期显示统一走系统 locale 的 medium 格式。
 *
 * 不手写 "M月d日"：那只有中文对。英文设备上应该读作 "Nov 6, 2026"。
 */
@Composable
fun rememberDateFormatter(): DateFormat {
    val configuration = LocalConfiguration.current
    val locale = remember(configuration) { configuration.locales[0] }
    return remember(locale) { DateFormat.getDateInstance(DateFormat.MEDIUM, locale) }
}

@Composable
fun formatDate(millis: Long?): String {
    if (millis == null) return "—"
    val formatter = rememberDateFormatter()
    return remember(millis, formatter) { formatter.format(Date(millis)) }
}

fun formatDate(context: Context, millis: Long?): String {
    if (millis == null) return "—"
    return DateFormat.getDateInstance(DateFormat.MEDIUM, context.resources.configuration.locales[0])
        .format(Date(millis))
}

/** 媒体体积：只保留一位小数，单位按量级切换。 */
fun formatBytes(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1_000_000_000.0)
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "%.0f KB".format(bytes / 1_000.0)
    else -> "$bytes B"
}
