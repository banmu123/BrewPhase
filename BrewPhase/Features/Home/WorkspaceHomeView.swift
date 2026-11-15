import SwiftData
import SwiftUI

/// 首页：三个平等的空间，各自一列卡片堆叠。
///
/// 这一页不回答「今天该喝哪包豆」，它回答「我有三个地方，先看哪一个」。
/// 所以三列同宽、同高、同一种卡片、同一个上限——咖啡不靠尺寸和颜色抢位置，
/// 它只靠内容。首页也不写任何业务数据：卡片是投影，点开回到原件。
struct WorkspaceHomeView: View {

    /// 进入某个空间。导航状态住在 App 层，首页不自己持有路由。
    let onOpenSpace: (AppTab) -> Void

    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query(sort: \Record.createdAt, order: .reverse) private var records: [Record]
    @Query(sort: \Canvas.updatedAt, order: .reverse) private var canvases: [Canvas]

    @State private var destination: HomeDestination?

    /// 三列之间的缝。比页面留白窄，让三列读成一排而不是三块。
    private let columnGap: CGFloat = 10
    /// 内容上限：iPad 上卡片不该被拉成一整屏宽。
    private let contentMaxWidth: CGFloat = 760

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    // 页头之下直接是三个空间：规格的结构示意就是「标题 → 三列」，
                    // 中间不再插一段空档。三列之后是页面自己的留白。
                    columns.padding(.top, Metric.Space.xxl)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, Metric.sectionGap)
                .frame(maxWidth: contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.paper)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $destination) { target in
                destinationView(for: target)
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

    // MARK: - 三列

    private var columns: some View {
        HStack(alignment: .top, spacing: columnGap) {
            ForEach(AppTab.allCases) { space in
                WorkspaceCardStackView(
                    space: space,
                    cards: cards(for: space),
                    canvases: canvasByID,
                    accent: space.accent,
                    onOpenSpace: { onOpenSpace(space) },
                    onOpenCard: open
                )
                .frame(maxWidth: .infinity)
            }
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

    private var canvasByID: [UUID: Canvas] {
        Dictionary(canvases.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: - 打开内容

    private func open(_ card: WorkspaceCard) {
        switch card.target {
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

    /// 首页三列的辅助色。低饱和、等亮度：它们是识别用的，不构成等级。
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
