import CoreGraphics

/// 首页一个空间分区的几何：几张卡横向叠成一摞，像从盒子里抽出来的卡片。
///
/// 抽成纯值类型的原因和 `BeanDeck` 一样：错位关系是版式契约，应该能离开屏幕
/// 被验证——「空空间也占一张的位置」「后一张不许盖住前一张的标题」这类规则
/// 不值得靠截图去猜。
///
/// 三个分区**纵向**排列（每区一行卡片），而不是三列并排：手机上三列会把内容
/// 挤在屏幕上半截，下半截全是空白。
enum WorkspaceStackLayout {

    /// 一个分区最多露出几张卡。第四张之后只在空间自己的页面里出现。
    static let visibleLimit = 3

    /// 相邻两张卡重叠的宽度（pt）。后卡因此只露出一条边，而不是并排成网格。
    static let cardOverlap: CGFloat = 32

    /// 每往后一张，卡面向下沉多少（pt）。错位很轻，只让「叠」看得出来。
    static let depthLift: CGFloat = 3

    /// 单张卡的宽高比（宽 ÷ 高）。横向排布后卡片比原来宽，比例相应放矮一点；
    /// 0.9 是「三个分区能在 6.3 吋屏上同时看到大半」与「缩略图还看得清」的折中。
    static let cardAspect: CGFloat = 0.9

    /// 实际画几张：空空间也画一张（空态卡），有内容时按上限截断。
    static func visibleCount(itemCount: Int) -> Int {
        min(max(itemCount, 1), visibleLimit)
    }

    /// 第 depth 张（0 = 最前）向下让多少。
    static func lift(depth: Int) -> CGFloat {
        CGFloat(max(depth, 0)) * depthLift
    }

    /// 后卡要退到前卡后面去：只降一点不透明度，不改颜色——颜色属于内容。
    static func opacity(depth: Int) -> Double {
        switch max(depth, 0) {
        case 0: return 1
        case 1: return 0.9
        default: return 0.78
        }
    }

    /// 分区底部要额外让出的高度：最后一张卡下沉的那一段。
    ///
    /// 不退让的话，下一个分区会把卡片压在自己的标题上——错位是视觉，不该让
    /// 布局替它买单。
    static func sectionBottomPadding(itemCount: Int) -> CGFloat {
        lift(depth: visibleCount(itemCount: itemCount) - 1)
    }
}
