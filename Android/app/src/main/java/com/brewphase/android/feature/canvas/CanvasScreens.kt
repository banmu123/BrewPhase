package com.brewphase.android.feature.canvas

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.FitScreen
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.data.local.CanvasEntity
import com.brewphase.android.data.local.displayTitle
import com.brewphase.android.data.repository.CanvasDraft
import com.brewphase.android.data.repository.CanvasNodeView
import com.brewphase.android.data.repository.CanvasRepository
import com.brewphase.android.data.repository.DuplicateRecordException
import com.brewphase.android.data.repository.RecordRepository
import com.brewphase.android.ui.components.BpEmptyState
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class CanvasListViewModel(private val repository: CanvasRepository) : ViewModel() {

    val canvases: StateFlow<List<CanvasEntity>> = repository.observeCanvases()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun save(name: String, note: String, existingId: String? = null, onDone: () -> Unit = {}) =
        viewModelScope.launch {
            repository.saveCanvas(CanvasDraft(name, note), existingId)
            onDone()
        }

    fun delete(id: String) = viewModelScope.launch { repository.deleteCanvas(id) }

    companion object {
        fun factory(container: AppContainer) = viewModelFactory {
            initializer { CanvasListViewModel(container.canvasRepository) }
        }
    }
}

data class CanvasWorkspaceState(
    val canvas: CanvasEntity? = null,
    val nodes: List<CanvasNodeView> = emptyList(),
)

