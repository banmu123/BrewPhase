import SwiftUI

/// Records 内容区的两列 Masonry 布局。
///
/// 一个共享的纵向 `ScrollView`（由 `RecordsView` 提供）里放一个
/// `HStack(alignment: .top)`，左右两列各是一个 `LazyVStack`——列的归属
/// **只**来自 `MasonryColumnPlanner`，视图自己不维护第二套分派事实。
///
/// 高度链路：Planner 用估算值分派 → 卡片自然渲染 → `onGeometryChange`
/// 把实测高度回传给 `planner.updateHeight`（阈值过滤 + 不换列），布局从此
/// 稳定。卡片高度由内容决定，不由 Planner 决定——这是不形成测量循环的
/// 关键：分派只认列，不画框。
///
/// 新记录的下落只属于 `droppedRecordID` 这一条：它拿到从上方进入的
/// transition 与抬升的 zIndex，其余卡片（分页追加、重绘）保持原样。
struct RecordsMasonryView: View {

    @Binding var planner: MasonryColumnPlanner
    let dataSource: RecordsDataSource
    /// 刚刚保存、正在下落的记录；nil 表示没有进行中的插入动画。
    var droppedRecordID: UUID?
    var reduceMotion = false
    var onMeasure: (UUID, CGFloat) -> Void
    /// 触底或人工重试：请求下一批。
    var onNearBottom: () -> Void
    var onOpen: (Record) -> Void
    var onDelete: (Record) -> Void
    var onWidthChange: (CGFloat) -> Void

    /// 页脚哨兵挂在哪一列。**按取数代数冻结**，不在每次 body 里重算：
    /// 实测高度回传会让两列累计高度频繁互相反超，哨兵一旦跟着换列就成了
    /// 新视图，`onAppear` 会在用户没动的时候再取一批。换批时重选一次即可。
    @State private var footerColumn: MasonryColumn = .left

    var body: some View {
        HStack(alignment: .top, spacing: Metric.Space.sm) {
            column(.left)
            column(.right)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            onWidthChange(width)
        }
        // 每来一批重新挑一次「更高的一列」。批内不动，避免测量回传把
        // 哨兵在两列之间来回搬。
        .onChange(of: dataSource.pageGeneration, initial: true) { _, _ in
            footerColumn = planner.totalHeight(of: .left) >= planner.totalHeight(of: .right)
                ? .left : .right
        }
    }

    // MARK: - 一列

    private func column(_ side: MasonryColumn) -> some View {
        LazyVStack(spacing: Metric.Space.sm) {
            ForEach(planner.items(in: side), id: \.id) { item in
                card(for: item)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        onMeasure(item.id, height)
                    }
                    .transition(insertionTransition(for: item.id))
                    // 下落中的那张卡要在同列其他卡之上，不然会被挤在中间。
                    .zIndex(item.id == droppedRecordID ? 1 : 0)
            }
            // 分页哨兵只挂在**更高**的那一列末尾：它的底边就是整块内容的
            // 底边，短列提前触发的路径从结构上消失。
            if side == footerColumn {
                footer
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
    }

    @ViewBuilder
    private func card(for item: MasonryLayoutItem) -> some View {
        if let record = dataSource.record(with: item.id) {
            Button {
                onOpen(record)
            } label: {
                MasonryRecordCard(record: record)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button(role: .destructive) {
                    onDelete(record)
                } label: {
                    Label("删除这条记录", systemImage: "trash")
                }
            }
        }
    }

    // MARK: - 下落

    /// 只有「刚落下的那一条」拿下落 transition；其余一律 identity——
    /// 分页追加、重绘、从详情页返回都不会重播。
    ///
    /// Reduce Motion 不是「没有动画」而是「没有位移」：换成纯透明度过渡，
    /// 让新卡片仍然能被察觉，但绝不弹跳。
    private func insertionTransition(for id: UUID) -> AnyTransition {
        guard id == droppedRecordID else { return .identity }
        let motion = InsertionMotion.make(reduceMotion: reduceMotion)
        if motion.isOpacityOnly {
            return .asymmetric(insertion: .opacity, removal: .identity)
        }
        return .asymmetric(
            insertion: .modifier(
                active: DropFromAbove(offset: motion.offset, opacity: 0),
                identity: DropFromAbove(offset: 0, opacity: 1)
            ),
            removal: .identity
        )
    }

    // MARK: - 触底与加载

    /// 内容底部唯一的加载哨兵。加载失败给轻量重试；没有更多数据时安静收场，
    /// 不立一块「到底了」的牌子。
    @ViewBuilder
    private var footer: some View {
        if dataSource.lastLoadFailed {
            Button {
                onNearBottom()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .semibold))
                    Text("重新加载")
                }
                .font(TypeScale.callout)
                .foregroundStyle(Palette.roast)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else if dataSource.canLoadMore {
            // 代数换一次，哨兵换一个：同一批里它只会请求一次；这一批装完
            // 页脚还在视野内（内容不足一屏）时，新哨兵会继续把屏幕填满。
            PaginationSentinel(action: onNearBottom)
                .id(dataSource.pageGeneration)
        }
    }
}

/// 分页哨兵：一个取数代数只有一个哨兵，哨兵自己最多请求一次。
///
/// 它必须留在 `LazyVStack` 里——放在普通容器中会在首帧就被创建，
/// `onAppear` 会把整库一口气拉完。
private struct PaginationSentinel: View {

    let action: () -> Void

    @State private var fired = false

    var body: some View {
        Color.clear
            .frame(height: 1)
            .onAppear {
                guard !fired else { return }
                fired = true
                action()
            }
            // 离开渲染窗口再回来 = 用户又滑到底了：允许为同一代数再试一次
            // （上一批若因游标错位没取到新记录，这是唯一的自动恢复口）。
            .onDisappear { fired = false }
            .accessibilityHidden(true)
    }
}

/// 插入动画的几何契约：默认从上方 150pt 落下；Reduce Motion 下位移必须
/// 为 0，只保留一次淡入。
///
/// 单独成一个值类型，是为了让「无障碍模式下没有位移」变成可以离屏断言的
/// 事实（`InsertionMotionTests`），而不是埋在 `AnyTransition` 里没法检查。
struct InsertionMotion: Equatable {

    /// 起始位移（负值 = 从上方进入）。
    let offset: CGFloat
    /// 是否只做透明度过渡。
    let isOpacityOnly: Bool

    /// 默认：Memory Drop，一次下落、一点回弹。
    static let drop = InsertionMotion(offset: -150, isOpacityOnly: false)
    /// Reduce Motion：不位移、不回弹，只淡入。
    static let fade = InsertionMotion(offset: 0, isOpacityOnly: true)

    static func make(reduceMotion: Bool) -> InsertionMotion {
        reduceMotion ? .fade : .drop
    }
}

/// 新卡片下落的那一段位移与透明度。终点即卡片自己的最终位置，
/// 所以「抬起 150pt → 落回原位」就是全部动作，不缩放、不旋转。
private struct DropFromAbove: ViewModifier {
    let offset: CGFloat
    let opacity: Double

    func body(content: Content) -> some View {
        content
            .offset(y: offset)
            .opacity(opacity)
    }
}
