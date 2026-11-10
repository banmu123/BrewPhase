package com.brewphase.android.feature.records

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import coil.compose.AsyncImage
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.data.local.RecordTagWithCount
import com.brewphase.android.data.local.RecordWithTags
import com.brewphase.android.data.local.carrier
import com.brewphase.android.data.local.displayTitle
import com.brewphase.android.data.local.openURL
import com.brewphase.android.data.local.providerLabel
import com.brewphase.android.data.repository.DuplicateRecordException
import com.brewphase.android.data.repository.RecordDraft
import com.brewphase.android.data.repository.RecordRepository
import com.brewphase.android.data.media.MediaStore
import com.brewphase.android.domain.model.RecordCarrier
import com.brewphase.android.ui.components.BpPrimaryButton
import com.brewphase.android.ui.components.BpTag
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.components.SectionHeader
import com.brewphase.android.ui.formatDate
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

enum class RecordError { Duplicate, InvalidUrl, SaveFailed }

class RecordEditorViewModel(
    private val recordId: String?,
    initialCarrier: RecordCarrier?,
    private val repository: RecordRepository,
    private val mediaStore: MediaStore,
) : ViewModel() {

    var carrier by mutableStateOf(initialCarrier ?: RecordCarrier.Text)
        private set
    var title by mutableStateOf("")
        private set
    var note by mutableStateOf("")
        private set
    var url by mutableStateOf("")
        private set
    var source by mutableStateOf("")
        private set
    var mediaName by mutableStateOf<String?>(null)
        private set
    var tags by mutableStateOf<List<RecordTagWithCount>>(emptyList())
        private set
    var selectedTagIds by mutableStateOf<Set<String>>(emptySet())
        private set
    var tagsLoaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<RecordError?>(null)
        private set
    var saving by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(recordId == null)
        private set

    init {
        viewModelScope.launch {
            if (recordId != null) {
                repository.getRecord(recordId)?.let { item ->
                    carrier = item.record.carrier()
                    title = item.record.title
                    note = item.record.note
                    url = item.record.urlString
                    source = item.record.sourceName
                    mediaName = item.record.mediaPath ?: item.record.previewPath
                    selectedTagIds = item.tags.map { it.id }.toSet()
                }
                loaded = true
            }
            tags = repository.observeTags().first()
            tagsLoaded = true
        }
    }

    fun chooseCarrier(value: RecordCarrier) {
        carrier = value
        error = null
    }

    fun updateTitle(value: String) { title = value }
    fun updateNote(value: String) { note = value }
    fun updateUrl(value: String) { url = value; error = null }
    fun updateSource(value: String) { source = value }

    fun toggleTag(id: String) {
        selectedTagIds = if (id in selectedTagIds) selectedTagIds - id else selectedTagIds + id
    }

    fun importImage(uri: Uri) = viewModelScope.launch {
        mediaStore.importImage(uri).onSuccess {
            mediaName = it
            carrier = RecordCarrier.Image
        }
    }

    fun importVideo(uri: Uri) = viewModelScope.launch {
        mediaStore.importVideo(uri).onSuccess {
            mediaName = it
            carrier = RecordCarrier.Video
        }
    }

    fun save(onSaved: (String) -> Unit) {
        if (saving) return
        saving = true
        viewModelScope.launch {
            val draft = RecordDraft(
                carrier = carrier,
                title = title,
                note = note,
                urlString = url,
                sourceName = source,
                previewPath = if (carrier == RecordCarrier.Image || carrier == RecordCarrier.Video) mediaName else null,
                mediaPath = if (carrier == RecordCarrier.Image || carrier == RecordCarrier.Video) mediaName else null,
            )
            repository.saveRecord(draft, recordId, selectedTagIds.toList()).fold(
                onSuccess = { id -> saving = false; onSaved(id) },
                onFailure = { throwable ->
                    saving = false
                    error = when (throwable) {
                        is DuplicateRecordException -> RecordError.Duplicate
                        is IllegalArgumentException -> RecordError.InvalidUrl
                        else -> RecordError.SaveFailed
                    }
                },
            )
        }
    }

    companion object {
        fun factory(container: AppContainer, recordId: String?, carrier: RecordCarrier?) = viewModelFactory {
            initializer {
                RecordEditorViewModel(recordId, carrier, container.recordRepository, container.mediaStore)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun RecordEditorScreen(
    container: AppContainer,
    recordId: String?,
    carrier: RecordCarrier?,
    onBack: () -> Unit,
    onSaved: (String) -> Unit,
) {
    val viewModel: RecordEditorViewModel = viewModel(
        factory = RecordEditorViewModel.factory(container, recordId, carrier),
    )
    val context = LocalContext.current
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let(viewModel::importImage)
    }
    val videoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let(viewModel::importVideo)
    }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(if (recordId == null) R.string.records_add else R.string.action_edit),
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
            if (recordId == null) {
                SectionHeader(stringResource(R.string.record_carrier_label))
                Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp)) {
                    RecordCarrier.entries.forEach { c ->
                        val selected = c == viewModel.carrier
                        Text(
                            text = carrierLabel(c),
                            style = MaterialTheme.typography.labelLarge,
                            color = if (selected) BpColors.Card else BpColors.InkSoft,
                            modifier = Modifier
                                .clip(RoundedCornerShape(BpRadius.s.dp))
                                .background(if (selected) BpColors.Espresso else BpColors.Well)
                                .clickable { viewModel.chooseCarrier(c) }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        )
                    }
                }
            }

            when (viewModel.carrier) {
                RecordCarrier.Link -> {
                    SectionHeader(stringResource(R.string.record_field_url))
                    BpTextField(
                        label = stringResource(R.string.record_field_url),
                        value = viewModel.url,
                        onValueChange = viewModel::updateUrl,
                        placeholder = "https://",
                        keyboardType = KeyboardType.Uri,
                    )
                    SectionHeader(stringResource(R.string.record_field_title))
                    BpTextField(
                        label = stringResource(R.string.record_field_title),
                        value = viewModel.title,
                        onValueChange = viewModel::updateTitle,
                    )
                    SectionHeader(stringResource(R.string.record_field_source))
                    BpTextField(
                        label = stringResource(R.string.record_field_source),
                        value = viewModel.source,
                        onValueChange = viewModel::updateSource,
                    )
                }

                RecordCarrier.Image, RecordCarrier.Video -> {
                    SectionHeader(
                        stringResource(
                            if (viewModel.carrier == RecordCarrier.Image) R.string.carrier_image
                            else R.string.carrier_video,
                        ),
                    )
                    val name = viewModel.mediaName
                    if (name != null) {
                        val file = container.mediaStore.preview(name).takeIf { it.exists() }
                            ?: container.mediaStore.file(name)
                        AsyncImage(
                            model = file,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(220.dp)
                                .clip(RoundedCornerShape(BpRadius.m.dp)),
                        )
                    }
                    Spacer(Modifier.height(BpSpacing.s.dp))
                    BpPrimaryButton(
                        text = stringResource(
                            if (viewModel.carrier == RecordCarrier.Image) R.string.record_pick_image
                            else R.string.record_pick_video,
                        ),
                        onClick = {
                            if (viewModel.carrier == RecordCarrier.Image) imagePicker.launch("image/*")
                            else videoPicker.launch("video/*")
                        },
                    )
                    SectionHeader(stringResource(R.string.record_field_title))
                    BpTextField(
                        label = stringResource(R.string.record_field_title),
                        value = viewModel.title,
                        onValueChange = viewModel::updateTitle,
                    )
                }

                RecordCarrier.Text -> {
                    SectionHeader(stringResource(R.string.carrier_text))
                    BpTextField(
                        label = stringResource(R.string.record_field_title),
                        value = viewModel.title,
                        onValueChange = viewModel::updateTitle,
                    )
                }
            }

            SectionHeader(stringResource(R.string.record_tags))
            if (viewModel.tags.isEmpty()) {
                Text(
                    stringResource(R.string.records_empty_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkFaint,
                )
            } else {
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp),
                    verticalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp),
                ) {
                    viewModel.tags.forEach { tag ->
                        val selected = tag.id in viewModel.selectedTagIds
                        Text(
                            text = tag.name,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (selected) BpColors.Card else BpColors.InkSoft,
                            modifier = Modifier
                                .clip(RoundedCornerShape(BpRadius.pill.dp))
                                .background(if (selected) BpColors.Roast else BpColors.Well)
                                .clickable { viewModel.toggleTag(tag.id) }
                                .padding(horizontal = 10.dp, vertical = 5.dp),
                        )
                    }
                }
            }

            SectionHeader(stringResource(R.string.record_field_note))
            BpTextField(
                label = stringResource(R.string.record_field_note),
                value = viewModel.note,
                onValueChange = viewModel::updateNote,
                singleLine = false,
            )

            viewModel.error?.let { error ->
                Spacer(Modifier.height(BpSpacing.s.dp))
                Text(
                    text = when (error) {
                        RecordError.Duplicate -> stringResource(R.string.record_duplicate)
                        RecordError.InvalidUrl -> stringResource(R.string.record_invalid_url)
                        RecordError.SaveFailed -> stringResource(R.string.save_failed)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.Declining,
                )
            }

            Spacer(Modifier.height(BpSpacing.xl.dp))
            BpPrimaryButton(
                text = stringResource(R.string.action_save),
                onClick = {
                    viewModel.save { id ->
                        // 图片/视频需要把文件写进应用目录后才知道文件名；这里已经完成。
                        onSaved(id)
                    }
                },
                enabled = !viewModel.saving,
            )
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }
}

