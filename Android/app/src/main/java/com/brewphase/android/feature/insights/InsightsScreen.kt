package com.brewphase.android.feature.insights

import androidx.compose.foundation.background
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
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
import com.brewphase.android.domain.model.BeanPhase
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.domain.model.BrewRecord
import com.brewphase.android.ui.components.SectionHeader
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

data class InsightCard(val titleRes: Int, val body: String, val evidence: String?)

data class InsightsState(
    val cards: List<InsightCard> = emptyList(),
    val hasData: Boolean = false,
)

/**
 * 洞察：只说得出来的话。
 *
 * 每一条都来自真实记录——没有足够样本时它就说"证据不足"，而不是用平均值假装
 * 一个结论。与 iOS 的六段结构对应：今天喝哪包、最近一杯、与上一杯的变化、
 * 参数偏差、我的最佳参数、下一步建议。
 */
class InsightsViewModel(
    beanRepository: BeanRepository,
    brewRepository: BrewRepository,
) : ViewModel() {

    val state: StateFlow<InsightsState> = combine(
        beanRepository.observeBeans(),
        beanRepository.observeRuleBook(),
        brewRepository.observeAllBrews(),
    ) { beans, rules, brews ->
        val today = DateMath.today()
        val cards = mutableListOf<InsightCard>()

        val active = beans.filter { it.status == BeanStatus.Active && it.remainingG > 0 }
        val readings = active.associateWith {
            com.brewphase.android.domain.engine.PhaseEngine.reading(it, rules[it.roastLevel], today)
        }

        // 1. 今天喝哪包：优先在黄金期、窗口剩余天数最少的；没有再退到衰减期。
        val peak = active
            .filter { readings[it]?.phase == BeanPhase.Peak }
            .minByOrNull { readings[it]?.daysUntilWindowEnd ?: Int.MAX_VALUE }
        val declining = active.firstOrNull { readings[it]?.phase == BeanPhase.Declining }
        val pick = peak ?: declining
        cards += if (pick != null) {
            InsightCard(
                titleRes = R.string.insights_today,
                body = pick.name.ifBlank { pick.roaster.ifBlank { "—" } },
                evidence = readings[pick]?.let {
                    if (it.daysUntilWindowEnd >= 0) {
                        "黄金期还剩 ${it.daysUntilWindowEnd} 天 · 剩 ${formatGrams(pick.remainingG)}g"
                    } else {
                        "已过黄金期 ${-it.daysUntilWindowEnd} 天 · 剩 ${formatGrams(pick.remainingG)}g"
                    }
                },
            )
        } else {
            InsightCard(R.string.insights_today, "—", null)
        }

        // 2. 最近一杯
        val latest = brews.maxByOrNull { it.dateMillis }
        if (latest != null) {
            cards += InsightCard(
                titleRes = R.string.insights_latest,
                body = listOfNotNull(
                    latest.recipe.method.ifBlank { null },
                    latest.recipe.coffeeG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                    latest.recipe.waterG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                    latest.timeText.ifBlank { null },
                    latest.score.takeIf { it > 0 }?.let { "$it/5" },
                ).joinToString(" · ").ifBlank { "—" },
                evidence = null,
            )

            // 3. 与上一杯的变化：同一包豆的前一杯，只在有评分时比较。
            val previous = brews.filter { it.beanId == latest.beanId && it.id != latest.id }
                .maxByOrNull { it.dateMillis }
            if (previous != null && latest.score > 0 && previous.score > 0) {
                val delta = latest.score - previous.score
                cards += InsightCard(
                    titleRes = R.string.insights_change,
                    body = when {
                        delta > 0 -> "+$delta 分"
                        delta < 0 -> "$delta 分"
                        else -> "持平"
                    },
                    evidence = "上一杯 ${previous.score}/5",
                )
            } else {
                cards += InsightCard(R.string.insights_change, stringResourceFallback(), null)
            }

            // 4. 参数偏差：这包豆最近几杯的平均粉量与水温。
            val beanBrews = brews.filter { it.beanId == latest.beanId && it.recipe.coffeeG > 0 }
            if (beanBrews.size >= 3) {
                val avgDose = beanBrews.map { it.recipe.coffeeG }.average()
                val avgTemp = beanBrews.filter { it.recipe.waterTemp > 0 }
                    .map { it.recipe.waterTemp }.average()
                val parts = buildList {
                    add("粉量 ${"%.1f".format(avgDose)}g（这杯 ${formatGrams(latest.recipe.coffeeG)}g）")
                    if (avgTemp > 0) add("水温 ${"%.0f".format(avgTemp)}°C")
                }
                cards += InsightCard(
                    titleRes = R.string.insights_deviation,
                    body = parts.joinToString(" · "),
                    evidence = "${beanBrews.size} 杯样本",
                )
            } else {
                cards += InsightCard(R.string.insights_deviation, "证据不足", null)
            }

            // 5. 我的最佳参数：这包豆最高分的一杯。
            val best = brews.filter { it.beanId == latest.beanId && it.score > 0 }.maxByOrNull { it.score }
            cards += if (best != null) {
                InsightCard(
                    titleRes = R.string.insights_best,
                    body = listOfNotNull(
                        best.score.takeIf { it > 0 }?.let { "$it/5" },
                        best.recipe.coffeeG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                        best.recipe.waterG.takeIf { it > 0 }?.let { "${formatGrams(it)}g" },
                        best.recipe.waterTemp.takeIf { it > 0 }?.let { "${it.toInt()}°C" },
                    ).joinToString(" · "),
                    evidence = null,
                )
            } else {
                InsightCard(R.string.insights_best, "证据不足", null)
            }

            // 6. 下一步：只在有最佳参数、且当前这一杯低于最佳时给建议。
            val bestBrew = brews.filter { it.beanId == latest.beanId && it.score > 0 }.maxByOrNull { it.score }
            val next = when {
                bestBrew == null -> "再多记几杯，才能比较。"
                latest.score <= 0 -> "给这一杯打个分，下一步才有依据。"
                latest.score < bestBrew.score -> buildString {
                    append("回到 ${bestBrew.recipe.coffeeG.let { formatGrams(it) }}g")
                    if (bestBrew.recipe.waterTemp > 0) append(" / ${bestBrew.recipe.waterTemp.toInt()}°C")
                    append(" 的那套参数试试。")
                }
                else -> "这已经是目前最好的一杯，先保持。"
            }
            cards += InsightCard(R.string.insights_next, next, null)
        }

        InsightsState(cards = cards, hasData = active.isNotEmpty() || brews.isNotEmpty())
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), InsightsState())

    private fun stringResourceFallback(): String = "—"

    companion object {
        fun factory(container: AppContainer) = viewModelFactory {
            initializer { InsightsViewModel(container.beanRepository, container.brewRepository) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsightsScreen(container: AppContainer, onBack: () -> Unit) {
    val viewModel: InsightsViewModel = viewModel(factory = InsightsViewModel.factory(container))
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.insights_title), style = MaterialTheme.typography.titleLarge) },
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
            if (!state.hasData) {
                Text(
                    stringResource(R.string.insights_no_data),
                    style = MaterialTheme.typography.bodyLarge,
                    color = BpColors.InkFaint,
                    modifier = Modifier.padding(vertical = BpSpacing.xl.dp),
                )
                return@Column
            }

            state.cards.forEach { card ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = BpSpacing.s.dp)
                        .background(BpColors.Card, RoundedCornerShape(BpRadius.l.dp))
                        .padding(BpSpacing.l.dp),
                ) {
                    Text(
                        stringResource(card.titleRes),
                        style = MaterialTheme.typography.labelLarge,
                        color = BpColors.InkFaint,
                    )
                    Spacer(Modifier.height(BpSpacing.xs.dp))
                    Text(card.body, style = MaterialTheme.typography.titleMedium, color = BpColors.Ink)
                    card.evidence?.let {
                        Spacer(Modifier.height(BpSpacing.xxs.dp))
                        Text(it, style = MaterialTheme.typography.labelSmall, color = BpColors.InkFaint)
                    }
                }
            }
            Spacer(Modifier.height(BpSpacing.xxl.dp))
        }
    }
}
