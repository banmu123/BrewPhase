import SwiftUI
import SwiftData

/// 豆仓 — the home screen, and the only screen most days.
///
/// It answers one question first ("今天喝哪包"), then gets out of the way and
/// lists the rest of the cellar in the order you should drink it (§25).
struct HomeView: View {

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.defaultMethod) private var defaultMethod: String = "V60"
    @AppStorage(PrefKey.defaultDoseG) private var defaultDoseG: Double = 15
    @AppStorage(PrefKey.defaultWaterG) private var defaultWaterG: Double = 240
    @AppStorage(PrefKey.defaultWaterTemp) private var defaultWaterTemp: Double = 92

    @State private var isAddingBean = false
    @State private var brewingBean: Bean?
    @State private var isLoggingBrew = false

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
                                title: "豆仓还是空的",
                                message: "添加第一包豆子，开始记录它从养豆到衰退的整个过程。",
                                actionLabel: "添加豆子",
                                action: { isAddingBean = true }
                            )
                        }
                    } else {
                        if let pick = todaysPick {
                            TodayCard(insight: pick.insight, bean: pick.bean) {
                                brewingBean = pick.bean
                            }
                        }
                        cellar
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .background(Palette.paper)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // 记一杯是每天都会做的事，和「加一包豆」同级，所以放在工具栏最左边、
                // 带文字。冲完直接进来记，参数默认沿用上一杯——这条路的长度决定了
                // 用户会不会一直记下去。
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
                    HStack(spacing: 18) {
                        // 问一问排在最前：它此前只有两条路能到——「更多 → 问一问」，
                        // 或者进某包豆的详情页。前者要翻两层，后者得先有想聊的那包豆，
                        // 于是「主界面上怎么开始问」在界面上是无解的。
                        NavigationLink {
                            AskView()
                        } label: {
                            Image(systemName: "questionmark.bubble")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Palette.roast)
                        }
                        .accessibilityLabel("问一问")

                        // 洞察放在添加豆旁边：问「最近适合喝哪包」「今天做手冲
                        // 还是意式」是和「加一包豆」同级别的日常动作，不该藏在
                        // 更多页的折叠线下面。
                        NavigationLink {
                            InsightsView()
                        } label: {
                            Image(systemName: "sparkles")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Palette.roast)
                        }
                        .accessibilityLabel("洞察")

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

    // MARK: - Cellar

    private var cellar: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "豆仓",
                          detail: .alreadyLocalized(L("%@ 包", String(beans.count))))

            if !activeInsights.isEmpty {
                tallyRow
            }

            ForEach(activeInsights) { insight in
                if let bean = beans.first(where: { $0.id == insight.id }) {
                    NavigationLink {
                        BeanDetailView(bean: bean)
                    } label: {
                        BeanCard(insight: insight)
                    }
                    .buttonStyle(CardButtonStyle())
                }
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
