import Foundation

/// 保存回调的暂存队列：**编辑器保存 ≠ 立即插入**。
///
/// 保存发生在嵌套 sheet 里（载体卡 → 编辑器），此时列表被两层 sheet 盖住；
/// 如果回调当场把记录插进瀑布流，下落动画会在用户看不见的地方播完。
/// 所以回调只入队，等外层 sheet 完全关闭后由 `RecordsView` 一次性 drain。
///
/// 队列按入队顺序处理、按 `Record.id` 去重：保存回调理论上可能重入，
/// 连续快速保存也可能排进多条——都不能丢、也不能重复插入。
struct PendingInsertions: Equatable {

    private(set) var records: [Record] = []
    private var ids: Set<UUID> = []

    var isEmpty: Bool { records.isEmpty }

    init() {}

    /// 只暂存。重复 id（同一条记录的回调第二次到达）直接忽略。
    mutating func enqueue(_ record: Record) {
        guard !ids.contains(record.id) else { return }
        ids.insert(record.id)
        records.append(record)
    }

    /// 取出全部并按入队顺序返回，队列随之清空。匹配筛选与真正插入
    /// 由调用方负责——队列自己不认识查询条件。
    mutating func drain() -> [Record] {
        defer {
            records.removeAll()
            ids.removeAll()
        }
        return records
    }
}
