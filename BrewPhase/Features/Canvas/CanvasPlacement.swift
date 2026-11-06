import CoreGraphics

/// 新节点落到哪里：在当前可见区域里找一个不压住已有节点的空位。
///
/// 画布是自由空间，但「加进来就盖住别人」不是自由，是麻烦。规则很简单：
/// 从可见区左上角按小步长扫描，第一个与已有节点（留 `gap` 呼吸）不相交的
/// 位置就是它；实在没有空位，就顺着已有内容的底边往下排。纯函数，
/// `CanvasPlacementTests` 直接验证「不重叠、不出可见区」。
enum CanvasPlacement {

    /// 扫描步长。24pt 足够细，又不至于把一次添加变成一次布局计算。
    private static let scanStep: CGFloat = 24
    /// 节点的最小逻辑尺寸，与 `CanvasNode.frame` 的下限一致。
    private static let minSide: CGFloat = 48

    /// - Parameters:
    ///   - sizes: 待放置节点的逻辑尺寸，按添加顺序。
    ///   - occupied: 已经占位的世界矩形（含画布上已有的节点）。
    ///   - visible: 当前可见的世界矩形。
    ///   - gap: 节点之间至少留出的空隙。
    /// - Returns: 与 `sizes` 一一对应的世界坐标左上角。
    static func origins(sizes: [CGSize],
                        occupied: [CGRect],
                        in visible: CGRect,
                        gap: CGFloat = 16) -> [CGPoint] {
        var taken = occupied
        var results: [CGPoint] = []
        results.reserveCapacity(sizes.count)

        for size in sizes {
            let width = max(minSide, size.width)
            let height = max(minSide, size.height)
            let rect = firstFreeRect(width: width, height: height,
                                     taken: taken, visible: visible, gap: gap)
            taken.append(rect)
            results.append(rect.origin)
        }
        return results
    }

    private static func firstFreeRect(width: CGFloat, height: CGFloat,
                                      taken: [CGRect], visible: CGRect,
                                      gap: CGFloat) -> CGRect {
        var y = visible.minY
        while y + height <= visible.maxY {
            var x = visible.minX
            while x + width <= visible.maxX {
                let candidate = CGRect(x: x, y: y, width: width, height: height)
                if !taken.contains(where: { $0.insetBy(dx: -gap, dy: -gap).intersects(candidate) }) {
                    return candidate
                }
                x += scanStep
            }
            y += scanStep
        }

        // 可见区已经没有空位：排到已有内容的下方。宁可让用户滚一下，
        // 也不要把新节点叠在别人的内容上。
        let bottom = taken.map(\.maxY).max() ?? visible.maxY
        return CGRect(x: visible.minX, y: bottom + gap, width: width, height: height)
    }
}
