package com.brewphase.android.feature.brew

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.data.repository.BeanRepository
import com.brewphase.android.data.repository.BrewDraft
import com.brewphase.android.data.repository.BrewRepository
import com.brewphase.android.data.repository.BrewValidationException
import com.brewphase.android.domain.engine.BrewIssue
import com.brewphase.android.domain.engine.BrewMath
import com.brewphase.android.domain.engine.BrewPrefill
import com.brewphase.android.domain.engine.BrewPrefillBuilder
import com.brewphase.android.domain.engine.BrewRecipe
import com.brewphase.android.domain.model.BrewRecord
import com.brewphase.android.data.repository.SettingsRepository
import com.brewphase.android.ui.components.BpPrimaryButton
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.components.SectionHeader
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

data class BrewFormState(
    val method: String = "",
    val grinder: String = "",
    val grind: String = "",
    val waterTemp: String = "",
    val coffee: String = "",
    val water: String = "",
    val timeText: String = "",
    val score: Int = 0,
    val acidity: Int = 0,
    val sweetness: Int = 0,
    val bitterness: Int = 0,
    val body: Int = 0,
    val aftertaste: Int = 0,
    val tags: String = "",
    val notes: String = "",
    val dateMillis: Long = System.currentTimeMillis(),
)

class BrewEditorViewModel(
    private val beanId: String,
    private val existingBrewId: String?,
    private val beanRepository: BeanRepository,
    private val brewRepository: BrewRepository,
    settingsRepository: SettingsRepository,
) : ViewModel() {

    var form by mutableStateOf(BrewFormState())
        private set
    var prefillSource by mutableStateOf<BrewPrefill.Source?>(null)
        private set
    var beanName by mutableStateOf("")
        private set
    var remainingG by mutableStateOf(0.0)
        private set
    var issues by mutableStateOf<List<BrewIssue>>(emptyList())
        private set
    var saving by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set

    init {
        viewModelScope.launch {
            val bean = beanRepository.beanForEdit(beanId)
            beanName = bean?.name.orEmpty()
            remainingG = bean?.remainingG ?: 0.0

            val existing = existingBrewId?.let { brewRepository.observeBrew(it).first() }
            if (existing != null) {
                form = existing.toForm()
            } else {
                val settings = settingsRepository.settings.first()
                val beanBrews = brewRepository.observeBrews(beanId).first()
                val all = brewRepository.observeAllBrews().first()
                val prefill = BrewPrefillBuilder.prefill(
                    beanBrews = beanBrews,
                    allBrews = all,
                    defaults = settings.defaults,
                )
                prefillSource = prefill.source
                form = BrewFormState(
                    method = prefill.recipe.method,
                    grinder = prefill.recipe.grinder,
                    grind = prefill.recipe.grindSize,
                    waterTemp = prefill.recipe.waterTemp.takeIf { it > 0 }?.let { formatGrams(it) } ?: "",
                    coffee = prefill.recipe.coffeeG.takeIf { it > 0 }?.let { formatGrams(it) } ?: "",
                    water = prefill.recipe.waterG.takeIf { it > 0 }?.let { formatGrams(it) } ?: "",
                    timeText = prefill.timeText,
                )
            }
            loaded = true
        }
    }

    fun update(transform: (BrewFormState) -> BrewFormState) {
        form = transform(form)
        issues = emptyList()
    }

    /** 记下这一杯之后大概还剩多少。用与保存时相同的夹紧规则，不另写一套公式。 */
    fun projectedRemaining(): Double {
        val dose = form.coffee.toDoubleOrNull() ?: 0.0
        return maxOf(remainingG - dose, 0.0).coerceAtMost(remainingG)
    }

    fun save(onSaved: () -> Unit) {
        if (saving) return
        saving = true
        viewModelScope.launch {
            val draft = BrewDraft(
                dateMillis = form.dateMillis,
                recipe = BrewRecipe(
                    method = form.method.trim(),
                    grinder = form.grinder.trim(),
                    grindSize = form.grind.trim(),
                    waterTemp = form.waterTemp.toDoubleOrNull() ?: 0.0,
                    coffeeG = form.coffee.toDoubleOrNull() ?: 0.0,
                    waterG = form.water.toDoubleOrNull() ?: 0.0,
                    timeSeconds = BrewMath.parseTime(form.timeText) ?: 0,
                ),
                timeText = form.timeText,
                score = form.score,
                acidity = form.acidity,
                sweetness = form.sweetness,
                bitterness = form.bitterness,
                body = form.body,
                aftertaste = form.aftertaste,
                flavorTags = form.tags.split(',', '，').map { it.trim() }.filter { it.isNotEmpty() },
                notes = form.notes,
            )
            val result = brewRepository.saveBrew(beanId, draft, existingBrewId)
            saving = false
            result.fold(
                onSuccess = { onSaved() },
                onFailure = { error ->
                    if (error is BrewValidationException) issues = error.issues
                },
            )
        }
    }

    companion object {
        fun factory(container: AppContainer, beanId: String, brewId: String?) = viewModelFactory {
            initializer {
                BrewEditorViewModel(
                    beanId = beanId,
                    existingBrewId = brewId,
                    beanRepository = container.beanRepository,
                    brewRepository = container.brewRepository,
                    settingsRepository = container.settingsRepository,
                )
            }
        }
    }
}

