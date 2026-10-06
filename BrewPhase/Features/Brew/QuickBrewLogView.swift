import SwiftData
import SwiftUI

/// 记一杯：30 秒能走完的那条路（CP-005）。
///
/// 第一层只有四件事——**哪包豆、怎么冲、几分、什么味道**——因为它们是你三分钟后
/// 还会记得的东西。粉量、水温、研磨这些参数默认**沿用上一杯**，除非你这次真改了；
/// 改了哪一项，页面会在存之前就把「和上一杯比改了什么」摆出来（规格 §七）。
///
/// 保存走的是 `BrewRecorder`，与完整表单同一个写入路径；存完不退出，直接把这一杯的
/// 诊断与下一杯建议显示在同一页上——这就是「记录 → 分析 → 建议 → 再记录」那个环。
struct QuickBrewLogView: View {

    /// 从哪包豆进来。传 nil（首页那种「我现在就想记一杯」）时自己挑：
    /// 先看最近冲过的那包，其次今天最该喝的那包。
    let bean: Bean?

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var allBrews: [Brew]
    @Query private var rules: [PhaseRule]

    @State private var beanID: UUID?
    @State private var recipe: BrewRecipe
    @State private var timeText: String
    @State private var date: Date

    @State private var score = 0
    @State private var acidity = 0
    @State private var sweetness = 0
    @State private var bitterness = 0
    @State private var bodyValue = 0
    @State private var aftertaste = 0
    @State private var flavorTags: [String] = []
    @State private var notes = ""

    @State private var showsParameters = false
    /// 风味标签默认折着（折叠态由 `CollapsibleFlavorTags` 管理）；
    /// 这里只存调试入口的「初始展开」种子。
    @State private var showsFlavorTags = false
    /// 用户动过参数之后就不再自动预填，免得他刚填的数字被覆盖。
    @State private var touchedRecipe = false
    @State private var prefill: BrewPrefill

    @State private var saved: Brew?
    @State private var diagnosis: BrewDiagnosis?
    /// 「上一杯的建议 → 这一杯」的观察性对比。上一杯存在时才可能有值。
    @State private var followUp: SuggestionFollowUp?
    /// 结果页的完整诊断（证据 / 知识出处）默认收着。
    @State private var showsFullDiagnosis = false
    @State private var errorMessage: String?
    @State private var didResolveDefault = false
    /// 「上一杯」对比卡的展开状态（上一批的规格：默认只给摘要）。
    @State private var showsPreviousBrewDetail = false
    /// 轻引导：只给第一次成功保存看一眼，看完就收。
    @State private var showsPrefillHint = false

    private var languageCode: String { LanguageManager.shared.current.resolvedCode }
    private var defaults: BrewDefaults { BrewDefaults.current() }
    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    init(bean: Bean?) {
        self.bean = bean
        let defaults = BrewDefaults.current()
        let seed = bean.map {
            BrewPrefillBuilder.prefill(
                beanBrews: $0.brewsNewestFirst, allBrews: $0.brewsNewestFirst, defaults: defaults
            )
        } ?? BrewPrefill(source: .userDefaults, recipe: defaults.asRecipe, timeText: "", basis: nil)

        _beanID = State(initialValue: bean?.id)
        _prefill = State(initialValue: seed)
        _recipe = State(initialValue: seed.recipe)
        _timeText = State(initialValue: seed.timeText)
        _date = State(initialValue: Date())

        // UI inspection only (见 `DebugLaunch.quickLogFocus`)：模拟器不能点击，
        // 折叠区展开后的样子要靠这两行先替用户展开。
        let focus = DebugLaunch.quickLogFocus
        _showsParameters = State(initialValue: focus == "params" || focus == "all")
        _showsFlavorTags = State(initialValue: focus == "flavor" || focus == "all")
    }

    // MARK: - 派生

    private var selectedBean: Bean? {
        guard let beanID else { return nil }
        return beans.first { $0.id == beanID }
    }

    private var activeBeans: [Bean] {
        let active = beans.filter { !$0.isFinished }
        return active.isEmpty ? beans : active
    }

