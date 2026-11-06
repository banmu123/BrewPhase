import Foundation
import SwiftData

/// 一块画布：一个自己命名的空间，用来把咖啡与记录里的东西放到一起。
///
/// 画布本身只存名字、说明与时间。摆在画布上的内容由 `CanvasNode` 承载：
/// 它用 UUID 引用记录并保存世界坐标与尺寸，**不复制**记录的任何内容。
/// 所以删画布要显式清理节点（`CanvasNodeStore`），而删节点永远不碰记录。
@Model
final class Canvas {

    var id: UUID = UUID()
    var name: String = ""
    /// 一句话说明：这块画布想装什么。
    var note: String = ""

    var createdAt: Date = Date()
    var updatedAt: Date = Date()

    /// 示例数据标记，与 `Record` 同义。
    var isSample: Bool = false

    init(name: String = "", note: String = "", createdAt: Date = Date(), isSample: Bool = false) {
        self.id = UUID()
        self.name = name
        self.note = note
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.isSample = isSample
    }

    /// 没有名字的画布不该出现在列表里，但真出现了也得有个能读的标签。
    var displayName: String {
        let trimmed = name.trimmed
        return trimmed.isEmpty ? L("未命名画布") : trimmed
    }

    func touch() {
        updatedAt = Date()
    }
}
