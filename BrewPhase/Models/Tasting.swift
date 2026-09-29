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
    /// Frozen at creation time. Recomputed on the fly it would silently change
    /// meaning if the roast date were later corrected.
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

    var dayText: String { Fmt.day(dayAfterRoast) }
}

/// Where a tasting came from. Kept visible in the timeline so a note that was
/// auto-created from a brew can be deleted without deleting the brew.
enum TastingSource: String, Codable, CaseIterable, Sendable {
    case manual
    case brew

    var label: String {
        switch self {
        case .manual: return L("风味记录")
        case .brew: return L("冲煮记录")
        }
    }
}
