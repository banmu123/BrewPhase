import Foundation

/// 保存后下落动画的串行序列：**任何时刻只允许一条记录处于下落中**。
///
/// 旧实现是「插入间隔 520ms + 状态清理 760ms」两个互不知情的固定延时：
/// 连续保存三条时，第一条的清理定时器会在第二条已经开播之后才到点，
/// 两条记录抢同一个 `droppedRecordID`，于是后一条要么不播、要么重播。
///
/// 这里把「谁在下落、还有谁在排队」收成一份可推进的状态：
///
/// - `enqueue` 只排队，不动数据库、不动界面；
/// - `takeNext` 在下落位空着时交出一条，并占住下落位；
/// - `finishActive` 由**动画完成回调**调用，让出下落位后下一条才能开始；
/// - `cancel` 只清动画状态——记录在保存时就已经落库，取消不会丢数据。
///
/// 它不认识 SwiftUI，也不认识 SwiftData，因此可以在离屏测试里按任意时序
/// 推进（`InsertionSequenceTests`）。
struct InsertionSequence {

    /// 待下落的记录，按入队顺序。
    private(set) var pending: [Record] = []
    /// 正在下落的记录 id；nil 表示下落位空着。
    private(set) var activeID: UUID?

    /// 没有任何排队、也没有正在播的动画。
    var isIdle: Bool { activeID == nil && pending.isEmpty }
    /// 有一条记录正在下落。
    var isBusy: Bool { activeID != nil }

    init() {}

    /// 按顺序排队。重复 id（保存回调重入、同一条又被传了一次）只保留一次；
    /// 正在下落的那条也算「已经有了」，不会再排一份。
    mutating func enqueue(_ records: [Record]) {
        var known = Set(pending.map(\.id))
        if let activeID { known.insert(activeID) }
        for record in records where known.insert(record.id).inserted {
            pending.append(record)
        }
    }

    /// 取下一条并占住下落位。下落位非空、或没有排队时返回 nil。
    mutating func takeNext() -> Record? {
        guard activeID == nil, !pending.isEmpty else { return nil }
        let next = pending.removeFirst()
        activeID = next.id
        return next
    }

    /// 当前这条的动画结束（或被跳过）：让出下落位，下一条才能开始。
    mutating func finishActive() {
        activeID = nil
    }

    /// 放弃整段序列：用户切了筛选、离开页面，或动画被系统打断。
    /// **只清动画状态**——已保存的记录仍在数据库里，后续查询照样找得到。
    mutating func cancel() {
        pending.removeAll()
        activeID = nil
    }
}
