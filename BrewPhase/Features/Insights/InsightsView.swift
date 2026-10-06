import SwiftData
import SwiftUI

/// 洞察：「我不用问，它主动告诉我现在最值得关注什么。」
///
/// 与「问一问」的分工：问一问是用户带着问题来的入口，这里是**主动汇报**——
/// 按固定的四层往下讲，每一层都把依据摆在明面上（协议 §29）：
///
/// 1. **Today** —— 今天喝哪包（`PriorityEngine` 的排序结论 + 天气微调）、
///    手冲还是意式；
/// 2. **Recent Brew** —— 最近一杯：参数、评分、味觉，与再上一杯相比变了什么，
///    以及是否偏离自己的正常范围（`ParameterDeviationAnalyzer`）；
/// 3. **Personal Pattern** —— 高评分记录的稳定参数（`PersonalBestAnalyzer`）；
/// 4. **Action** —— 只给一个最值得执行的改动（既有诊断链的 `AdjustmentSuggestion`，
///    这里不新造建议）。
///
/// 提问式的检索不在这里——那是「问一问」的职责，两个页面不再各养一个输入框。
struct InsightsView: View {

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query private var rules: [PhaseRule]

    @State private var engine: RecommendationEngine?
    @State private var todayInsight: Insight?
    @State private var methodInsight: Insight?
    @State private var bestInsight: Insight?
    @State private var deviationInsight: Insight?
    @State private var selectedBeanID: UUID?

