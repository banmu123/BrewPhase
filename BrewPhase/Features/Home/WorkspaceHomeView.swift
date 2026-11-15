import SwiftData
import SwiftUI

/// 首页：三个平等的空间，纵向排开，每个空间一行卡片。
///
/// 这一页不回答「今天该喝哪包豆」，它回答「我有三个地方，先看哪一个」。
/// 三个分区同宽、同高、同一种卡片、同一个上限——咖啡不靠尺寸和颜色抢位置，
/// 它只靠内容。首页也不写任何业务数据：卡片是投影，点开回到原件。
///
/// 点分区 = 进这个空间的**列表**，不直接开某一条；要直接开某一条，用顶部搜索。
struct WorkspaceHomeView: View {

    /// 进入某个空间。导航状态住在 App 层，首页不自己持有路由。
    let onOpenSpace: (AppTab) -> Void

    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query(sort: \Record.createdAt, order: .reverse) private var records: [Record]
    @Query(sort: \Canvas.updatedAt, order: .reverse) private var canvases: [Canvas]

    @State private var destination: HomeDestination?

    /// 输入框里的字。
    @State private var searchText = DebugLaunch.searchQuery ?? ""
    /// 真正用于匹配的字：停手 200ms 才更新，打字过程不重算。
    @State private var query = ""

    /// 内容上限：iPad 上卡片不该被拉成一整屏宽。
    private let contentMaxWidth: CGFloat = 760

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header

                    // 桌面端是三个空间共同的外围入口，放在首页顶端，而不是
                    // 长在咖啡那一栏下面。
                    DesktopSyncEntryRow(sync: .shared)
                        .padding(.top, Metric.Space.sm)

                    searchField.padding(.top, Metric.Space.sm)

