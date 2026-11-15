import SwiftUI

/// 空空间的「架子」：一层空搁板，不再放卡片。
///
/// 旧版空态是一张和真卡片同尺寸、写着「空着」的卡，孤零零居中立在一整行
/// 空白里，看起来像一条还没加载出来的内容。现在**只画架子本身**：一层很薄
/// 的横板、板下的一道浅影，以及板上方一行极淡的小字；板上方完全留空。
///
/// 高度不是拍脑袋定的：内部复用 `WorkspaceStackLayout` 的卡位与宽高比撑出
/// **与卡片行完全相同**的高度，所以三个分区的位置、ScrollView 内容尺寸、
/// 外层 Button 的点击区域都不变——变的只是「这一栏里没有卡片」。
///
/// 架子保持中性色，不染空间辅助色：空态要退到背景里，而不是和真内容抢注意力。
struct WorkspaceEmptyShelfView: View {

    let space: AppTab

    var body: some View {
        // 三个透明卡位只为撑高，横板由 overlay 横贯整行画出来。
        // 与卡片行用同一组 (visibleLimit, cardOverlap, cardAspect)，
        // 因此不必读 GeometryReader、也不会有首帧宽度为 0 的塌陷。
        HStack(spacing: -WorkspaceStackLayout.cardOverlap) {
            ForEach(0..<WorkspaceStackLayout.visibleLimit, id: \.self) { _ in
                Rectangle()
                    .fill(Color.clear)
                    .frame(maxWidth: .infinity)
                    .aspectRatio(WorkspaceStackLayout.cardAspect, contentMode: .fit)
            }
        }
        .overlay(alignment: .bottom) { shelf }
    }

    // MARK: - 搁板

    private var shelf: some View {
        VStack(spacing: 0) {
            // 板上方的空：什么都不放，这是「空架子」的主体。
            Spacer(minLength: 0)

            Text(verbatim: space.emptyTitle)
                .font(.system(size: Shelf.captionSize, weight: .regular))
                .tracking(0.6)
                .foregroundStyle(Palette.inkFaint)
                .lineLimit(1)
                .padding(.bottom, Shelf.captionGap)

            board
            shadow
        }
        .padding(.horizontal, Shelf.sideInset)
        .background(alignment: .bottom) {
            // 板上方一小段极淡的进深：让板看起来是「一层」，
            // 而不是随便一条分隔线。只有底部 64pt，不铺成一整块色卡。
            LinearGradient(
                colors: [Color.clear, Palette.well.opacity(0.5)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: Shelf.depthFadeHeight)
        }
    }

    /// 板面：上亮下暗的极浅渐变，加一道顶部高光，像薄薄一层搁板。
    private var board: some View {
        RoundedRectangle(cornerRadius: Shelf.boardRadius, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [Palette.well, Palette.wellDeep],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .frame(height: Shelf.boardHeight)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Palette.card.opacity(0.85))
                    .frame(height: 0.7)
            }
    }

    /// 板下的一道浅影：给板一点厚度，不投影到下一个分区。
    private var shadow: some View {
        Rectangle()
            .fill(Palette.hairline.opacity(0.6))
            .frame(height: Shelf.shadowHeight)
            .padding(.top, Shelf.shadowGap)
    }

    // MARK: - 构图值

    /// 空架的视觉常量集中在这里，方便整体调轻/调重，不散落在 View 里。
    private enum Shelf {
        /// 搁板厚度：只是一条薄板，不是卡片。
        static let boardHeight: CGFloat = 5
        static let boardRadius: CGFloat = 2.5
        /// 板下投影的间距与粗细。
        static let shadowGap: CGFloat = 2
        static let shadowHeight: CGFloat = 1
        /// 小字离板的距离：字贴着板，不浮在半空。
        static let captionGap: CGFloat = 12
        static let captionSize: CGFloat = 11
        /// 板左右各收一点，不顶到页面边缘。
        static let sideInset: CGFloat = 2
        /// 板上方进深渐变的高度。
        static let depthFadeHeight: CGFloat = 64
    }
}
