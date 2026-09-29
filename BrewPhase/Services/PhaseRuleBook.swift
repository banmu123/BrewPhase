import Foundation
import SwiftData

/// The phase rules the app is currently obeying, keyed by roast level.
///
/// Views read through this rather than touching `PhaseRule` rows, so there is
/// exactly one place that decides what happens when a level's rule is missing.
struct PhaseRuleBook: Equatable, Sendable {
    var rules: [RoastLevel: PhaseRuleData]

    static let defaults = PhaseRuleBook(
        rules: Dictionary(uniqueKeysWithValues: DefaultPhaseRules.all.map { ($0.roastLevel, $0) })
    )

    func rule(for level: RoastLevel) -> PhaseRuleData {
        rules[level] ?? DefaultPhaseRules.data(for: level)
    }

    /// True when every level is still on its shipped numbers.
    var isPristine: Bool {
        RoastLevel.allCases.allSatisfy { rule(for: $0).matchesDefaults() }
    }

    /// Levels whose rules no longer match the defaults.
    var customized: [RoastLevel] {
        RoastLevel.pickerOrder.filter { !rule(for: $0).matchesDefaults() }
    }

    // MARK: - Store bridging

    static func make(stored: [PhaseRule]) -> PhaseRuleBook {
        var rules: [RoastLevel: PhaseRuleData] = [:]
        for row in stored {
            rules[row.roastLevel] = row.data
        }
        return PhaseRuleBook(rules: rules)
    }

    /// Brings the store in line with what a bag needs: every roast level that is
    /// in use has a rule, and levels nobody has touched keep their defaults.
    ///
    /// Called once on launch. It is idempotent — running it twice changes
    /// nothing — which is what makes it safe to call from `init`.
    @discardableResult
    static func seedIfNeeded(context: ModelContext, defaults: UserDefaults = .standard) -> Bool {
        let existing = (try? context.fetch(FetchDescriptor<PhaseRule>())) ?? []
        let present = Set(existing.map(\.roastLevel))
        let missing = RoastLevel.allCases.filter { !present.contains($0) }
        guard !missing.isEmpty else { return false }

        for level in missing {
            context.insert(PhaseRule(data: DefaultPhaseRules.data(for: level)))
        }
        try? context.save()
        defaults.set(true, forKey: PrefKey.seededPhaseRules)
        return true
    }

    /// Resets every level back to the shipped window.
    static func resetToDefaults(context: ModelContext) {
        let existing = (try? context.fetch(FetchDescriptor<PhaseRule>())) ?? []
        for row in existing { context.delete(row) }
        for level in RoastLevel.allCases {
            context.insert(PhaseRule(data: DefaultPhaseRules.data(for: level)))
        }
        try? context.save()
    }
}
