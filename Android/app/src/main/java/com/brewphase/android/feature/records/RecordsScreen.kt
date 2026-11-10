package com.brewphase.android.feature.records

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.data.local.RecordWithTags
import com.brewphase.android.data.local.carrier
import com.brewphase.android.data.local.displayTitle
import com.brewphase.android.data.local.providerLabel
import com.brewphase.android.data.local.sourceLine
import com.brewphase.android.domain.model.RecordCarrier
import com.brewphase.android.ui.components.BpEmptyState
import com.brewphase.android.ui.components.BpTag
import com.brewphase.android.ui.components.TagLine
import com.brewphase.android.ui.formatDate
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordsScreen(
    container: AppContainer,
    onOpenRecord: (String) -> Unit,
    onAddRecord: (RecordCarrier?) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val viewModel: RecordsViewModel = viewModel(factory = RecordsViewModel.factory(container))
    val state by viewModel.state.collectAsStateWithLifecycle()
    val mediaStore = container.mediaStore

    LaunchedEffect(Unit) { viewModel.ensureSuggestedTags() }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(R.string.records_title),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Normal,
                    )
                },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Outlined.Settings, contentDescription = stringResource(R.string.settings_title), tint = BpColors.InkSoft)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = BpColors.Paper),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { onAddRecord(null) },
                containerColor = BpColors.Espresso,
                contentColor = Color.White,
                shape = RoundedCornerShape(BpRadius.l.dp),
            ) {
                Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.records_add))
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            SearchField(
                value = state.query,
                onValueChange = viewModel::setQuery,
            )

            if (state.tags.isNotEmpty()) {
                LazyRow(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = BpSpacing.l.dp),
                    horizontalArrangement = Arrangement.spacedBy(BpSpacing.xs.dp),
                ) {
                    item {
                        FilterChip(
                            label = stringResource(R.string.records_all),
                            selected = state.selectedTagId == null,
                            onClick = { viewModel.selectTag(null) },
                        )
                    }
                    items(state.tags, key = { it.id }) { tag ->
                        FilterChip(
                            label = if (tag.recordCount > 0) "${tag.name} ${tag.recordCount}" else tag.name,
                            selected = state.selectedTagId == tag.id,
                            onClick = { viewModel.selectTag(if (state.selectedTagId == tag.id) null else tag.id) },
                        )
                    }
                }
            }

            if (state.records.isEmpty() && !state.loading) {
                Box(Modifier.fillMaxSize()) {
                    BpEmptyState(
                        title = stringResource(
                            if (state.query.isBlank() && state.selectedTagId == null) R.string.records_empty_title
                            else R.string.records_no_result,
                        ),
                        body = stringResource(
                            if (state.query.isBlank() && state.selectedTagId == null) R.string.records_empty_body
                            else R.string.records_search,
                        ),
                    )
                }
                return@Column
            }

            LazyVerticalStaggeredGrid(
                columns = StaggeredGridCells.Adaptive(minSize = 156.dp),
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = BpSpacing.l.dp,
                    end = BpSpacing.l.dp,
                    top = BpSpacing.s.dp,
                    bottom = 96.dp,
                ),
                verticalItemSpacing = BpSpacing.s.dp,
                horizontalArrangement = Arrangement.spacedBy(BpSpacing.s.dp),
            ) {
                items(state.records, key = { it.record.id }) { item ->
                    RecordCard(
                        item = item,
                        imageFile = item.record.previewPath?.let { name ->
                            mediaStore.preview(name).takeIf { it.exists() } ?: mediaStore.file(name)
                        },
                        onClick = { onOpenRecord(item.record.id) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = BpSpacing.l.dp, vertical = BpSpacing.xs.dp),
        placeholder = { Text(stringResource(R.string.records_search), style = MaterialTheme.typography.bodyMedium) },
        leadingIcon = {
            Icon(Icons.Outlined.Search, contentDescription = null, tint = BpColors.InkFaint, modifier = Modifier.size(18.dp))
        },
        singleLine = true,
        shape = RoundedCornerShape(BpRadius.m.dp),
        textStyle = MaterialTheme.typography.bodyLarge,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = BpColors.Well,
            unfocusedContainerColor = BpColors.Well,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            focusedTextColor = BpColors.Ink,
            unfocusedTextColor = BpColors.Ink,
            cursorColor = BpColors.Roast,
        ),
    )
}

@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = if (selected) BpColors.Card else BpColors.InkSoft,
        modifier = Modifier
            .clip(RoundedCornerShape(BpRadius.pill.dp))
            .background(if (selected) BpColors.Espresso else BpColors.Well)
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 5.dp),
    )
}

@Composable
private fun RecordCard(item: RecordWithTags, imageFile: File?, onClick: () -> Unit) {
    val record = item.record
    val carrier = record.carrier()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(BpRadius.l.dp))
            .background(BpColors.Card)
            .clickable(onClick = onClick),
    ) {
        if (imageFile != null && imageFile.exists()) {
            AsyncImage(
                model = imageFile,
                contentDescription = null,
                contentScale = ContentScale.FillWidth,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Column(Modifier.padding(BpSpacing.m.dp)) {
            if (carrier == RecordCarrier.Link) {
                Text(
                    text = record.providerLabel().ifBlank { record.sourceLine() },
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.Latte,
                )
                Spacer(Modifier.height(BpSpacing.xxs.dp))
            }
            Text(
                text = record.displayTitle().ifBlank { stringResource(R.string.label_untitled) },
                style = MaterialTheme.typography.titleMedium,
                color = BpColors.Ink,
                maxLines = if (carrier == RecordCarrier.Text) 6 else 3,
                overflow = TextOverflow.Ellipsis,
            )
            if (carrier == RecordCarrier.Link && record.summary.isNotBlank()) {
                Spacer(Modifier.height(BpSpacing.xxs.dp))
                Text(
                    text = record.summary.trim(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkSoft,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (carrier == RecordCarrier.Text && record.note.isNotBlank()) {
                Spacer(Modifier.height(BpSpacing.xxs.dp))
                Text(
                    text = record.note.trim(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkSoft,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (item.tags.isNotEmpty()) {
                Spacer(Modifier.height(BpSpacing.s.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(BpSpacing.xxs.dp)) {
                    item.tags.take(2).forEach { tag -> BpTag(tag.name) }
                }
            }
            Spacer(Modifier.height(BpSpacing.xs.dp))
            Text(
                text = formatDate(record.createdAtMillis),
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
            )
        }
    }
}
