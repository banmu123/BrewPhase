import Foundation
import SwiftData

/// 一块画布：一个自己命名的空间，用来把咖啡与记录里的东西放到一起。
///
/// 这一版只存画布本身（名字、描述、时间）。画布里的内容尚未建模——与其先造一张
/// 空的关联表、让界面显示「0 条内容」却放不进任何东西，不如把边界摆在明处：
/// 列表、封面、新建与详情是真的，内容聚合是下一步。
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
