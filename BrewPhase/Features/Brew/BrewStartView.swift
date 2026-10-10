import SwiftData
import SwiftUI

/// 引导结束后交给记录页的种子：配方**目标值** + 引导计时器实测的全程时长。
///
/// 它不是记录——真正的写入只有 `QuickBrewLogView` → `BrewRecorder` 那一条路。
/// 这里只是把目标值摆进表单，让用户确认或改成本次的实际值。
/// `Identifiable` 供 `sheet(item:)` 呈现：item 即种子，呈现与取值同一时机。
/// id 由饮品与做法派生——同一次引导重复交接（连点/连发两次完成）落到同一个
/// id 上，sheet 不会重摆，记录页也就只有一份。
struct GuidedBrewSeed: Identifiable, Equatable {
    var id: String { "\(plan.drink.rawValue)-\(plan.method)" }

    let plan: DrinkRecipePlan
    /// 引导计时器累计的全程秒数。0 = 没开过表。
    let measuredSeconds: Int

    /// 目标值配方（时间取建议/实测值）。
    var recipe: BrewRecipe {
        var recipe = plan.asRecipe()
        recipe.timeSeconds = suggestedSeconds
        return recipe
    }

    /// 时间预填的口径：引导里真开过表就用实测值；没开过给配方的建议值，
    /// 让字段不是空的——用户仍然要自己确认。
    var suggestedSeconds: Int { measuredSeconds > 0 ? measuredSeconds : plan.totalSeconds }

    var timeText: String { BrewMath.formatTime(suggestedSeconds) }

    /// 实测过就明说，没实测就不冒充。
    var isMeasured: Bool { measuredSeconds > 0 }
}

/// 配方的出处。历史优先是既有的预填纪律：同一包豆子上一次怎么冲的，
/// 比一本通用的默认值更接近用户手里的豆子。
@MainActor
enum DrinkPlanBuilder {

    struct Result: Equatable {
        let plan: DrinkRecipePlan
        /// 配方来自这包豆子的历史（而不是内置默认）。
        let fromHistory: Bool
        /// 依据的那一杯摘要（已本地化，可直接显示）。
        let basisSummary: String?
    }

    /// 给定饮品与豆子，取配方。
    ///
    /// 查找顺序：这包豆子上一次**同家族**的冲法 → 内置默认。跨家族的参数
    /// （手冲的 240g 注水）绝不带进另一种饮品——只借两边都说得通的字段：
    /// 粉量、水温，以及意式系的浓缩液与奶量。
    static func plan(for drink: DrinkType, bean: Bean?, previous: DrinkRecipePlan?) -> Result {
        var base = DrinkRecipePlan.default(for: drink)

        // 会话里已经改过的粉量是用户自己的决定：历史缺席时保留它，
        // 其余字段一律回到新饮品的默认——不把上一杯的整体参数拖过来。
        if let previous, previous.coffeeG > 0 {
            base.coffeeG = previous.coffeeG
        }

        guard let related = relatedBrew(for: drink, bean: bean) else {
            return Result(plan: base, fromHistory: false, basisSummary: nil)
        }

        if related.coffeeG > 0 { base.coffeeG = related.coffeeG }
        if related.waterTemp > 0, drink != .coldBrew { base.waterTemp = related.waterTemp }
        if drink.family == .espresso, related.espressoYieldG > 0 {
            base.espressoYieldG = related.espressoYieldG
        }
        if drink.usesMilk, related.milkG > 0 { base.milkG = related.milkG }
        if drink == .americano, related.addedWaterG > 0 { base.addedWaterG = related.addedWaterG }
        base.method = drink.defaultMethod

        return Result(
            plan: base,
            fromHistory: true,
            basisSummary: related.recipe.summaryParts.joined(separator: " · ")
        )
    }

    /// 这包豆子上一次同家族的冲法；没有就是 nil。
    private static func relatedBrew(for drink: DrinkType, bean: Bean?) -> Brew? {
        guard let bean else { return nil }
        return bean.brewsNewestFirst.first { MethodRules.family(of: $0.method) == drink.family }
    }
}

/// 「想做一杯什么」——引导流程的第一屏。
///
/// 选饮品 → 看配方（可改）→ 开始制作或跳过引导直接记录。它只做选择与准备，
/// 不写任何数据；记录仍然交给 `QuickBrewLogView`。
struct BrewStartView: View {

