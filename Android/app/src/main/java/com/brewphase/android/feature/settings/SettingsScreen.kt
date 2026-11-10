package com.brewphase.android.feature.settings

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.data.repository.AppSettings
import com.brewphase.android.data.repository.BeanRepository
import com.brewphase.android.data.repository.SettingsRepository
import com.brewphase.android.domain.engine.PhaseRuleData
import com.brewphase.android.domain.model.ReminderKind
import com.brewphase.android.domain.model.RoastLevel
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.components.Hairline
import com.brewphase.android.ui.components.SectionHeader
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.formatBytes
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SettingsViewModel(
    private val settingsRepository: SettingsRepository,
    private val beanRepository: BeanRepository,
    private val recordRepository: com.brewphase.android.data.repository.RecordRepository,
    private val mediaStore: com.brewphase.android.data.media.MediaStore,
) : ViewModel() {

    val settings: StateFlow<AppSettings> = settingsRepository.settings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), AppSettings())

    val rules: StateFlow<Map<RoastLevel, PhaseRuleData>> = beanRepository.observeRuleBook()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyMap())

    var mediaBytes by mutableStateOf(mediaStore.totalBytes())
        private set
    var cleanedCount by mutableStateOf<Int?>(null)
        private set

    fun saveDefaults(method: String, dose: Double, water: Double, temp: Double) = viewModelScope.launch {
        settingsRepository.setDefaults(method, dose, water, temp)
    }

    fun saveRule(rule: PhaseRuleData) = viewModelScope.launch {
        beanRepository.saveRule(rule)
    }

    fun resetRules() = viewModelScope.launch { beanRepository.resetRules() }

    fun setReminder(kind: ReminderKind, enabled: Boolean) = viewModelScope.launch {
        settingsRepository.setReminderEnabled(kind, enabled)
    }

    fun setLanguage(tag: String) = viewModelScope.launch {
        settingsRepository.setLanguage(tag)
    }

    fun cleanupMedia() = viewModelScope.launch {
        val referenced = mediaReferences()
        cleanedCount = mediaStore.cleanupOrphans(referenced)
        mediaBytes = mediaStore.totalBytes()
    }

    /** 只清理真正没人引用的文件：记录里出现的文件名一律保留。 */
    private suspend fun mediaReferences(): Set<String> = recordRepository.allMediaNames()

    fun refreshMediaUsage() {
        mediaBytes = mediaStore.totalBytes()
    }

    fun clearDemoData() = viewModelScope.launch {
        beanRepository.clearSampleData()
    }

    companion object {
        fun factory(container: AppContainer) = viewModelFactory {
            initializer {
                SettingsViewModel(
                    container.settingsRepository,
                    container.beanRepository,
                    container.recordRepository,
                    container.mediaStore,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val viewModel: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(container))
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val rules by viewModel.rules.collectAsStateWithLifecycle()

    var languageOpen by remember { mutableStateOf(false) }
    var editingRule by remember { mutableStateOf<PhaseRuleData?>(null) }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleLarge) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = BpColors.Paper),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = BpSpacing.l.dp),
        ) {
            SectionHeader(stringResource(R.string.settings_defaults))
            Text(
                stringResource(R.string.settings_defaults_hint),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
            )
            DefaultsEditor(settings, onSave = viewModel::saveDefaults)

            SectionHeader(stringResource(R.string.settings_phase_rules))
            Text(
                stringResource(R.string.settings_phase_rules_hint),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
            )
            RoastLevel.pickerOrder.forEach { level ->
                val rule = rules[level] ?: return@forEach
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { editingRule = rule }
                        .padding(vertical = BpSpacing.m.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(roastLabel(level), style = MaterialTheme.typography.bodyLarge, color = BpColors.Ink)
                    Text(
                        stringResource(
                            R.string.rule_preview,
                            rule.restMinDays, rule.restMaxDays, rule.peakStartDay, rule.peakEndDay,
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = BpColors.InkSoft,
                    )
                }
                Hairline()
            }
            TextButton(onClick = viewModel::resetRules) {
                Text(stringResource(R.string.rule_reset), color = BpColors.Roast)
            }

            SectionHeader(stringResource(R.string.settings_reminders))
            Text(
                stringResource(R.string.settings_reminders_hint),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
            )
            ReminderKind.entries.forEach { kind ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = BpSpacing.xs.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(reminderLabel(kind), style = MaterialTheme.typography.bodyLarge, color = BpColors.Ink)
                        if (kind.recommendedByDefault) {
                            Text(
                                stringResource(R.string.reminder_recommended),
                                style = MaterialTheme.typography.labelSmall,
                                color = BpColors.Moss,
                            )
                        }
                    }
                    Switch(
                        checked = settings.reminderEnabled(kind),
                        onCheckedChange = { viewModel.setReminder(kind, it) },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = BpColors.Card,
                            checkedTrackColor = BpColors.Roast,
                            uncheckedThumbColor = BpColors.InkFaint,
                            uncheckedTrackColor = BpColors.Well,
                        ),
                    )
                }
            }

            SectionHeader(stringResource(R.string.settings_language))
            Row(
                modifier = Modifier.fillMaxWidth().clickable { languageOpen = true }.padding(vertical = BpSpacing.m.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    when (settings.language) {
                        "zh" -> stringResource(R.string.settings_language_zh)
                        "en" -> stringResource(R.string.settings_language_en)
                        else -> stringResource(R.string.settings_language_system)
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    color = BpColors.Ink,
                )
                Text(stringResource(R.string.action_edit), style = MaterialTheme.typography.labelSmall, color = BpColors.InkFaint)
            }

            SectionHeader(stringResource(R.string.settings_media))
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = BpSpacing.s.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(stringResource(R.string.settings_media_usage, formatBytes(viewModel.mediaBytes)), style = MaterialTheme.typography.bodyMedium, color = BpColors.InkSoft)
                TextButton(onClick = viewModel::cleanupMedia) {
                    Text(stringResource(R.string.settings_media_cleanup))
                }
            }
            viewModel.cleanedCount?.let {
                Text(
                    stringResource(R.string.settings_media_cleanup_done, it),
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.InkFaint,
                )
            }

            SectionHeader(stringResource(R.string.settings_backup))
            Text(
                stringResource(R.string.settings_backup_coming),
                style = MaterialTheme.typography.bodyMedium,
                color = BpColors.InkFaint,
            )

            SectionHeader(stringResource(R.string.settings_about))
            Box(Modifier.fillMaxWidth().padding(vertical = BpSpacing.s.dp)) {
                Text(
                    stringResource(R.string.settings_version) + " 0.1.0 · Android",
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkSoft,
                )
            }
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }

    if (languageOpen) {
        AlertDialog(
            onDismissRequest = { languageOpen = false },
            title = { Text(stringResource(R.string.settings_language)) },
            text = {
                Column {
                    listOf(
                        "system" to stringResource(R.string.settings_language_system),
                        "zh" to stringResource(R.string.settings_language_zh),
                        "en" to stringResource(R.string.settings_language_en),
                    ).forEach { (tag, label) ->
                        Text(
                            text = label,
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (settings.language == tag) BpColors.Roast else BpColors.Ink,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    viewModel.setLanguage(tag)
                                    languageOpen = false
                                }
                                .padding(vertical = BpSpacing.s.dp),
                        )
                    }
                    Text(
                        stringResource(R.string.settings_language_restart),
                        style = MaterialTheme.typography.labelSmall,
                        color = BpColors.InkFaint,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { languageOpen = false }) { Text(stringResource(R.string.action_close)) }
            },
        )
    }

    editingRule?.let { rule ->
        RuleEditorDialog(
            rule = rule,
            onDismiss = { editingRule = null },
            onSave = {
                viewModel.saveRule(it)
                editingRule = null
            },
        )
    }
}

