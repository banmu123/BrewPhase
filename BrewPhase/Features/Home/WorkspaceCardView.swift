import SwiftUI

/// 首页的一张小卡片：上面是真实内容，下面一条窄窄的白边写它是什么。
///
/// 尺寸由列宽决定（`WorkspaceStackLayout.cardAspect`），所以三列永远一样高。
/// 图片读 `ImageStore` 的 **400px 缩略图**——首页同时最多放九张卡，用展示图
/// 会把解码内存放大九倍，而这里每张只画到一百来点宽。
///
/// 没有图的内容不编一张图：给出与空间色同源的极浅色块，加一个取自标题的
/// 首字。**不用咖啡杯、咖啡豆插图**——首页是三个空间的并列，不是咖啡主题页。
struct WorkspaceCardView: View {

    let card: WorkspaceCard
    /// 画布卡需要模型对象本身才能画节点分布；其余卡片传 nil。
    var canvas: Canvas?
    /// 空间辅助色。只上在小字与色块上，不铺整张卡。
    let accent: Color

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption2) private var overlineSize: CGFloat = 9
    @ScaledMetric(relativeTo: .caption) private var titleSize: CGFloat = 11.5

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: CardRadius.small, style: .continuous)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: CardRadius.small, style: .continuous)
            .fill(Palette.card)
            .aspectRatio(WorkspaceStackLayout.cardAspect, contentMode: .fit)
            .overlay {
                VStack(spacing: 0) {
                    surface
                    caption
                }
            }
            .clipShape(shape)
            .overlay { shape.strokeBorder(Palette.hairline, lineWidth: 0.7) }
            // 卡片自己不是控件：点击由外层决定（打开详情 / 进入空间）。
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: card.title))
            .accessibilityValue(Text(verbatim: card.overline))
    }

    // MARK: - 上半：内容

    @ViewBuilder
    private var surface: some View {
        ZStack {
            if let canvas {
                // 画布的真实节点分布。缩略图组件自带加载与失败回退。
                CanvasThumbnailPreview(canvas: canvas, height: nil, chrome: false)
            } else if let image = ImageStore.shared.image(named: card.imagePath, thumbnail: true) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .overlay(alignment: .topLeading) { badge }
    }

    /// 没有图片时的底面：一层极浅的空间色 + 标题首字。
    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [accent.opacity(0.16), Palette.well],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            if card.kind == .empty {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .light))
                    .foregroundStyle(accent.opacity(0.6))
            } else if let monogram {
                Text(verbatim: monogram)
                    .font(.system(size: 30, weight: .light, design: .serif))
                    .foregroundStyle(accent.opacity(0.35))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
            }
        }
    }

    /// 首字替代封面。画布封面用同样的语言（`CanvasCover`），这里延续它。
    private var monogram: String? {
        let trimmed = card.title.trimmed
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(1))
    }

    @ViewBuilder
    private var badge: some View {
        if !card.badge.isEmpty {
            Text(verbatim: card.badge)
                .font(.system(size: 9, weight: .medium).monospacedDigit())
                .foregroundStyle(Palette.inkSoft)
                .lineLimit(1)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Capsule(style: .continuous).fill(Palette.card.opacity(0.9)))
                .padding(6)
        }
    }

    // MARK: - 下半：说明

    private var caption: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: card.overline)
                .font(.system(size: overlineSize, weight: .medium))
                .tracking(0.4)
                .foregroundStyle(accent)
                .lineLimit(1)

            Text(verbatim: card.title)
                .font(.system(size: min(titleSize, 15), weight: .semibold))
                .foregroundStyle(Palette.ink)
                // 辅助字号下窄列放不下两行：只留一行，卡片不变形。
                .lineLimit(typeSize.isAccessibilitySize ? 1 : 2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .background(Palette.card)
    }

    // MARK: - 构图值

    private enum CardRadius {
        /// 小卡片沿用 `radiusSmall` 这一层，不新造圆角层级。
        static let small = Metric.radiusSmall
    }
}
