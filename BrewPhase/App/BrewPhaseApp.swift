import SwiftUI
import SwiftData

@main
struct BrewPhaseApp: App {

    /// One container for the whole app. Local-only: the default configuration
    /// writes to the app's own sandbox and nothing else (§20).
    ///
    /// There is deliberately no third state here. The app used to fall back to
    /// an in-memory store when the real one could not be opened — the worst of
    /// the available answers: the user would keep logging coffee into a session
    /// that evaporates when the app closes, and nothing on screen said so.
    /// Unopenable now means unopenable: the recovery screen, no writes, no
    /// pretending.
    @State private var store: PersistenceState

    /// The schema is shared between the first open and every retry, so the two
    /// can never drift apart.
    private static let schema = Schema([
        Bean.self,
        Brew.self,
        Tasting.self,
        PhaseReminder.self,
        PhaseRule.self,
        // 本地问答用的向量索引。它是**派生数据**：全部内容都能从上面几张表重算，
        // 所以清掉它不丢信息，只是下次提问要多花一次建索引的时间。加进 schema
        // 意味着新增一张表，SwiftData 对这种「只加实体」的变更是轻量迁移，
        // 老数据不需要转换。
        EmbeddingRecord.self,
    ])

    @StateObject private var language = LanguageManager.shared

    /// Held here rather than inside `RootView` so that rebuilding the view tree
    /// for a language change does not reset which tab the user is on.
    @State private var selection: AppTab = DebugLaunch.tab ?? .cellar

    init() {
        // Touch the singleton before the first frame so the language is already
        // resolved when `body` runs.
        _ = LanguageManager.shared

        // UI inspection only: `-BrewPhaseScreen persistenceRecovery` starts the
        // app as if the container had failed to open. A broken store cannot be
        // staged on a working simulator any other way.
        if DebugLaunch.recoveryDemo {
            AppLog.lifecycle.error("store forced into recovery state by launch argument")
            _store = State(initialValue: .failed)
        } else if let container = Self.openStore() {
            _store = State(initialValue: .ready(container))
            Self.bootstrap(on: container)
        } else {
            _store = State(initialValue: .failed)
        }
    }

    // MARK: - Opening the store

