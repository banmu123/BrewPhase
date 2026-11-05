import SwiftData
import SwiftUI

/// 豆仓 — the home screen, and the only screen most days.
///
/// One question first: which bag is worth drinking now. The answer is a deck:
/// the bag `PriorityEngine` ranked first sits at the front at full size, the
/// others are stacked behind it, and a swipe walks the whole cellar in that same
/// order. Nothing is summarised into chips or counted into a dashboard — the
/// rest of the numbers live on the bag's own page.
struct HomeView: View {

    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var recentBrews: [Brew]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.defaultMethod) private var defaultMethod: String = "V60"
    @AppStorage(PrefKey.defaultDoseG) private var defaultDoseG: Double = 15
    @AppStorage(PrefKey.defaultWaterG) private var defaultWaterG: Double = 240
    @AppStorage(PrefKey.defaultWaterTemp) private var defaultWaterTemp: Double = 92

    @State private var isAddingBean = false
    @State private var brewingBean: Bean?
    @State private var isLoggingBrew = false
    /// 「最近一杯」点进去是冲煮编辑器——和冲煮历史里同一条路。
    @State private var editingBrew: Brew?
    @State private var detailBean: Bean?
    /// 卡片堆叠当前停在哪一包。调试启动可以直接停在中间或最后一包。
    @State private var cardIndex = DebugLaunch.cardIndex ?? 0
    /// 已喝完的豆子收在折叠入口里，不占活跃堆叠。
    @State private var showsFinished = false

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

                    if beans.isEmpty {
                        EmptyStateView(
                            symbol: "square.stack.3d.up",
                            title: "还没有你的咖啡豆",
                            message: "记录每一包豆，看到风味怎么变化。先添加正在喝的这一包。",
                            actionLabel: "添加第一包豆",
                            action: { isAddingBean = true }
                        )
                        .padding(.top, 48)
                    } else {
                        if activeInsights.isEmpty {
                            cellarEmptied.padding(.top, 34)
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
                            .padding(.top, 24)
                        }

                        recentSection.padding(.top, 36)
                        finishedSection
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            // 页面自己带标题，导航栏不再重复一遍——也让堆叠卡片更靠近顶部。
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $detailBean) { bean in
                BeanDetailView(bean: bean)
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
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text("豆仓")
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
                isAddingBean = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.ink)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.card))
                    .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("添加豆子")
        }
        .padding(.top, 10)
    }

    /// 所有豆子都喝完了：不能让首页空白，也不能拿「已喝完」的列表顶替今天。
    private var cellarEmptied: some View {
        EmptyStateView(
            symbol: "checkmark.seal",
            title: "豆仓暂时空了",
            message: "添加下一包豆，继续记录你的风味轨迹。",
            actionLabel: "添加豆子",
            action: { isAddingBean = true }
        )
    }

    // MARK: - 最近一杯

    /// 首页上的轻量一行：上一杯怎么样了。点进去是冲煮编辑器。
    /// 完整的诊断与建议在豆子页和 Quick Log 结果页——这里不展开。
    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline()

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SectionLabel(title: "最近一杯")

                Spacer(minLength: 0)

                Button {
                    isLoggingBrew = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                            .font(.system(size: 9, weight: .bold))
                        Text("记一杯")
                            .font(TypeScale.caption)
                    }
                    .foregroundStyle(Palette.roast)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 16)

            if let brew = recentBrews.first {
                Button {
                    editingBrew = brew
                } label: {
                    recentBrewBody(brew)
                }
                .buttonStyle(.plain)
            } else {
                Text("还没有记录。冲完随手记一笔，之后这里会自动带上一次的参数。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 16)
            }
        }
    }

    private func recentBrewBody(_ brew: Brew) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(beanName(of: brew))
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)

                Spacer(minLength: 8)

                Text(verbatim: Fmt.short(brew.date, calendar: DateMath.calendar))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }

            HStack(spacing: 9) {
                if brew.score > 0 {
                    StarRating(score: brew.score, size: 10)
                }
                if let taste = brew.tasteLine {
                    Text(LocalizedStringKey.alreadyLocalized(taste))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if !brew.method.trimmed.isEmpty {
                    Text(brew.method)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }
        }
        .padding(.vertical, 15)
        .contentShape(Rectangle())
    }

    private func beanName(of brew: Brew) -> LocalizedStringKey {
        guard let name = brew.bean?.displayName, !name.isEmpty else {
            return LocalizedStringKey("—")
        }
        return LocalizedStringKey.alreadyLocalized(name)
    }

    // MARK: - 已喝完

    private var finishedSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !finishedBeans.isEmpty {
                Hairline().padding(.top, 6)

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
                    .padding(.vertical, 16)
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

/// The page's one separator: a single hairline, full width of the content.
struct Hairline: View {
    var body: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(height: 0.7)
    }
}
