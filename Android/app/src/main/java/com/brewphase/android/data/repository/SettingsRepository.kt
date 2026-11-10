package com.brewphase.android.data.repository

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.brewphase.android.domain.engine.BrewDefaults
import com.brewphase.android.domain.model.ReminderKind
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.brewPhaseDataStore by preferencesDataStore(name = "brewphase_settings")

/**
 * 用户偏好。
 *
 * 默认值与 iOS `MoreView` 的 `@AppStorage` 声明逐项一致：V60 / 15g / 240g / 92°C。
 * 提醒默认只开三个推荐项——不要默认开启过多提醒。
 */
data class AppSettings(
    val defaultMethod: String = "V60",
    val defaultDoseG: Double = 15.0,
    val defaultWaterG: Double = 240.0,
    val defaultWaterTemp: Double = 92.0,
    /** `system` / `zh` / `en`；`system` 跟随设备。 */
    val language: String = "system",
    val disabledReminders: Set<ReminderKind> = emptySet(),
) {
    val defaults: BrewDefaults
        get() = BrewDefaults(
            method = defaultMethod,
            doseG = defaultDoseG,
            waterG = defaultWaterG,
            waterTemp = defaultWaterTemp,
        )

    fun reminderEnabled(kind: ReminderKind): Boolean = kind !in disabledReminders
}

class SettingsRepository(private val context: Context) {

    private object Keys {
        val method = stringPreferencesKey("default_method")
        val dose = doublePreferencesKey("default_dose_g")
        val water = doublePreferencesKey("default_water_g")
        val temp = doublePreferencesKey("default_water_temp")
        val language = stringPreferencesKey("language")
        val disabledPrefix = "reminder_disabled_"
    }

    val settings: Flow<AppSettings> = context.brewPhaseDataStore.data.map { prefs ->
        val disabled = ReminderKind.entries.filter { kind ->
            prefs[booleanPreferencesKey(Keys.disabledPrefix + kind.raw)] == true
        }.toSet()

        AppSettings(
            defaultMethod = prefs[Keys.method] ?: "V60",
            defaultDoseG = prefs[Keys.dose] ?: 15.0,
            defaultWaterG = prefs[Keys.water] ?: 240.0,
            defaultWaterTemp = prefs[Keys.temp] ?: 92.0,
            language = prefs[Keys.language] ?: "system",
            disabledReminders = disabled,
        )
    }

    suspend fun current(): AppSettings = settings.first()

    suspend fun setDefaults(method: String, doseG: Double, waterG: Double, waterTemp: Double) {
        context.brewPhaseDataStore.edit { prefs ->
            prefs[Keys.method] = method.trim()
            prefs[Keys.dose] = doseG
            prefs[Keys.water] = waterG
            prefs[Keys.temp] = waterTemp
        }
    }

    suspend fun setLanguage(tag: String) {
        context.brewPhaseDataStore.edit { it[Keys.language] = tag }
    }

    suspend fun setReminderEnabled(kind: ReminderKind, enabled: Boolean) {
        context.brewPhaseDataStore.edit { prefs ->
            val key = booleanPreferencesKey(Keys.disabledPrefix + kind.raw)
            if (enabled) prefs.remove(key) else prefs[key] = true
        }
    }
}
