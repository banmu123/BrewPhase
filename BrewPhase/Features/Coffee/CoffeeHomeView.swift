import SwiftData
import SwiftUI

/// 咖啡 —— 一级页面之一，也是这个 App 原来的全部。
///
/// 它保留了豆仓的形态：一次只把一包豆推到前面，其余的在后面叠着。变化在于，
/// 「冲煮」不再是另一个 Tab：记录冲煮本来就是喝咖啡的一部分，所以它变成了
/// 这一页底部的一段，以及一个通往完整历史的入口。
struct CoffeeHomeView: View {

    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.defaultMethod) private var defaultMethod: String = "V60"
    @AppStorage(PrefKey.defaultDoseG) private var defaultDoseG: Double = 15
    @AppStorage(PrefKey.defaultWaterG) private var defaultWaterG: Double = 240
    @AppStorage(PrefKey.defaultWaterTemp) private var defaultWaterTemp: Double = 92

    @Environment(\.modelContext) private var context
    /// 首页桌面同步卡的可观察状态：phase / lastSyncAt 变化时卡片自己刷新。
    @ObservedObject private var sync = SyncManager.shared

    @State private var isAddingBean = false
    @State private var brewingBean: Bean?
    @State private var isLoggingBrew = false
    @State private var editingBrew: Brew?
    @State private var detailBean: Bean?
    /// 卡片堆叠当前停在哪一包。调试启动可以直接停在中间或最后一包。
    @State private var cardIndex = DebugLaunch.cardIndex ?? 0
    /// 已喝完的豆子收在折叠入口里，不占活跃堆叠。
    @State private var showsFinished = false
    @State private var showsSettings = false

    // MARK: - Derived

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    private var defaults: BrewDefaults {
        BrewDefaults(method: defaultMethod, doseG: defaultDoseG,
                     waterG: defaultWaterG, waterTemp: defaultWaterTemp)
    }

    /// Priority order is the engine's, unchanged: the deck is just that list.
    private var ranked: [BeanInsight] {
        InsightFactory.ranked(beans, book: book, defaults: defaults)
    }

    private var activeInsights: [BeanInsight] {
        ranked.filter { !$0.bean.isFinished }
    }

    private var finishedBeans: [Bean] {
        ranked.filter { $0.bean.isFinished }.compactMap { insight in
            beans.first { $0.id == insight.id }
        }
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header

                    // 桌面同步入口（发现性）：header 之下、咖啡内容之前的
                    // 一条极简状态行——不是卡片，视觉焦点留给咖啡豆。
                    DesktopSyncEntryRow(sync: .shared)
                        .padding(.top, Metric.Space.lg)

                    if beans.isEmpty {
                        EmptyStateView(
                            symbol: "square.stack.3d.up",
                            title: "工作室还空着",
                            message: "把第一包咖啡豆带进来，看着风味一天天打开。",
                            actionLabel: "添加第一包豆",
                            action: { isAddingBean = true }
                        )
                        // 构图值：空态与页头之间的一次深呼吸，不在梯子上。
                        .padding(.top, 44)
                    } else {
                        if activeInsights.isEmpty {
                            cellarEmptied.padding(.top, Metric.Space.xxl)
                        } else {
                            BeanStack(
                                items: activeInsights,
                                index: $cardIndex,
                                onOpen: { insight in
                                    detailBean = beans.first { $0.id == insight.id }
                                },
                                onBrew: { insight in
                                    brewingBean = beans.first { $0.id == insight.id }
                                }
                            )
                            // 堆叠里靠后的卡片会向上探出两档（各 stackPeek 13pt），
                            // 再加一格呼吸（sm 12）——压住「N 包在喝」就是事故。
                            .padding(.top, Metric.stackPeek * 2 + Metric.Space.sm)
                        }

                        brewsSection.padding(.top, Metric.Space.xxl)
                        finishedSection
                    }
                }
                .padding(.horizontal, Metric.gutter)
                // 顶端一线呼吸：刻意小于一格梯子（6pt），标题不必再往下让。
                .padding(.top, 6)
                // 页尾收尾与区块间距同值（28），但语义是页尾而非区块。
                .padding(.bottom, Metric.sectionGap)
            }
            .background(Palette.paper)
            // 页面自己带标题，导航栏不再重复一遍——也让堆叠卡片更靠近顶部。
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $detailBean) { bean in
                BeanDetailView(bean: bean)
            }
            .sheet(isPresented: $showsSettings) {
                MoreView()
            }
            .sheet(isPresented: $isAddingBean) {
                BeanEditorView(mode: .create)
            }
            .sheet(item: $brewingBean) { bean in
                QuickBrewLogView(bean: bean)
            }
            .sheet(isPresented: $isLoggingBrew) {
                QuickBrewLogView(bean: nil)
            }
            .sheet(item: $editingBrew) { brew in
                if let bean = brew.bean {
                    BrewEditorView(bean: bean, existing: brew)
                }
            }
            .animation(Motion.glide, value: beans.count)
        }
    }

    // MARK: - 顶部

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                // 品牌 overline：拉丁字专属的衬线小字，中文标题不跟风。
                Text(verbatim: "BREWPHASE / STUDIO")
                    .font(TypeScale.brandMark)
                    .italic()
                    .tracking(2.4)
                    .foregroundStyle(Palette.inkFaint)

                Text("咖啡")
                    .font(TypeScale.display)
                    .foregroundStyle(Palette.ink)

                if !activeInsights.isEmpty {
                    Text(verbatim: Fmt.bagsOpen(activeInsights.count))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }

            Spacer(minLength: 0)

            Button {
                showsSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.inkSoft)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.card))
                    .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("设置")

            Button {
                isAddingBean = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.card)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.espresso))
            }
            .buttonStyle(.plain)
            // 这一页是豆仓：加号只加豆子，不是 Records 的内容收集面板。
            .accessibilityLabel("添加咖啡豆")
        }
        .padding(.top, 10)
    }

    /// 所有豆子都喝完了：不能让首页空白，也不能拿「已喝完」的列表顶替今天。
    private var cellarEmptied: some View {
        EmptyStateView(
            symbol: "checkmark.seal",
            title: "这一批都喝完了",
            message: "把下一包豆带进来，风味档案继续写下去。",
            actionLabel: "添加豆子",
            action: { isAddingBean = true }
        )
    }

    // MARK: - 冲煮

    /// 冲煮不再是独立 Tab 之后，这一页要负责它的入口：最近两杯直接看见，
    /// 完整历史一次点击到达。没有记录时给一个「记一杯」，而不是留一段空白。
    private var brewsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline()

            HStack(alignment: .firstTextBaseline, spacing: Metric.Space.xs) {
                SectionLabel(title: "最近冲煮")
                Spacer(minLength: 0)
                NavigationLink {
                    BrewHistoryView()
                } label: {
                    HStack(spacing: 3) {
                        Text("全部记录")
                            .font(TypeScale.caption)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .foregroundStyle(Palette.roast)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.top, Metric.Space.md)

            if brews.isEmpty {
                Text("还没有冲煮记录。冲完随手记一笔，这里会长起来。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 14)

                logAnotherBrew
            } else {
                let recent = Array(brews.prefix(2))
                ForEach(Array(recent.enumerated()), id: \.element.id) { index, brew in
                    Button {
                        editingBrew = brew
                    } label: {
                        brewRow(brew)
                    }
                    .buttonStyle(.plain)

                    if index != recent.count - 1 {
                        CardDivider()
                    }
                }

                logAnotherBrew
            }
        }
    }

    /// 轻量级「记一杯」：一行文字加一个加号，不再是一枚胶囊按钮——
    /// 它是工作台上的日常动作，不是一个功能入口。
    private var logAnotherBrew: some View {
        Button {
            isLoggingBrew = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                Text("记一杯")
                    .font(TypeScale.callout.weight(.medium))
            }
            .foregroundStyle(Palette.roast)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func brewRow(_ brew: Brew) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(brew.method.trimmed.isEmpty
                         ? LocalizedStringKey("冲煮")
                         : .alreadyLocalized(brew.method))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)

                    Spacer(minLength: 8)

                    Text(verbatim: Fmt.short(brew.date, calendar: DateMath.calendar))
                        .font(TypeScale.dataSmall)
                        .foregroundStyle(Palette.inkFaint)
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let beanName = brew.bean?.displayName, !beanName.isEmpty {
                        Text(LocalizedStringKey.alreadyLocalized(beanName))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .lineLimit(1)
                    }
                    if brew.coffeeG > 0 {
                        Text(verbatim: Fmt.doseLine(coffeeG: brew.coffeeG, waterG: brew.waterG))
                            .font(TypeScale.numeral)
                            .foregroundStyle(Palette.inkFaint)
                    }
                    if let taste = brew.tasteLine {
                        Text(LocalizedStringKey.alreadyLocalized(taste))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                    }
                }
            }

            Spacer(minLength: 6)

            if brew.score > 0 {
                StarRating(score: brew.score, size: 10)
            }
        }
        .padding(.vertical, 13)
        .contentShape(Rectangle())
    }

    // MARK: - 已喝完

    private var finishedSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !finishedBeans.isEmpty {
                Hairline().padding(.top, Metric.Space.lg)

                Button {
                    withAnimation(Motion.settle) { showsFinished.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Text("已喝完")
                            .font(TypeScale.body)
                            .foregroundStyle(Palette.inkSoft)
                        Text(verbatim: Fmt.bags(finishedBeans.count))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                        Spacer(minLength: 0)
                        Image(systemName: showsFinished ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Palette.inkFaint)
                    }
                    .padding(.vertical, Metric.Space.md)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if showsFinished {
                    VStack(spacing: 0) {
                        ForEach(finishedBeans) { bean in
                            Button {
                                detailBean = bean
                            } label: {
                                BeanRow(insight: InsightFactory.insight(
                                    for: bean, book: book, defaults: defaults))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }
}

// MARK: - 桌面同步入口

/// 首页的桌面同步入口（§发现性）：一条极简状态行，不是功能卡片。
///
/// 未配对 / 已配对 / 同步中 / 同步失败共用同一行布局，只换图标色、标题
/// 与辅助行；行本身透明、无边框、无按钮胶囊，视觉焦点留给咖啡豆。
/// `pairedDevice()` 有凭据 ≠ 桌面在线，文案永远只说「已配对」。
private struct DesktopSyncEntryRow: View {
    @ObservedObject var sync: SyncManager
    @Environment(\.modelContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if pairedDevice != nil {
                pairedRow
                    .transition(.opacity)
            } else {
                unpairedRow
                    .transition(.opacity)
            }
        }
        // 只在状态类别变化时过渡；同步进度刷新不改变 stage，不会重放动画。
        .animation(reduceMotion ? Motion.fade : Motion.standard, value: stage)
    }

    // MARK: 状态派生

    private enum Stage { case unpaired, paired, syncing, failed }

    private var stage: Stage {
        guard pairedDevice != nil else { return .unpaired }
        if isSyncing { return .syncing }
        if isFailed { return .failed }
        return .paired
    }

    private var isSyncing: Bool {
        switch sync.phase {
        case .preparing, .sendingData, .sendingMedia: return true
        default: return false
        }
    }

    private var isFailed: Bool {
        if case .failed = sync.phase { return true }
        return false
    }

    /// 生产路径读 Keychain；只有带 `-BrewPhaseScreen` 的 UI inspection 才
    /// 回退到展示用设备（与 DesktopSyncView 同一份数据），方便截图验收。
    private var pairedDevice: (host: String, port: Int, deviceId: String, token: String)? {
        sync.pairedDevice() ?? SyncInspection.placeholderDevice
    }

    private var deviceName: String {
        if let inspection = SyncInspection.deviceName, sync.pairedDevice() == nil {
            return inspection
        }
        let stored = SyncKeychain.string(forKey: "desktop.deviceName") ?? ""
        return stored.isEmpty ? "BrewPhase Desktop" : stored
    }

    private var iconColor: Color {
        switch stage {
        case .unpaired: return Palette.inkFaint
        case .paired: return Palette.moss
        case .syncing: return Palette.roast
        case .failed: return Palette.priority
        }
    }

    // MARK: 各状态

    private var unpairedRow: some View {
        NavigationLink {
            DesktopSyncView()
        } label: {
            entryRow(
                title: { Text("桌面空间") },
                subtitle: { Text("尚未配对 · 连接桌面端") },
                showsChevron: true
            )
        }
        .buttonStyle(CardButtonStyle())
    }

    private var pairedRow: some View {
        HStack(spacing: Metric.Space.xs) {
            NavigationLink {
                DesktopSyncView()
            } label: {
                entryRow(
                    title: { Text(verbatim: deviceName) },
                    subtitle: { pairedSubtitle },
                    showsChevron: true
                )
            }
            .buttonStyle(CardButtonStyle())

            // 重试是独立 Button，不嵌在 NavigationLink 里：一次点按只做一件事。
            if isFailed {
                Button {
                    Task { await sync.syncNow(context: context) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Palette.roast)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isSyncing)
                .accessibilityLabel(Text("重试"))
            }
        }
    }

    @ViewBuilder private var pairedSubtitle: some View {
        if isSyncing, let status = sync.compactStatus {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Text(LocalizedStringKey.alreadyLocalized(status))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
            }
        } else if isFailed {
            Text("已配对 · 同步失败")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.priority)
        } else if let last = sync.lastSyncAt {
            Text(LocalizedStringKey.alreadyLocalized(L("已配对 · 上次同步 %@", Fmt.dayTime(last))))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        } else {
            Text("已配对 · 尚未同步")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
    }

    // MARK: 共用行布局

    private func entryRow<Title: View, Subtitle: View>(
        @ViewBuilder title: () -> Title,
        @ViewBuilder subtitle: () -> Subtitle,
        showsChevron: Bool
    ) -> some View {
        HStack(spacing: Metric.Space.sm) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Palette.well)
                .frame(width: 32, height: 32)
                .overlay(
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(iconColor)
                )

            VStack(alignment: .leading, spacing: 2) {
                title()
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                subtitle()
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
