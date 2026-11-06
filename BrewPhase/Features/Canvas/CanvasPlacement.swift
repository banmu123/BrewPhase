import CoreGraphics

/// 新节点落到哪里：在当前可见区域里找一个不压住已有节点的空位。
///
/// 画布是自由空间，但「加进来就盖住别人」不是自由，是麻烦。规则：从可见区
/// 左上角按小步长扫描，第一个与已有节点（留 `gap` 呼吸）不相交的位置就是它；
/// 实在没有空位，就顺着已有内容的底边往下排。
///
/// 性能：候选位置与已占位矩形都用 **40pt 网格索引**。节点几百个时，逐个
/// 遍历已占位矩形会把一次添加拖成十几毫秒；网格把「是否相交」压到十几个
/// 哈希查找。纯函数，`CanvasPlacementTests` 验证正确性与规模。
enum CanvasPlacement {

    /// 扫描步长与网格单元。20pt 的候选步长足够细腻，又不会让候选数量爆炸。
    private static let scanStep: CGFloat = 20
    private static let cellSize: CGFloat = 40
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
        var index = OccupancyIndex(gap: gap)
        for rect in occupied { index.insert(rect) }

        var results: [CGPoint] = []
        results.reserveCapacity(sizes.count)

        for size in sizes {
            let width = max(minSide, size.width)
            let height = max(minSide, size.height)
            let rect = firstFreeRect(width: width, height: height,
                                     index: index, visible: visible, gap: gap)
            index.insert(rect)
            results.append(rect.origin)
        }
        return results
    }

    private static func firstFreeRect(width: CGFloat, height: CGFloat,
                                      index: OccupancyIndex, visible: CGRect,
                                      gap: CGFloat) -> CGRect {
        var y = visible.minY
        while y + height <= visible.maxY {
            var x = visible.minX
            while x + width <= visible.maxX {
                let candidate = CGRect(x: x, y: y, width: width, height: height)
                if !index.overlaps(candidate) { return candidate }
                x += scanStep
            }
            y += scanStep
        }

        // 可见区已经没有空位：排到已有内容的下方。宁可让用户滚一下，
        // 也不要把新节点叠在别人的内容上。
        let bottom = index.maxY ?? visible.maxY
        return CGRect(x: visible.minX, y: bottom + gap, width: width, height: height)
    }

    /// 已占位矩形的网格索引。`gap` 在插入时扩进矩形，查询时不用再加。
    private struct OccupancyIndex {

        struct Cell: Hashable {
            let x: Int
            let y: Int
        }

        let gap: CGFloat
        private var cells: Set<Cell> = []
        private(set) var maxY: CGFloat?

        init(gap: CGFloat) {
            self.gap = gap
        }

        mutating func insert(_ rect: CGRect) {
            let padded = rect.insetBy(dx: -gap, dy: -gap)
            maxY = max(maxY ?? rect.maxY, rect.maxY)
            let range = cellRange(padded)
            for x in range.x {
                for y in range.y {
                    cells.insert(Cell(x: x, y: y))
                }
            }
        }

        /// 不建中间数组：候选位置可能有几千个，每次分配一个小数组会白白
        /// 制造几万次内存操作。
        func overlaps(_ rect: CGRect) -> Bool {
            let range = cellRange(rect)
            for x in range.x {
                for y in range.y {
                    if cells.contains(Cell(x: x, y: y)) { return true }
                }
            }
            return false
        }

        private func cellRange(_ rect: CGRect) -> (x: ClosedRange<Int>, y: ClosedRange<Int>) {
            let minX = Int((rect.minX / CanvasPlacement.cellSize).rounded(.down))
            let maxX = Int((rect.maxX / CanvasPlacement.cellSize).rounded(.down))
            let minY = Int((rect.minY / CanvasPlacement.cellSize).rounded(.down))
            let maxY = Int((rect.maxY / CanvasPlacement.cellSize).rounded(.down))
            return (minX...max(minX, maxX), minY...max(minY, maxY))
        }
    }
}
