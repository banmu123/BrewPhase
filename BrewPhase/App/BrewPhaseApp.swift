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
    /// can never drift apart. 实体清单与迁移约定见 `BrewPhaseSchema`。
    private static let schema = BrewPhaseSchema.schema

    @StateObject private var language = LanguageManager.shared

    /// Held here rather than inside `RootView` so that rebuilding the view tree
    /// for a language change does not reset which tab the user is on.
    @State private var selection: AppTab = DebugLaunch.tab ?? .coffee

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
        // 六个建议标签要在示例记录之前铺好：示例记录会按名字挂到它们上面。
        RecordTag.seedIfNeeded(context: context)
        DemoData.installIfRequested(context: context)
        // 数据落库 → 自动推送（已配对时）。seed 本身也会被它看到，但 2 秒
        // 合并窗口把它们全部收进一轮，且未配对时什么都不做。
        SyncAutoPush.install(container: container)
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

/// 三个一级页面：喝什么、记什么、把什么放在一起。
///
/// 「豆仓」与「冲煮」不再是两个并列的 Tab——冲煮本来就是咖啡这件事的一部分，
/// 现在它作为咖啡页里的一个入口存在。腾出来的位置给了记录与画布，这是这一版
/// 产品形态的变化：从一台咖啡工具，变成一个有咖啡的个人空间。
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case coffee
    case records
    case canvas

    var id: String { rawValue }

    var title: String {
        switch self {
        case .coffee: return L("咖啡")
        case .records: return L("记录")
        case .canvas: return L("画布")
        }
    }

    var symbol: String {
        switch self {
        case .coffee: return "cup.and.saucer.fill"
        case .records: return "rectangle.stack.fill"
        case .canvas: return "square.grid.2x2.fill"
        }
    }
}

struct RootView: View {

    @Binding var selection: AppTab

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query private var rules: [PhaseRule]

    /// Only ever set when the app was launched for UI inspection. See `DebugLaunch`.
    @State private var debugScreen: DebugScreen?
    /// 画布工作区要全屏呈现：sheet 给它的尺寸不是真实窗口尺寸，装窗会算错，
    /// 截出来的图也就不能用来验收「重进画布」。
    @State private var debugCanvas: Canvas?

    var body: some View {
        // 导航条与页面是上下两块，而不是把胶囊浮在内容上面：页面自己滚动到
        // 多长都走不到胶囊底下，也就不需要每个列表各自猜一个底部内边距。
        VStack(spacing: 0) {
            TabView(selection: $selection) {
                CoffeeHomeView()
                    .toolbar(.hidden, for: .tabBar)
                    .tag(AppTab.coffee)

                RecordsView()
                    .toolbar(.hidden, for: .tabBar)
                    .tag(AppTab.records)

                CanvasListView()
                    .toolbar(.hidden, for: .tabBar)
                    .tag(AppTab.canvas)
            }
            .tint(Palette.roast)

            CapsuleTabBar(selection: $selection)
                .padding(.horizontal, 56)
                .padding(.top, 8)
                .padding(.bottom, 4)
        }
        .background(Palette.paper)
        .sheet(item: $debugScreen) { screen in
            debugContent(for: screen)
        }
        .fullScreenCover(item: $debugCanvas) { canvas in
            NavigationStack { CanvasWorkspaceView(canvas: canvas) }
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
                // 验收用：进画布前先把几条记录摆上去（幂等，只有带参数才会执行）。
                if requested == .canvasWorkspace {
                    debugCanvas = CanvasDebugSeed.prepare(context: context)
                } else {
                    debugScreen = requested
                }
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
        case .addSheet:
            AddFlowView()
        case .canvasEditor:
            CanvasEditorView()
        case .canvasWorkspace:
            // 走 `fullScreenCover`：sheet 的尺寸不是真实窗口尺寸。
            debugEmpty
        case .recordEditor:
            RecordEditorView(carrier: DebugLaunch.recordCarrier ?? .link,
                             initialURL: DebugLaunch.linkURL ?? "")
        case .tagManager:
            TagManagerView()
        case .recordDetail:
            if let record = (try? context.fetch(
                FetchDescriptor<Record>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
            ))?.first {
                NavigationStack { RecordDetailView(record: record) }
            } else {
                debugEmpty
            }
        case .playerFullscreen:
            if let record = debugLinkRecord, let embed = record.linkEmbed {
                FullScreenPlayerView(record: record, embed: embed)
            } else {
                debugEmpty
            }
        case .linkDetail:
            if let record = debugLinkRecord {
                NavigationStack {
                    RecordDetailView(record: record, autoPlay: DebugLaunch.autoPlay)
                }
            } else {
                debugEmpty
            }
        case .desktopSync, .desktopSyncPairing, .desktopSyncError,
             .desktopSyncFirstSync, .desktopSyncPaired:
            NavigationStack { DesktopSyncView() }
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

    /// `linkDetail` 要打开的那条链接：可以按平台挑，默认取最新一条。
    private var debugLinkRecord: Record? {
        let links = ((try? context.fetch(
            FetchDescriptor<Record>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        )) ?? []).filter { $0.carrier == .link }
        if let provider = DebugLaunch.linkProvider,
           let picked = links.first(where: { $0.provider == provider }) {
            return picked
        }
        return links.first
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
