package com.brewphase.android.feature.bean

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.core.DateMath
import com.brewphase.android.data.repository.BeanRepository
import com.brewphase.android.data.repository.BrewRepository
import com.brewphase.android.domain.engine.ConsumptionEstimate
import com.brewphase.android.domain.engine.ConsumptionEstimator
import com.brewphase.android.domain.engine.PhaseEngine
import com.brewphase.android.domain.engine.PhaseReading
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.domain.model.BrewRecord
import com.brewphase.android.domain.model.TastingRecord
import com.brewphase.android.ui.components.BpPrimaryButton
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.components.Hairline
import com.brewphase.android.ui.components.KeyValueRow
import com.brewphase.android.ui.components.SectionHeader
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.components.phaseLabel
import com.brewphase.android.ui.formatDate
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate

data class BeanDetailState(
    val bean: BeanSnapshot? = null,
    val editable: com.brewphase.android.data.repository.BeanEditable? = null,
    val reading: PhaseReading? = null,
    val brews: List<BrewRecord> = emptyList(),
    val tastings: List<TastingRecord> = emptyList(),
    val estimate: ConsumptionEstimate? = null,
    val loading: Boolean = true,
)

class BeanDetailViewModel(
    private val beanId: String,
    private val beanRepository: BeanRepository,
    private val brewRepository: BrewRepository,
) : ViewModel() {

    val state: StateFlow<BeanDetailState> = combine(
        beanRepository.observeBean(beanId),
        beanRepository.observeRuleBook(),
        brewRepository.observeBrews(beanId),
        beanRepository.observeTastings(beanId),
    ) { bean, rules, brews, tastings ->
        if (bean == null) {
            BeanDetailState(loading = false)
        } else {
            val samples = brews.map {
                com.brewphase.android.domain.model.BrewSample(
                    DateMath.fromEpochMillis(it.dateMillis),
                    it.recipe.coffeeG,
                    it.recipe.waterG,
                )
            }
            BeanDetailState(
                bean = bean,
                editable = beanRepository.beanForEdit(beanId),
                reading = PhaseEngine.reading(bean, rules[bean.roastLevel], DateMath.today()),
                brews = brews,
                tastings = tastings,
                estimate = ConsumptionEstimator.estimate(bean.remainingG, samples),
                loading = false,
            )
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), BeanDetailState())

    fun setRemaining(grams: Double) = viewModelScope.launch {
        beanRepository.setRemaining(beanId, grams)
    }

    fun markFinished() = viewModelScope.launch { beanRepository.markFinished(beanId) }

    fun restoreActive() = viewModelScope.launch { beanRepository.restoreToActive(beanId) }

    fun deleteBean(onDone: () -> Unit) = viewModelScope.launch {
        beanRepository.deleteBean(beanId)
        onDone()
    }

    /** 删除冲煮：库存回补与镜像清理都由同一个 repository 事务负责。 */
    fun deleteBrew(id: String) = viewModelScope.launch { brewRepository.deleteBrew(id) }

    fun deleteTasting(id: String) = viewModelScope.launch { beanRepository.deleteTasting(id) }

    companion object {
        fun factory(container: AppContainer, beanId: String) = viewModelFactory {
            initializer {
                BeanDetailViewModel(beanId, container.beanRepository, container.brewRepository)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BeanDetailScreen(
    container: AppContainer,
    beanId: String,
    onBack: () -> Unit,
    onEdit: (String) -> Unit,
    onLogBrew: (String) -> Unit,
    onDeleted: () -> Unit,
    onAsk: (String) -> Unit,
) {
    val viewModel: BeanDetailViewModel = viewModel(factory = BeanDetailViewModel.factory(container, beanId))
    val state by viewModel.state.collectAsStateWithLifecycle()

    var adjustOpen by remember { mutableStateOf(false) }
    var deleteOpen by remember { mutableStateOf(false) }

    val bean = state.bean
    val reading = state.reading

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        bean?.name ?: stringResource(R.string.bean_detail_title),
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                actions = {
                    IconButton(onClick = { onEdit(beanId) }) {
                        Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.action_edit))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = BpColors.Paper),
            )
        },
    ) { padding ->
        if (bean == null || reading == null) return@Scaffold

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = BpSpacing.l.dp),
        ) {
            // 阶段
            SectionHeader(stringResource(R.string.bean_phase_track))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(BpColors.Card, androidx.compose.foundation.shape.RoundedCornerShape(BpRadius.l.dp))
                    .padding(BpSpacing.l.dp),
            ) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        phaseFullLabel(reading.phase),
                        style = MaterialTheme.typography.titleLarge,
                        color = BpColors.Ink,
                    )
                    Spacer(Modifier.width(BpSpacing.s.dp))
                    if (reading.dayAfterRoast != null) {
                        Text(
                            stringResource(R.string.bean_day, reading.dayAfterRoast),
                            style = MaterialTheme.typography.labelSmall,
                            color = BpColors.InkFaint,
                        )
                    }
                }
                Spacer(Modifier.height(BpSpacing.m.dp))
                PhaseTrack(reading)
                Spacer(Modifier.height(BpSpacing.s.dp))
                Text(
                    text = windowLine(reading),
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkSoft,
                )
                if (reading.sealedShiftDays > 0) {
                    Text(
                        stringResource(R.string.bean_sealed_shift, reading.sealedShiftDays),
                        style = MaterialTheme.typography.labelSmall,
                        color = BpColors.InkFaint,
                    )
                }
                reading.problem?.let { problem ->
                    Spacer(Modifier.height(BpSpacing.xs.dp))
                    Text(
                        text = when (problem) {
                            PhaseReading.Problem.MissingRoastDate -> stringResource(R.string.bean_no_roast_date)
                            PhaseReading.Problem.RoastDateInFuture -> stringResource(R.string.bean_roast_future)
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = BpColors.Declining,
                    )
                }
                Spacer(Modifier.height(BpSpacing.xs.dp))
                Text(
                    stringResource(R.string.phase_estimate_note),
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.InkFaint,
                )
            }

            // 库存
            SectionHeader(stringResource(R.string.bean_stock))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        stringResource(R.string.bean_stock_remaining, formatGrams(bean.remainingG), formatGrams(bean.weightG)),
                        style = MaterialTheme.typography.titleMedium,
                        color = BpColors.Ink,
                    )
                    state.estimate?.let { estimate ->
                        if (!estimate.usedDefaults) {
                            Text(
                                text = "${estimate.averageDoseG.toInt()}g × ${"%.1f".format(estimate.brewsPerDay)}/d",
                                style = MaterialTheme.typography.labelSmall,
                                color = BpColors.InkFaint,
                            )
                        }
                    }
                }
                TextButton(onClick = { adjustOpen = true }) {
                    Text(stringResource(R.string.bean_stock_adjust))
                }
            }

            // 信息
            SectionHeader(stringResource(R.string.bean_basic_info))
            Hairline()
            if (bean.roaster.isNotBlank()) KeyValueRow(stringResource(R.string.field_roaster), bean.roaster)
            KeyValueRow(stringResource(R.string.bean_roast_level), roastLevelLabel(bean.roastLevel))
            bean.roastDate?.let { KeyValueRow(stringResource(R.string.bean_roast_date), it.toString()) }
            bean.openDate?.let { KeyValueRow(stringResource(R.string.bean_open_date), it.toString()) }
            val editable = state.editable
            if (!editable?.origin.isNullOrBlank()) KeyValueRow(stringResource(R.string.bean_origin), editable.origin)
            if (!editable?.process.isNullOrBlank()) KeyValueRow(stringResource(R.string.bean_process), editable.process)
            if (!editable?.channel.isNullOrBlank()) KeyValueRow(stringResource(R.string.bean_channel), editable.channel)
            if (!editable?.notes.isNullOrBlank()) {
                Spacer(Modifier.height(BpSpacing.s.dp))
                Text(editable.notes, style = MaterialTheme.typography.bodyMedium, color = BpColors.InkSoft)
            }

            // 冲煮
            SectionHeader(stringResource(R.string.bean_brews)) {
                TextButton(onClick = { onLogBrew(beanId) }) {
                    Text(stringResource(R.string.bean_brew_now))
                }
            }
            if (state.brews.isEmpty()) {
                Text(
                    stringResource(R.string.coffee_no_brew),
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkFaint,
                    modifier = Modifier.padding(vertical = BpSpacing.s.dp),
                )
            } else {
                state.brews.take(20).forEach { brew ->
                    BrewRow(brew)
                }
            }

            // 品鉴
            SectionHeader(stringResource(R.string.bean_tasting_timeline))
            if (state.tastings.isEmpty()) {
                Text(
                    stringResource(R.string.bean_no_tasting),
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkFaint,
                    modifier = Modifier.padding(vertical = BpSpacing.s.dp),
                )
            } else {
                state.tastings.takeLast(20).forEach { tasting ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = BpSpacing.xs.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "D${tasting.dayAfterRoast}",
                            style = MaterialTheme.typography.labelSmall,
                            color = BpColors.InkFaint,
                            modifier = Modifier.width(38.dp),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                listOfNotNull(
                                    tasting.score.takeIf { it > 0 }?.let { "$it/5" },
                                    tasting.flavorTags.joinToString(" · ").ifBlank { null },
                                ).joinToString("  ") .ifBlank { stringResource(R.string.label_empty) },
                                style = MaterialTheme.typography.bodyMedium,
                                color = BpColors.Ink,
                            )
                            if (tasting.notes.isNotBlank()) {
                                Text(
                                    tasting.notes,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = BpColors.InkFaint,
                                    maxLines = 2,
                                )
                            }
                        }
                        if (!tasting.isMirror) {
                            TextButton(onClick = { viewModel.deleteTasting(tasting.id) }) {
                                Text(stringResource(R.string.action_delete), style = MaterialTheme.typography.labelSmall)
                            }
                        } else {
                            Text(
                                stringResource(R.string.tasting_source_brew),
                                style = MaterialTheme.typography.labelSmall,
                                color = BpColors.InkFaint,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(BpSpacing.xl.dp))
            BpPrimaryButton(stringResource(R.string.bean_brew_now), onClick = { onLogBrew(beanId) })
            Spacer(Modifier.height(BpSpacing.s.dp))
            OutlinedButton(
                onClick = { onAsk(beanId) },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(BpRadius.m.dp),
            ) {
                Text(stringResource(R.string.bean_ask), style = MaterialTheme.typography.labelLarge)
            }
            Spacer(Modifier.height(BpSpacing.m.dp))
            if (bean.status == BeanStatus.Active) {
                TextButton(onClick = { viewModel.markFinished() }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.bean_mark_finished), color = BpColors.InkSoft)
                }
            } else {
                TextButton(onClick = { viewModel.restoreActive() }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.bean_restore), color = BpColors.InkSoft)
                }
            }
            TextButton(onClick = { deleteOpen = true }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.bean_delete), color = BpColors.Declining)
            }
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }

    if (adjustOpen && bean != null) {
        var text by remember { mutableStateOf(formatGrams(bean.remainingG)) }
        AlertDialog(
            onDismissRequest = { adjustOpen = false },
            title = { Text(stringResource(R.string.bean_stock_adjust_title)) },
            text = {
                BpTextField(
                    label = stringResource(R.string.field_remaining),
                    value = text,
                    onValueChange = { text = it },
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal,
                    suffix = "g",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    text.toDoubleOrNull()?.let { viewModel.setRemaining(it) }
                    adjustOpen = false
                }) { Text(stringResource(R.string.action_save)) }
            },
            dismissButton = {
                TextButton(onClick = { adjustOpen = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }

    if (deleteOpen) {
        AlertDialog(
            onDismissRequest = { deleteOpen = false },
            title = { Text(stringResource(R.string.bean_delete)) },
            text = { Text(stringResource(R.string.bean_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    deleteOpen = false
                    viewModel.deleteBean(onDeleted)
                }) { Text(stringResource(R.string.action_delete), color = BpColors.Declining) }
            },
            dismissButton = {
                TextButton(onClick = { deleteOpen = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

@Composable
private fun BrewRow(brew: BrewRecord) {
    Column(Modifier.fillMaxWidth().padding(vertical = BpSpacing.s.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                text = listOfNotNull(
                    brew.recipe.method.ifBlank { null },
                    brew.recipe.coffeeG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                    brew.recipe.waterG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                    brew.timeText.ifBlank { null },
                ).joinToString(" · ").ifBlank { stringResource(R.string.label_empty) },
                style = MaterialTheme.typography.bodyLarge,
                color = BpColors.Ink,
            )
            Text(formatDate(brew.dateMillis), style = MaterialTheme.typography.labelSmall, color = BpColors.InkFaint)
        }
        if (brew.score > 0 || brew.taste.hasDetail) {
            Text(
                text = listOfNotNull(
                    brew.score.takeIf { it > 0 }?.let { "$it/5" },
                    brew.taste.acidity.takeIf { it > 0 }?.let { "酸$it" },
                    brew.taste.sweetness.takeIf { it > 0 }?.let { "甜$it" },
                    brew.taste.bitterness.takeIf { it > 0 }?.let { "苦$it" },
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkSoft,
            )
        }
        if (brew.notes.isNotBlank()) {
            Text(brew.notes, style = MaterialTheme.typography.labelSmall, color = BpColors.InkFaint, maxLines = 2)
        }
    }
}

@Composable
fun PhaseTrack(reading: PhaseReading) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(8.dp)
            .background(BpColors.Well, androidx.compose.foundation.shape.RoundedCornerShape(4.dp)),
    ) {
        reading.trackSegments.forEach { segment ->
            val color = when (segment.phase) {
                com.brewphase.android.domain.model.BeanPhase.Resting -> BpColors.Resting
                com.brewphase.android.domain.model.BeanPhase.Opening -> BpColors.Opening
                com.brewphase.android.domain.model.BeanPhase.Peak -> BpColors.Peak
                com.brewphase.android.domain.model.BeanPhase.Declining -> BpColors.Declining
            }
            Box(
                Modifier
                    .weight(segment.width.toFloat().coerceAtLeast(0.001f))
                    .height(8.dp)
                    .background(color.copy(alpha = if (segment.phase == reading.phase) 1f else 0.28f)),
            )
        }
    }
}

@Composable
fun phaseFullLabel(phase: com.brewphase.android.domain.model.BeanPhase): String = when (phase) {
    com.brewphase.android.domain.model.BeanPhase.Resting -> stringResource(R.string.phase_resting_full)
    com.brewphase.android.domain.model.BeanPhase.Opening -> stringResource(R.string.phase_opening_full)
    com.brewphase.android.domain.model.BeanPhase.Peak -> stringResource(R.string.phase_peak_full)
    com.brewphase.android.domain.model.BeanPhase.Declining -> stringResource(R.string.phase_declining_full)
}

@Composable
private fun windowLine(reading: PhaseReading): String = when {
    reading.daysUntilPeakStart > 0 -> stringResource(R.string.bean_days_until_peak, reading.daysUntilPeakStart)
    reading.daysUntilWindowEnd >= 0 -> stringResource(R.string.bean_days_until_end, reading.daysUntilWindowEnd)
    else -> stringResource(R.string.bean_past_window, -reading.daysUntilWindowEnd)
}

@Composable
fun roastLevelLabel(level: com.brewphase.android.domain.model.RoastLevel): String = when (level) {
    com.brewphase.android.domain.model.RoastLevel.Light -> stringResource(R.string.roast_light)
    com.brewphase.android.domain.model.RoastLevel.Medium -> stringResource(R.string.roast_medium)
    com.brewphase.android.domain.model.RoastLevel.MediumDark -> stringResource(R.string.roast_medium_dark)
    com.brewphase.android.domain.model.RoastLevel.Dark -> stringResource(R.string.roast_dark)
    com.brewphase.android.domain.model.RoastLevel.EspressoBlend -> stringResource(R.string.roast_espresso)
}