@Composable
fun carrierLabel(carrier: RecordCarrier): String = when (carrier) {
    RecordCarrier.Link -> stringResource(R.string.carrier_link)
    RecordCarrier.Image -> stringResource(R.string.carrier_image)
    RecordCarrier.Video -> stringResource(R.string.carrier_video)
    RecordCarrier.Text -> stringResource(R.string.carrier_text)
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun RecordDetailScreen(
    container: AppContainer,
    recordId: String,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onDeleted: () -> Unit,
) {
    val repository = container.recordRepository
    val context = LocalContext.current
    var item by remember { mutableStateOf<RecordWithTags?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(recordId) {
        item = repository.observeRecord(recordId).first()
    }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.record_detail), style = MaterialTheme.typography.titleLarge) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                actions = {
                    TextButton(onClick = onEdit) { Text(stringResource(R.string.action_edit)) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = BpColors.Paper),
            )
        },
    ) { padding ->
        val current = item ?: return@Scaffold
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = BpSpacing.l.dp),
        ) {
            val record = current.record
            Text(
                text = record.displayTitle().ifBlank { stringResource(R.string.label_untitled) },
                style = MaterialTheme.typography.headlineMedium,
                color = BpColors.Ink,
            )
            Spacer(Modifier.height(BpSpacing.xs.dp))
            Text(
                text = listOfNotNull(
                    record.providerLabel().ifBlank { null },
                    formatDate(record.createdAtMillis),
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
            )

            val media = record.mediaPath ?: record.previewPath
            if (!media.isNullOrBlank()) {
                Spacer(Modifier.height(BpSpacing.m.dp))
                val file = container.mediaStore.preview(media).takeIf { it.exists() }
                    ?: container.mediaStore.file(media)
                if (file.exists()) {
                    AsyncImage(
                        model = file,
                        contentDescription = null,
                        contentScale = ContentScale.FillWidth,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(BpRadius.m.dp)),
                    )
                } else {
                    Text(stringResource(R.string.record_media_missing), color = BpColors.Declining)
                }
            }

            if (record.summary.isNotBlank()) {
                Spacer(Modifier.height(BpSpacing.m.dp))
                Text(record.summary.trim(), style = MaterialTheme.typography.bodyLarge, color = BpColors.InkSoft)
            }
            if (record.note.isNotBlank()) {
                Spacer(Modifier.height(BpSpacing.m.dp))
                Text(record.note.trim(), style = MaterialTheme.typography.bodyLarge, color = BpColors.Ink)
            }

            if (current.tags.isNotEmpty()) {
                Spacer(Modifier.height(BpSpacing.m.dp))
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp),
                ) {
                    current.tags.forEach { BpTag(it.name) }
                }
            }

            val open = record.openURL()
            if (!open.isNullOrBlank()) {
                Spacer(Modifier.height(BpSpacing.l.dp))
                BpPrimaryButton(stringResource(R.string.record_open_original), onClick = {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(open)))
                    }
                })
            }

            Spacer(Modifier.height(BpSpacing.m.dp))
            TextButton(onClick = { confirmDelete = true }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_delete), color = BpColors.Declining)
            }
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.action_delete)) },
            text = { Text(stringResource(R.string.record_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch {
                        repository.deleteRecord(recordId)
                        onDeleted()
                    }
                }) { Text(stringResource(R.string.action_delete), color = BpColors.Declining) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}
