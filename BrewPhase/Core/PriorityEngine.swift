import Foundation

/// What to do about one bag, in words a person would actually say.
///
/// The score exists so beans can be *ordered*. It never leaves this file — the
/// UI shows the headline and the reasons, and nothing else (§17).
struct PriorityVerdict: Equatable, Sendable {
    var score: Double
    var tier: PriorityTier
    /// One short sentence: why this bag, in phase terms.
    var headline: String
    /// Up to two supporting observations.
    var details: [String]
    /// Shown only when the app is actually asking for urgency.
    var closing: String?

    var reasons: [String] { [headline] + details }

    static let none = PriorityVerdict(score: 0, tier: .low, headline: "", details: [], closing: nil)
}

/// Everything the ranking needs about one bag.
struct Candidate: Equatable, Sendable, Identifiable {
    var bean: BeanSnapshot
    var reading: PhaseReading
    var estimate: ConsumptionEstimate
    var lastScore: Int?

    var id: UUID { bean.id }
}

/// A candidate plus the verdict, ready for a view.
struct BeanInsight: Equatable, Sendable, Identifiable {
    var candidate: Candidate
    var verdict: PriorityVerdict

    var id: UUID { candidate.bean.id }
    var bean: BeanSnapshot { candidate.bean }
    var reading: PhaseReading { candidate.reading }
    var estimate: ConsumptionEstimate { candidate.estimate }
    var name: String { candidate.bean.name }
}

/// Turns the factors in §17 into an order, and into an explanation.
///
/// The rules, in order of weight:
///   * a bag in its window beats one that is not;
///   * a window about to close beats one with weeks left;
///   * a bag that will not be finished inside its window gets pushed up;
///   * a bag that has already left its window and is still mostly full gets
///     pushed up, because that is coffee being wasted;
///   * a bag still resting is never recommended, whatever else is in the cellar.
enum PriorityEngine {

    // MARK: - Public

    /// Priority order across the whole cellar.
    static func rank(_ candidates: [Candidate]) -> [BeanInsight] {
        candidates
            .map { BeanInsight(candidate: $0, verdict: verdict(for: $0)) }
            .sorted { lhs, rhs in
                if lhs.verdict.score != rhs.verdict.score {
                    return lhs.verdict.score > rhs.verdict.score
                }
                // Same urgency: the older roast is the one to drink.
                let l = lhs.bean.roastDate ?? lhs.bean.createdAt
                let r = rhs.bean.roastDate ?? rhs.bean.createdAt
                if l != r { return l < r }
                return lhs.bean.createdAt < rhs.bean.createdAt
            }
    }

    /// The bag to put at the top of the home screen, if any bag deserves it.
    ///
    /// Finished bags are excluded outright: "today's suggestion" that suggests
    /// an empty bag is worse than no suggestion at all.
    static func todaysPick(from candidates: [Candidate]) -> BeanInsight? {
        let viable = candidates.filter { !$0.bean.isFinishedForRecommendation }
        guard !viable.isEmpty else { return nil }
        return rank(viable).first
    }

    // MARK: - Scoring

