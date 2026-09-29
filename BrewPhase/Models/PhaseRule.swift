import Foundation
import SwiftData

/// A user-editable flavour window for one roast level (§7, §18).
///
/// Rules are not constants baked into the engine: the app ships defaults, seeds
/// them into the store on first launch, and from then on the stored rows are the
/// only truth. That is what makes the windows configurable rather than hardcoded.
@Model
final class PhaseRule {

    var id: UUID = UUID()
    var roastLevelRaw: String = RoastLevel.medium.rawValue

    /// Exhaust / resting window, in days after roast.
    var restMinDays: Int = 2
    var restMaxDays: Int = 5

    /// The window worth drinking in.
    var peakStartDay: Int = 5
    var peakEndDay: Int = 21

    /// Where flavour is generally considered to be heading downhill.
    var declineStartDay: Int = 21

    var enabled: Bool = true
    var updatedAt: Date = Date()

    init(data: PhaseRuleData) {
        self.id = UUID()
        self.roastLevelRaw = data.roastLevel.rawValue
        self.restMinDays = data.restMinDays
        self.restMaxDays = data.restMaxDays
        self.peakStartDay = data.peakStartDay
        self.peakEndDay = data.peakEndDay
        self.declineStartDay = data.declineStartDay
        self.enabled = data.enabled
        self.updatedAt = Date()
    }

    var roastLevel: RoastLevel {
        get { RoastLevel(rawValue: roastLevelRaw) ?? .medium }
        set { roastLevelRaw = newValue.rawValue }
    }

    var data: PhaseRuleData {
        PhaseRuleData(
            roastLevel: roastLevel,
            restMinDays: restMinDays,
            restMaxDays: restMaxDays,
            peakStartDay: peakStartDay,
            peakEndDay: peakEndDay,
            declineStartDay: declineStartDay,
            enabled: enabled
        )
    }

    func apply(_ newValue: PhaseRuleData) {
        restMinDays = newValue.restMinDays
        restMaxDays = newValue.restMaxDays
        peakStartDay = newValue.peakStartDay
        peakEndDay = newValue.peakEndDay
        declineStartDay = newValue.declineStartDay
        enabled = newValue.enabled
        updatedAt = Date()
    }

    /// A one-line description of the window, for the rules editor.
    var summary: String {
        L("排气 %@–%@ · 窗口 %@–%@ · 衰退 %@",
          String(restMinDays), String(restMaxDays),
          String(peakStartDay), String(peakEndDay), String(declineStartDay))
    }
}