private fun BrewRecord.toForm(): BrewFormState = BrewFormState(
    method = recipe.method,
    grinder = recipe.grinder,
    grind = recipe.grindSize,
    waterTemp = recipe.waterTemp.takeIf { it > 0 }?.let { formatGrams(it) } ?: "",
    coffee = formatGrams(recipe.coffeeG),
    water = formatGrams(recipe.waterG),
    timeText = if (recipe.timeSeconds > 0) BrewMath.formatTime(recipe.timeSeconds) else "",
    score = score,
    acidity = taste.acidity,
    sweetness = taste.sweetness,
    bitterness = taste.bitterness,
    body = taste.body,
    aftertaste = taste.aftertaste,
    tags = flavorTags.joinToString(", "),
    notes = notes,
    dateMillis = dateMillis,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrewEditorScreen(
    container: AppContainer,
    beanId: String,
    brewId: String?,
    quick: Boolean,
    onBack: () -> Unit,
    onSaved: () -> Unit,
) {
    val viewModel: BrewEditorViewModel = viewModel(
        factory = BrewEditorViewModel.factory(container, beanId, brewId),
    )
    val form = viewModel.form
    var expanded by mutableStateOf(!quick)

    val title = when {
        brewId != null -> stringResource(R.string.brew_edit)
        quick -> stringResource(R.string.brew_quick)
        else -> stringResource(R.string.brew_full)
    }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = { Text(title, style = MaterialTheme.typography.titleLarge) },
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
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = BpSpacing.l.dp),
        ) {
            if (viewModel.prefillSource != null && brewId == null) {
                Text(
                    text = when (viewModel.prefillSource) {
                        BrewPrefill.Source.LastBrewOfSameBean -> stringResource(R.string.brew_prefill_from_same)
                        BrewPrefill.Source.LastBrewAnyBean -> stringResource(R.string.brew_prefill_from_any)
                        else -> stringResource(R.string.brew_prefill_default)
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.InkFaint,
                    modifier = Modifier.padding(top = BpSpacing.s.dp),
                )
            }

            SectionHeader(stringResource(R.string.field_coffee))
            Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.s.dp)) {
                BpTextField(
                    label = stringResource(R.string.field_coffee),
                    value = form.coffee,
                    onValueChange = { v -> viewModel.update { it.copy(coffee = v) } },
                    keyboardType = KeyboardType.Decimal,
                    suffix = "g",
                    modifier = Modifier.weight(1f),
                )
                BpTextField(
                    label = stringResource(R.string.field_water),
                    value = form.water,
                    onValueChange = { v -> viewModel.update { it.copy(water = v) } },
                    keyboardType = KeyboardType.Decimal,
                    suffix = "g",
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(BpSpacing.s.dp))
            BpTextField(
                label = stringResource(R.string.field_time),
                value = form.timeText,
                onValueChange = { v -> viewModel.update { it.copy(timeText = v) } },
                placeholder = stringResource(R.string.brew_time_hint),
                keyboardType = KeyboardType.Text,
            )
            val ratio = BrewMath.ratioValue(
                form.coffee.toDoubleOrNull() ?: 0.0,
                form.water.toDoubleOrNull() ?: 0.0,
            )
            if (ratio > 0) {
                Text(
                    stringResource(R.string.brew_ratio) + " 1:${"%.1f".format(ratio)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.InkFaint,
                    modifier = Modifier.padding(top = BpSpacing.xs.dp),
                )
            }

            if (expanded) {
                SectionHeader(stringResource(R.string.brew_full))
                BpTextField(
                    label = stringResource(R.string.field_method),
                    value = form.method,
                    onValueChange = { v -> viewModel.update { it.copy(method = v) } },
                )
                Spacer(Modifier.height(BpSpacing.s.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.s.dp)) {
                    BpTextField(
                        label = stringResource(R.string.field_grinder),
                        value = form.grinder,
                        onValueChange = { v -> viewModel.update { it.copy(grinder = v) } },
                        modifier = Modifier.weight(1f),
                    )
                    BpTextField(
                        label = stringResource(R.string.field_grind),
                        value = form.grind,
                        onValueChange = { v -> viewModel.update { it.copy(grind = v) } },
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.height(BpSpacing.s.dp))
                BpTextField(
                    label = stringResource(R.string.field_water_temp),
                    value = form.waterTemp,
                    onValueChange = { v -> viewModel.update { it.copy(waterTemp = v) } },
                    keyboardType = KeyboardType.Decimal,
                    suffix = "°C",
                )

                SectionHeader(stringResource(R.string.field_score))
                ScoreRow(form.score) { v -> viewModel.update { it.copy(score = v) } }

                SectionHeader(stringResource(R.string.field_taste))
                TasteRow(stringResource(R.string.taste_acidity), form.acidity) { v -> viewModel.update { it.copy(acidity = v) } }
                TasteRow(stringResource(R.string.taste_sweetness), form.sweetness) { v -> viewModel.update { it.copy(sweetness = v) } }
                TasteRow(stringResource(R.string.taste_bitterness), form.bitterness) { v -> viewModel.update { it.copy(bitterness = v) } }
                TasteRow(stringResource(R.string.taste_body), form.body) { v -> viewModel.update { it.copy(body = v) } }
                TasteRow(stringResource(R.string.taste_aftertaste), form.aftertaste) { v -> viewModel.update { it.copy(aftertaste = v) } }

                SectionHeader(stringResource(R.string.field_flavor_tags))
                BpTextField(
                    label = stringResource(R.string.field_flavor_tags),
                    value = form.tags,
                    onValueChange = { v -> viewModel.update { it.copy(tags = v) } },
                    placeholder = stringResource(R.string.field_tags_hint),
                )
                SectionHeader(stringResource(R.string.field_notes))
                BpTextField(
                    label = stringResource(R.string.field_notes),
                    value = form.notes,
                    onValueChange = { v -> viewModel.update { it.copy(notes = v) } },
                    singleLine = false,
                )
            } else {
                Text(
                    text = stringResource(R.string.brew_more),
                    style = MaterialTheme.typography.labelLarge,
                    color = BpColors.Roast,
                    modifier = Modifier
                        .padding(top = BpSpacing.m.dp)
                        .clickable { expanded = true },
                )
            }

            if (viewModel.issues.isNotEmpty()) {
                Spacer(Modifier.height(BpSpacing.m.dp))
                viewModel.issues.forEach { issue ->
                    Text(
                        text = brewIssueText(issue),
                        style = MaterialTheme.typography.bodyMedium,
                        color = BpColors.Declining,
                    )
                }
            }

            Spacer(Modifier.height(BpSpacing.l.dp))
            Text(
                stringResource(R.string.brew_stock_preview, formatGrams(viewModel.projectedRemaining())),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
            )
            Spacer(Modifier.height(BpSpacing.s.dp))
            BpPrimaryButton(
                text = stringResource(R.string.action_save),
                onClick = { viewModel.save(onSaved) },
                enabled = !viewModel.saving,
            )
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }
}

