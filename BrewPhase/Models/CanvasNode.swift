import Foundation
import SwiftData

/// 一条 Record 在某块 Canvas 里的**摆放实例**。
///
/// 它不复制记录的任何内容——不存标题、正文、图片、视频、网址。画布上的卡片
/// 永远从 `Record` 读原件，节点只负责「放在哪、多大、第几层、我在这一块画布
/// 上对它说了什么」。同一条记录可以被多块画布引用，也可以在同一块画布上被
/// 移除而不影响记录本身。
///
/// 为什么用 `canvasID` / `recordID` 两个 UUID，而不是 SwiftData 关系：
/// 关系要改 `Canvas` 与 `Record` 的模型、要为删除设计级联，而节点是**摆放**
/// 不是归属——记录不该知道自己被哪些画布摆着。代价是删除必须由应用层显式
/// 清理（见 `CanvasNodeStore`），这正是本文件旁边那条规则存在的原因。
@Model
final class CanvasNode {

    var id: UUID = UUID()

    /// 所属画布。画布删除时由 `CanvasNodeStore` 一并清理。
    var canvasID: UUID = UUID()
    /// 原始记录。记录删除时由 `CanvasNodeStore` 一并清理。
    var recordID: UUID = UUID()

    /// 画布**世界坐标**里的左上角。不是屏幕坐标，不随缩放/平移改变。
    var positionX: Double = 0
    var positionY: Double = 0

    /// 逻辑尺寸（世界坐标单位）。屏幕上的大小 = 它 × viewport.scale。
    var width: Double = 220
    var height: Double = 180

    /// 同一画布内的层级，大的在上。
    var zIndex: Int = 0

    /// 当前画布专属的备注。**不会**写回 Record.note。
    var annotation: String = ""

    var createdAt: Date = Date()
    var updatedAt: Date = Date()

    init(canvasID: UUID,
         recordID: UUID,
         positionX: Double = 0,
         positionY: Double = 0,
         width: Double,
         height: Double,
         zIndex: Int = 0,
         annotation: String = "",
         createdAt: Date = Date()) {
        self.id = UUID()
        self.canvasID = canvasID
        self.recordID = recordID
        self.positionX = positionX
        self.positionY = positionY
        self.width = width
        self.height = height
        self.zIndex = zIndex
        self.annotation = annotation
        self.createdAt = createdAt
        self.updatedAt = createdAt
    }

    /// 世界坐标里的矩形。尺寸做下限保护：0 会让节点无法被点中。
    var frame: CGRect {
        CGRect(x: positionX, y: positionY,
               width: max(48, width), height: max(48, height))
    }

    func move(to origin: CGPoint) {
        positionX = origin.x
        positionY = origin.y
    }

    func touch() {
        updatedAt = Date()
    }
}
