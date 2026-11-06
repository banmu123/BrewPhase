import Foundation

// MARK: - 数据

/// 一条待布局的记录：稳定 id + 外部估算的展示高度。
///
/// Planner 不读 SwiftData、不解析图片、不量测 SwiftUI 文本——高度是调用方
/// 给的数字（估算或实测），身份是 `Record.id`。高度在入口处防御（见
/// `sanitized`），模块内部永远拿到干净数字，坏输入污染不了布局状态。
struct MasonryLayoutItem: Equatable, Sendable {

    let id: UUID
    /// 单张卡片的展示高度（pt），不含列间距。
    let height: CGFloat

    /// 单条高度防御的合理上限。一张卡片不该有十屏高；超过它的输入按估算
    /// 失误处理、钳到上限——否则两条 `greatestFiniteMagnitude` 相加会把
    /// 整列累计冲成无穷，毁掉之后所有的「比较谁更短」。
    static let heightCeiling: CGFloat = 10_000

    init(id: UUID, height: CGFloat) {
        self.id = id
        self.height = Self.sanitized(height)
    }

    /// NaN / ±∞ / 负数 → 0（内容不丢，等测高修正）；超出上限 → 上限。
    /// 0 是合法下限：退化的估算只影响「谁更短」的判断，不破坏状态一致性。
    static func sanitized(_ height: CGFloat) -> CGFloat {
        guard height.isFinite else { return 0 }
        return min(max(height, 0), heightCeiling)
    }
}

/// 两列之一。语义固定：首条记录进左列，完全打平时也进左列。
enum MasonryColumn: Equatable, Sendable {
    case left
    case right
}

// MARK: - 规划器

/// Records 两列瀑布流的列归属规划器（Records Masonry 改版的前置模块）。
///
/// 职责只有一个：给定按创建时间倒序的记录和各自的展示高度，决定每条记录
/// 进左列还是右列——**最短列优先的贪心分配**，外加分页追加、测高修正与
/// 删除。它不认识 SwiftUI、SwiftData 和全局单例，所以布局规则可以离屏
/// 检验（`MasonryColumnPlannerTests`）。
///
/// 设计决定：
///
/// - **值类型即快照**。Planner 是 struct：拷贝一份就是一份布局快照，
///   「上一批的快照」就是调用方留着的旧值，不需要单独的 Snapshot 类型。
/// - **列归属一旦给出，不因高度变化而改变**。图片加载后只修正高度与所在
///   列的累计值，已分配的记录原地不动——换列闪动是这个模块要消灭的头号
///   体验问题。
/// - **确定性**。平局规则固定（累计高度相同比条数，条数相同进左列）；
///   字典只做 id → 列的查询，从不参与遍历或排序决策，相同输入与状态
///   必然得到相同布局。
/// - **复杂度**。追加一条是 O(1)（累计高度做增量维护，不重扫全列）；
///   更新与删除在所在列内做一次 O(k) 查找。追加路径从不需要「重新分配
///   已有记录」。
struct MasonryColumnPlanner: Equatable, Sendable {

    /// 卡片之间的垂直间距，由调用方按设计规范传入；空列与单条列不计间距。
    private let interItemSpacing: CGFloat

    init(interItemSpacing: CGFloat) {
        // 间距同样防御：NaN / 负数没有几何意义，退成 0。
        self.interItemSpacing = interItemSpacing.isFinite && interItemSpacing > 0
            ? interItemSpacing
            : 0
    }

    // MARK: - 状态

    /// 一列的实时状态：自上而下的条目 + 累计高度。
    ///
    /// `totalHeight` 的契约是 `sum(高度) + spacing × (条数 − 1)`：
    /// `rebuild` 按条目精确重建，追加/更新/删除走 O(1) 变化量。两条路径在
    /// 浮点上允许末位差异，一致性由测试按 0.001 精度钉住。
    private struct ColumnState: Equatable, Sendable {
        fileprivate var entries: [Entry] = []
        fileprivate var totalHeight: CGFloat = 0

        fileprivate struct Entry: Equatable, Sendable {
            let id: UUID
            var height: CGFloat
        }

        /// 追加一条：只有「从空列到第一条」不加间距。
        fileprivate mutating func append(id: UUID, height: CGFloat, spacing: CGFloat) {
            if !entries.isEmpty { totalHeight += spacing }
            totalHeight += height
            entries.append(Entry(id: id, height: height))
        }

        /// 移除一条：拔掉最后一条时**直接置 0**，不留浮点漂移。
        fileprivate mutating func remove(at index: Int, spacing: CGFloat) {
            let entry = entries.remove(at: index)
            if entries.isEmpty {
                totalHeight = 0
            } else {
                totalHeight -= entry.height + spacing
            }
        }

