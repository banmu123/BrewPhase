import Foundation

/// A flavour window, as a value.
///
/// The engine reads these, the store persists them, and the tests build them by
/// hand. Nothing date-related is allowed to reach a View, and nothing here is a
/// constant: these are the defaults the app *seeds*, not the rules it obeys.
struct PhaseRuleData: Equatable, Sendable {
    var roastLevel: RoastLevel
    var restMinDays: Int
    var restMaxDays: Int
    var peakStartDay: Int
    var peakEndDay: Int
    var declineStartDay: Int
    var enabled: Bool

    /// Coerces a hand-edited rule into something the engine can reason about.
    ///
    /// The editor lets people type anything, so this is where nonsense gets
    /// quieted rather than in the middle of a date calculation: a window cannot
    /// start before it ends, and the declining point cannot precede the peak.
    ///
    /// `restMaxDays` is kept inside `[restMinDays, peakStartDay]`. It describes
    /// when the exhaust *finishes* — "排气期 3–7 天" means resting is over
    /// somewhere in there — so it can never run past the day the good window
    /// opens, and it is what the UI quotes back as a range.
    func normalized() -> PhaseRuleData {
        var d = self
        d.restMinDays = max(0, d.restMinDays)
        d.peakStartDay = max(1, d.peakStartDay)
        d.restMaxDays = min(max(d.restMaxDays, d.restMinDays), d.peakStartDay)
        d.peakEndDay = max(d.peakStartDay + 1, d.peakEndDay)
        d.declineStartDay = max(d.peakStartDay + 1, d.declineStartDay)
        return d
    }

    /// True when the rule's numbers were left at the shipped defaults.
    func matchesDefaults() -> Bool {
        self == DefaultPhaseRules.data(for: roastLevel)
    }
}

/// The shipped windows from §7.
///
/// These are estimates, and the UI says so. They are never presented as a
/// food-safety fact, and the app never uses the word "过期".
enum DefaultPhaseRules {

    /// Shown next to every phase reading.
    ///
    /// Computed, not stored: a `let` would capture the translation at first use
    /// and keep it after the interface language changed.
    static var disclaimer: String { L("基于默认风味窗口估算") }

    static func data(for level: RoastLevel) -> PhaseRuleData {
        switch level {
        case .light:
            return PhaseRuleData(roastLevel: .light, restMinDays: 3, restMaxDays: 7,
                                 peakStartDay: 7, peakEndDay: 28, declineStartDay: 28, enabled: true)
        case .medium:
            return PhaseRuleData(roastLevel: .medium, restMinDays: 2, restMaxDays: 5,
                                 peakStartDay: 5, peakEndDay: 21, declineStartDay: 21, enabled: true)
        case .mediumDark:
            return PhaseRuleData(roastLevel: .mediumDark, restMinDays: 1, restMaxDays: 3,
                                 peakStartDay: 3, peakEndDay: 14, declineStartDay: 14, enabled: true)
        case .dark:
            return PhaseRuleData(roastLevel: .dark, restMinDays: 1, restMaxDays: 3,
                                 peakStartDay: 3, peakEndDay: 14, declineStartDay: 14, enabled: true)
        case .espressoBlend:
            // Blends rest longer than they peak: the exhaust window deliberately
            // overlaps the start of the good window, so an espresso blend opens
            // straight into its peak rather than passing through "Opening".
            return PhaseRuleData(roastLevel: .espressoBlend, restMinDays: 5, restMaxDays: 14,
                                 peakStartDay: 7, peakEndDay: 21, declineStartDay: 21, enabled: true)
        }
    }

    static var all: [PhaseRuleData] {
        RoastLevel.pickerOrder.map { data(for: $0) }
    }
}
