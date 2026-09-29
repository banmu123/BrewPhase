import SwiftUI
import SwiftData

@main
struct BrewPhaseApp: App {

    /// One container for the whole app. Local-only: the default configuration
    /// writes to the app's own sandbox and nothing else (§20).
    private let container: ModelContainer

    @StateObject private var language = LanguageManager.shared

    /// Held here rather than inside `RootView` so that rebuilding the view tree
    /// for a language change does not reset which tab the user is on.
    @State private var selection: AppTab = DebugLaunch.tab ?? .cellar

    init() {
        // Touch the singleton before the first frame so the language is already
        // resolved when `body` runs.
        _ = LanguageManager.shared

        let schema = Schema([
            Bean.self,
            Brew.self,
            Tasting.self,
            PhaseReminder.self,
            PhaseRule.self,
        ])

        do {
            container = try ModelContainer(
                for: schema,
                configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)]
            )
            AppLog.lifecycle.info("store opened")
        } catch {
            // A store that cannot be opened must not take the app down with it.
            // Falling back to memory keeps the UI usable and lets the user export
            // whatever is still reachable, rather than facing a crash on launch.
            AppLog.lifecycle.error("store failed to open: \(error.localizedDescription, privacy: .public)")
            container = try! ModelContainer(
                for: schema,
                configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
            )
        }

        bootstrap()
    }

    /// First-launch work, done before any view reads the store.
    ///
    /// Both steps are idempotent, so running them on every launch is safe and
    /// means there is no "did we migrate yet" flag to get out of step.
    private func bootstrap() {
        let context = container.mainContext
        PhaseRuleBook.seedIfNeeded(context: context)
        DemoData.installIfRequested(context: context)
    }

    var body: some Scene {
        WindowGroup {
            RootView(selection: $selection)
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
        .modelContainer(container)
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
            }
        }
    }

    // MARK: - UI inspection (inert unless launched with -BrewPhaseScreen)

    /// The highest-priority bag, which is the one worth looking at on the detail
    /// page and in the editors.
    private var spotlightBean: Bean? {
        guard let insight = InsightFactory.todaysPick(beans, book: PhaseRuleBook.make(stored: rules)),
              let bean = beans.first(where: { $0.id == insight.id })
        else { return beans.first }
        return bean
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
        }
    }

    private var debugEmpty: some View {
        Text("没有豆子可以展示")
            .font(TypeScale.body)
            .foregroundStyle(Palette.inkSoft)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.paper)
    }
}