@Composable
private fun DefaultsEditor(settings: AppSettings, onSave: (String, Double, Double, Double) -> Unit) {
    var method by remember(settings.defaultMethod) { mutableStateOf(settings.defaultMethod) }
    var dose by remember(settings.defaultDoseG) { mutableStateOf(formatGrams(settings.defaultDoseG)) }
    var water by remember(settings.defaultWaterG) { mutableStateOf(formatGrams(settings.defaultWaterG)) }
    var temp by remember(settings.defaultWaterTemp) { mutableStateOf(formatGrams(settings.defaultWaterTemp)) }

    Column {
        BpTextField(stringResource(R.string.field_method), method, { method = it })
        Spacer(Modifier.height(BpSpacing.s.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.s.dp)) {
            BpTextField(
                label = stringResource(R.string.field_coffee),
                value = dose,
                onValueChange = { dose = it },
                modifier = Modifier.weight(1f),
                keyboardType = KeyboardType.Decimal,
                suffix = "g",
            )
            BpTextField(
                label = stringResource(R.string.field_water),
                value = water,
                onValueChange = { water = it },
                modifier = Modifier.weight(1f),
                keyboardType = KeyboardType.Decimal,
                suffix = "g",
            )
        }
        Spacer(Modifier.height(BpSpacing.s.dp))
        BpTextField(
            label = stringResource(R.string.field_water_temp),
            value = temp,
            onValueChange = { temp = it },
            keyboardType = KeyboardType.Decimal,
            suffix = "°C",
        )
        Spacer(Modifier.height(BpSpacing.s.dp))
        TextButton(onClick = {
            onSave(method, dose.toDoubleOrNull() ?: 15.0, water.toDoubleOrNull() ?: 240.0, temp.toDoubleOrNull() ?: 92.0)
        }) { Text(stringResource(R.string.action_save)) }
    }
}