                    content.padding(.top, Metric.Space.xl)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, Metric.sectionGap)
                .frame(maxWidth: contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.paper)
            .scrollDismissesKeyboard(.interactively)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $destination) { target in
                destinationView(for: target)
            }
            .task(id: searchText) {
                let typed = searchText
                if typed.trimmed.isEmpty {
                    query = ""
                    return
                }
                // 防抖：停手 200ms 才真的过滤，边打边算会把长列表拖顿。
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                query = typed
            }
        }
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: "BREWPHASE / STUDIO")
                .font(TypeScale.brandMark)
                .italic()
                .tracking(2.4)
                .foregroundStyle(Palette.inkFaint)

            Text(verbatim: greeting.line)
                .font(TypeScale.greeting)
                .foregroundStyle(Palette.ink)

            Text(verbatim: dateLine)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .padding(.top, 10)
    }

    private var greeting: WorkspaceGreeting {
        let hour = DateMath.calendar.component(.hour, from: Date())
        return WorkspaceGreeting.at(hour: hour)
    }

    private var dateLine: String {
        let now = Date()
        return "\(Fmt.short(now)) · \(Fmt.weekday(now))"
    }

    // MARK: - 搜索

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.inkFaint)

            TextField("搜索咖啡、记录、画布", text: $searchText)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
                .submitLabel(.search)
                .autocorrectionDisabled()

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.inkFaint)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: L("清除搜索")))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Capsule(style: .continuous).fill(Palette.card))
        .overlay(Capsule(style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.8))
    }

    // MARK: - 内容：三个分区，或搜索结果

    @ViewBuilder
    private var content: some View {
        if query.trimmed.isEmpty {
            sections
        } else {
            searchResults
        }
    }

    private var sections: some View {
        VStack(spacing: 20) {
            ForEach(AppTab.allCases) { space in
                WorkspaceCardStackView(
                    space: space,
                    cards: cards(for: space),
                    canvases: canvasByID,
                    accent: space.accent,
                    onOpenSpace: { onOpenSpace(space) }
                )
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        let hits = WorkspaceHomeFeed.matches(query, in: searchItems)

        if hits.isEmpty {
            EmptyStateView(
                symbol: "magnifyingglass",
                title: "没有找到",
                message: "换个词试试，或者清空搜索回到三个空间。",
                actionLabel: "清除搜索",
                action: { searchText = "" }
            )
        } else {
            VStack(spacing: 0) {
                ForEach(hits) { hit in
                    Button {
                        open(hit.target)
                    } label: {
                        searchRow(hit)
                    }
                    .buttonStyle(.plain)

                    if hit.id != hits.last?.id {
                        CardDivider()
                    }
                }
            }
        }
    }

    private func searchRow(_ hit: WorkspaceSearchItem) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(hit.space.accent.opacity(0.12))
                .frame(width: 34, height: 34)
                .overlay(
                    Image(systemName: glyph(for: hit.space))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(hit.space.accent)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: hit.title)
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)

                Text(verbatim: hit.subtitle)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func glyph(for space: AppTab) -> String {
        switch space {
        case .coffee: return "cup.and.saucer"
        case .records: return "rectangle.stack"
        case .canvas: return "square.grid.2x2"
        }
    }

    // MARK: - 数据投影

    private func cards(for space: AppTab) -> [WorkspaceCard] {
        let picked = WorkspaceHomeFeed.cards(from: candidates(for: space))
        // 没有内容时不拿假数据填：给一张同尺寸的空态卡。
        return picked.isEmpty ? [.empty(for: space)] : picked
    }

    private func candidates(for space: AppTab) -> [WorkspaceCard] {
        switch space {
        case .coffee:
            return beans.prefix(candidatePool).map(WorkspaceCard.init(bean:))
                + brews.prefix(candidatePool).map(WorkspaceCard.init(brew:))
                + tastings.prefix(candidatePool).map(WorkspaceCard.init(tasting:))
        case .records:
            return records.prefix(candidatePool).map(WorkspaceCard.init(record:))
        case .canvas:
            return canvases.prefix(candidatePool).map(WorkspaceCard.init(canvas:))
        }
    }

    /// 候选池上限：只读够排序用的最近一段，不为看不见的卡片建对象。
    private var candidatePool: Int { 24 }

    /// 搜索的候选池比首页卡片宽得多：搜索就是要能翻到旧东西。
    private var searchItems: [WorkspaceSearchItem] {
        beans.prefix(searchPool).map(WorkspaceSearchItem.init(bean:))
            + brews.prefix(searchPool).map(WorkspaceSearchItem.init(brew:))
            + tastings.prefix(searchPool).map(WorkspaceSearchItem.init(tasting:))
            + records.prefix(searchPool).map(WorkspaceSearchItem.init(record:))
            + canvases.prefix(searchPool).map(WorkspaceSearchItem.init(canvas:))
    }

    private var searchPool: Int { 200 }

    private var canvasByID: [UUID: Canvas] {
        Dictionary(canvases.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: - 打开内容

    /// 搜索结果点开的是**这一条**：用户已经说出他要找什么，不必再从列表里翻。
    private func open(_ target: WorkspaceCard.Target) {
        switch target {
        case .bean(let id): destination = .bean(id)
        case .record(let id): destination = .record(id)
        case .canvas(let id): destination = .canvas(id)
        case .none: break
        }
    }

    @ViewBuilder
    private func destinationView(for target: HomeDestination) -> some View {
        switch target {
        case .bean(let id):
            if let bean = beans.first(where: { $0.id == id }) {
                BeanDetailView(bean: bean)
            } else {
                missing
            }
        case .record(let id):
            if let record = records.first(where: { $0.id == id }) {
                RecordDetailView(record: record)
            } else {
                missing
            }
        case .canvas(let id):
            if let canvas = canvases.first(where: { $0.id == id }) {
                CanvasWorkspaceView(canvas: canvas)
            } else {
                missing
            }
        }
    }

    /// 卡片在、原件不在：只可能发生在别的窗口删掉了它。不猜、不重建。
    private var missing: some View {
        Text("这条内容已经不在了")
            .font(TypeScale.body)
            .foregroundStyle(Palette.inkSoft)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.paper)
    }
}

/// 首页能推开的三种详情。用 UUID 而不是模型对象：路由要能比较、要能跨视图
/// 传递，`@Model` 引用不该进入导航状态。
enum HomeDestination: Hashable {
    case bean(UUID)
    case record(UUID)
    case canvas(UUID)
}

extension AppTab {

    /// 首页三个分区的辅助色。低饱和、等亮度：它们是识别用的，不构成等级。
    var accent: Color {
        switch self {
        case .coffee: return Palette.roast
        case .records: return Palette.sage
        case .canvas: return Palette.lilac
        }
    }

    /// 空间空着时那张卡上的一句话。
    var emptyTitle: String {
        switch self {
        case .coffee: return L("还没有咖啡")
        case .records: return L("还没有记录")
        case .canvas: return L("还没有画布")
        }
    }
}