        /// 修正一条的高度：累计值跟着做差，条目原地不动。
        fileprivate mutating func setHeight(at index: Int, to height: CGFloat) {
            totalHeight += height - entries[index].height
            entries[index].height = height
        }
    }

    private var states: [MasonryColumn: ColumnState] = [.left: .init(), .right: .init()]
    /// id → 列。只用于查询与去重；顺序的真相永远在 `entries` 数组里。
    private var placement: [UUID: MasonryColumn] = [:]

    // MARK: - 建立与重建

    /// 用一组记录建立**全新**布局。首次加载与「搜索/筛选/宽度变化后的
    /// 重建」都走这里——两者在算法上没有区别，都是整体替换、从头贪心。
    /// 输入按创建时间倒序；列内的相对顺序就是输入的相对顺序。
    /// 输入里重复的 id 只保留第一次出现：重复展示比丢内容更糟。
    mutating func rebuild(with items: [MasonryLayoutItem]) {
        states = [.left: .init(), .right: .init()]
        placement = [:]
        for item in items where placement[item.id] == nil {
            place(item)
        }
    }

    // MARK: - 分页追加

    /// 追加**更早**的一批记录（分页向上翻）。
    ///
    /// 只处理新记录：已有条目的列归属与列内顺序原样保留，新记录从当前
    /// 累计高度继续分配。重复 id 静默跳过——既不重复展示，也不破坏累计。
    /// 这正是「不要为了追加一批就对全部历史重新分配」的契约。
    mutating func append(_ items: [MasonryLayoutItem]) {
        for item in items where placement[item.id] == nil {
            place(item)
        }
    }

    /// 最短列优先：高度比大小 → 平局比条数 → 再平局进左列。
    /// 空规划器两条都是 0、条数都是 0 → 完全平局 → 首条必进左列。
    private mutating func place(_ item: MasonryLayoutItem) {
        let left = states[.left] ?? ColumnState()
        let right = states[.right] ?? ColumnState()

        let column: MasonryColumn
        if left.totalHeight != right.totalHeight {
            column = left.totalHeight < right.totalHeight ? .left : .right
        } else if left.entries.count != right.entries.count {
            column = left.entries.count < right.entries.count ? .left : .right
        } else {
            column = .left
        }

        states[column]?.append(id: item.id, height: item.height, spacing: interItemSpacing)
        placement[item.id] = column
    }

    // MARK: - 测高修正

    /// 图片等媒体加载后，用实测高度替换估算值。
    ///
    /// 只改这一条的高度与所在列的累计值，**列归属不变**——不允许因为
    /// 高度变化把已分配的记录挪去另一列。后续追加自然用修正后的累计继续
    /// 分配。id 不存在时是安全空操作；重复调用以最后一次为准（做差更新，
    /// 不会重复累加）。
    mutating func updateHeight(of id: UUID, to height: CGFloat) {
        guard let column = placement[id],
              let index = states[column]?.entries.firstIndex(where: { $0.id == id }) else {
            return
        }
        states[column]?.setHeight(at: index, to: MasonryLayoutItem.sanitized(height))
    }

    // MARK: - 删除

    /// 把一条记录从布局里拿掉。其余记录的列归属与顺序不变，间距随条数
    /// 自然少一份。id 不存在时是安全空操作，状态分毫不动。
    mutating func remove(id: UUID) {
        guard let column = placement[id],
              let index = states[column]?.entries.firstIndex(where: { $0.id == id }) else {
            return
        }
        states[column]?.remove(at: index, spacing: interItemSpacing)
        placement[id] = nil
    }

    // MARK: - 读取

    /// 布局里是否一条记录都没有。
    var isEmpty: Bool { placement.isEmpty }

    /// 两列的记录总数。
    var recordCount: Int { placement.count }

    /// 某一列自上而下的条目（id 与当前高度）。列内顺序 = 输入相对顺序。
    func items(in column: MasonryColumn) -> [MasonryLayoutItem] {
        (states[column] ?? ColumnState()).entries.map {
            MasonryLayoutItem(id: $0.id, height: $0.height)
        }
    }

    /// 列的累计高度：`sum(高度) + 间距 × (条数 − 1)`；空列为 0。
    func totalHeight(of column: MasonryColumn) -> CGFloat {
        states[column]?.totalHeight ?? 0
    }

    /// 这条记录在哪一列；不在布局里则 nil。
    func column(of id: UUID) -> MasonryColumn? {
        placement[id]
    }

    /// 这条记录当前使用的高度；不在布局里则 nil。
    func height(of id: UUID) -> CGFloat? {
        guard let column = placement[id] else { return nil }
        return states[column]?.entries.first { $0.id == id }?.height
    }
}
