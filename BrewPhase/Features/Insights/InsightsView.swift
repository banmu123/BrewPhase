import SwiftData
import SwiftUI

/// 洞察：V1 智能层的主界面（协议 §30）。
///
/// 刻意**不是**聊天界面。四张卡片各答一类问题，每一张都把依据摆在明面上
/// （协议 §29）：理由在前，数据行在后，证据不足时直接说「还比较不了」并给出
/// 真实的样本阈值，而不是硬给一个结论。
///
/// 卡片与数据的关系：
/// * 今日建议 —— 既有 `PriorityEngine` 的排序结论 + 真实存量与评分；
/// * 相似冲煮 —— 唯一走语义检索的入口，查的是用户自己的记录；
/// * 我的最佳参数 —— 用户高评分记录的统计；
/// * 历史分析 —— 最近一次冲煮和上述统计的偏离。
struct InsightsView: View {

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query private var rules: [PhaseRule]

    @State private var engine: RecommendationEngine?
    @State private var capability: IntelligenceCapability?
    @State private var todayInsight: Insight?
    @State private var methodInsight: Insight?
    @State private var bestInsight: Insight?
    @State private var deviationInsight: Insight?
    @State private var selectedBeanID: UUID?

    // MARK: 天气场景（手选默认，自动可选）

    @AppStorage(PrefKey.weatherMode) private var weatherMode: String = "manual"
    @AppStorage(PrefKey.weatherManualScene) private var manualSceneRaw: String = WeatherScene.unknown.rawValue
    @State private var automaticWeather: WeatherContext?
    @State private var isFetchingWeather = false

    @State private var searchText = ""
    @State private var searchResult: Insight?
    @State private var isSearching = false
    @FocusState private var searchFocused: Bool