    static func verdict(for candidate: Candidate) -> PriorityVerdict {
        let reading = candidate.reading
        let bean = candidate.bean
        let estimate = candidate.estimate

        var score = 0.0
        var details: [String] = []
        let headline: String

        // A. Nothing to recommend.
        if bean.status == .finished || bean.remainingG <= 0 {
            return PriorityVerdict(score: -100, tier: .low, headline: L("已经喝完了"),
                                   details: [], closing: nil)
        }

        // B. Where it sits in time.
        switch reading.phase {
        case .resting:
            score -= 40
            headline = L("还在养豆，风味还没打开")
        case .opening:
            score += 22
            headline = L("风味正在打开")
        case .peak:
            score += 55
            headline = L("现在正处于黄金风味期")
        case .declining:
            score += 40
            headline = L("风味已经开始衰减")
        }

        if reading.dayAfterRoast == nil {
            score -= 25
            details.append(L("还没有烘焙日期"))
        }
        if reading.problem == .roastDateInFuture {
            score -= 15
            details.append(L("烘焙日期在未来"))
        }

        // C. The window is closing.
        if reading.phase == .peak {
            if reading.daysUntilWindowEnd <= 2 {
                score += 20
                details.append(L("黄金风味期这两天就结束了"))
            } else if reading.daysUntilWindowEnd <= 6 {
                score += 10
            }
            // Inside the peak, the later half is the more valuable one to catch.
            score += max(0, 14 - Double(reading.daysUntilWindowEnd)) * 0.5
        }

        if reading.phase == .declining {
            // The longer it has been out of the window, the less reason to keep it.
            score += min(16, Double(max(0, -reading.daysUntilWindowEnd)) * 0.6)
        }

        // D. Stock pressure.
        let stockFraction = bean.weightG > 0
            ? min(max(bean.remainingG / bean.weightG, 0), 1)
            : 0

        if estimate.brewsRemaining > 0, estimate.brewsRemaining <= 3 {
            score += 8
            details.append(L("只剩 %@ 次的量", String(estimate.brewsRemaining)))
        }

        if reading.phase == .declining, stockFraction > 0.45 {
            score += stockFraction * 16
            details.append(L("已过黄金风味期但还剩不少"))
        }

        // E. This bag will not be finished before the window shuts.
        if reading.phase.isInWindow, reading.daysUntilWindowEnd >= 0 {
            if estimate.daysRemaining > reading.daysUntilWindowEnd {
                score += 16
                details.append(L("黄金风味期比你的消耗速度更短"))
            }
        }

        // F. A recent bad cup is a reason to use it up rather than save it.
        if let last = candidate.lastScore, last > 0, last <= 2, reading.phase != .resting {
            score += 5
            details.append(L("上次这杯不太理想"))
        }

        let tier = tier(for: score)

        return PriorityVerdict(
            score: score,
            tier: tier,
            headline: headline,
            details: Array(details.prefix(2)),
            closing: closing(for: tier)
        )
    }

    private static func tier(for score: Double) -> PriorityTier {
        switch score {
        case 85...: return .urgent
        case 62...: return .high
        case 32...: return .normal
        default: return .low
        }
    }

    private static func closing(for tier: PriorityTier) -> String? {
        switch tier {
        case .urgent: return L("尽快喝完")
        case .high: return L("建议优先饮用")
        case .normal, .low: return nil
        }
    }
}

private extension BeanSnapshot {
    /// A finished bag is never "today's suggestion".
    var isFinishedForRecommendation: Bool {
        status == .finished || remainingG <= 0
    }
}

// MARK: - Insight construction

/// Builds a `BeanInsight` from a bag's snapshot and history.
///
/// One place that knows how to combine the engine, the estimator and the rules,
/// so the views never assemble these themselves.
enum InsightBuilder {

    static func candidate(
        bean: BeanSnapshot,
        rule: PhaseRuleData?,
        samples: [BrewSample],
        lastScore: Int?,
        defaultDoseG: Double = ConsumptionEstimator.defaultDoseG,
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> Candidate {
        let reading = PhaseEngine.reading(for: bean, rule: rule, today: today, calendar: calendar)
        // A bag with nothing left has nothing to consume; skip the estimate so it
        // cannot claim "about 5 brews remaining".
        let estimate = bean.remainingG > 0
            ? ConsumptionEstimator.estimate(remainingG: bean.remainingG, samples: samples,
                                            defaultDoseG: defaultDoseG, today: today, calendar: calendar)
            : ConsumptionEstimate(averageDoseG: defaultDoseG, brewsPerDay: 1, brewsRemaining: 0,
                                  daysRemaining: 0, sampleCount: samples.count, usedDefaults: true)

        return Candidate(bean: bean, reading: reading, estimate: estimate, lastScore: lastScore)
    }

    static func insight(
        bean: BeanSnapshot,
        rule: PhaseRuleData?,
        samples: [BrewSample],
        lastScore: Int?,
        defaultDoseG: Double = ConsumptionEstimator.defaultDoseG,
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> BeanInsight {
        let c = candidate(bean: bean, rule: rule, samples: samples, lastScore: lastScore,
                          defaultDoseG: defaultDoseG, today: today, calendar: calendar)
        return BeanInsight(candidate: c, verdict: PriorityEngine.verdict(for: c))
    }
}
