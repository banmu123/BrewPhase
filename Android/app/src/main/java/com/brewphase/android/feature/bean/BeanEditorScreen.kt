package com.brewphase.android.feature.bean

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDatePickerState
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
import com.brewphase.android.core.DateMath
import com.brewphase.android.data.local.toLocalDate
import com.brewphase.android.data.repository.BeanDraft
import com.brewphase.android.data.repository.BeanRepository
import com.brewphase.android.data.repository.BeanValidationException
import com.brewphase.android.domain.engine.BeanIssue
import com.brewphase.android.domain.model.RoastLevel
import com.brewphase.android.ui.components.BpPrimaryButton
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.components.SectionHeader
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

data class BeanForm(
    val name: String = "",
    val roaster: String = "",
    val origin: String = "",
    val process: String = "",
    val roastLevel: RoastLevel = RoastLevel.Medium,
    val roastDate: LocalDate? = null,
    val purchaseDate: LocalDate? = null,
    val openDate: LocalDate? = null,
    val weightG: String = "",
    val remainingG: String = "",
    val price: String = "",
    val channel: String = "",
    val flavorTags: String = "",
    val notes: String = "",
)

class BeanEditorViewModel(
    private val beanId: String?,
    private val repository: BeanRepository,
) : ViewModel() {

    var form by mutableStateOf(BeanForm())
        private set
    var issues by mutableStateOf<List<BeanIssue>>(emptyList())
        private set
    var loaded by mutableStateOf(beanId == null)
        private set
    var saving by mutableStateOf(false)
        private set

    init {
        if (beanId != null) {
            viewModelScope.launch {
                repository.beanForEdit(beanId)?.let { bean ->
                    form = BeanForm(
                        name = bean.name,
                        roaster = bean.roaster,
                        origin = bean.origin,
                        process = bean.process,
                        roastLevel = bean.roastLevel,
                        roastDate = bean.roastDate,
                        purchaseDate = bean.purchaseDate,
                        openDate = bean.openDate,
                        weightG = formatGrams(bean.weightG),
                        remainingG = formatGrams(bean.remainingG),
                        price = if (bean.price > 0) formatGrams(bean.price) else "",
                        channel = bean.channel,
                        flavorTags = bean.flavorTags.joinToString(", "),
                        notes = bean.notes,
                    )
                }
                loaded = true
            }
        }
    }

    fun update(transform: (BeanForm) -> BeanForm) {
        form = transform(form)
        issues = emptyList()
    }

    fun save(onSaved: () -> Unit) {
        if (saving) return
        saving = true
        viewModelScope.launch {
            val draft = BeanDraft(
                name = form.name,
                roaster = form.roaster,
                origin = form.origin,
                process = form.process,
                roastLevel = form.roastLevel,
                roastDate = form.roastDate,
                purchaseDate = form.purchaseDate,
                openDate = form.openDate,
                weightG = form.weightG.toDoubleOrNull() ?: 0.0,
                remainingG = form.remainingG.toDoubleOrNull(),
                price = form.price.toDoubleOrNull() ?: 0.0,
                channel = form.channel,
                flavorTags = form.flavorTags
                    .split(',', '，')
                    .map { it.trim() }
                    .filter { it.isNotEmpty() },
                notes = form.notes,
            )
            val result = repository.saveBean(draft, beanId)
            saving = false
            result.fold(
                onSuccess = { onSaved() },
                onFailure = { error ->
                    if (error is BeanValidationException) issues = error.issues else issues = listOf(BeanIssue.MissingName)
                },
            )
        }
    }

    companion object {
        fun factory(container: AppContainer, beanId: String?) = viewModelFactory {
            initializer { BeanEditorViewModel(beanId, container.beanRepository) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BeanEditorScreen(
    container: AppContainer,
    beanId: String?,
    onBack: () -> Unit,
    onSaved: () -> Unit,
) {
    val viewModel: BeanEditorViewModel = viewModel(factory = BeanEditorViewModel.factory(container, beanId))
    val form = viewModel.form
    var picker by remember { mutableStateOf<String?>(null) }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(if (beanId == null) R.string.editor_new_bean else R.string.editor_edit_bean),
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
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
            SectionHeader(stringResource(R.string.bean_basic_info))
            BpTextField(
                label = stringResource(R.string.field_name),
                value = form.name,
                onValueChange = { v -> viewModel.update { it.copy(name = v) } },
            )
            Spacer(Modifier.height(BpSpacing.s.dp))
            BpTextField(
                label = stringResource(R.string.field_roaster),
                value = form.roaster,
                onValueChange = { v -> viewModel.update { it.copy(roaster = v) } },
            )
            Spacer(Modifier.height(BpSpacing.s.dp))
            BpTextField(
                label = stringResource(R.string.field_origin),
                value = form.origin,
                onValueChange = { v -> viewModel.update { it.copy(origin = v) } },
            )
            Spacer(Modifier.height(BpSpacing.s.dp))
            BpTextField(
                label = stringResource(R.string.field_process),
                value = form.process,
                onValueChange = { v -> viewModel.update { it.copy(process = v) } },
            )

            SectionHeader(stringResource(R.string.field_roast_level))
            Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp)) {
                RoastLevel.pickerOrder.forEach { level ->
                    val selected = level == form.roastLevel
                    Text(
                        text = roastLevelLabel(level),
                        style = MaterialTheme.typography.labelLarge,
                        color = if (selected) BpColors.Card else BpColors.InkSoft,
                        modifier = Modifier
                            .background(
                                if (selected) BpColors.Espresso else BpColors.Well,
                                RoundedCornerShape(BpRadius.s.dp),
                            )
                            .clickable { viewModel.update { it.copy(roastLevel = level) } }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }

            SectionHeader(stringResource(R.string.bean_roast_date))
            DateRow(form.roastDate, onPick = { picker = "roast" }, onClear = { viewModel.update { it.copy(roastDate = null) } })
            Spacer(Modifier.height(BpSpacing.xs.dp))
            Text(stringResource(R.string.field_open_date), style = MaterialTheme.typography.labelSmall, color = BpColors.InkFaint)
            DateRow(form.openDate, onPick = { picker = "open" }, onClear = { viewModel.update { it.copy(openDate = null) } })

            SectionHeader(stringResource(R.string.bean_stock))
            Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.s.dp)) {
                BpTextField(
                    label = stringResource(R.string.field_weight),
                    value = form.weightG,
                    onValueChange = { v -> viewModel.update { it.copy(weightG = v) } },
                    keyboardType = KeyboardType.Decimal,
                    suffix = "g",
                    modifier = Modifier.weight(1f),
                )
                BpTextField(
                    label = stringResource(R.string.field_remaining),
                    value = form.remainingG,
                    onValueChange = { v -> viewModel.update { it.copy(remainingG = v) } },
                    keyboardType = KeyboardType.Decimal,
                    suffix = "g",
                    modifier = Modifier.weight(1f),
                )
            }

            SectionHeader(stringResource(R.string.field_flavor_tags))
            BpTextField(
                label = stringResource(R.string.field_flavor_tags),
                value = form.flavorTags,
                onValueChange = { v -> viewModel.update { it.copy(flavorTags = v) } },
                placeholder = stringResource(R.string.field_tags_hint),
            )

            SectionHeader(stringResource(R.string.field_notes))
            BpTextField(
                label = stringResource(R.string.field_notes),
                value = form.notes,
                onValueChange = { v -> viewModel.update { it.copy(notes = v) } },
                singleLine = false,
            )

            if (viewModel.issues.isNotEmpty()) {
                Spacer(Modifier.height(BpSpacing.m.dp))
                viewModel.issues.forEach { issue ->
                    Text(
                        text = issueText(issue),
                        style = MaterialTheme.typography.bodyMedium,
                        color = BpColors.Declining,
                    )
                }
            }

            Spacer(Modifier.height(BpSpacing.xl.dp))
            BpPrimaryButton(
                text = stringResource(R.string.action_save),
                onClick = { viewModel.save(onSaved) },
                enabled = !viewModel.saving,
            )
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }

    val pickerTarget = picker
    if (pickerTarget != null) {
        val initial = when (pickerTarget) {
            "roast" -> form.roastDate
            else -> form.openDate
        }
        val state = rememberDatePickerState(
            initialSelectedDateMillis = initial?.let { DateMath.startOfDayMillis(it) }
                ?: System.currentTimeMillis(),
        )
        DatePickerDialog(
            onDismissRequest = { picker = null },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { millis ->
                        val date = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
                        viewModel.update {
                            if (pickerTarget == "roast") it.copy(roastDate = date) else it.copy(openDate = date)
                        }
                    }
                    picker = null
                }) { Text(stringResource(R.string.action_save)) }
            },
            dismissButton = {
                TextButton(onClick = { picker = null }) { Text(stringResource(R.string.action_cancel)) }
            },
        ) {
            DatePicker(state = state)
        }
    }
}

@Composable
private fun DateRow(date: LocalDate?, onPick: () -> Unit, onClear: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = BpSpacing.xs.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = date?.toString() ?: stringResource(R.string.date_pick),
            style = MaterialTheme.typography.bodyLarge,
            color = if (date == null) BpColors.InkFaint else BpColors.Ink,
            modifier = Modifier
                .weight(1f)
                .clickable(onClick = onPick)
                .padding(vertical = BpSpacing.s.dp),
        )
        if (date != null) {
            TextButton(onClick = onClear) { Text(stringResource(R.string.date_clear)) }
        }
    }
}

@Composable
fun issueText(issue: BeanIssue): String = when (issue) {
    BeanIssue.MissingName -> stringResource(R.string.bean_issue_missing_name)
    BeanIssue.MissingRoastDate -> stringResource(R.string.bean_issue_missing_roast)
    BeanIssue.WeightNotPositive -> stringResource(R.string.bean_issue_weight)
    BeanIssue.NegativeRemaining -> stringResource(R.string.bean_issue_negative)
    is BeanIssue.RemainingOverWeight -> stringResource(R.string.bean_issue_over, formatGrams(issue.correctedWeightG))
}