@Composable
private fun ScoreRow(value: Int, onChange: (Int) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp)) {
        (1..5).forEach { score ->
            val selected = score <= value
            Text(
                text = score.toString(),
                style = MaterialTheme.typography.bodyMedium,
                color = if (selected) BpColors.Card else BpColors.InkSoft,
                modifier = Modifier
                    .background(
                        if (selected) BpColors.Espresso else BpColors.Well,
                        RoundedCornerShape(BpRadius.s.dp),
                    )
                    .clickable { onChange(if (score == value) 0 else score) }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun TasteRow(label: String, value: Int, onChange: (Int) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = BpColors.InkSoft, modifier = Modifier.width(64.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.xxs.dp)) {
            (1..5).forEach { score ->
                val selected = score <= value
                Text(
                    text = score.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (selected) BpColors.Card else BpColors.InkFaint,
                    modifier = Modifier
                        .background(
                            if (selected) BpColors.Roast else BpColors.Well,
                            RoundedCornerShape(BpRadius.s.dp),
                        )
                        .clickable { onChange(if (score == value) 0 else score) }
                        .padding(horizontal = 11.dp, vertical = 5.dp),
                )
            }
        }
    }
}

@Composable
fun brewIssueText(issue: BrewIssue): String = when (issue) {
    BrewIssue.MissingDose -> stringResource(R.string.brew_issue_missing_dose)
    BrewIssue.MissingWater -> stringResource(R.string.brew_issue_missing_water)
    BrewIssue.MissingTemperature -> stringResource(R.string.brew_issue_missing_temp)
    BrewIssue.MissingTime -> stringResource(R.string.brew_issue_missing_time)
}
