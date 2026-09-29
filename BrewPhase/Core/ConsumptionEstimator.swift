import Foundation

/// How fast this bag is disappearing, and what that means for the window (§9).
///
/// The whole point is to be stable and explainable rather than clever: an
/// average dose, an average cadence, two divisions. If the drinker has not
/// logged anything yet it says so via `usedDefaults` instead of pretending.
struct ConsumptionEstimate: Equatable, Sendable {
    var averageDoseG: Double
    var brewsPerDay: Double
    var brewsRemaining: Int
    var daysRemaining: Int
    var sampleCount: Int
    var usedDefaults: Bool

    static let unknown = ConsumptionEstimate(
        averageDoseG: 15, brewsPerDay: 1, brewsRemaining: 0, daysRemaining: 0,
        sampleCount: 0, usedDefaults: true
    )

    /// `约 5 次` or `不足一次`.
    var brewsText: String {
        brewsRemaining <= 0 ? L("不足一次") : Fmt.brews(brewsRemaining)
    }
}

enum ConsumptionEstimator {

    /// Fallback dose when there is no history at all, in grams.
    static let defaultDoseG: Double = 15
    /// How many recent brews feed the dose average.
    static let doseWindow = 5

    static func estimate(
        remainingG: Double,
        samples: [BrewSample],
        defaultDoseG: Double = ConsumptionEstimator.defaultDoseG,
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> ConsumptionEstimate {
        let usable = samples.filter { $0.coffeeG > 0 }.sorted { $0.date < $1.date }

        let dose: Double
        var usedDefaults = true
        if let recent = usable.suffix(doseWindow).nonEmpty {
            dose = recent.reduce(0) { $0 + $1.coffeeG } / Double(recent.count)
            usedDefaults = false
        } else {
            dose = max(1, defaultDoseG)
        }

        // Cadence: brews per day across the logged span. One brew on one day is
        // "one a day", not "infinitely many", hence the max(1, …).
        var rate: Double = 1
        if usable.count >= 2, let first = usable.first, let last = usable.last {
            let span = max(1, DateMath.daysBetween(first.date, last.date, calendar: calendar) + 1)
            rate = Double(usable.count) / Double(span)
        }
        rate = min(max(rate, 0.2), 4)

        guard remainingG > 0 else {
            return ConsumptionEstimate(averageDoseG: dose, brewsPerDay: rate,
                                       brewsRemaining: 0, daysRemaining: 0,
                                       sampleCount: usable.count, usedDefaults: usedDefaults)
        }

        // Less than a dose left is not "about one brew" — it is nothing, and
        // saying otherwise would promise a cup that cannot be made.
        let brews = remainingG < dose ? 0 : max(1, Int((remainingG / dose).rounded()))
        let days = max(1, Int((remainingG / (dose * rate)).rounded(.up)))

        return ConsumptionEstimate(
            averageDoseG: dose,
            brewsPerDay: rate,
            brewsRemaining: brews,
            daysRemaining: days,
            sampleCount: usable.count,
            usedDefaults: usedDefaults
        )
    }
}

private extension Array {
    var nonEmpty: [Element]? { isEmpty ? nil : self }
}