class CanvasWorkspaceViewModel(
    private val canvasId: String,
    private val canvasRepository: CanvasRepository,
    private val recordRepository: RecordRepository,
) : ViewModel() {

    val state: StateFlow<CanvasWorkspaceState> = combine(
        canvasRepository.observeCanvas(canvasId),
        canvasRepository.observeNodes(canvasId),
    ) { canvas, nodes -> CanvasWorkspaceState(canvas, nodes) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), CanvasWorkspaceState())

    val allRecords = recordRepository.observeRecords()

    fun addRecord(recordId: String, x: Double, y: Double, onDuplicate: () -> Unit = {}) =
        viewModelScope.launch {
            val result = canvasRepository.addRecord(canvasId, recordId, x, y)
            if (result.exceptionOrNull() is DuplicateRecordException) onDuplicate()
        }

    fun move(nodeId: String, x: Double, y: Double) = viewModelScope.launch {
        canvasRepository.moveNode(nodeId, x, y)
    }

    fun remove(nodeId: String) = viewModelScope.launch { canvasRepository.removeNode(nodeId) }

    fun annotate(nodeId: String, text: String) = viewModelScope.launch {
        canvasRepository.updateAnnotation(nodeId, text)
    }

    companion object {
        fun factory(container: AppContainer, canvasId: String) = viewModelFactory {
            initializer {
                CanvasWorkspaceViewModel(canvasId, container.canvasRepository, container.recordRepository)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CanvasListScreen(
    container: AppContainer,
    onOpenCanvas: (String) -> Unit,
) {
    val viewModel: CanvasListViewModel = viewModel(factory = CanvasListViewModel.factory(container))
    val canvases by viewModel.canvases.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<CanvasEntity?>(null) }
    var creating by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(stringResource(R.string.canvas_title), style = MaterialTheme.typography.headlineMedium)
                },
                actions = {
                    IconButton(onClick = { creating = true }) {
                        Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.canvas_new))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = BpColors.Paper),
            )
        },
    ) { padding ->
        if (canvases.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding)) {
                BpEmptyState(
                    title = stringResource(R.string.canvas_empty_title),
                    body = stringResource(R.string.canvas_empty_body),
                )
            }
        } else {
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = BpSpacing.l.dp),
            ) {
                canvases.forEach { canvas ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onOpenCanvas(canvas.id) }
                            .padding(vertical = BpSpacing.m.dp),
                    ) {
                        Text(
                            canvas.name.ifBlank { stringResource(R.string.label_untitled) },
                            style = MaterialTheme.typography.titleMedium,
                            color = BpColors.Ink,
                        )
                        if (canvas.note.isNotBlank()) {
                            Text(
                                canvas.note,
                                style = MaterialTheme.typography.bodyMedium,
                                color = BpColors.InkSoft,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Row {
                            TextButton(
                                onClick = { editing = canvas },
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                            ) {
                                Text(stringResource(R.string.action_edit), style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(BpColors.Hairline))
                }
                Spacer(Modifier.height(BpSpacing.xxl.dp))
            }
        }
    }

    if (creating || editing != null) {
        val target = editing
        var name by remember(target) { mutableStateOf(target?.name.orEmpty()) }
        var note by remember(target) { mutableStateOf(target?.note.orEmpty()) }
        AlertDialog(
            onDismissRequest = { creating = false; editing = null },
            title = { Text(stringResource(if (target == null) R.string.canvas_new else R.string.canvas_rename)) },
            text = {
                Column {
                    BpTextField(stringResource(R.string.canvas_name), name, { name = it })
                    Spacer(Modifier.height(BpSpacing.s.dp))
                    BpTextField(stringResource(R.string.canvas_note), note, { note = it }, singleLine = false)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.save(name, note, target?.id)
                    creating = false
                    editing = null
                }) { Text(stringResource(R.string.action_save)) }
            },
            dismissButton = {
                TextButton(onClick = { creating = false; editing = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

/**
 * 无限画布。
 *
 * 节点位置是**世界坐标**：缩放与平移只改 viewport（父层 graphicsLayer），从不写回
 * 节点。所以换一台手机、或者把画布缩到 40% 再退出，回来时每张卡片仍在原来的地方。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CanvasWorkspaceScreen(
    container: AppContainer,
    canvasId: String,
    onBack: () -> Unit,
    onOpenRecord: (String) -> Unit,
) {
    val viewModel: CanvasWorkspaceViewModel = viewModel(factory = CanvasWorkspaceViewModel.factory(container, canvasId))
    val state by viewModel.state.collectAsStateWithLifecycle()
    val records by viewModel.allRecords.collectAsStateWithLifecycle(initialValue = emptyList())
    var scale by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var pickerOpen by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<CanvasNodeView?>(null) }
    var duplicate by remember { mutableStateOf(false) }
    val density = LocalDensity.current

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        state.canvas?.name?.ifBlank { stringResource(R.string.label_untitled) }
                            ?: stringResource(R.string.canvas_title),
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                actions = {
                    IconButton(onClick = { pickerOpen = true }) {
                        Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.canvas_add_record))
                    }
                    IconButton(onClick = {
                        val nodes = state.nodes
                        if (nodes.isNotEmpty()) {
                            val minX = nodes.minOf { it.node.positionX }
                            val minY = nodes.minOf { it.node.positionY }
                            val maxX = nodes.maxOf { it.node.positionX + it.node.width }
                            val maxY = nodes.maxOf { it.node.positionY + it.node.height }
                            val width = (maxX - minX).coerceAtLeast(1.0)
                            val height = (maxY - minY).coerceAtLeast(1.0)
                            scale = (0.9f / maxOf(width / 360.0, height / 640.0)).toFloat().coerceIn(0.4f, 1.6f)
                            pan = Offset((-minX * scale * density.density).toFloat() + 24f, (-minY * scale * density.density).toFloat() + 24f)
                        }
                    }) {
                        Icon(Icons.Outlined.FitScreen, contentDescription = stringResource(R.string.canvas_fit))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = BpColors.Paper),
            )
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .background(BpColors.Paper)
                .pointerInput(Unit) {
                    detectTransformGestures { _, panChange, zoom, _ ->
                        scale = (scale * zoom).coerceIn(0.35f, 2.5f)
                        pan += panChange
                    }
                },
        ) {
            if (state.nodes.isEmpty()) {
                BpEmptyState(
                    title = stringResource(R.string.canvas_empty_title),
                    body = stringResource(R.string.canvas_empty_workspace),
                    modifier = Modifier.align(Alignment.Center),
                )
            }

            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = pan.x
                        translationY = pan.y
                        transformOrigin = TransformOrigin(0f, 0f)
                    },
            ) {
                state.nodes.forEach { node ->
                    CanvasNodeCard(
                        node = node,
                        scale = scale,
                        onOpen = { onOpenRecord(node.node.recordId) },
                        onSelect = { selected = node },
                        onRemove = { viewModel.remove(node.node.id) },
                        onDragEnd = { dx, dy ->
                            viewModel.move(node.node.id, node.node.positionX + dx, node.node.positionY + dy)
                        },
                    )
                }
            }

            Text(
                text = stringResource(R.string.canvas_zoom_hint) + "  ·  ${(scale * 100).toInt()}%",
                style = MaterialTheme.typography.labelSmall,
                color = BpColors.InkFaint,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = BpSpacing.l.dp),
            )
        }
    }

    if (pickerOpen) {
        AlertDialog(
            onDismissRequest = { pickerOpen = false },
            title = { Text(stringResource(R.string.canvas_pick_record)) },
            text = {
                Column(Modifier.height(360.dp).verticalScroll(rememberScrollState())) {
                    if (records.isEmpty()) {
                        Text(stringResource(R.string.records_empty_body), color = BpColors.InkFaint)
                    }
                    records.forEach { item ->
                        Text(
                            text = item.record.displayTitle().ifBlank { stringResource(R.string.label_untitled) },
                            style = MaterialTheme.typography.bodyLarge,
                            color = BpColors.Ink,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    val index = state.nodes.size
                                    viewModel.addRecord(
                                        item.record.id,
                                        x = 32.0 + (index % 3) * 28.0,
                                        y = 48.0 + index * 26.0,
                                        onDuplicate = { duplicate = true },
                                    )
                                    pickerOpen = false
                                }
                                .padding(vertical = BpSpacing.s.dp),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { pickerOpen = false }) { Text(stringResource(R.string.action_close)) }
            },
        )
    }

    selected?.let { node ->
        var annotation by remember(node.node.id) { mutableStateOf(node.node.annotation) }
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text(stringResource(R.string.canvas_annotation)) },
            text = {
                Column {
                    BpTextField(
                        label = stringResource(R.string.canvas_annotation),
                        value = annotation,
                        onValueChange = { annotation = it },
                        singleLine = false,
                    )
                    Spacer(Modifier.height(BpSpacing.s.dp))
                    Text(
                        stringResource(R.string.canvas_open_record),
                        style = MaterialTheme.typography.labelLarge,
                        color = BpColors.Roast,
                        modifier = Modifier.clickable {
                            selected = null
                            onOpenRecord(node.node.recordId)
                        },
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.annotate(node.node.id, annotation)
                    selected = null
                }) { Text(stringResource(R.string.action_save)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    viewModel.remove(node.node.id)
                    selected = null
                }) { Text(stringResource(R.string.canvas_remove_node), color = BpColors.Declining) }
            },
        )
    }

    if (duplicate) {
        AlertDialog(
            onDismissRequest = { duplicate = false },
            title = { Text(stringResource(R.string.canvas_node_duplicate)) },
            confirmButton = {
                TextButton(onClick = { duplicate = false }) { Text(stringResource(R.string.action_done)) }
            },
        )
    }
}

@Composable
private fun CanvasNodeCard(
    node: CanvasNodeView,
    scale: Float,
    onOpen: () -> Unit,
    onSelect: () -> Unit,
    onRemove: () -> Unit,
    onDragEnd: (Double, Double) -> Unit,
) {
    val density = LocalDensity.current
    var drag by remember(node.node.id) { mutableStateOf(Offset.Zero) }

    Box(
        modifier = Modifier
            .offset(x = node.node.positionX.dp, y = node.node.positionY.dp)
            .size(node.node.width.dp, node.node.height.dp)
            .graphicsLayer {
                translationX = drag.x
                translationY = drag.y
            }
            .clip(RoundedCornerShape(BpRadius.l.dp))
            .background(BpColors.Card)
            .pointerInput(node.node.id, scale) {
                detectDragGestures(
                    onDrag = { change, amount ->
                        change.consume()
                        drag += amount
                    },
                    onDragEnd = {
                        val dx = drag.x / density.density / scale
                        val dy = drag.y / density.density / scale
                        drag = Offset.Zero
                        onDragEnd(dx.toDouble(), dy.toDouble())
                    },
                    onDragCancel = { drag = Offset.Zero },
                )
            }
            .clickable(onClick = onOpen),
    ) {
        Column(Modifier.fillMaxSize().padding(BpSpacing.m.dp)) {
            Text(
                text = node.record?.displayTitle()?.ifBlank { null } ?: stringResource(R.string.label_untitled),
                style = MaterialTheme.typography.titleMedium,
                color = BpColors.Ink,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            if (node.node.annotation.isNotBlank()) {
                Spacer(Modifier.height(BpSpacing.xs.dp))
                Text(
                    node.node.annotation,
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.InkSoft,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(Modifier.align(Alignment.TopEnd)) {
            IconButton(onClick = onSelect, modifier = Modifier.size(32.dp)) {
                Text("⋯", style = MaterialTheme.typography.labelLarge, color = BpColors.InkFaint)
            }
            IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.canvas_remove_node), tint = BpColors.InkFaint, modifier = Modifier.size(16.dp))
            }
        }
    }
}
