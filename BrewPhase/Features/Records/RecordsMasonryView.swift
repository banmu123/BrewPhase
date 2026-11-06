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
struct RecordsMasonryView: View {

    @Binding var planner: MasonryColumnPlanner
    let dataSource: RecordsDataSource
    var onMeasure: (UUID, CGFloat) -> Void
    var onNearBottom: () -> Void
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
                .accessibilityHidden(true)
        }
    }
}