    private var settings: RAGSettings { RAGSettings.current() }
    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }
    private var activeBeans: [Bean] { beans.filter { !$0.isFinished } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                if activeBeans.isEmpty {
                    emptyCellar
                } else {
                    if let todayInsight {
                        insightSection(title: "今天喝哪包", insight: todayInsight)
                    }
                    if let methodInsight {
                        insightSection(title: "手冲还是意式", insight: methodInsight)
                    }
                    recentBrewSection
                    if let bestInsight {
                        insightSection(title: "我的最佳参数", insight: bestInsight)
                        if bestInsight.confidence != .insufficientEvidence {
                            Text("这是你自己的高分记录统计，不是专业标准。")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .padding(.horizontal, 4)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let nextAction {
                        actionSection(nextAction)
                    }
                    footnote
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 12)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("洞察")
        .navigationBarTitleDisplayMode(.inline)
        .task { await prepare() }
        .onChange(of: selectedBeanID) {
            refreshAnalysis()
        }
    }

    // MARK: - 空库

    private var emptyCellar: some View {
        VStack(spacing: 10) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 22))
                .foregroundStyle(Palette.inkFaint)
            Text("豆仓里还没有豆子。先加一包，喝过几次之后这里就会有话说了。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    // MARK: - 卡片

    private func insightSection(title: LocalizedStringKey, insight: Insight) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title)
            insightCard(insight)
        }
    }

    private func insightCard(_ insight: Insight) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text(LocalizedStringKey.alreadyLocalized(insight.headline))
                    .font(TypeScale.cardTitle)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                if insight.confidence == .insufficientEvidence {
                    // 数据不足也要漂亮（规格 §十六）：不是一句冷冰冰的「证据不足」，
                    // 而是告诉用户规律正在路上。具体差几杯在下面的证据行里。
                    VStack(alignment: .leading, spacing: 5) {
                        Text("还在认识你的冲煮习惯")
                            .font(TypeScale.callout.weight(.medium))
                            .foregroundStyle(Palette.inkSoft)
                        Text("再记录几杯，这里会开始出现你的个人规律。")
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                    }
                }

                ForEach(insight.reasons, id: \.self) { reason in
                    bullet(reason, color: Palette.inkSoft)
                }

                if !insight.evidence.isEmpty {
                    CardDivider()
                    ForEach(insight.evidence) { row in
                        HStack(alignment: .top, spacing: 7) {
                            Circle()
                                .fill(Palette.latte)
                                .frame(width: 3, height: 3)
                                .padding(.top, 7)
                            Text(LocalizedStringKey.alreadyLocalized(row.text))
                                .font(TypeScale.caption.monospacedDigit())
                                .foregroundStyle(Palette.inkFaint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private func bullet(_ text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Circle()
                .fill(color.opacity(0.55))
                .frame(width: 4, height: 4)
                .padding(.top, 7)
            Text(LocalizedStringKey.alreadyLocalized(text))
                .font(TypeScale.callout)
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 最近一杯（第二层）

    /// 选中豆子最近的一次冲煮：参数、评分、味觉，以及与再上一杯的差。
    /// 提问式的检索归「问一问」，这里只做主动汇报。
    private var recentBrewSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // 「最近一杯 / 我的习惯 / 下一步」说的都是同一包豆——切换器就摆在
            // 这一组开头，默认是今天最该关注的那包。只有一包时不用切。
            HStack {
                SectionHeader(title: "最近一杯")
                if activeBeans.count > 1 {
                    beanPicker
                }
            }

            if let latest = selectedBean?.latestBrew {
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(LocalizedStringKey.alreadyLocalized(
                                latest.recipe.summaryParts.joined(separator: " · ")
                            ))
                            .font(TypeScale.numeral)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Text(Fmt.short(latest.date, calendar: DateMath.calendar))
                                .font(TypeScale.micro)
                                .foregroundStyle(Palette.inkFaint)
                        }

                        if latest.score > 0 {
                            StarRating(score: latest.score)
                        }

                        if let taste = latest.tasteLine {
                            Text(LocalizedStringKey.alreadyLocalized(taste))
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkSoft)
                        }

                        if let previous = brewBefore(latest) {
                            let comparison = SuggestionFollowUp.between(
                                previous: previous, suggestion: nil, current: latest
                            )
                            if comparison.hasChanges || comparison.scoreText != nil {
                                CardDivider()
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("与上一次相比")
                                        .font(TypeScale.micro)
                                        .foregroundStyle(Palette.inkFaint)
                                    if let changes = comparison.changesText {
                                        Text(LocalizedStringKey.alreadyLocalized(changes))
                                            .font(TypeScale.caption.monospacedDigit())
                                            .foregroundStyle(Palette.inkSoft)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                if let scoreText = comparison.scoreText {
                                    Text(LocalizedStringKey.alreadyLocalized(scoreText))
                                        .font(TypeScale.micro)
                                        .foregroundStyle(Palette.inkFaint)
                                }
                            }
                        }
                    }
                }
            } else {
                Card {
                    Text("这包豆还没有冲煮记录。记一杯之后，这里就是它的最新进展。")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // 「是否偏离自己的正常范围」是这一层的另一半，分析器已经算好了。
            if let deviationInsight {
                insightCard(deviationInsight)
            }
        }
    }

    private func brewBefore(_ brew: Brew) -> Brew? {
        guard let bean = selectedBean else { return nil }
        let brews = bean.brewsNewestFirst
        guard let index = brews.firstIndex(where: { $0.id == brew.id }),
              brews.indices.contains(index + 1) else { return nil }
        return brews[index + 1]
    }

    // MARK: - 下一步（第四层）

    /// 只给一个最值得执行的改动。来源是既有诊断链的 `AdjustmentSuggestion`
    /// ——这里不新造建议，只把它从诊断里提出来放到台面上。
    private var nextAction: AdjustmentSuggestion? {
        guard let bean = selectedBean else { return nil }
        return BrewDiagnosisService.diagnose(
            bean: bean, allBrews: brews,
            languageCode: LanguageManager.shared.current.resolvedCode
        )?.suggestion
    }

    private func actionSection(_ suggestion: AdjustmentSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "下一步")
            Card {
                VStack(alignment: .leading, spacing: 7) {
                    Text(LocalizedStringKey.alreadyLocalized(suggestion.headline))
                        .font(TypeScale.title)
                        .foregroundStyle(Palette.roast)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(LocalizedStringKey.alreadyLocalized(suggestion.reason))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - 换豆子

    /// 「我的最佳参数」和「历史分析」看的是选中的这包豆。默认给今天最该关注的那包。
    private var beanPicker: some View {
        Menu {
            ForEach(activeBeans) { bean in
                Button {
                    selectedBeanID = bean.id
                } label: {
                    if bean.id == selectedBeanID {
                        Label {
                            Text(LocalizedStringKey.alreadyLocalized(bean.displayName))
                        } icon: {
                            Image(systemName: "checkmark")
                        }
                    } else {
                        Text(LocalizedStringKey.alreadyLocalized(bean.displayName))
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(LocalizedStringKey.alreadyLocalized(selectedBean?.displayName ?? ""))
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.roast)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
        }
    }

    private var selectedBean: Bean? {
        if let selectedBeanID, let bean = activeBeans.first(where: { $0.id == selectedBeanID }) {
            return bean
        }
        return activeBeans.first
    }

    // MARK: - 能力说明

    private var footnote: some View {
        Text("建议与分析只来自你记录里的数字和既定规则；没有历史的地方会直接说证据不足。")
            .font(TypeScale.caption)
            .foregroundStyle(Palette.inkFaint)
            .padding(.horizontal, 4)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - 动作

    private func prepare() async {
        if engine == nil { engine = RecommendationEngine(context: context) }
        refreshAnalysis()
    }

    /// 今日建议、做法建议、最佳参数与偏离都是同步统计，刷新一次成本可以忽略。
    private func refreshAnalysis() {
        guard let engine, !activeBeans.isEmpty else { return }

        todayInsight = engine.todayPick(beans: beans, book: book)

        // 默认选中今天最该关注的那包；用户手动换过之后尊重他的选择。
        if selectedBeanID == nil || !activeBeans.contains(where: { $0.id == selectedBeanID }) {
            selectedBeanID = todayInsight?.beanID ?? activeBeans.first?.id
        }
        guard let bean = selectedBean else { return }

        methodInsight = engine.methodSuggestion(for: bean, allBrews: brews)
        bestInsight = engine.personalBest(for: bean)
        deviationInsight = engine.deviation(for: bean)
    }
}
