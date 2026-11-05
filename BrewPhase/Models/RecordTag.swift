import Foundation
import SwiftData

/// 用户自己定义的标签。
///
/// 它不挂在任何载体上，也不带预设字段：一条记录可以贴任意多个标签，标签也可以
/// 被改名、被删掉。「到访 / 视频 / 文章 / 开发 / 随记 / 人生」只是第一次启动时
/// 替用户准备好的六个起点，不是系统分类——删得掉，也改得了。
@Model
final class RecordTag {

    var id: UUID = UUID()
    var name: String = ""
    var createdAt: Date = Date()

    /// 反向关系。删除标签只解除它和记录的关联，记录本身留着。
    var records: [Record]? = []

    init(name: String, createdAt: Date = Date()) {
        self.id = UUID()
        self.name = name
        self.createdAt = createdAt
    }

    var displayName: String {
        let trimmed = name.trimmed
        return trimmed.isEmpty ? L("未命名标签") : trimmed
    }

    /// 这个标签被多少条记录用过。列表里按它排序，常用的排前面。
    var usageCount: Int { records?.count ?? 0 }

    // MARK: - 初始标签

    /// 六个起点。刻意就用用户看得懂的名词，而不是「visit」「idea」这类内部词。
    static var suggestedNames: [String] {
        [L("到访"), L("视频"), L("文章"), L("开发"), L("随记"), L("人生")]
    }

    /// 第一次启动时铺好六个起点。
    ///
    /// 只在**既没有标签、也没有记录**时执行：用户如果把标签全删了，说明他不想
    /// 要这些词，下次启动不应该再给他塞回来。用数据本身判断，而不是存一个
    /// 「已经初始化过」的开关——那个开关不在备份里，换机之后会和数据对不上。
    static func seedIfNeeded(context: ModelContext) {
        let tagCount = (try? context.fetchCount(FetchDescriptor<RecordTag>())) ?? 0
        guard tagCount == 0 else { return }
        let recordCount = (try? context.fetchCount(FetchDescriptor<Record>())) ?? 0
        guard recordCount == 0 else { return }

        var offset: TimeInterval = 0
        for name in suggestedNames {
            // 每个标签隔一秒：`orderedTags` 按 createdAt 排序，同一秒会让顺序随机。
            context.insert(RecordTag(name: name, createdAt: Date().addingTimeInterval(offset)))
            offset += 1
        }
        do {
            try context.save()
        } catch {
            AppLog.store.error("record tag seed failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }
}

extension RecordTag {

    /// 按名字找已有标签，没有就新建一个。用于输入标签时的去重：
    /// 用户重复输入「到访」不应该长出第二个「到访」。
    static func findOrCreate(named raw: String, in context: ModelContext, existing: [RecordTag]) -> RecordTag? {
        let name = raw.trimmed
        guard !name.isEmpty else { return nil }
        if let match = existing.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            return match
        }
        let tag = RecordTag(name: name)
        context.insert(tag)
        return tag
    }
}
