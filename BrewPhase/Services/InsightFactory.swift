import Foundation
import SwiftData

/// The one place that turns stored `Bean` rows into decisions.
///
/// Views ask this for insights; they never call `PhaseEngine`, the estimator and
/// the ranker themselves. That keeps "what day is this bag on" answered
/// identically on the home screen, the detail page and the reminder planner.
enum InsightFactory {

    // MARK: - Single bag

    static func insight(
        for bean: Bean,
        book: PhaseRuleBook,
        defaults: BrewDefaults = .current(),
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> BeanInsight {
        InsightBuilder.insight(
            bean: bean.snapshot,
            rule: book.rule(for: bean.roastLevel),
            samples: bean.brewSamples,
            lastScore: bean.latestScore,
            defaultDoseG: defaults.doseG,
            today: today,
            calendar: calendar
        )
    }

    static func candidate(
        for bean: Bean,
        book: PhaseRuleBook,
        defaults: BrewDefaults = .current(),
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> Candidate {
        InsightBuilder.candidate(
            bean: bean.snapshot,
            rule: book.rule(for: bean.roastLevel),
            samples: bean.brewSamples,
            lastScore: bean.latestScore,
            defaultDoseG: defaults.doseG,
            today: today,
            calendar: calendar
        )
    }

    // MARK: - The cellar

    /// Everything, in priority order.
    static func ranked(
        _ beans: [Bean],
        book: PhaseRuleBook,
        defaults: BrewDefaults = .current(),
        today: Date = Date()
    ) -> [BeanInsight] {
        let candidates = beans
            // A bag with a future roast date is a data-entry problem, not a
            // recommendation candidate — but it stays in the cellar, sorted last.
            .map { candidate(for: $0, book: book, defaults: defaults, today: today) }
        return PriorityEngine.rank(candidates)
    }

    /// The bag to lead with today (§4), or nil when there is nothing to say.
    static func todaysPick(
        _ beans: [Bean],
        book: PhaseRuleBook,
        defaults: BrewDefaults = .current(),
        today: Date = Date()
    ) -> BeanInsight? {
        let candidates = beans.map { candidate(for: $0, book: book, defaults: defaults, today: today) }
        return PriorityEngine.todaysPick(from: candidates)
    }

    // MARK: - Cellar summary

    /// `2 黄金窗口 · 1 进入窗口 · 2 养豆` for the home header (§25).
    static func phaseTally(_ insights: [BeanInsight]) -> [(phase: BeanPhase, count: Int)] {
        BeanPhase.allCases.compactMap { phase in
            let count = insights.filter { $0.reading.phase == phase && !$0.bean.isFinished }.count
            return count > 0 ? (phase, count) : nil
        }
    }
}

extension BeanSnapshot {
    var isFinished: Bool { status == .finished || remainingG <= 0 }
}
