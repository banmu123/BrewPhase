import CoreGraphics
import Foundation

/// 画布的视口：世界坐标与屏幕坐标之间唯一的一次换算。
///
/// 节点只认识世界坐标，手势只产生屏幕位移——两者在这里相遇。把换算收成一个
/// 纯值类型，拖动、捏合、重新进入时的「布局是否还在原处」才能离屏检验
/// （`CanvasViewportTests`），而不是靠肉眼看。
///
/// `offset` 是**世界原点在屏幕上的位置**（pt），`scale` 是屏幕像素 ÷ 世界单位。
/// 屏幕点 = 世界点 × scale + offset。
struct CanvasViewport: Equatable, Sendable {

    var scale: CGFloat = 1
    var offset: CGSize = .zero

    static let minScale: CGFloat = 0.35
    static let maxScale: CGFloat = 2.5

    // MARK: - 换算

    func screenPoint(_ world: CGPoint) -> CGPoint {
        CGPoint(x: world.x * scale + offset.width,
                y: world.y * scale + offset.height)
    }

    func worldPoint(_ screen: CGPoint) -> CGPoint {
        CGPoint(x: (screen.x - offset.width) / scale,
                y: (screen.y - offset.height) / scale)
    }

    /// 当前屏幕窗口对应的世界矩形。节点裁剪与「新节点落在可见区」都用它。
    func worldRect(in size: CGSize) -> CGRect {
        CGRect(origin: worldPoint(.zero),
               size: CGSize(width: size.width / scale, height: size.height / scale))
    }

    // MARK: - 手势结果

    mutating func pan(by translation: CGSize) {
        offset.width += translation.width
        offset.height += translation.height
    }

    /// 以屏幕上的 `anchor` 为不动点缩放到 `newScale`：手指下面的内容不跑。
    func zoomed(to newScale: CGFloat, anchor: CGPoint) -> CanvasViewport {
        let clamped = Self.clampedScale(newScale)
        guard scale > 0, clamped != scale else { return self }
        let ratio = clamped / scale
        return CanvasViewport(
            scale: clamped,
            offset: CGSize(width: anchor.x - (anchor.x - offset.width) * ratio,
                           height: anchor.y - (anchor.y - offset.height) * ratio)
        )
    }

    static func clampedScale(_ value: CGFloat) -> CGFloat {
        guard value.isFinite else { return 1 }
        return min(max(value, minScale), maxScale)
    }

    // MARK: - 初始视口

    /// 把所有节点的包围盒装进窗口：留一圈 `padding`，最多放大到 1（小画布
    /// 不硬撑），最小到 `minScale`。没有节点时回到原点、100%。
    func fitted(content: CGRect, in size: CGSize, padding: CGFloat = 48) -> CanvasViewport {
        guard size.width > 0, size.height > 0 else { return .init() }
        guard content.width > 0, content.height > 0 else { return .init() }

        let available = CGSize(width: max(1, size.width - padding * 2),
                               height: max(1, size.height - padding * 2))
        let raw = min(available.width / content.width, available.height / content.height)
        let scale = Self.clampedScale(min(1, raw))
        let contentCenter = CGPoint(x: content.midX, y: content.midY)
        let offset = CGSize(width: size.width / 2 - contentCenter.x * scale,
                            height: size.height / 2 - contentCenter.y * scale)
        return CanvasViewport(scale: scale, offset: offset)
    }

    /// 一组世界矩形的包围盒。空数组返回 nil。
    static func contentBounds(_ frames: [CGRect]) -> CGRect? {
        guard let first = frames.first else { return nil }
        return frames.dropFirst().reduce(first) { $0.union($1) }
    }
}