    /// 从哪包豆进来（豆子详情页）。nil 时自己挑，与快记同一条规则。
    let bean: Bean?

    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var allBrews: [Brew]
    @Query private var rules: [PhaseRule]

    @State private var beanID: UUID?
    @State private var drink: DrinkType?
    @State private var plan: DrinkRecipePlan?
    /// 配方是不是内置默认（决定那句「默认建议」提示）。
    @State private var planFromHistory = false
    @State private var planBasisSummary: String?
    @State private var showsGuide = false
    @State private var showsQuickLog = false
    @State private var recordSeed: GuidedBrewSeed?
    @State private var didResolveDefaultBean = false

    init(bean: Bean?) {
        self.bean = bean
        _beanID = State(initialValue: bean?.id)
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

    private var steps: [BrewStep] {
        plan.map { BrewStepBuilder.steps(for: $0) } ?? []
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            Group {
                if activeBeans.isEmpty {
                    emptyState
                } else {
                    content
                }
            }
            .background(Palette.paper)
            .navigationTitle("想做一杯什么")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
            }
            .task { resolveDefaultBeanIfNeeded() }
            .navigationDestination(isPresented: $showsGuide) {
                if let plan {
                    BrewGuideView(plan: plan) { measured in
                        showsGuide = false
                        recordSeed = GuidedBrewSeed(plan: plan, measuredSeconds: measured)
                        showsQuickLog = true
                    }
                }
            }
            .sheet(isPresented: $showsQuickLog) {
                QuickBrewLogView(bean: selectedBean, guidedSeed: recordSeed)
            }
        }
    }

    private var emptyState: some View {
        Card(lifted: true) {
            EmptyStateView(
                symbol: "square.stack.3d.up",
                title: "豆仓还是空的",
                message: "先加一包豆，再开始做这一杯。"
            )
        }
        .padding(.horizontal, Metric.gutter)
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                beanSection
                drinkSection
                if let drink, let plan {
                    recipeSection(drink: drink, plan: plan)
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 28)
        }
        .safeAreaInset(edge: .bottom) { actionBar }
    }

    // MARK: - 哪包豆

    private var beanSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "用哪包豆")
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
                                       Fmt.day(bean.dayAfterRoast(on: Date())),
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

    // MARK: - 想喝什么

    private var drinkSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "想喝什么", detail: .alreadyLocalized("选一个开始"))
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(DrinkType.allCases) { drink in
                    drinkCard(drink)
                }
            }
        }
    }

    private func drinkCard(_ drink: DrinkType) -> some View {
        let isSelected = self.drink == drink
        return Button {
            withAnimation(Motion.settle) { select(drink: drink) }
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                Image(systemName: drink.symbolName)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(isSelected ? Palette.roast : Palette.inkFaint)
                Text(LocalizedStringKey.alreadyLocalized(drink.name))
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                Text(LocalizedStringKey.alreadyLocalized(drink.blurb))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(LocalizedStringKey.alreadyLocalized(drink.estimateText))
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .strokeBorder(isSelected ? Palette.roast : Palette.hairline.opacity(0.9),
                                  lineWidth: isSelected ? 1.4 : 0.7)
            )
            .shadow(color: Palette.cardShadow, radius: 7, y: 3)
        }
        .buttonStyle(CardButtonStyle())
    }

    // MARK: - 配方

    private func recipeSection(drink: DrinkType, plan: DrinkRecipePlan) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "配方", detail: .alreadyLocalized(L("共 %@ 步 · %@", String(steps.count), drink.estimateText)))

            if planFromHistory, let planBasisSummary {
                sourceNote(
                    symbol: "arrow.counterclockwise.circle",
                    text: L("按这包豆子上次同款冲法预填"),
                    detail: planBasisSummary
                )
            } else {
                sourceNote(
                    symbol: "slider.horizontal.3",
                    text: L("默认建议"),
                    detail: L("容易上手的参考起点，不是标准答案——按豆子和口味随意改。")
                )
            }

            Card(padding: 0) {
                VStack(spacing: 0) {
                    EditorRow(title: "咖啡粉") {
                        NumberField(placeholder: "0", value: planBinding(\.coffeeG), unit: "g")
                    }
                    if drink.family == .espresso {
                        EditorRow(title: "浓缩液") {
                            NumberField(placeholder: "0", value: planBinding(\.espressoYieldG), unit: "g")
                        }
                    }
                    if drink.family != .espresso {
                        EditorRow(title: "水量") {
                            NumberField(placeholder: "0", value: planBinding(\.waterG), unit: "g")
                        }
                    }
                    if drink == .americano {
                        EditorRow(title: "加水") {
                            NumberField(placeholder: "0", value: planBinding(\.addedWaterG), unit: "g")
                        }
                    }
                    if drink.usesMilk {
                        EditorRow(title: "牛奶") {
                            NumberField(placeholder: "0", value: planBinding(\.milkG), unit: "g")
                        }
                    }
                    if drink != .coldBrew {
                        EditorRow(title: "水温") {
                            NumberField(placeholder: "0", value: planBinding(\.waterTemp), unit: "°C")
                        }
                    }
                    EditorChipsRow(
                        title: "做法",
                        options: drink.methodOptions,
                        isOn: { $0 == plan.method },
                        onPick: { self.plan?.method = $0 },
                        showsDivider: false
                    ) {
                        EditorTextField(placeholder: LocalizedStringKey.alreadyLocalized(drink.defaultMethod),
                                        text: methodBinding)
                    }
                }
            }

            Button {
                withAnimation(Motion.settle) { self.plan = DrinkRecipePlan.default(for: drink) }
            } label: {
                Text("恢复默认配方")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.roast)
            }
            .buttonStyle(.plain)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private func sourceNote(symbol: String, text: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.roast)
            VStack(alignment: .leading, spacing: 2) {
                Text(LocalizedStringKey.alreadyLocalized(text))
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.ink)
                Text(LocalizedStringKey.alreadyLocalized(detail))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: - 底部动作

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if plan != nil {
                SecondaryButton(title: "跳过引导，直接记录", systemImage: "square.and.pencil") {
                    startRecording(measured: 0)
                }
            }
            PrimaryButton(title: plan == nil ? "先选一杯" : "开始制作") {
                guard plan != nil else { return }
                showsGuide = true
            }
            .disabled(plan == nil)
            .opacity(plan == nil ? 0.5 : 1)
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }

    // MARK: - 动作

    private func resolveDefaultBeanIfNeeded() {
        guard !didResolveDefaultBean else { return }
        didResolveDefaultBean = true
        guard beanID == nil else { return }
        // 与快记同一条规则：最近冲过的那包优先，其次今天最该喝的那包。
        let book = PhaseRuleBook.make(stored: rules)
        if let recent = allBrews.first?.bean, !recent.isFinished {
            beanID = recent.id
        } else if let pick = InsightFactory.todaysPick(
            activeBeans, book: book, defaults: BrewDefaults.current()
        ), let bean = activeBeans.first(where: { $0.id == pick.id }) {
            beanID = bean.id
        } else {
            beanID = activeBeans.first?.id
        }
    }

    private func select(_ bean: Bean) {
        beanID = bean.id
        // 换豆子后配方出处会变，重新算一遍；饮品没选过就还只是选豆。
        if let drink { applyPlan(for: drink, previous: nil) }
    }

    private func select(drink: DrinkType) {
        // 重复点同一杯不动配方——已经改过的数字不该被悄悄抹掉。
        guard self.drink != drink || plan == nil else { return }
        let previous = plan
        self.drink = drink
        applyPlan(for: drink, previous: previous)
    }

    private func applyPlan(for drink: DrinkType, previous: DrinkRecipePlan?) {
        let result = DrinkPlanBuilder.plan(for: drink, bean: selectedBean, previous: previous)
        plan = result.plan
        planFromHistory = result.fromHistory
        planBasisSummary = result.basisSummary
    }

    private func startRecording(measured: Int) {
        guard let plan else { return }
        recordSeed = GuidedBrewSeed(plan: plan, measuredSeconds: measured)
        showsQuickLog = true
    }

    // MARK: - 绑定

    /// `plan` 是可选状态，字段编辑用这条绑定写到值上。
    private func planBinding(_ keyPath: WritableKeyPath<DrinkRecipePlan, Double>) -> Binding<Double> {
        Binding(
            get: { plan?[keyPath: keyPath] ?? 0 },
            set: { plan?[keyPath: keyPath] = $0 }
        )
    }

    private var methodBinding: Binding<String> {
        Binding(
            get: { plan?.method ?? "" },
            set: { plan?.method = $0 }
        )
    }
}