@Composable
private fun RuleEditorDialog(
    rule: PhaseRuleData,
    onDismiss: () -> Unit,
    onSave: (PhaseRuleData) -> Unit,
) {
    var restMin by remember { mutableStateOf(rule.restMinDays.toString()) }
    var restMax by remember { mutableStateOf(rule.restMaxDays.toString()) }
    var peakStart by remember { mutableStateOf(rule.peakStartDay.toString()) }
    var peakEnd by remember { mutableStateOf(rule.peakEndDay.toString()) }
    var decline by remember { mutableStateOf(rule.declineStartDay.toString()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(roastLabel(rule.roastLevel) + " · " + stringResource(R.string.settings_phase_rules)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                listOf(
                    stringResource(R.string.rule_rest_min) to (restMin to { v: String -> restMin = v }),
                    stringResource(R.string.rule_rest_max) to (restMax to { v: String -> restMax = v }),
                    stringResource(R.string.rule_peak_start) to (peakStart to { v: String -> peakStart = v }),
                    stringResource(R.string.rule_peak_end) to (peakEnd to { v: String -> peakEnd = v }),
                    stringResource(R.string.rule_decline) to (decline to { v: String -> decline = v }),
                ).forEach { (label, pair) ->
                    BpTextField(
                        label = label,
                        value = pair.first,
                        onValueChange = pair.second,
                        keyboardType = KeyboardType.Number,
                        suffix = stringResource(R.string.rule_days, 0).replace("0", "").trim(),
                    )
                    Spacer(Modifier.height(BpSpacing.xs.dp))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(
                    rule.copy(
                        restMinDays = restMin.toIntOrNull() ?: rule.restMinDays,
                        restMaxDays = restMax.toIntOrNull() ?: rule.restMaxDays,
                        peakStartDay = peakStart.toIntOrNull() ?: rule.peakStartDay,
                        peakEndDay = peakEnd.toIntOrNull() ?: rule.peakEndDay,
                        declineStartDay = decline.toIntOrNull() ?: rule.declineStartDay,
                    ),
                )
            }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

@Composable
fun roastLabel(level: RoastLevel): String = when (level) {
    RoastLevel.Light -> stringResource(R.string.roast_light)
    RoastLevel.Medium -> stringResource(R.string.roast_medium)
    RoastLevel.MediumDark -> stringResource(R.string.roast_medium_dark)
    RoastLevel.Dark -> stringResource(R.string.roast_dark)
    RoastLevel.EspressoBlend -> stringResource(R.string.roast_espresso)
}

@Composable
fun reminderLabel(kind: ReminderKind): String = when (kind) {
    ReminderKind.RestComplete -> stringResource(R.string.reminder_name_rest_complete)
    ReminderKind.WindowOpens -> stringResource(R.string.reminder_name_window_opens)
    ReminderKind.WindowHalfway -> stringResource(R.string.reminder_name_window_halfway)
    ReminderKind.WindowEnding -> stringResource(R.string.reminder_name_window_ending)
    ReminderKind.BrewPriority -> stringResource(R.string.reminder_name_priority)
}
