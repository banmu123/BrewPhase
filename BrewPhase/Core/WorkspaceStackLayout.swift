import CoreGraphics

/// 首页一列卡片堆叠的几何。
///
/// 抽成纯值类型的原因和 `BeanDeck` 一样：三列的错位关系是这一页的版式契约，
/// 它应该能离开屏幕被验证——「后一张一定比前一张低」「空空间也只画一张卡」
/// 这类规则不值得靠截图去猜。
///
/// 这里只回答「错开多少」，不回答「多宽」：宽度由三列等分的布局给出，卡片
/// 自己按 `cardAspect` 定高。三列因此永远同宽同高，视觉重量一致。
enum WorkspaceStackLayout {

    /// 一列最多露出几张卡。第四张之后只在空间自己的页面里出现。
    static let visibleLimit = 3

    /// 每一层向后下方退让的距离（pt）。三列共用同一个值。
    static let depthDrop: CGFloat = 7

    /// 每一层向右错开的距离（pt）。
    ///
    /// 后卡**不收窄**：早先想过「两侧各内收 4pt」，但卡片按宽高比定高，
    /// 一收窄就比前卡矮 11pt，而它只下探 7pt——后卡整张躲进前卡背后，
    /// 堆叠看起来只有一张卡。宽度保持不变、整体往右下挪，台阶才是可见的。
    ///
    /// 只挪 2pt：三列之间的缝是 10pt，挪多了会挤到隔壁那一列。
    static let depthShift: CGFloat = 2

    /// 单张卡片的宽高比（宽 ÷ 高）。缩略图优先，所以卡片偏高。
    static let cardAspect: CGFloat = 0.62

    /// 实际画几张：空空间也画一张（空态卡），有内容时按上限截断。
    static func visibleCount(itemCount: Int) -> Int {
        min(max(itemCount, 1), visibleLimit)
    }

    /// 第 depth 层（0 = 最前）向下退让多少。
    static func drop(depth: Int) -> CGFloat {
        CGFloat(max(depth, 0)) * depthDrop
    }

    /// 第 depth 层向右错开多少。
    static func shift(depth: Int) -> CGFloat {
        CGFloat(max(depth, 0)) * depthShift
    }

    /// 后卡要退到前卡后面去：只降一点不透明度，不改颜色——颜色属于内容。
    static func opacity(depth: Int) -> Double {
        switch max(depth, 0) {
        case 0: return 1
        case 1: return 0.9
        default: return 0.78
        }
    }

    /// 堆叠下方要额外让出的高度：最后一张卡下探的那一段。
    ///
    /// 不退让的话，三列会把下一行内容压在自己的卡片上——错位是视觉，不该
    /// 让布局替它买单。
    static func stackBottomPadding(itemCount: Int) -> CGFloat {
        drop(depth: visibleCount(itemCount: itemCount) - 1)
    }
}
