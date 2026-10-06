import SwiftData
import SwiftUI

/// 豆子详情 (§11): the whole life of one bag on a single page.
struct BeanDetailView: View {

    let bean: Bean

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var rules: [PhaseRule]
    /// 别的豆子的记录也要看：个人基线的第三层回退是「同一冲法、别的豆子」。
    @Query(sort: \Brew.date, order: .reverse) private var allBrews: [Brew]

    @State private var isEditing = false
    @State private var isAddingBrew = false
    @State private var isQuickLogging = false
    @State private var isAddingTasting = false
    @State private var editingBrew: Brew?
    @State private var isAdjustingStock = false
    @State private var isConfirmingDelete = false
    @State private var showsAllBrews = false
    /// 「最近一杯」卡片里的完整诊断默认收着，点「展开依据」才出现。
    @State private var showsRecentDiagnosis = false
    /// 工具栏动作（标记喝完 / 恢复在喝 / 删除）失败时的提示。
    @State private var actionError: String?

    /// 本地问答的总开关。跟着设置走，关掉时这里不显示入口——留一个点了没有反应的
    /// 按钮比不显示更糟。
    @AppStorage(PrefKey.askEnabled) private var asksAboutThisBag: Bool = true

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    private var insight: BeanInsight {
        InsightFactory.insight(for: bean, book: book)
    }

    /// 最近一杯的诊断。没有记录时为 nil——一张没有对象的诊断卡不该出现。
    ///
    /// 算在视图这一层是刻意的：它只依赖已有记录，是纯函数，不需要缓存；
    /// 换一包豆、记完新的一杯，它会自己刷新。
    private var recentDiagnosis: BrewDiagnosis? {
        BrewDiagnosisService.diagnose(bean: bean, allBrews: allBrews, languageCode: languageCode)
    }

    private var rule: PhaseRuleData { book.rule(for: bean.roastLevel) }

