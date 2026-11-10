package com.brewphase.android.feature.coffee

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.ui.components.BpEmptyState
import com.brewphase.android.ui.components.PhaseDot
import com.brewphase.android.ui.components.TagLine
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.formatDate
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import java.io.File

/**
 * 豆仓。
 *
 * 视觉语言刻意保持"仓库"而不是"库存后台"：没有卡片墙、没有彩色徽章，
 * 只有一列豆子、一条细分隔线和一个说明它现在处在哪一段的小圆点。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CoffeeScreen(
    container: AppContainer,
    onOpenBean: (String) -> Unit,
    onAddBean: () -> Unit,
    onOpenInsights: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val viewModel: CoffeeViewModel = viewModel(factory = CoffeeViewModel.factory(container))
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(R.string.coffee_title),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Normal,
                    )
                },
                actions = {
                    IconButton(onClick = onOpenInsights) {
                        Icon(Icons.Outlined.Insights, contentDescription = stringResource(R.string.insights_title), tint = BpColors.InkSoft)
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Outlined.Settings, contentDescription = stringResource(R.string.settings_title), tint = BpColors.InkSoft)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = BpColors.Paper,
                    titleContentColor = BpColors.Ink,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onAddBean,
                containerColor = BpColors.Espresso,
                contentColor = androidx.compose.ui.graphics.Color.White,
                shape = RoundedCornerShape(BpRadius.l.dp),
            ) {
                Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.coffee_add))
            }
        },
    ) { padding ->
        if (state.active.isEmpty() && state.finished.isEmpty() && !state.loading) {
            Box(Modifier.fillMaxSize().padding(padding)) {
                BpEmptyState(
                    title = stringResource(R.string.coffee_empty_title),
                    body = stringResource(R.string.coffee_empty_body),
                )
            }
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 96.dp),
        ) {
            if (state.active.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.coffee_active_section),
                        modifier = Modifier.padding(start = BpSpacing.l.dp, top = BpSpacing.l.dp, bottom = BpSpacing.xs.dp),
                        style = MaterialTheme.typography.labelLarge,
                        color = BpColors.InkFaint,
                    )
                }
                items(state.active, key = { it.bean.id }) { item ->
                    BeanRow(item = item, onClick = { onOpenBean(item.bean.id) })
                }
            }

            if (state.finished.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.coffee_finished_section),
                        modifier = Modifier.padding(start = BpSpacing.l.dp, top = BpSpacing.xl.dp, bottom = BpSpacing.xs.dp),
                        style = MaterialTheme.typography.labelLarge,
                        color = BpColors.InkFaint,
                    )
                }
                items(state.finished, key = { it.bean.id }) { item ->
                    BeanRow(item = item, onClick = { onOpenBean(item.bean.id) }, dimmed = true)
                }
            }
        }
    }
}

@Composable
private fun BeanRow(
    item: CoffeeBeanItem,
    onClick: () -> Unit,
    dimmed: Boolean = false,
) {
    val bean = item.bean
    val reading = item.reading
    val alpha = if (dimmed) 0.55f else 1f

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .background(BpColors.Paper)
            .padding(horizontal = BpSpacing.l.dp, vertical = BpSpacing.m.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Box(
                modifier = Modifier
                    .size(58.dp)
                    .clip(RoundedCornerShape(BpRadius.m.dp))
                    .background(BpColors.Well),
            ) {
                val path = bean.imagePath
                if (!path.isNullOrBlank()) {
                    AsyncImage(
                        model = File(path),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            Spacer(Modifier.width(BpSpacing.m.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = bean.name.ifBlank { stringResource(R.string.label_untitled) },
                    style = MaterialTheme.typography.titleMedium,
                    color = BpColors.Ink.copy(alpha = alpha),
                    maxLines = 2,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = buildString {
                        if (bean.roaster.isNotBlank()) append(bean.roaster).append(" · ")
                        append(roastLevelLabel(bean.roastLevel))
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = BpColors.InkSoft.copy(alpha = alpha),
                    maxLines = 1,
                )
                Spacer(Modifier.height(BpSpacing.xs.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PhaseDot(reading.phase)
                    Spacer(Modifier.width(BpSpacing.m.dp))
                    Text(
                        text = stringResource(R.string.coffee_remaining, formatGrams(bean.remainingG)),
                        style = MaterialTheme.typography.labelSmall,
                        color = BpColors.InkFaint,
                    )
                    if (reading.dayAfterRoast != null) {
                        Spacer(Modifier.width(BpSpacing.m.dp))
                        Text(
                            text = stringResource(R.string.coffee_day, reading.dayAfterRoast),
                            style = MaterialTheme.typography.labelSmall,
                            color = BpColors.InkFaint,
                        )
                    }
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    text = item.latestBrew?.let { brew ->
                        stringResource(
                            R.string.coffee_last_brew,
                            listOfNotNull(
                                brew.recipe.method.ifBlank { null },
                                brew.recipe.coffeeG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                                brew.recipe.waterG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                            ).joinToString(" · ").ifBlank { formatDate(brew.dateMillis) },
                        )
                    } ?: stringResource(R.string.coffee_no_brew),
                    style = MaterialTheme.typography.labelSmall,
                    color = BpColors.InkFaint.copy(alpha = alpha),
                    maxLines = 1,
                )
                TagLine(bean.flavorTags, modifier = Modifier.padding(top = 2.dp))
            }
        }
        Spacer(Modifier.height(BpSpacing.m.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(BpColors.Hairline))
    }
}

@Composable
fun roastLevelLabel(level: com.brewphase.android.domain.model.RoastLevel): String = when (level) {
    com.brewphase.android.domain.model.RoastLevel.Light -> stringResource(R.string.roast_light)
    com.brewphase.android.domain.model.RoastLevel.Medium -> stringResource(R.string.roast_medium)
    com.brewphase.android.domain.model.RoastLevel.MediumDark -> stringResource(R.string.roast_medium_dark)
    com.brewphase.android.domain.model.RoastLevel.Dark -> stringResource(R.string.roast_dark)
    com.brewphase.android.domain.model.RoastLevel.EspressoBlend -> stringResource(R.string.roast_espresso)
}
