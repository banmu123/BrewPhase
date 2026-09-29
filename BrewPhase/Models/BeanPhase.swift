import Foundation

/// Where a bag sits in its life, according to the active phase rule.
///
/// Four phases, not five: "建议优先消耗" is not a point in time, it is a
/// conclusion drawn from the phase plus how much is left. Keeping them separate
/// means the engine stays deterministic and the UI can still speak in five
/// words (see `PhasePresentation`).
enum BeanPhase: String, Codable, CaseIterable, Identifiable, Sendable {
    case resting
    case opening
    case peak
    case declining

    var id: String { rawValue }

    /// Full name, used on the detail page.
    var title: String {
        switch self {
        case .resting: return L("太新")
        case .opening: return L("开始进入窗口")
        case .peak: return L("黄金风味窗口")
        case .declining: return L("风味衰退")
        }
    }

    /// Two-to-four characters, used under the phase track and in list rows.
    var shortTitle: String {
        switch self {
        case .resting: return L("养豆")
        case .opening: return L("进入窗口")
        case .peak: return L("黄金窗口")
        case .declining: return L("衰退")
        }
    }

    /// What the user should actually do, in their words.
    var subtitle: String {
        switch self {
        case .resting: return L("正在养豆")
        case .opening: return L("风味开始打开")
        case .peak: return L("现在喝")
        case .declining: return L("建议优先饮用")
        }
    }

    var order: Int {
        switch self {
        case .resting: return 0
        case .opening: return 1
        case .peak: return 2
        case .declining: return 3
        }
    }

    /// Whether this bag is worth drinking today at all.
    var isInWindow: Bool { self == .peak || self == .declining }
}

/// How loudly the app should nag about a bag.
enum PriorityTier: Int, Codable, CaseIterable, Comparable, Sendable {
    case low = 0
    case normal = 1
    case high = 2
    case urgent = 3

    static func < (lhs: PriorityTier, rhs: PriorityTier) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    var label: String {
        switch self {
        case .low: return L("可以等")
        case .normal: return L("照常喝")
        case .high: return L("建议优先")
        case .urgent: return L("尽快喝完")
        }
    }
}

/// One coloured band of the phase track, in 0…1 track space.
struct TrackSegment: Identifiable, Equatable, Sendable {
    let phase: BeanPhase
    let start: Double
    let end: Double

    var width: Double { max(0, end - start) }
    var id: String { phase.rawValue }

    /// Where the segment's centre sits, for label placement.
    var mid: Double { (start + end) / 2 }
}
