import XCTest
@testable import BrewPhase

/// §9 (how fast the bag is going) and §17 (which bag to drink first).
final class ConsumptionAndPriorityTests: XCTestCase {

    private let today = Date(timeIntervalSince1970: 1_780_000_000)

    /// The verdicts are localised copy, so the language is pinned here rather
    /// than inherited from the test machine.
    override func setUp() {
        super.setUp()
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    private func daysAgo(_ n: Int) -> Date { DateMath.add(days: -n, to: today) }

    private func snapshot(
        _ name: String = "Bean",
        level: RoastLevel = .light,
        roastedDaysAgo: Int = 10,
        weight: Double = 200,
        remaining: Double = 120,
        status: BeanStatus = .active
    ) -> BeanSnapshot {
        BeanSnapshot(name: name, roastLevel: level,
                     roastDate: DateMath.add(days: -roastedDaysAgo, to: today),
                     weightG: weight, remainingG: remaining, status: status)
    }

    // MARK: - Consumption estimate

    func testNoHistoryFallsBackToTheDefaultDoseAndSaysSo() {
        let e = ConsumptionEstimator.estimate(remainingG: 90, samples: [], today: today)
        XCTAssertTrue(e.usedDefaults)
        XCTAssertEqual(e.averageDoseG, ConsumptionEstimator.defaultDoseG)
        XCTAssertEqual(e.brewsPerDay, 1.0)
        XCTAssertEqual(e.brewsRemaining, 6)          // 90 / 15
    }

    func testDoseIsAveragedFromTheLoggedBrews() {
        let samples = [
            BrewSample(date: daysAgo(9), coffeeG: 18),
            BrewSample(date: daysAgo(6), coffeeG: 18),
            BrewSample(date: daysAgo(3), coffeeG: 18),
        ]
        let e = ConsumptionEstimator.estimate(remainingG: 86, samples: samples, today: today)
        XCTAssertFalse(e.usedDefaults)
        XCTAssertEqual(e.averageDoseG, 18, accuracy: 0.001)
        XCTAssertEqual(e.brewsRemaining, 5)          // 86 / 18 ≈ 4.8 → 5
    }

    func testOnlyTheMostRecentFiveBrewsSetTheDose() {
        // A wild old brew must not drag the average around.
        var samples: [BrewSample] = [BrewSample(date: daysAgo(30), coffeeG: 40)]
        samples.append(contentsOf: (0..<5).map { BrewSample(date: daysAgo(10 - $0), coffeeG: 20) })
        let e = ConsumptionEstimator.estimate(remainingG: 100, samples: samples, today: today)
        XCTAssertEqual(e.averageDoseG, 20, accuracy: 0.001)
        XCTAssertEqual(e.sampleCount, 6)
    }

    func testCadenceComesFromTheSpanBetweenBrews() {
        // Six brews over six days is one a day.
        let daily = (0..<6).map { BrewSample(date: daysAgo(6 - $0), coffeeG: 15) }
        let e = ConsumptionEstimator.estimate(remainingG: 270, samples: daily, today: today)
        XCTAssertEqual(e.brewsPerDay, 1, accuracy: 0.001)
        XCTAssertEqual(e.daysRemaining, 18)                  // 270 / 15

        // Three in one day is three a day, and the days run out faster.
        let burst = (0..<3).map { BrewSample(date: daysAgo(0).addingTimeInterval(Double($0) * 60), coffeeG: 15) }
        let bursty = ConsumptionEstimator.estimate(remainingG: 150, samples: burst, today: today)
        XCTAssertEqual(bursty.brewsPerDay, 3, accuracy: 0.001)
        XCTAssertEqual(bursty.daysRemaining, 4)              // 150 / (15 * 3) → ceil(3.33)
    }

    func testZeroRemainingMeansNoBrewsLeft() {
        let e = ConsumptionEstimator.estimate(remainingG: 0, samples: [], today: today)
        XCTAssertEqual(e.brewsRemaining, 0)
        XCTAssertEqual(e.daysRemaining, 0)
        XCTAssertEqual(e.brewsText, "不足一次")
    }

    func testLessThanOneDoseLeftSaysSo() {
        let e = ConsumptionEstimator.estimate(remainingG: 8, samples: [BrewSample(date: daysAgo(1), coffeeG: 18)],
                                             today: today)
        XCTAssertEqual(e.averageDoseG, 18, accuracy: 0.001)
        XCTAssertEqual(e.brewsRemaining, 0)
        XCTAssertEqual(e.brewsText, "不足一次")
        XCTAssertEqual(e.daysRemaining, 1)
    }

    func testSamplesWithNoDoseAreIgnored() {
        let samples = [BrewSample(date: daysAgo(3), coffeeG: 0), BrewSample(date: daysAgo(2), coffeeG: 0)]
        let e = ConsumptionEstimator.estimate(remainingG: 100, samples: samples, today: today)
        XCTAssertTrue(e.usedDefaults)
        XCTAssertEqual(e.sampleCount, 0)
    }

    // MARK: - Priority (§17)

    private func candidate(
        _ name: String,
        level: RoastLevel = .light,
        roastedDaysAgo: Int,
        weight: Double = 200,
        remaining: Double = 120,
        samples: [BrewSample] = [],
        lastScore: Int? = nil,
        status: BeanStatus = .active
    ) -> BeanInsight {
        InsightBuilder.insight(
            bean: snapshot(name, level: level, roastedDaysAgo: roastedDaysAgo,
                           weight: weight, remaining: remaining, status: status),
            rule: nil,
            samples: samples,
            lastScore: lastScore,
            today: today
        )
    }

    /// `rank` and `todaysPick` take candidates; the tests mostly care about the
    /// verdict that comes back with them.
    private func candidates(_ items: [BeanInsight]) -> [Candidate] {
        items.map(\.candidate)
    }

    func testAPeakBagOutranksARestingOne() {
        let resting = candidate("Resting", roastedDaysAgo: 1)
        let peak = candidate("Peak", roastedDaysAgo: 10)
        let ranked = PriorityEngine.rank(candidates([resting, peak]))
        XCTAssertEqual(ranked.first?.bean.name, "Peak")
    }

    func testRestingIsNeverTodaysPickWhenAnythingElseIsDrinkable() {
        let restingA = candidate("Resting A", roastedDaysAgo: 1, remaining: 20)
        let restingB = candidate("Resting B", roastedDaysAgo: 2, remaining: 20)
        let pick = PriorityEngine.todaysPick(from: candidates([restingA, restingB]))
        // Both are resting; the app may still lead with one, but it must not
        // claim urgency about it.
        XCTAssertEqual(pick?.verdict.tier, .low)
    }

    func testABagThatCannotBeFinishedInsideItsWindowIsLifted() {
        // Slow drinker: 200g left, one brew a day at 15g → 14 days of coffee,
        // but only 8 days of window.
        let slow = candidate("Slow", roastedDaysAgo: 20, weight: 200, remaining: 200)
        XCTAssertGreaterThan(slow.estimate.daysRemaining, slow.reading.daysUntilWindowEnd)
        XCTAssertTrue(slow.verdict.details.contains("黄金风味期比你的消耗速度更短"))
        XCTAssertGreaterThanOrEqual(slow.verdict.tier, PriorityTier.high)
    }

    func testDeclineingBagWithLotsLeftIsLiftedAboveAFreshPeak() {
        let stale = candidate("Stale", level: .mediumDark, roastedDaysAgo: 30,
                              weight: 250, remaining: 210)
        let fresh = candidate("Fresh", level: .light, roastedDaysAgo: 9,
                              weight: 200, remaining: 150)
        let ranked = PriorityEngine.rank(candidates([fresh, stale]))
        XCTAssertEqual(ranked.first?.bean.name, "Stale")
        XCTAssertEqual(stale.verdict.tier, .high)
        XCTAssertEqual(stale.verdict.closing, "建议优先饮用")
    }

    func testAlmostFinishedBagIsLifted() {
        let nearlyDone = candidate("Nearly", roastedDaysAgo: 12, weight: 200, remaining: 34,
                                   samples: [BrewSample(date: daysAgo(1), coffeeG: 17)])
        XCTAssertTrue(nearlyDone.verdict.details.contains { $0.contains("次的量") })
    }

    func testABadCupIsAReasonToUseItUpRatherThanSaveIt() {
        let withBadScore = candidate("Meh", roastedDaysAgo: 12, lastScore: 2)
        let without = candidate("Unknown", roastedDaysAgo: 12)
        let ranked = PriorityEngine.rank(candidates([without, withBadScore]))
        XCTAssertEqual(ranked.first?.bean.name, "Meh")
        XCTAssertTrue(withBadScore.verdict.details.contains("上次这杯不太理想"))
    }

    func testFinishedBagsAreNeverRecommended() {
        let done = candidate("Finished", roastedDaysAgo: 10, remaining: 0, status: .finished)
        let alive = candidate("Alive", roastedDaysAgo: 2)
        XCTAssertEqual(PriorityEngine.todaysPick(from: candidates([done, alive]))?.bean.name, "Alive")
        XCTAssertEqual(PriorityEngine.todaysPick(from: candidates([done])), nil)
        XCTAssertNotEqual(done.verdict.headline, "现在正处于风味窗口")
    }

    func testRankingIsStableForEqualScores() {
        let a = candidate("Older roast", roastedDaysAgo: 14, remaining: 120)
        let b = candidate("Newer roast", roastedDaysAgo: 12, remaining: 120)
        let ranked = PriorityEngine.rank(candidates([b, a]))
        // Same phase and same stock → the longer-ago roast goes first.
        XCTAssertEqual(ranked.first?.bean.name, "Older roast")
    }

    func testReasonsAreFewAndNeverNumericScores() {
        let busy = candidate("Busy", level: .mediumDark, roastedDaysAgo: 30,
                             weight: 250, remaining: 240, lastScore: 1)
        let verdict = busy.verdict
        XCTAssertFalse(verdict.headline.isEmpty)
        XCTAssertLessThanOrEqual(verdict.details.count, 2)
        for line in verdict.reasons {
            XCTAssertFalse(line.contains("分"), "reasons should never leak a score: \(line)")
        }
    }

    func testABagWithNoRoastDateIsNotRecommendedOnItsOwnMerit() {
        let undated = InsightBuilder.insight(
            bean: BeanSnapshot(name: "Undated", roastLevel: .light, roastDate: nil,
                               weightG: 200, remainingG: 200),
            rule: nil, samples: [], lastScore: nil, today: today
        )
        let dated = candidate("Dated", roastedDaysAgo: 3)
        let ranked = PriorityEngine.rank(candidates([undated, dated]))
        XCTAssertEqual(ranked.first?.bean.name, "Dated")
        XCTAssertTrue(undated.verdict.details.contains("还没有烘焙日期"))
    }

    // MARK: - Insight building

    func testInsightCarriesTheSnapshotThrough() {
        let insight = InsightBuilder.insight(
            bean: snapshot("Guji", level: .light, roastedDaysAgo: 16, weight: 200, remaining: 86),
            rule: nil, samples: [], lastScore: 5, today: today
        )
        XCTAssertEqual(insight.name, "Guji")
        XCTAssertEqual(insight.reading.phase, .peak)
        XCTAssertEqual(insight.bean.remainingG, 86)
        XCTAssertEqual(insight.estimate.brewsRemaining, 6)
        XCTAssertEqual(insight.candidate.lastScore, 5)
    }

    func testPhaseTallyCountsOnlyLiveBags() {
        let beans = [
            snapshot("A", roastedDaysAgo: 10),
            snapshot("B", roastedDaysAgo: 10),
            snapshot("C", roastedDaysAgo: 2),
            snapshot("D", roastedDaysAgo: 10, remaining: 0, status: .finished),
        ]
        let insights = beans.map {
            InsightBuilder.insight(bean: $0, rule: nil, samples: [], lastScore: nil, today: today)
        }
        let tally = InsightFactory.phaseTally(insights)
        let peak = tally.first { $0.phase == .peak }
        XCTAssertEqual(peak?.count, 2)
        XCTAssertNil(tally.first { $0.phase == .declining })
    }
}