    private var settings: RAGSettings { RAGSettings.current() }
    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }
    private var activeBeans: [Bean] { beans.filter { !$0.isFinished } }

    /// 推荐当前可用的天气上下文。自动模式取抓到的实况；手选模式把场景包成
    /// 上下文；「未设置」时为 nil——推荐退化为不看天气，行为和从前一样。
    private var weatherContext: WeatherContext? {
        if weatherMode == "auto" { return automaticWeather }
        guard let scene = WeatherScene(rawValue: manualSceneRaw), scene != .unknown else { return nil }
        return WeatherContext(scene: scene, temperatureCelsius: nil, isAutomatic: false, note: nil)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                if activeBeans.isEmpty {
                    emptyCellar
                } else {
                    weatherRow
                    if let todayInsight {
                        insightSection(title: "今日建议", insight: todayInsight)
                    }
                    if let methodInsight {
                        insightSection(title: "手冲还是意式", insight: methodInsight)
                    }
                    searchSection
                    if let bestInsight {
                        insightSection(title: "我的最佳参数", insight: bestInsight)
                    }
                    if let deviationInsight {
                        insightSection(title: "历史分析", insight: deviationInsight)
                    }
                    capabilityFootnote
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

    // MARK: - 天气场景

    /// 手动场景在前（默认、零权限），自动在后（一次位置权限 + 联网）。
    /// 这行的选择立即生效并持久化——它不是设置项，是推荐的一部分。
    private var weatherRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "今天的天气", detail: "推荐会参考，但只做微调")

            FlowLayout(spacing: 7, lineSpacing: 7) {
                ForEach(WeatherScene.manualChoices, id: \.self) { scene in
                    let isSelected = weatherMode == "manual" && manualSceneRaw == scene.rawValue
                    Button {
                        weatherMode = "manual"
                        manualSceneRaw = scene.rawValue
                        refreshAnalysis()
                    } label: {
                        Chip(
                            text: scene.label,
                            tint: isSelected ? Palette.card : Palette.roast,
                            background: isSelected ? Palette.roast : Palette.well
                        )
                    }
                    .buttonStyle(.plain)
                }

                Button {
                    weatherMode = "auto"
                    fetchWeather()
                } label: {
                    Chip(
                        text: autoChipLabel,
                        tint: weatherMode == "auto" ? Palette.card : Palette.roast,
                        background: weatherMode == "auto" ? Palette.roast : Palette.well
                    )
                }
                .buttonStyle(.plain)
                .disabled(isFetchingWeather)
            }

            if isFetchingWeather {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在取位置和天气…")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                }
            } else if weatherMode == "auto", let automaticWeather, let note = automaticWeather.note {
                Text(LocalizedStringKey.alreadyLocalized(note))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var autoChipLabel: String {
        if isFetchingWeather { return L("自动…") }
        if let automaticWeather, weatherMode == "auto" {
            if let temperature = automaticWeather.temperatureCelsius {
                return L("自动 · %@ %@", Fmt.number(temperature), automaticWeather.scene.label)
            }
            return L("自动 · %@", automaticWeather.scene.label)
        }
        return L("自动获取")
    }

    private func fetchWeather() {
        guard !isFetchingWeather else { return }
        isFetchingWeather = true

        Task {
            let context = await WeatherKitWeatherService().current()
            automaticWeather = context
            isFetchingWeather = false
            refreshAnalysis()
        }
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
                    Label {
                        Text("证据不足，先不给结论")
                    } icon: {
                        Image(systemName: "info.circle")
                    }
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.priority)
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

    // MARK: - 相似冲煮

    private var searchSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "相似冲煮")

            Card {
                VStack(alignment: .leading, spacing: 12) {
                    Text("写下这次遇到的情况，我在你自己的记录里找相似的先例。")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 10) {
                        TextField("比如「干涩」「发苦」「香气闷」", text: $searchText, axis: .vertical)
                            .font(TypeScale.body)
                            .lineLimit(1...3)
                            .focused($searchFocused)
                            .submitLabel(.search)
                            .onSubmit { runSearch() }

                        Button {
                            runSearch()
                        } label: {
                            Image(systemName: "text.magnifyingglass")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Palette.card)
                                .frame(width: 34, height: 34)
                                .background(
                                    Circle().fill(canSearch ? Palette.roast : Palette.inkFaint)
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSearch)
                    }
                }
            }

            if isSearching {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在翻你的记录…")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                }
                .padding(.leading, 4)
            } else if let searchResult {
                insightCard(searchResult)
            }
        }
    }

    private var canSearch: Bool {
        !isSearching && !searchText.trimmed.isEmpty
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

    private var capabilityFootnote: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let capability {
                if capability.isUsingLexicalFallback {
                    Text("这台设备上没有可用的语义模型，相似冲煮已退到词法匹配：只认字面相近的说法。")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                } else {
                    Text("相似冲煮使用端侧语义模型，离线可用。")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }
            Text("建议与分析只来自你记录里的数字和既定规则；没有历史的地方会直接说证据不足。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .padding(.horizontal, 4)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - 动作

    private func prepare() async {
        if engine == nil { engine = RecommendationEngine(context: context) }
        refreshAnalysis()
        capability = await engine?.capability(settings: settings, languageCode: LanguageManager.shared.current.resolvedCode)
    }

    /// 今日建议、做法建议、最佳参数与偏离都是同步统计，刷新一次成本可以忽略。
    private func refreshAnalysis() {
        guard let engine, !activeBeans.isEmpty else { return }

        todayInsight = engine.todayPick(beans: beans, book: book, weather: weatherContext)

        // 默认选中今天最该关注的那包；用户手动换过之后尊重他的选择。
        if selectedBeanID == nil || !activeBeans.contains(where: { $0.id == selectedBeanID }) {
            selectedBeanID = todayInsight?.beanID ?? activeBeans.first?.id
        }
        guard let bean = selectedBean else { return }

        methodInsight = engine.methodSuggestion(for: bean, weather: weatherContext, allBrews: brews)
        bestInsight = engine.personalBest(for: bean)
        deviationInsight = engine.deviation(for: bean)
    }

    private func runSearch() {
        guard let engine, canSearch else { return }
        let question = searchText.trimmed
        isSearching = true
        searchResult = nil
        searchFocused = false

        let settings = self.settings
        let languageCode = LanguageManager.shared.current.resolvedCode
        let beans = self.beans
        let brews = self.brews
        let tastings = self.tastings
        let book = self.book

        Task {
            let result = await engine.similarHistory(
                matching: question,
                focus: nil,
                beans: beans,
                brews: brews,
                tastings: tastings,
                book: book,
                settings: settings,
                languageCode: languageCode
            )
            searchResult = result
            isSearching = false
        }
    }
}
