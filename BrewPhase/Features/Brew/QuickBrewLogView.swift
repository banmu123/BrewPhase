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
    /// 用户动过参数之后就不再自动预填，免得他刚填的数字被覆盖。
    @State private var touchedRecipe = false
    @State private var prefill: BrewPrefill

    @State private var saved: Brew?
    @State private var diagnosis: BrewDiagnosis?
    @State private var errorMessage: String?
    @State private var didResolveDefault = false

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

    private var form: some View {
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
                    methodSection
                    tasteSection
                    flavorSection
                    notesSection
                    parametersSection
                    if let errorMessage {
                        messageCard(errorMessage)
                    }
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 24)
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
                                Text(L("%@ → %@", change.from, change.to))
                                    .font(TypeScale.caption.monospacedDigit())
                                    .foregroundStyle(Palette.roast)
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

    private var flavorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "风味标签", detail: .alreadyLocalized("可以以后再补"))
            Card { FlavorTagEditor(tags: $flavorTags) }
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
                    Text(L("%@ · %@", recipe.ratioText, timeText.isEmpty ? "—" : timeText))
                        .font(TypeScale.micro.monospacedDigit())
                        .foregroundStyle(Palette.inkFaint)
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

    // MARK: - 结果

    private func result(saved brew: Brew, diagnosis: BrewDiagnosis) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Palette.peak)
                            Text("记下了")
                                .font(TypeScale.bodyMedium)
                                .foregroundStyle(Palette.ink)
                            Spacer(minLength: 0)
                            if brew.score > 0 {
                                Text(L("%@ 星", String(brew.score)))
                                    .font(TypeScale.caption.monospacedDigit())
                                    .foregroundStyle(Palette.roast)
                            }
                        }
                        Text(L("%@ · %@", brew.bean?.displayName ?? "", brew.recipe.summaryParts.joined(separator: " · ")))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                BrewDiagnosticCard(diagnosis: diagnosis)

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

    // MARK: - 动作

    private func resolveDefaultBeanIfNeeded() {
        guard !didResolveDefault else { return }
        didResolveDefault = true

        if beanID == nil, let fallback = defaultBean() {
            beanID = fallback.id
            applyPrefill(for: fallback, method: recipe.method, force: true)
        }

        // 调试入口（`-BrewPhaseQuickLogDemo yes`）：直接记一杯「酸高、甜低、口感薄」
        // 的咖啡并停在结果页，好让「记完立刻看到诊断与建议」这条路能截图。
        // 注意它不依赖上面那条「没有指定豆子」的分支——带豆进来时同样要能演示。
        if DebugLaunch.quickLogDemo, saved == nil {
            score = 3
            acidity = 5
            sweetness = 2
            bitterness = 2
            bodyValue = 2
            notes = L("有点酸，尾段偏薄")
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
        guard let bean = selectedBean else { return }
        errorMessage = nil

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
            diagnosis = BrewDiagnosisService.diagnose(
                bean: bean, brew: brew, allBrews: allBrews, languageCode: languageCode
            )
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
        if let bean = selectedBean { applyPrefill(for: bean, method: recipe.method, force: true) }
    }
}