    /// 知识区块的文案与检索都跟着当前界面语言走。
    private var languageCode: String { LanguageManager.shared.current.resolvedCode }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                // 页面的十个层次按用户打开一包豆后的提问顺序排（§十一）：
                // 现在怎么样 → 还剩多少 → 上一杯怎么样 → 下一杯怎么改 → 继续冲，
                // 冲出足够的记录之后才是参考材料与备注。
                hero
                PhaseCard(insight: insight) { isEditing = true }
                stockSection
                if let brew = bean.latestBrew, let recentDiagnosis {
                    recentCupSection(brew: brew, diagnosis: recentDiagnosis)
                }
                // 主要行动：不再只靠页面底部的小按钮。
                if !bean.isFinished {
                    PrimaryButton(title: "记一杯", systemImage: "cup.and.saucer") {
                        isQuickLogging = true
                    }
                    .padding(.top, -6)
                }
                brewsSection
                TastingTimelineView(
                    tastings: bean.tastingsOldestFirst,
                    bean: bean.snapshot,
                    rule: rule,
                    onAdd: { isAddingTasting = true },
                    onDelete: delete(tasting:)
                )
                // 预计风味窗口与知识区块都是参考资料，不属于当前行动，统一排在
                // 自己的记录之后。
                FlavorWindowCard(bean: bean,
                                 defaults: BrewDefaults.current(),
                                 todayDay: bean.currentDayAfterRoast)
                BeanKnowledgeSection(bean: bean, languageCode: languageCode)
                if asksAboutThisBag {
                    askSection
                }
                notesSection
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 4)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        isEditing = true
                    } label: {
                        Label("编辑豆子", systemImage: "pencil")
                    }
                    Button {
                        isAdjustingStock = true
                    } label: {
                        Label("调整剩余量", systemImage: "scalemass")
                    }
                    // 一句话只在一种状态下是对的——菜单跟着状态说。
                    if bean.status == .finished {
                        Button {
                            restoreToActive()
                        } label: {
                            Label("恢复到在喝", systemImage: "arrow.uturn.backward")
                        }
                    } else {
                        Button {
                            markFinished()
                        } label: {
                            Label("标记为已喝完", systemImage: "checkmark.circle")
                        }
                    }
                    Divider()
                    Button(role: .destructive) {
                        isConfirmingDelete = true
                    } label: {
                        Label("删除这包豆子", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Palette.roast)
                }
            }
        }
        .sheet(isPresented: $isEditing) {
            BeanEditorView(mode: .edit, bean: bean)
        }
        .sheet(isPresented: $isAddingBrew) {
            BrewEditorView(bean: bean)
        }
        .sheet(isPresented: $isAddingTasting) {
            TastingEditorView(bean: bean)
        }
        .sheet(item: $editingBrew) { brew in
            BrewEditorView(bean: bean, existing: brew)
        }
        .sheet(isPresented: $isAdjustingStock) {
            StockAdjustView(bean: bean)
        }
        .sheet(isPresented: $isQuickLogging) {
            QuickBrewLogView(bean: bean)
        }
        .confirmationDialog(
            "删除这包豆子？",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) { deleteBean() }
            Button("取消", role: .cancel) {}
        } message: {
            Text(L("删除这包豆子后，它关联的 %@ 条冲煮记录和 %@ 条风味记录也会一起被删除，无法恢复。",
                   String(bean.brewsCount), String(bean.tastingsOldestFirst.count)))
        }
        // 保存类动作失败一律走到这里：动作没生效就得说出来，默默失败等于骗人。
        .alert(
            "没能保存",
            isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )
        ) {
            Button("好") { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let image = ImageStore.shared.image(named: bean.imagePath, thumbnail: false) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(height: 190)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                            .strokeBorder(Palette.hairline, lineWidth: 0.7)
                    )
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : LocalizedStringKey.alreadyLocalized(bean.name))
                    .font(TypeScale.cardTitle)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                if !bean.roaster.isEmpty {
                    Text(verbatim: bean.roaster)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                }

                if !metadataChips.isEmpty {
                    FlowLayout(spacing: 6, lineSpacing: 6) {
                        ForEach(metadataChips, id: \.self) { text in
                            Chip(text: text, tint: Palette.inkSoft, background: Palette.well)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    private var metadataChips: [String] {
        var chips: [String] = [bean.roastLevel.label]
        if !bean.origin.isEmpty { chips.append(bean.origin) }
        if !bean.process.isEmpty { chips.append(bean.process) }
        if let roastDate = bean.roastDate { chips.append(L("烘焙 %@", Fmt.short(roastDate))) }
        return chips
    }

    // MARK: - Ask

    /// 就这包豆子提问。
    ///
    /// 放在存量之后：看完「还剩多少」，最自然的下一个问题就是「那我该怎么喝」。
    /// 入口带着这包豆子进去，所以用户不必在问题里念一遍名字。
    private var askSection: some View {
        NavigationLink {
            AskView(focusBean: bean)
        } label: {
            Card {
                HStack(spacing: 12) {
                    Image(systemName: "text.magnifyingglass")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Palette.roast)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("就这包豆子提问")
                            .font(TypeScale.body)
                            .foregroundStyle(Palette.ink)
                        Text("从你自己的记录里找答案：什么时候开封的、哪次冲得最好")
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Palette.inkFaint)
                }
            }
        }
        .buttonStyle(CardButtonStyle())
    }

    // MARK: - Stock

    private var stockSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "库存", detail: .alreadyLocalized(bean.status.label))
            Card {
                VStack(alignment: .leading, spacing: 13) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Fmt.grams(bean.remainingG))
                            .font(TypeScale.bigNumeral)
                            .foregroundStyle(Palette.ink)
                        Text("/ \(Fmt.grams(bean.weightG))")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.inkFaint)
                        Spacer(minLength: 0)
                        Button("调整") { isAdjustingStock = true }
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.roast)
                    }

                    // A thin fill bar: the one place stock is shown as a quantity
                    // rather than a number.
                    GeometryReader { geo in
                        let fraction = bean.weightG > 0
                            ? min(max(bean.remainingG / bean.weightG, 0), 1)
                            : 0
                        ZStack(alignment: .leading) {
                            Capsule().fill(Palette.well)
                            Capsule()
                                .fill(Palette.latte)
                                .frame(width: max(0, geo.size.width * fraction))
                        }
                    }
                    .frame(height: 6)

                    HStack(spacing: 10) {
                        Text(insight.estimate.usedDefaults
                             ? L("按默认 %@/次 估算", Fmt.gramsShort(insight.estimate.averageDoseG))
                             : L("平均 %@/次", Fmt.gramsShort(insight.estimate.averageDoseG)))
                        Text(verbatim: "·")
                        Text(insight.estimate.brewsText)
                        if insight.reading.dayAfterRoast != nil, bean.remainingG > 0 {
                            Text(verbatim: "·")
                            Text(Fmt.daysLeftPhrase(insight.estimate.daysRemaining))
                        }
                    }
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                }
            }
        }
    }

    // MARK: - 最近一杯

    /// 第四层：最近一杯。一眼看到「上一次发生了什么、下一杯怎么改」。
    ///
    /// 完整诊断（结论的依据、知识出处）收在同一张卡片里，点「展开依据」才出现：
    /// 日常扫一眼只需要三行结论，想深究的时候它还在——功能一个没少，只是不再
    /// 把整张诊断卡铺在页面前半部分。
    private func recentCupSection(brew: Brew, diagnosis: BrewDiagnosis) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "最近一杯",
                          detail: .alreadyLocalized(Fmt.short(brew.date, calendar: DateMath.calendar)))
            Card {
                VStack(alignment: .leading, spacing: 13) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(recentRecipeLine(brew))
                            .font(TypeScale.numeral)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        if brew.score > 0 {
                            StarRating(score: brew.score)
                        }
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        Text(LocalizedStringKey.alreadyLocalized(conclusionLine(diagnosis)))
                            .font(TypeScale.bodyMedium)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if let suggestion = diagnosis.suggestion {
                            Text(L("下一杯：%@", suggestion.headline))
                                .font(TypeScale.callout)
                                .foregroundStyle(Palette.roast)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    CardDivider()

                    HStack(spacing: 10) {
                        SecondaryButton(title: "再记一杯", systemImage: "plus") {
                            isQuickLogging = true
                        }
                        Spacer(minLength: 0)
                        Button {
                            withAnimation(Motion.settle) { showsRecentDiagnosis.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Text(showsRecentDiagnosis ? "收起依据" : "展开依据")
                                Image(systemName: showsRecentDiagnosis ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if showsRecentDiagnosis {
                BrewDiagnosticCard(diagnosis: diagnosis, showsKnowledge: false)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    /// 一句话结论。没有候选结论时也得说话——说清楚是「记录不够」还是「这杯正常」。
    private func conclusionLine(_ diagnosis: BrewDiagnosis) -> String {
        if let primary = diagnosis.primary { return primary.finding.title }
        if diagnosis.baseline.isUsable { return L("这一杯在你自己的记录里没有明显异常。") }
        return L("目前数据还不足以建立个人基线。")
    }

    /// 「最近一杯」的参数行：`2:08 · 18g · 300g · 92°C`（§十一 的排版）。
    /// 比 `summaryParts` 略去器具——这里是「上一杯发生了什么」，器具在下面的
    /// 冲煮记录里每次都写着。
    private func recentRecipeLine(_ brew: Brew) -> String {
        var parts: [String] = []
        if brew.timeSeconds > 0 { parts.append(brew.timeText) }
        if brew.coffeeG > 0 { parts.append(Fmt.gramsShort(brew.coffeeG)) }
        if brew.waterG > 0 { parts.append(Fmt.gramsShort(brew.waterG)) }
        if brew.waterTemp > 0 { parts.append("\(Int(brew.waterTemp.rounded()))°C") }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    // MARK: - Brews

    private var brewsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "冲煮记录",
                          detail: bean.brewsCount == 0
                              ? nil
                              : .alreadyLocalized(L("%@ 次", String(bean.brewsCount))))

            Card {
                VStack(alignment: .leading, spacing: 16) {
                    if bean.brewsCount == 0 {
                        Text("还没有冲煮记录\n冲一次，然后记下今天这杯怎么样。")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.inkSoft)
                            .lineSpacing(3)
                        addBrewButtons
                    } else {
                        let brews = visibleBrews
                        ForEach(Array(brews.enumerated()), id: \.element.id) { index, brew in
                            Button {
                                editingBrew = brew
                            } label: {
                                BrewRow(brew: brew)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)

                            if index != brews.count - 1 {
                                CardDivider()
                            }
                        }

                        if bean.brewsCount > brews.count {
                            Button {
                                withAnimation(Motion.settle) { showsAllBrews = true }
                            } label: {
                                Text(L("查看全部 %@ 条", String(bean.brewsCount)))
                                    .font(TypeScale.callout)
                                    .foregroundStyle(Palette.roast)
                            }
                            .buttonStyle(.plain)
                        }

                        CardDivider()
                        addBrewButtons
                    }
                }
            }
        }
    }

    private var visibleBrews: [Brew] {
        let all = bean.brewsNewestFirst
        return showsAllBrews ? all : Array(all.prefix(3))
    }

    private var addBrewButtons: some View {
        HStack(spacing: 10) {
            // 常用的是快记：参数已经沿用上一杯，只需要回答「这次变了什么」。
            SecondaryButton(title: "记一杯", systemImage: "plus") {
                isQuickLogging = true
            }
            // 完整表单仍然在：想逐项填、或者要改的是配方本身时用它。
            SecondaryButton(title: "完整表单", systemImage: "square.and.pencil") {
                isAddingBrew = true
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var notesSection: some View {
        if !bean.notes.trimmed.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "备注")
                Card {
                    Text(bean.notes)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.inkSoft)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Actions

    private func delete(tasting: Tasting) {
        context.delete(tasting)
        bean.touch()
        do {
            try context.save()
        } catch {
            AppLog.store.error("tasting delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            actionError = L("没能删除，请再试一次")
        }
    }

    /// 标记喝完只改状态：不动库存、不动历史（见 `Bean.markFinished()`）。
    private func markFinished() {
        bean.markFinished()
        do {
            try context.save()
        } catch {
            AppLog.store.error("mark finished failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            bean.status = .active
            actionError = L("没能保存下来，请再试一次")
            return
        }
        NotificationManager.shared.cancel(bean: bean, context: context)
    }

    /// 恢复到在喝：只恢复状态。库存保持用户当前的值，历史记录一律不碰；
    /// 提醒则跟着重新排——在喝的袋子才需要提醒。
    private func restoreToActive() {
        bean.restoreToActive()
        do {
            try context.save()
        } catch {
            AppLog.store.error("restore active failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            bean.status = .finished
            actionError = L("没能保存下来，请再试一次")
            return
        }
        Task { await BrewRecorder.rescheduleReminders(for: bean, in: context) }
    }

    /// Deleting a bag takes its brews, tastings and images with it (§21, §33).
    ///
    /// 顺序是这一版刻意定的：**先让 SwiftData 真删成功，再动磁盘上的图片**。
    /// 反过来（先删图片、再落库）一旦落库失败，就是「记录还在、照片没了」。
    /// 落库失败时这里什么都不碰：豆子、历史、图片都原样，页面停着，把失败
    /// 告诉用户。
    private func deleteBean() {
        let imagePath = bean.imagePath
        let reminderIdentifiers = NotificationPlanner.allIdentifiers(beanID: bean.id)

        context.delete(bean)
        do {
            try context.save()
        } catch {
            AppLog.store.error("bean delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            actionError = L("没能删除，请再试一次")
            return
        }

        // 库里已经没有这包豆了，系统里的待送达提醒和图片文件现在才可以清。
        NotificationManager.shared.unschedule(identifiers: reminderIdentifiers)
        ImageStore.shared.delete(imagePath)
        dismiss()
    }
}

/// Adjusting remaining stock by hand, for the times a brew was not logged.
struct StockAdjustView: View {

    let bean: Bean

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var value: Double
    @State private var errorMessage: String?

    /// - Parameter initialValue: 只给调试屏用——「剩余量 > 总量」那条提示需要
    ///   从那个状态直接打开才看得见（见 `DebugLaunch.stockOvershoot`）。
    init(bean: Bean, initialValue: Double? = nil) {
        self.bean = bean
        _value = State(initialValue: initialValue ?? bean.remainingG)
    }

    /// 剩余量超过总克数时保存会抬高总克数。这是必须**提前说**的事：
    /// 悄悄改掉用户填进去的总量，等于历史数据被动过而没人知道。
    private var expandsBag: Bool { value > bean.weightG }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: "剩余克数")
                    Card(padding: 0) {
                        EditorRow(title: "剩余", showsDivider: false) {
                            NumberField(placeholder: "0", value: $value, unit: "g")
                        }
                    }
                }

                HStack(spacing: 8) {
                    ForEach([-18.0, -15.0, 15.0, 18.0], id: \.self) { delta in
                        Button {
                            withAnimation(Motion.quick) {
                                value = max(0, value + delta)
                            }
                        } label: {
                            Text(delta > 0 ? "+\(Int(delta))g" : "\(Int(delta))g")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.roast)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(Capsule(style: .continuous).fill(Palette.cream.opacity(0.5)))
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }

                if expandsBag {
                    expansionNotice
                }

                if let errorMessage {
                    messageCard(errorMessage)
                }

                PrimaryButton(title: "保存") { save() }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 10)
            .background(Palette.paper)
            .navigationTitle("调整剩余量")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
            }
        }
    }

    /// 「保存后总量会调整为 220g」——把即将发生的事写全，用户点保存之前就知道
    /// 自己在同意什么。
    private var expansionNotice: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").font(.system(size: 13))
            Text(L("剩余量 %@\n当前总量 %@\n\n保存后总量会调整为 %@。",
                   Fmt.grams(value), Fmt.grams(bean.weightG), Fmt.grams(value)))
                .font(TypeScale.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Palette.inkSoft)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous).fill(Palette.well)
        )
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

    /// 三条规则都在 `Bean.setRemaining` 里；这里只管落库。失败就把三个字段
    /// 逐个写回去（`rollback()` 撤不回属性改动，见 `BeanOriginalValues`），
    /// 留在这一页——数字还摆在输入框里，用户看得到、也改得动。
    private func save() {
        errorMessage = nil
        let previousRemaining = bean.remainingG
        let previousWeight = bean.weightG
        let previousStatus = bean.status

        bean.setRemaining(value)
        do {
            try context.save()
        } catch {
            AppLog.store.error("stock adjust failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            bean.remainingG = previousRemaining
            bean.weightG = previousWeight
            bean.status = previousStatus
            errorMessage = L("没能保存下来，请再试一次")
            return
        }
        dismiss()
    }
}
