import SwiftUI
import SwiftData

/// 豆仓 — the home screen, and the only screen most days.
///
/// It answers one question first ("今天喝哪包"), then gets out of the way and
/// lists the rest of the cellar in the order you should drink it (§25).
struct HomeView: View {

    @Environment(\.modelContext) private var context
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
    /// 豆仓超过一屏放不下时的「查看全部」。默认只给最先该喝的几包。
    @State private var showsAllBeans = false
    /// 「最近一杯」点进去是冲煮编辑器——和冲煮历史里同一条路。
    @State private var editingBrew: Brew?

    // MARK: - Derived

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    private var defaults: BrewDefaults {
        BrewDefaults(method: defaultMethod, doseG: defaultDoseG,
                     waterG: defaultWaterG, waterTemp: defaultWaterTemp)
    }

    private var ranked: [BeanInsight] {
        InsightFactory.ranked(beans, book: book, defaults: defaults)
    }

    /// The bag to lead with, paired back to its stored record so it can be
    /// brewed and opened directly.
    private var todaysPick: (bean: Bean, insight: BeanInsight)? {
        guard let insight = InsightFactory.todaysPick(beans, book: book, defaults: defaults),
              let bean = beans.first(where: { $0.id == insight.id })
        else { return nil }
        return (bean, insight)
    }

    private var activeInsights: [BeanInsight] {
        ranked.filter { !$0.bean.isFinished }
    }

    private var finishedBeans: [Bean] {
        ranked.filter { $0.bean.isFinished }.compactMap { insight in
            beans.first { $0.id == insight.id }
        }
    }

