package com.brewphase.android.feature.ask

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
import androidx.compose.material.icons.outlined.Send
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
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
import com.brewphase.android.domain.engine.PhaseEngine
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BrewRecord
import com.brewphase.android.domain.model.TastingRecord
import com.brewphase.android.ui.components.BpTextField
import com.brewphase.android.ui.components.formatGrams
import com.brewphase.android.ui.theme.BpColors
import com.brewphase.android.ui.theme.BpRadius
import com.brewphase.android.ui.theme.BpSpacing
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** 一条回答里的引用：说到哪条记录，就把那条记录摆出来。 */
data class AskCitation(val label: String, val detail: String, val source: CitationSource)

enum class CitationSource { PersonalRecord, KnowledgeBase }

data class AskAnswer(
    val question: String,
    val body: String,
    val citations: List<AskCitation>,
)

/**
 * 本地咖啡问答（V1）。
 *
 * **明确的能力边界**：这里做的是基于用户自己记录的关键词检索与结构化事实回答，
 * 没有移植 iOS 的 RAG（HybridRetriever / Embedding / 知识库 JSON）。所以：
 * - 它不会假装读过知识库，也不会伪造引用；
 * - 检索不到就直说"你的记录里没有足够的信息"；
 * - 每一条结论后面都跟着它来自哪条记录。
 *
 * 见 `docs/IOS_PARITY_MATRIX.md` 的 Ask 一行：状态是 IN_PROGRESS，不是 TESTED。
 */
