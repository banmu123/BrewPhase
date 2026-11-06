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
    /// 哨兵离开渲染窗口：重新武装自动加载，用户再次滑到底时才能再取一批。
    var onFooterLeft: () -> Void
    var onOpen: (Record) -> Void
    var onDelete: (Record) -> Void
    var onWidthChange: (CGFloat) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Metric.Space.sm) {
            column(.left)
            column(.right)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            onWidthChange(width)
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
            footer
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
    private func insertionTransition(for id: UUID) -> AnyTransition {
        guard id == droppedRecordID, !reduceMotion else { return .identity }
        return .asymmetric(
            insertion: .modifier(
                active: DropFromAbove(offset: -150, opacity: 0),
                identity: DropFromAbove(offset: 0, opacity: 1)
            ),
            removal: .identity
        )
    }

    // MARK: - 触底与加载

    /// 列尾的加载哨兵。加载失败给轻量重试；没有更多数据时安静收场，
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
            Color.clear
                .frame(height: 1)
                .onAppear { onNearBottom() }
                .onDisappear { onFooterLeft() }
                .accessibilityHidden(true)
        }
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