    /// 豆仓默认只摆最先该喝的几包，其余收进「查看全部」。
    private var visibleInsights: [BeanInsight] {
        showsAllBeans ? activeInsights : Array(activeInsights.prefix(4))
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Metric.sectionGap) {
                    greeting

                    if beans.isEmpty {
                        Card(lifted: true) {
                            EmptyStateView(
                                symbol: "square.stack.3d.up",
                                title: "还没有你的咖啡豆",
                                message: "记录每一包豆，看到风味怎么变化。先添加正在喝的这一包。",
                                actionLabel: "添加第一包豆",
                                action: { isAddingBean = true }
                            )
                        }
                    } else {
                        if let pick = todaysPick {
                            TodayCard(insight: pick.insight, bean: pick.bean) {
                                brewingBean = pick.bean
                            }
                            if recentBrews.isEmpty {
                                firstBrewHint
                            }
                        } else if activeInsights.isEmpty {
                            cellarEmptied
                        }
                        cellar
                        recentBrewSection
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .background(Palette.paper)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // 记一杯是每天都会做的事，单独占工具栏左侧。问一问与洞察不再挤在
                // 这里——「更多」页和豆子页都有入口，首页的第一眼只回答一件事：
                // 现在该冲哪包（规格：打开 App 第一眼就知道下一步干什么）。
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        isLoggingBrew = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "cup.and.saucer.fill")
                                .font(.system(size: 13, weight: .semibold))
                            Text("记一杯")
                                .font(TypeScale.callout)
                        }
                        .foregroundStyle(Palette.roast)
                    }
                    .accessibilityLabel("记一杯")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isAddingBean = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Palette.roast)
                    }
                    .accessibilityLabel("添加豆子")
                }
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

    // MARK: - Greeting

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(greetingText)
                .font(TypeScale.greeting)
                .foregroundStyle(Palette.ink)
            Text(verbatim: DateMath.weekday(Date()) + " · " + Fmt.short(Date()))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 6)
    }

    private var greetingText: String {
        let hour = DateMath.calendar.component(.hour, from: Date())
        switch hour {
        case 5..<11: return L("早上好")
        case 11..<14: return L("中午好")
        case 14..<18: return L("下午好")
        default: return L("晚上好")
        }
    }

    // MARK: - 状态卡

    /// 有豆、还没记过任何一杯：TodayCard 回答了「喝哪包」，这里补上「下一步」
    /// ——记下第一杯，后面的参数预填和个人规律才有起点。
    private var firstBrewHint: some View {
        Card {
            EmptyStateView(
                symbol: "cup.and.saucer",
                title: "先记下第一杯",
                message: "冲完随手记一笔，之后这里会自动带上一次的参数。",
                actionLabel: "记一杯",
                action: { isLoggingBrew = true }
            )
        }
    }

    /// 所有豆子都喝完了：不能让首页空白，也不能拿「已喝完」的列表顶替今天。
    private var cellarEmptied: some View {
        Card(lifted: true) {
            EmptyStateView(
                symbol: "checkmark.seal",
                title: "豆仓暂时空了",
                message: "添加下一包豆，继续记录你的风味轨迹。",
                actionLabel: "添加豆子",
                action: { isAddingBean = true }
            )
        }
    }

    // MARK: - 最近一杯

    /// 首页上的轻量一行：昨天那杯怎么样了。点进去是冲煮编辑器。
    /// 完整的诊断与建议在豆子页和 Quick Log 结果页——这里不展开。
    @ViewBuilder
    private var recentBrewSection: some View {
        if let brew = recentBrews.first {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "最近一杯")
                Button {
                    editingBrew = brew
                } label: {
                    Card {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 8) {
                                Text(Fmt.short(brew.date, calendar: DateMath.calendar))
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.inkFaint)
                                Spacer(minLength: 0)
                                if let beanName = brew.bean?.displayName, !beanName.isEmpty {
                                    Text(LocalizedStringKey.alreadyLocalized(
                                        L("%@ · %@", beanName, brew.method.trimmed.isEmpty ? "—" : brew.method.trimmed)))
                                        .font(TypeScale.caption)
                                        .foregroundStyle(Palette.inkSoft)
                                        .lineLimit(1)
                                }
                            }
                            HStack(spacing: 10) {
                                if brew.score > 0 {
                                    StarRating(score: brew.score, size: 11)
                                }
                                if let taste = brew.tasteLine {
                                    Text(LocalizedStringKey.alreadyLocalized(taste))
                                        .font(TypeScale.caption)
                                        .foregroundStyle(Palette.inkSoft)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Palette.inkFaint)
                            }
                        }
                    }
                }
                .buttonStyle(CardButtonStyle())
            }
        }
    }

    // MARK: - Cellar

    private var cellar: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "我的咖啡豆",
                          detail: .alreadyLocalized(L("%@ 包", String(beans.count))))

            if !activeInsights.isEmpty {
                tallyRow
            }

            ForEach(visibleInsights) { insight in
                if let bean = beans.first(where: { $0.id == insight.id }) {
                    NavigationLink {
                        BeanDetailView(bean: bean)
                    } label: {
                        BeanCard(insight: insight)
                    }
                    .buttonStyle(CardButtonStyle())
                }
            }

            // 豆子多过一屏时收一层，首页的第一眼留给 TodayCard。
            if activeInsights.count > 4 {
                Button {
                    withAnimation(Motion.settle) { showsAllBeans.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        Text(showsAllBeans ? "收起" : L("查看全部 %@ 包", String(activeInsights.count)))
                        Image(systemName: showsAllBeans ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.roast)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }

            if !finishedBeans.isEmpty {
                finishedSection
            }
        }
    }

    /// `2 黄金窗口 · 1 进入窗口 · 1 养豆` — the cellar at a glance.
    ///
    /// Wraps rather than scrolls: with a bag in each of the four phases the row
    /// is wider than the page, and a scrolling strip here would have pushed the
    /// last chip out over the gutter. Four short chips never need a hidden
    /// overflow, so they simply move to a second line.
    private var tallyRow: some View {
        let tally = InsightFactory.phaseTally(ranked)
        return FlowLayout(spacing: 7, lineSpacing: 7) {
            ForEach(tally, id: \.phase) { entry in
                Chip(
                    text: "\(entry.count) \(entry.phase.shortTitle)",
                    tint: Palette.tint(entry.phase),
                    background: Palette.well,
                    dot: Palette.tint(entry.phase)
                )
            }
        }
    }

    private var finishedSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "已喝完",
                          detail: .alreadyLocalized(L("%@ 包", String(finishedBeans.count))))
            ForEach(finishedBeans) { bean in
                NavigationLink {
                    BeanDetailView(bean: bean)
                } label: {
                    BeanCard(insight: InsightFactory.insight(for: bean, book: book, defaults: defaults))
                }
                .buttonStyle(CardButtonStyle())
                .opacity(0.6)
            }
        }
        .padding(.top, 6)
    }
}