    /// 存之前就能看见的「这次和上一杯比改了什么」。
    private var delta: BrewDelta {
        BrewDelta.between(previous: prefill.recipe, current: resolvedRecipe)
    }

    /// 解析过时间的当前配方——保存、校验、差异比较都用它，免得三处各算一遍。
    private var resolvedRecipe: BrewRecipe {
        var recipe = recipe
        recipe.timeSeconds = BrewMath.parseTime(timeText) ?? 0
        return recipe
    }

    /// 「更多参数」那一行右侧的摘要：`18g · 1:16 · 92°C · 2:28`。
    /// 只有真有了的值才出现，一个都没有时显示破折号。
    private var parameterSummary: String {
        var parts: [String] = []
        if recipe.coffeeG > 0 { parts.append(Fmt.gramsShort(recipe.coffeeG)) }
        if recipe.coffeeG > 0, recipe.waterG > 0 { parts.append(recipe.ratioText) }
        if recipe.waterTemp > 0 { parts.append("\(Int(recipe.waterTemp.rounded()))°C") }
        if let seconds = BrewMath.parseTime(timeText), seconds > 0 {
            parts.append(BrewMath.formatTime(seconds))
        }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    private var projectedRemaining: Double? {
        guard let bean = selectedBean, recipe.coffeeG > 0 else { return nil }
        return BrewMath.remainingAfter(current: bean.remainingG, dose: recipe.coffeeG, total: bean.weightG)
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            Group {
                if let saved, let diagnosis {
                    result(saved: saved, diagnosis: diagnosis)
                } else {
                    form
                }
            }
            .background(Palette.paper)
            .navigationTitle(saved == nil ? "记一杯" : "记下了")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(saved == nil ? "取消" : "完成") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
            }
            .task { resolveDefaultBeanIfNeeded() }
        }
    }

    // MARK: - 表单

    /// 折叠区的滚动锚点，只给调试屏用（展开后内容在折叠线以下，截不到图）。
    private static let flavorAnchor = "quicklog.flavor"
    private static let parametersAnchor = "quicklog.parameters"

    private var form: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if activeBeans.isEmpty {
                        Card(lifted: true) {
                            EmptyStateView(
                                symbol: "square.stack.3d.up",
                                title: "豆仓还是空的",
                                message: "先加一包豆，再记这一杯。"
                            )
                        }
                } else {
                    beanSection
                    prefillNote
                    previousBrewCard
                    methodSection
                    tasteSection
                    flavorSection
                        .id(Self.flavorAnchor)
                    notesSection
                    parametersSection
                        .id(Self.parametersAnchor)
                    if let errorMessage {
                        messageCard(errorMessage)
                    }
                }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .onAppear {
                // UI inspection only：展开之后滚到展开的那一块跟前。
                guard let focus = DebugLaunch.quickLogFocus, focus != "all" else { return }
                let target = focus == "flavor" ? Self.flavorAnchor : Self.parametersAnchor
                Task {
                    // 等布局稳定，不然目标还没有尺寸，滚过去也是原地。
                    try? await Task.sleep(for: .milliseconds(600))
                    proxy.scrollTo(target, anchor: .top)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { saveBar }
    }

    /// 哪包豆。默认已经选好，只有想换的时候才需要动手。
    private var beanSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "哪包豆")
            Card {
                Menu {
                    ForEach(activeBeans) { bean in
                        Button {
                            select(bean)
                        } label: {
                            Text(LocalizedStringKey.alreadyLocalized(bean.displayName))
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        BeanThumbnail(imageName: selectedBean?.imagePath, size: 38, cornerRadius: 10)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(selectedBean.map { LocalizedStringKey.alreadyLocalized($0.displayName) } ?? LocalizedStringKey("选一包豆"))
                                .font(TypeScale.bodyMedium)
                                .foregroundStyle(Palette.ink)
                            if let bean = selectedBean {
                                Text(L("%@ · 剩余 %@",
                                       Fmt.day(bean.dayAfterRoast(on: date)),
                                       Fmt.grams(bean.remainingG)))
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.inkFaint)
                            }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Palette.inkFaint)
                    }
                }
            }
        }
    }

    /// 沿用上一杯的说明 + 改了什么的实时反馈（规格 §六/§七）。
    private var prefillNote: some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: prefill.isBareDefault ? "slider.horizontal.3" : "arrow.counterclockwise.circle")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(prefill.isBareDefault ? Palette.inkFaint : Palette.roast)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(prefillHeadline)
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.ink)
                        if let basis = prefill.basis {
                            Text(L("%@ · %@", Fmt.short(basis.date, calendar: DateMath.calendar), basis.summary))
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                }

                if delta.hasChanges {
                    Divider().overlay(Palette.hairline)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("这次改了")
                            .font(TypeScale.micro)
                            .foregroundStyle(Palette.inkFaint)
                        ForEach(delta.changes) { change in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(LocalizedStringKey.alreadyLocalized(change.label))
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.inkSoft)
                                // 数值参数用「快 22 秒」「高 1°C」这种一句话方向；
                                // 文本参数（器具/研磨）只有新旧值可看。
                                if let phrase = change.phrase {
                                    Text(LocalizedStringKey.alreadyLocalized(phrase))
                                        .font(TypeScale.caption.monospacedDigit())
                                        .foregroundStyle(Palette.roast)
                                } else {
                                    Text(L("%@ → %@", change.from, change.to))
                                        .font(TypeScale.caption.monospacedDigit())
                                        .foregroundStyle(Palette.roast)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
            }
        }
    }

    private var prefillHeadline: String {
        switch prefill.source {
        case .lastBrewOfSameBean: return L("沿用这包豆上一次的参数")
        case .lastBrewAnyBean: return L("沿用你上一次冲的参数")
        case .userDefaults: return L("用你设的默认参数")
        }
    }

    private var methodSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "怎么冲的")
            Card(padding: 0) {
                EditorChipsRow(
                    title: "器具",
                    options: BrewCatalog.methods,
                    isOn: { $0 == recipe.method },
                    onPick: { pick(method: $0) }
                ) {
                    EditorTextField(placeholder: "V60", text: $recipe.method)
                        .onChange(of: recipe.method) { touchedRecipe = true }
                }
            }
        }
    }

    private var tasteSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "这杯怎么样", detail: .alreadyLocalized("可以不填"))
            Card {
                VStack(alignment: .leading, spacing: 14) {
                    StarRatingInput(score: $score)
                    CardDivider()
                    VStack(spacing: 11) {
                        TasteScale(title: "酸", value: $acidity)
                        TasteScale(title: "甜", value: $sweetness)
                        TasteScale(title: "苦", value: $bitterness)
                        TasteScale(title: "醇厚", value: $bodyValue)
                        TasteScale(title: "余韵", value: $aftertaste)
                    }
                }
            }
        }
    }

    /// 风味标签：默认一行「添加风味」，展开才是完整的 `FlavorTagEditor`
    ///（与豆子编辑器共用 `CollapsibleFlavorTags`）。
    private var flavorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "风味标签", detail: .alreadyLocalized("可以以后再补"))
            Card {
                CollapsibleFlavorTags(tags: $flavorTags, initiallyExpanded: showsFlavorTags)
            }
        }
    }

    private var notesSection: some View {
        EditorSection(title: "一句话总结") {
            EditorRow(showsDivider: false) {
                EditorTextField(placeholder: "比如 甜感明显，下把可以再粗一点", text: $notes)
            }
        }
    }

    /// 详细参数折起来：30 秒那条路不该看见它们，但改参数时它们是必须有的。
    ///
    /// 摘要行把这一杯去要用的数字一眼写全（粉量 · 粉水比 · 水温 · 时间），
    /// 所以「不展开」也不会让人心里没底。
    private var parametersSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.settle) { showsParameters.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("更多参数")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                    Image(systemName: showsParameters ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.inkFaint)
                    Spacer(minLength: 0)
                    Text(parameterSummary)
                        .font(TypeScale.micro.monospacedDigit())
                        .foregroundStyle(Palette.inkFaint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .buttonStyle(.plain)

            if showsParameters {
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        EditorRow(title: "粉量") {
                            NumberField(placeholder: "0", value: $recipe.coffeeG, unit: "g")
                                .onChange(of: recipe.coffeeG) { touchedRecipe = true }
                        }
                        EditorRow(title: "水量") {
                            NumberField(placeholder: "0", value: $recipe.waterG, unit: "g")
                                .onChange(of: recipe.waterG) { touchedRecipe = true }
                        }
                        EditorRow(title: "水温") {
                            NumberField(placeholder: "0", value: $recipe.waterTemp, unit: "°C")
                                .onChange(of: recipe.waterTemp) { touchedRecipe = true }
                        }
                        EditorRow(title: "时间") {
                            TextField("", text: $timeText, prompt: Text("2:35").foregroundStyle(Palette.inkFaint))
                                .font(TypeScale.numeral)
                                .foregroundStyle(Palette.ink)
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numbersAndPunctuation)
                                .onChange(of: timeText) { touchedRecipe = true }
                        }
                        EditorRow(title: "研磨度") {
                            EditorTextField(placeholder: "比如 22 格", text: $recipe.grindSize, alignment: .trailing)
                                .onChange(of: recipe.grindSize) { touchedRecipe = true }
                        }
                        EditorRow(title: "磨豆机") {
                            EditorTextField(placeholder: "比如 司令官 C40", text: $recipe.grinder, alignment: .trailing)
                                .onChange(of: recipe.grinder) { touchedRecipe = true }
                        }
                        EditorRow(title: "日期", showsDivider: false) {
                            HStack(spacing: 8) {
                                Spacer(minLength: 0)
                                Text(Fmt.day(selectedBean?.dayAfterRoast(on: date)))
                                    .font(TypeScale.caption.monospacedDigit())
                                    .foregroundStyle(Palette.roast)
                                DatePicker("", selection: $date, displayedComponents: .date)
                                    .labelsHidden()
                                    .datePickerStyle(.compact)
                            }
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var saveBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let remaining = projectedRemaining {
                HStack(spacing: 6) {
                    Image(systemName: "scalemass").font(.system(size: 11, weight: .medium))
                    Text(L("保存后剩余 %@", Fmt.grams(remaining)))
                }
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
            }
            PrimaryButton(title: "记下这一杯") { save() }
                .disabled(selectedBean == nil)
                .opacity(selectedBean == nil ? 0.5 : 1)
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }

    private func messageCard(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").font(.system(size: 13))
            Text(LocalizedStringKey.alreadyLocalized(text))
                .font(TypeScale.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Palette.priority)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous).fill(Palette.well)
        )
    }

    // MARK: - 上一杯

    /// 上一杯摘要：时间 · 评分 · 主要味觉。展开才是「上次 → 本次」的参数与
    /// 味觉对照——默认只给三行，别让对比表抢占 30 秒那条路的注意力。
    @ViewBuilder
    private var previousBrewCard: some View {
        if let previous = selectedBean?.latestBrew {
            VStack(alignment: .leading, spacing: 10) {
                Card {
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text("上一杯")
                                .font(TypeScale.micro)
                                .tracking(0.8)
                                .foregroundStyle(Palette.inkFaint)
                            Spacer(minLength: 0)
                            Text(Fmt.short(previous.date, calendar: DateMath.calendar))
                                .font(TypeScale.micro)
                                .foregroundStyle(Palette.inkFaint)
                        }

                        HStack(spacing: 8) {
                            if previous.timeSeconds > 0 {
                                Text(previous.timeText)
                                    .font(TypeScale.numeral)
                                    .foregroundStyle(Palette.ink)
                            }
                            if previous.score > 0 {
                                StarRating(score: previous.score)
                            }
                            Spacer(minLength: 0)
                        }

                        if let taste = previous.tasteLine {
                            Text(LocalizedStringKey.alreadyLocalized(taste))
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkSoft)
                        }

                        if prefill.basis?.id == previous.id {
                            Text("本次将沿用上次参数")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                        }

                        Button {
                            withAnimation(Motion.settle) { showsPreviousBrewDetail.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Text(showsPreviousBrewDetail ? "收起对比" : "查看变化")
                                Image(systemName: showsPreviousBrewDetail ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.roast)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if showsPreviousBrewDetail {
                    Card {
                        VStack(alignment: .leading, spacing: 0) {
                            comparisonRow("器具", previous.method.trimmed, recipe.method.trimmed)
                            comparisonRow("粉量", dose(previous.coffeeG), dose(recipe.coffeeG))
                            comparisonRow("水量", dose(previous.waterG), dose(recipe.waterG))
                            comparisonRow("水温", temperature(previous.waterTemp), temperature(recipe.waterTemp))
                            comparisonRow("时间", clock(previous.timeSeconds), clock(BrewMath.parseTime(timeText) ?? 0))
                            comparisonRow("研磨度", previous.grindSize.trimmed.isEmpty ? "—" : previous.grindSize.trimmed,
                                          recipe.grindSize.trimmed.isEmpty ? "—" : recipe.grindSize.trimmed)
                            CardDivider().padding(.vertical, 4)
                            comparisonRow("酸", tally(previous.acidity), tally(acidity))
                            comparisonRow("甜", tally(previous.sweetness), tally(sweetness))
                            comparisonRow("苦", tally(previous.bitterness), tally(bitterness))
                            comparisonRow("醇厚", tally(previous.body), tally(bodyValue))
                            comparisonRow("余韵", tally(previous.aftertaste), tally(aftertaste))
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private func dose(_ value: Double) -> String {
        value > 0 ? Fmt.gramsShort(value) : "—"
    }

    private func temperature(_ value: Double) -> String {
        value > 0 ? "\(Int(value.rounded()))°C" : "—"
    }

    private func clock(_ seconds: Int) -> String {
        seconds > 0 ? BrewMath.formatTime(seconds) : "—"
    }

    private func tally(_ value: Int) -> String {
        value > 0 ? String(value) : "—"
    }

    /// 「上次 → 本次」的一行。变了用 roast 色标出来，没变就安静地单值。
    private func comparisonRow(_ label: LocalizedStringKey, _ last: String, _ current: String) -> some View {
        let changed = last != current
        return HStack(spacing: 12) {
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .frame(width: 52, alignment: .leading)
            Spacer(minLength: 0)
            if changed {
                Text(verbatim: "\(last) → \(current)")
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(Palette.roast)
            } else {
                Text(verbatim: last)
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(Palette.inkFaint)
            }
        }
        .padding(.vertical, 5)
    }

    // MARK: - 结果

    private func result(saved brew: Brew, diagnosis: BrewDiagnosis) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                // 刚喝完的人只想知道两件事：这杯怎么样、下一杯改什么。
                // 完整分析（证据、知识出处）收在折叠里，不铺成一屏报告。
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Palette.peak)
                            Text("记下了")
                                .font(TypeScale.callout)
                                .foregroundStyle(Palette.inkSoft)
                            Spacer(minLength: 0)
                            Text(LocalizedStringKey.alreadyLocalized(
                                brew.bean?.displayName ?? ""))
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .lineLimit(1)
                        }

                        if brew.score > 0 {
                            StarRating(score: brew.score, size: 17)
                                .accessibilityLabel(Text(L("%@ 星", String(brew.score))))
                        }
                        if let taste = brew.tasteLine {
                            Text(LocalizedStringKey.alreadyLocalized(taste))
                                .font(TypeScale.callout)
                                .foregroundStyle(Palette.ink)
                        }
                        Text(LocalizedStringKey.alreadyLocalized(
                            brew.recipe.summaryParts.joined(separator: " · ")))
                            .font(TypeScale.caption.monospacedDigit())
                            .foregroundStyle(Palette.inkFaint)
                            .fixedSize(horizontal: false, vertical: true)

                        CardDivider()

                        // 一句话诊断：候选结论的标题，或者诚实的「没有异常 / 数据还不够」。
                        Text(LocalizedStringKey.alreadyLocalized(verdictLine(diagnosis)))
                            .font(TypeScale.bodyMedium)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if diagnosis.primary == nil, !diagnosis.baseline.isUsable {
                            Text(LocalizedStringKey.alreadyLocalized(PersonalBaseline.keepRecordingAdvice))
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.roast)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        // 轻引导：只在这辈子的第一次保存后出现一次（规格 §十七）。
                        // 说清下一次会更快——这正是「再记一杯」想让人发现的事。
                        if showsPrefillHint {
                            CardDivider()
                            Text("下次记这一杯，会自动带上这次的参数。")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                // 「上一杯的建议 → 这一杯」：闭环里「验证」的那一环。只摆变化
                // 与方向，不下因果——判断留给用户（见 `SuggestionFollowUp`）。
                if let followUp {
                    followUpCard(followUp)
                }

                // 一杯就一个改动方向。数据不足时诊断不会给出建议，这里整块不出现
                // ——不给建议也是一个结论。
                if let suggestion = diagnosis.suggestion {
                    nextCupCard(suggestion)
                }

                Button {
                    withAnimation(Motion.settle) { showsFullDiagnosis.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Text(showsFullDiagnosis ? "收起完整分析" : "查看完整分析")
                        Image(systemName: showsFullDiagnosis ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                }
                .buttonStyle(.plain)

                if showsFullDiagnosis {
                    BrewDiagnosticCard(diagnosis: diagnosis)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                HStack(spacing: 10) {
                    SecondaryButton(title: "再记一杯", systemImage: "plus") { logAnother() }
                    PrimaryButton(title: "完成") { dismiss() }
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
    }

    /// 一句话诊断：候选结论的标题；没有候选时说清是「正常」还是「数据不够」。
    private func verdictLine(_ diagnosis: BrewDiagnosis) -> String {
        if let primary = diagnosis.primary { return primary.finding.title }
        if diagnosis.baseline.isUsable { return L("这一杯在你自己的记录里没有明显异常。") }
        return diagnosis.baseline.shortfallMessage
    }

    /// 「下一杯建议」的紧凑版：一个旋钮 + 一句为什么。
    private func nextCupCard(_ suggestion: AdjustmentSuggestion) -> some View {
        Card(lifted: true) {
            VStack(alignment: .leading, spacing: 7) {
                Text("下一杯建议")
                    .font(TypeScale.micro)
                    .tracking(0.8)
                    .foregroundStyle(Palette.inkFaint)
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

    /// 紧跟在「记下了」下面的那张小卡：上次建议是什么、这次变了什么、方向对不对。
    private func followUpCard(_ followUp: SuggestionFollowUp) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.uturn.backward.circle")
                        .font(.system(size: 11, weight: .medium))
                    Text("上次建议")
                        .font(TypeScale.micro)
                        .tracking(0.8)
                }
                .foregroundStyle(Palette.inkFaint)

                if let headline = followUp.suggestionHeadline {
                    Text(LocalizedStringKey.alreadyLocalized(headline))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.roast)
                }

                if let changes = followUp.changesText {
                    Text(LocalizedStringKey.alreadyLocalized(L("这次：%@", changes)))
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }

                let notes = [followUp.directionText, followUp.scoreText].compactMap { $0 }
                if !notes.isEmpty {
                    Text(LocalizedStringKey.alreadyLocalized(notes.joined(separator: "")))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - 动作

    private func resolveDefaultBeanIfNeeded() {
        guard !didResolveDefault else { return }
        didResolveDefault = true

        if beanID == nil, let fallback = defaultBean() {
            beanID = fallback.id
            applyPrefill(for: fallback, method: recipe.method, force: true)
        }

        // 调试入口（`-BrewPhaseQuickLogDemo yes`）：记一杯「照上一杯建议调整过」的
        // 咖啡并停在结果页，好让「上次建议 → 这一杯」的对比与诊断能一起截图。
        // 注意它不依赖上面那条「没有指定豆子」的分支——带豆进来时同样要能演示。
        if DebugLaunch.quickLogDemo, saved == nil {
            score = 4
            acidity = 4
            sweetness = 3
            bitterness = 2
            bodyValue = 2
            timeText = "2:28"
            notes = L("按上次的建议磨细了一档，酸降下来了")
            save()
        }
    }

    /// 从首页进来时挑哪包：最近冲过的那包（如果还没喝完），其次今天最该喝的那包。
    private func defaultBean() -> Bean? {
        if let recent = allBrews.first?.bean, !recent.isFinished { return recent }
        if let pick = InsightFactory.todaysPick(activeBeans, book: book, defaults: defaults),
           let bean = activeBeans.first(where: { $0.id == pick.id }) {
            return bean
        }
        return activeBeans.first
    }

    private func select(_ bean: Bean) {
        beanID = bean.id
        touchedRecipe = false
        applyPrefill(for: bean, method: recipe.method, force: true)
    }

    private func pick(method: String) {
        recipe.method = method
        applyPrefill(for: selectedBean, method: method)
    }

    private func applyPrefill(for bean: Bean?, method: String?, force: Bool = false) {
        guard force || !touchedRecipe, let bean else { return }
        let next = BrewPrefillBuilder.prefill(
            beanBrews: bean.brewsNewestFirst,
            allBrews: allBrews,
            method: method ?? recipe.method,
            defaults: defaults
        )
        prefill = next
        recipe = next.recipe
        timeText = next.timeText
        touchedRecipe = false
    }

    private func save() {
        // 双击防护：成功路径上 `saved` 在同一次调用里就被置位，第二次点击会在
        // 这里被挡住——不会出现两条记录、两次扣库存。失败时 saved 仍为 nil，
        // 修好再点一次照常工作。
        guard let bean = selectedBean, saved == nil else { return }
        errorMessage = nil

        // 上一杯与它当时的建议，必须在插入这一杯**之前**取：诊断的历史里
        // 不能混进还没落库的这一杯，建议也应该是当时真正给过的那条。
        let previousBrew = bean.latestBrew
        let previousSuggestion = previousBrew.flatMap { previous in
            BrewDiagnosisService.diagnose(
                bean: bean, brew: previous, allBrews: allBrews, languageCode: languageCode
            )?.suggestion
        }

        let draft = BrewRecorder.Draft(
            recipe: recipe,
            timeText: timeText,
            date: date,
            score: score,
            acidity: acidity,
            sweetness: sweetness,
            bitterness: bitterness,
            body: bodyValue,
            aftertaste: aftertaste,
            flavorTags: flavorTags,
            notes: notes
        )

        do {
            let brew = try BrewRecorder.save(draft, bean: bean, in: context)
            saved = brew
            if let previousBrew {
                followUp = SuggestionFollowUp.between(
                    previous: previousBrew, suggestion: previousSuggestion, current: brew
                )
            }
            diagnosis = BrewDiagnosisService.diagnose(
                bean: bean, brew: brew, allBrews: allBrews, languageCode: languageCode
            )
            showsPrefillHint = !UserDefaults.standard.bool(forKey: PrefKey.didShowPrefillHint)
            if showsPrefillHint {
                UserDefaults.standard.set(true, forKey: PrefKey.didShowPrefillHint)
            }
            Task { await BrewRecorder.rescheduleReminders(for: bean, in: context) }
        } catch let failure as BrewRecorder.Failure {
            switch failure {
            case .invalid(let message), .saveFailed(let message):
                showsParameters = true
                errorMessage = message
            }
        } catch {
            errorMessage = L("没能保存下来，请再试一次")
        }
    }

    /// 「再记一杯」：同一包豆接着记，参数以刚存下的这杯为准。
    private func logAnother() {
        saved = nil
        diagnosis = nil
        followUp = nil
        errorMessage = nil
        score = 0
        acidity = 0
        sweetness = 0
        bitterness = 0
        bodyValue = 0
        aftertaste = 0
        flavorTags = []
        notes = ""
        date = Date()
        showsPreviousBrewDetail = false
        showsFullDiagnosis = false
        if let bean = selectedBean { applyPrefill(for: bean, method: recipe.method, force: true) }
    }
}