    /// Opens the on-disk store, or returns nil and logs why.
    ///
    /// Nothing here touches the database files: a store that fails to open must
    /// never be "repaired" by deleting it, because that is exactly the data the
    /// user cares about.
    private static func openStore() -> ModelContainer? {
        do {
            let container = try ModelContainer(
                for: schema,
                configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)]
            )
            AppLog.lifecycle.info("store opened")
            return container
        } catch {
            // The raw error stays in the log; the recovery screen says only what
            // a normal user can act on.
            AppLog.lifecycle.error("store failed to open: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// First-launch work, done before any view reads the store.
    ///
    /// Both steps are idempotent, so running them on every launch is safe and
    /// means there is no "did we migrate yet" flag to get out of step.
    private static func bootstrap(on container: ModelContainer) {
        let context = container.mainContext
        PhaseRuleBook.seedIfNeeded(context: context)
        DemoData.installIfRequested(context: context)
    }

    /// The recovery screen's one action: build the persistent container again.
    private func retry() {
        guard let container = Self.openStore() else { return }
        Self.bootstrap(on: container)
        store = .ready(container)
    }

    var body: some Scene {
        WindowGroup {
            Group {
                switch store {
                case .ready(let container):
                    RootView(selection: $selection)
                        .modelContainer(container)
                case .failed:
                    PersistenceRecoveryView(onRetry: retry)
                }
            }
            // Channel one of two: `Text("…")` finds its translation through
            // the environment's locale. Channel two is `L()`, for every string
            // the app builds rather than renders as a literal.
            .environment(\.locale, language.current.locale)
            // Already-rendered navigation titles and section headers do not
            // re-read the locale on their own, so the tree is rebuilt. The tab
            // selection lives above this line and therefore survives it —
            // otherwise picking a language would bounce the user back to the
            // first tab.
            .id(language.current)
        }
    }
}

/// The three tabs (§26): what to drink, what I have drunk, and everything else.
enum AppTab: Hashable {
    case cellar
    case brews
    case more
}

struct RootView: View {

    @Binding var selection: AppTab

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query private var rules: [PhaseRule]

    /// Only ever set when the app was launched for UI inspection. See `DebugLaunch`.
    @State private var debugScreen: DebugScreen?

    var body: some View {
        TabView(selection: $selection) {
            HomeView()
                .tabItem { Label("豆仓", systemImage: "square.stack.3d.up") }
                .tag(AppTab.cellar)

            BrewHistoryView()
                .tabItem { Label("冲煮", systemImage: "cup.and.saucer") }
                .tag(AppTab.brews)

            MoreView()
                .tabItem { Label("更多", systemImage: "ellipsis.circle") }
                .tag(AppTab.more)
        }
        .tint(Palette.roast)
        .sheet(item: $debugScreen) { screen in
            debugContent(for: screen)
        }
        .task {
            // Reminders are planned once per launch, from the same rules the rest
            // of the app is reading — so a bag whose window moved because its rule
            // was edited gets re-scheduled without any extra bookkeeping.
            let book = PhaseRuleBook.make(stored: rules)
            await NotificationManager.shared.refreshAll(beans: beans, book: book, context: context)

            // UI inspection only: let the first frame settle before presenting.
            if let requested = DebugLaunch.screen {
                try? await Task.sleep(for: .milliseconds(700))
                debugScreen = requested
                // 有些菜单动作（标记喝完 / 恢复在喝）模拟器点不到，只能替用户
                // 走一步——截图要的就是动作发生之后的样子。
                if let action = DebugLaunch.beanAction {
                    try? await Task.sleep(for: .milliseconds(400))
                    performDebugBeanAction(action)
                }
            }
        }
    }

    // MARK: - UI inspection (inert unless launched with -BrewPhaseScreen)

    /// The highest-priority bag, which is the one worth looking at on the detail
    /// page and in the editors. `-BrewPhaseBean <name>` overrides the choice so a
    /// specific bag (no brews, already finished, no roast date) can be inspected.
    private var spotlightBean: Bean? {
        if let name = DebugLaunch.beanName,
           let named = beans.first(where: { $0.name == name }) {
            return named
        }
        guard let insight = InsightFactory.todaysPick(beans, book: PhaseRuleBook.make(stored: rules)),
              let bean = beans.first(where: { $0.id == insight.id })
        else { return beans.first }
        return bean
    }

    /// `-BrewPhaseBeanAction finish|restore` — 替用户按一次菜单。
    private func performDebugBeanAction(_ action: String) {
        guard let bean = spotlightBean else { return }
        switch action {
        case "finish": bean.markFinished()
        case "restore": bean.restoreToActive()
        default: return
        }
        do {
            try context.save()
        } catch {
            AppLog.store.error("debug bean action failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }

    @ViewBuilder
    private func debugContent(for screen: DebugScreen) -> some View {
        switch screen {
        case .beanDetail:
            if let bean = spotlightBean {
                NavigationStack { BeanDetailView(bean: bean) }
            } else {
                debugEmpty
            }
        case .beanEditor:
            BeanEditorView(mode: .create)
        case .brewEditor:
            if let bean = spotlightBean {
                BrewEditorView(bean: bean)
            } else {
                debugEmpty
            }
        case .tasting:
            if let bean = spotlightBean {
                TastingEditorView(bean: bean)
            } else {
                debugEmpty
            }
        case .tastingTimeline:
            if let bean = spotlightBean {
                NavigationStack {
                    ScrollView {
                        TastingTimelineView(
                            tastings: bean.tastingsOldestFirst,
                            bean: bean.snapshot,
                            rule: PhaseRuleBook.make(stored: rules).rule(for: bean.roastLevel),
                            onAdd: {},
                            onDelete: { _ in }
                        )
                        .padding(.horizontal, Metric.gutter)
                        .padding(.top, 14)
                    }
                    .background(Palette.paper)
                    .navigationTitle("风味变化")
                    .navigationBarTitleDisplayMode(.inline)
                }
            } else {
                debugEmpty
            }
        case .rules:
            NavigationStack { PhaseRulesView() }
        case .export:
            NavigationStack { ExportView() }
        case .language:
            NavigationStack {
                ScrollView {
                    LanguageSection(language: LanguageManager.shared)
                        .padding(.horizontal, Metric.gutter)
                        .padding(.top, 14)
                }
                .background(Palette.paper)
                .navigationTitle("语言")
                .navigationBarTitleDisplayMode(.inline)
            }
        case .ask:
            // 带上当前最该关注的那包豆子，这样截图时能同时看到「正在问某包豆」
            // 这条路径——不聚焦豆子的版本是同一个视图的另一半分支。
            NavigationStack { AskView(focusBean: spotlightBean) }
        case .insights:
            NavigationStack { InsightsView() }
        case .persistenceRecovery:
            // 到不了这里：这个状态在 App 层就被拦下，整个视图树都不会构建。
            // 留着这个分支只是让 switch 保持穷尽，好让新屏幕不会漏掉。
            debugEmpty
        case .stockAdjust:
            if let bean = spotlightBean {
                StockAdjustView(bean: bean,
                                initialValue: DebugLaunch.stockOvershoot ? bean.weightG + 20 : nil)
            } else {
                debugEmpty
            }
        case .askAdvanced:
            NavigationStack { AskAdvancedSettingsView() }
        case .flavorPrediction:
            if let bean = spotlightBean {
                NavigationStack {
                    ScrollView {
                        FlavorWindowCard(bean: bean,
                                         defaults: BrewDefaults.current(),
                                         todayDay: bean.currentDayAfterRoast)
                            .padding(.horizontal, Metric.gutter)
                            .padding(.top, 10)
                    }
                    .background(Palette.paper)
                    .navigationTitle("预计风味窗口")
                    .navigationBarTitleDisplayMode(.inline)
                }
            } else {
                debugEmpty
            }
        case .quickLog:
            // 从最近冲过的那包进来，和首页「记一杯」走的是同一条路。
            QuickBrewLogView(bean: beans.first { $0.id == recentBrewBeanID } ?? spotlightBean)
        case .brewDiagnosis:
            if let bean = spotlightBean,
               let diagnosis = BrewDiagnosisService.diagnose(
                   bean: bean, allBrews: brews, languageCode: LanguageManager.shared.current.resolvedCode
               ) {
                NavigationStack {
                    ScrollView {
                        BrewDiagnosticCard(diagnosis: diagnosis)
                            .padding(.horizontal, Metric.gutter)
                            .padding(.top, 10)
                    }
                    .background(Palette.paper)
                    .navigationTitle("这杯怎么样")
                    .navigationBarTitleDisplayMode(.inline)
                }
            } else {
                debugEmpty
            }
        }
    }

    /// 最近被冲过的那包豆——「记一杯」默认预填它的上一次参数。
    private var recentBrewBeanID: UUID? {
        let newest = brews.max { $0.date < $1.date }
        return newest?.bean?.id
    }

    private var debugEmpty: some View {
        Text("没有豆子可以展示")
            .font(TypeScale.body)
            .foregroundStyle(Palette.inkSoft)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.paper)
    }
}