class AskViewModel(
    private val beanId: String?,
    private val beanRepository: BeanRepository,
    private val brewRepository: BrewRepository,
) : ViewModel() {

    var answers by mutableStateOf<List<AskAnswer>>(emptyList())
        private set
    var busy by mutableStateOf(false)
        private set

    fun ask(question: String) {
        val trimmed = question.trim()
        if (trimmed.isEmpty() || busy) return
        busy = true
        viewModelScope.launch {
            val allBeans = beanRepository.observeBeans().first()
            val scopeBeans = if (beanId != null) allBeans.filter { it.id == beanId } else allBeans
            val brews = if (beanId != null) brewRepository.observeBrews(beanId).first()
            else brewRepository.observeAllBrews().first()
            val tastings = if (beanId != null) beanRepository.observeTastings(beanId).first() else emptyList()

            val terms = tokenize(trimmed)
            val citations = mutableListOf<AskCitation>()
            val facts = mutableListOf<String>()

            // 1. 豆子事实：阶段、库存、烘焙度。
            scopeBeans.forEach { bean ->
                if (matchesBean(bean, terms)) {
                    val reading = PhaseEngine.reading(
                        bean,
                        null,
                        DateMath.today(),
                    )
                    val phaseText = when (reading.problem) {
                        com.brewphase.android.domain.engine.PhaseReading.Problem.MissingRoastDate ->
                            "还没有烘焙日期，算不出阶段"
                        com.brewphase.android.domain.engine.PhaseReading.Problem.RoastDateInFuture ->
                            "烘焙日期在未来，需要先检查"
                        null -> "现在处在${phaseLabel(reading.phase)}，烘焙后第 ${reading.dayAfterRoast} 天"
                    }
                    facts += "${bean.name}：$phaseText，剩 ${formatGrams(bean.remainingG)}g。"
                    citations += AskCitation(
                        label = bean.name,
                        detail = "烘焙度 ${bean.roastLevel.raw} · 剩 ${formatGrams(bean.remainingG)}g",
                        source = CitationSource.PersonalRecord,
                    )
                }
            }

            // 2. 冲煮事实：匹配笔记、方法或风味标签。
            brews.filter { matchesBrew(it, terms) }.take(5).forEach { brew ->
                facts += buildString {
                    append("${formatDateShort(brew.dateMillis)} 这杯")
                    if (brew.recipe.method.isNotBlank()) append("（${brew.recipe.method}）")
                    append("：${formatGrams(brew.recipe.coffeeG)}g 粉 / ${formatGrams(brew.recipe.waterG)}g 水")
                    if (brew.score > 0) append("，${brew.score}/5")
                    if (brew.notes.isNotBlank()) append("，你写着「${brew.notes.take(40)}」")
                    append("。")
                }
                citations += AskCitation(
                    label = "${formatDateShort(brew.dateMillis)} 的冲煮",
                    detail = listOfNotNull(
                        brew.recipe.method.ifBlank { null },
                        brew.score.takeIf { it > 0 }?.let { "$it/5" },
                    ).joinToString(" · ").ifBlank { "冲煮记录" },
                    source = CitationSource.PersonalRecord,
                )
            }

            // 3. 品鉴事实
            tastings.filter { matchesTasting(it, terms) }.take(3).forEach { tasting ->
                facts += "第 ${tasting.dayAfterRoast} 天的品鉴：${
                    listOfNotNull(
                        tasting.score.takeIf { it > 0 }?.let { "$it/5" },
                        tasting.flavorTags.joinToString(" / ").ifBlank { null },
                        tasting.notes.take(30).ifBlank { null },
                    ).joinToString(" · ")
                }。"
                citations += AskCitation(
                    label = "第 ${tasting.dayAfterRoast} 天品鉴",
                    detail = tasting.flavorTags.joinToString(" · ").ifBlank { "品鉴记录" },
                    source = CitationSource.PersonalRecord,
                )
            }

            val body = when {
                facts.isEmpty() -> "你的记录里没有足够的信息来回答这个。换一个说法，或者先多记几杯。"
                else -> "基于你的记录：\n\n" + facts.distinct().take(6).joinToString("\n")
            }

            answers = answers + AskAnswer(trimmed, body, citations.distinctBy { it.label + it.detail }.take(6))
            busy = false
        }
    }

    private fun tokenize(text: String): List<String> =
        text.split(' ', '，', ',', '。', '？', '?', '！', '!', '、')
            .map { it.trim() }
            .filter { it.length >= 2 }

    private fun matchesBean(bean: BeanSnapshot, terms: List<String>): Boolean {
        val haystack = listOf(bean.name, bean.roaster, bean.flavorTags.joinToString(" ")).joinToString(" ")
        return terms.any { haystack.contains(it, ignoreCase = true) } || terms.isEmpty()
    }

    private fun matchesBrew(brew: BrewRecord, terms: List<String>): Boolean {
        val haystack = listOf(
            brew.recipe.method,
            brew.notes,
            brew.flavorTags.joinToString(" "),
        ).joinToString(" ")
        return terms.any { haystack.contains(it, ignoreCase = true) }
    }

    private fun matchesTasting(tasting: TastingRecord, terms: List<String>): Boolean {
        val haystack = listOf(tasting.notes, tasting.flavorTags.joinToString(" ")).joinToString(" ")
        return terms.any { haystack.contains(it, ignoreCase = true) }
    }

    private fun phaseLabel(phase: com.brewphase.android.domain.model.BeanPhase): String = when (phase) {
        com.brewphase.android.domain.model.BeanPhase.Resting -> "养豆期"
        com.brewphase.android.domain.model.BeanPhase.Opening -> "风味打开"
        com.brewphase.android.domain.model.BeanPhase.Peak -> "黄金风味期"
        com.brewphase.android.domain.model.BeanPhase.Declining -> "风味衰减"
    }

    private fun formatDateShort(millis: Long): String =
        DateMath.fromEpochMillis(millis).toString()

    companion object {
        fun factory(container: AppContainer, beanId: String?) = viewModelFactory {
            initializer { AskViewModel(beanId, container.beanRepository, container.brewRepository) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AskScreen(
    container: AppContainer,
    beanId: String?,
    onBack: () -> Unit,
) {
    val viewModel: AskViewModel = viewModel(factory = AskViewModel.factory(container, beanId))
    var input by mutableStateOf("")
    val scope = rememberCoroutineScope()

    Scaffold(
        containerColor = BpColors.Paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.ask_title), style = MaterialTheme.typography.titleLarge) },
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
                .padding(horizontal = BpSpacing.l.dp),
        ) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                if (viewModel.answers.isEmpty()) {
                    Text(
                        stringResource(R.string.ask_empty),
                        style = MaterialTheme.typography.bodyLarge,
                        color = BpColors.InkFaint,
                        modifier = Modifier.padding(vertical = BpSpacing.xl.dp),
                    )
                }
                viewModel.answers.forEach { answer ->
                    Column(Modifier.fillMaxWidth().padding(vertical = BpSpacing.s.dp)) {
                        Text(answer.question, style = MaterialTheme.typography.titleMedium, color = BpColors.Roast)
                        Spacer(Modifier.height(BpSpacing.xs.dp))
                        Text(answer.body, style = MaterialTheme.typography.bodyLarge, color = BpColors.Ink)
                        if (answer.citations.isNotEmpty()) {
                            Spacer(Modifier.height(BpSpacing.s.dp))
                            Text(
                                stringResource(R.string.ask_scope_personal),
                                style = MaterialTheme.typography.labelSmall,
                                color = BpColors.InkFaint,
                            )
                            answer.citations.forEach { citation ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 2.dp)
                                        .background(BpColors.Well, RoundedCornerShape(BpRadius.s.dp))
                                        .padding(horizontal = BpSpacing.s.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        citation.label,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = BpColors.InkSoft,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            Row(verticalAlignment = Alignment.Bottom) {
                BpTextField(
                    label = stringResource(R.string.ask_title),
                    value = input,
                    onValueChange = { input = it },
                    placeholder = stringResource(R.string.ask_placeholder),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = {
                    viewModel.ask(input)
                    input = ""
                }) {
                    Icon(Icons.Outlined.Send, contentDescription = stringResource(R.string.ask_send), tint = BpColors.Roast)
                }
            }
            Spacer(Modifier.height(BpSpacing.l.dp))
        }
    }
}
