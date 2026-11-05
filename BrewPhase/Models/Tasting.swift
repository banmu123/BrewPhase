import Foundation
import SwiftData

/// A single "how does it taste right now" note, independent of any particular
/// brew. Together, a bag's tastings are its flavour lifecycle (§16) — the reason
/// the timeline is worth looking at.
@Model
final class Tasting {

    static let tagSeparator = Bean.tagSeparator

    var id: UUID = UUID()
    var date: Date = Date()
    /// 创建时冻结的「烘焙后第几天」。
    ///
    /// 只作为**没有豆子可问**时的兜底（正常数据里风味记录一定挂着豆子，删豆
    /// 会级联带走它）。界面、导出与检索读的是 `resolvedDayAfterRoast`：
    /// 天数由（烘焙日期，记录日期）唯一决定，改了烘焙日期就该跟着改，否则
    /// 同一笔记在时间线上写着 Day 9、详情页写着 Day 6。
    var dayAfterRoast: Int = 0
    var flavorTagsRaw: String = ""
    var score: Int = 0
    var notes: String = ""
    var sourceRaw: String = TastingSource.manual.rawValue
    /// Set when this note was generated from a brew, so deleting that brew can
    /// take its timeline node with it — exactly, rather than by guessing at dates.
    var brewID: UUID?
    var createdAt: Date = Date()
    var bean: Bean?

    init(
        date: Date = Date(),
        dayAfterRoast: Int = 0,
        flavorTags: [String] = [],
        score: Int = 0,
        notes: String = "",
        source: TastingSource = .manual,
        brewID: UUID? = nil,
        bean: Bean? = nil
    ) {
        self.id = UUID()
        self.date = date
        self.dayAfterRoast = dayAfterRoast
        self.flavorTagsRaw = flavorTags.joined(separator: Self.tagSeparator)
        self.score = score
        self.notes = notes
        self.sourceRaw = source.rawValue
        self.brewID = brewID
        self.bean = bean
        self.createdAt = Date()
    }

    var flavorTags: [String] {
        get {
            flavorTagsRaw
                .components(separatedBy: Self.tagSeparator)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        }
        set {
            flavorTagsRaw = newValue
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: Self.tagSeparator)
        }
    }

    var source: TastingSource {
        get { TastingSource(rawValue: sourceRaw) ?? .manual }
        set { sourceRaw = newValue.rawValue }
    }

    /// 界面上那个「Day N」的唯一来源。
    ///
    /// 豆子还在就**现算**：烘焙日期是这包豆的属性，用户把它从 9 月 1 日改到
    /// 9 月 3 日，所有「Day N」都该一起挪两天。保存的 `dayAfterRoast` 只在豆子
    /// 已经不在时兜底。
    ///
    /// 没有烘焙日期时返回 nil——不是 0。「Day 0」是一句具体的话（烘焙当天），
    /// 而不知道就是不知道，界面上显示「—」。
    var resolvedDayAfterRoast: Int? {
        guard let bean else { return dayAfterRoast }
        return bean.dayAfterRoast(on: date)
    }

    var dayText: String { Fmt.day(resolvedDayAfterRoast) }
}

/// Where a tasting came from. Kept visible in the timeline so a note that was
/// auto-created from a brew can be deleted without deleting the brew.
enum TastingSource: String, Codable, CaseIterable, Sendable {
    case manual
    case brew

    var label: String {
        switch self {
        case .manual: return L("手动记录")
        case .brew: return L("冲煮记录")
        }
    }
}
