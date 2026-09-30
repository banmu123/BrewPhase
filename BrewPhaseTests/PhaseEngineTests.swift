import XCTest
@testable import BrewPhase

/// §39: the phase engine, per roast level, plus every awkward date case in §31.
///
/// Everything here is a pure function of (snapshot, rule, today), which is the
/// whole point of keeping the engine separate from the store.
final class PhaseEngineTests: XCTestCase {

    // MARK: - Helpers

    /// Midday, so no test can be tripped by a daylight-saving boundary.
    private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Date {
        DateMath.calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    private func reading(
        level: RoastLevel,
        roastedDaysAgo: Int,
        openedDaysAgo: Int? = nil,
        today: Date,
        rule: PhaseRuleData? = nil,
        remaining: Double = 200
    ) -> PhaseReading {
        let snapshot = BeanSnapshot(
            name: "Test",
            roastLevel: level,
            roastDate: DateMath.add(days: -roastedDaysAgo, to: today),
            openDate: openedDaysAgo.map { DateMath.add(days: -$0, to: today) },
            weightG: 200,
            remainingG: remaining
        )
        return PhaseEngine.reading(for: snapshot, rule: rule, today: today)
    }

    private let today = Date(timeIntervalSince1970: 1_780_000_000)

    // MARK: - Day counting

    func testDayAfterRoastIsZeroOnRoastDay() {
        let r = reading(level: .light, roastedDaysAgo: 0, today: today)
        XCTAssertEqual(r.dayAfterRoast, 0)
        XCTAssertEqual(r.phase, .resting)
    }

    func testDayCountingCrossesAMonthBoundary() {
        let roast = date(2026, 1, 28)
        let now = date(2026, 2, 5)
        XCTAssertEqual(DateMath.daysBetween(roast, now), 8)
    }

    func testDayCountingCrossesAYearBoundary() {
        let roast = date(2025, 12, 28)
        let now = date(2026, 1, 6)
        XCTAssertEqual(DateMath.daysBetween(roast, now), 9)
    }

    func testDayCountingAcrossLeapDay() {
        // 2024 is a leap year: 20 Feb → 2 Mar spans the 29th.
        XCTAssertTrue(DateMath.isLeapYear(2024))
        XCTAssertEqual(DateMath.daysBetween(date(2024, 2, 20), date(2024, 3, 2)), 11)
        // 2025 is not.
        XCTAssertFalse(DateMath.isLeapYear(2025))
        XCTAssertEqual(DateMath.daysBetween(date(2025, 2, 20), date(2025, 3, 2)), 10)
    }

    func testTimeOfDayDoesNotChangeTheDayNumber() {
        let roast = date(2026, 5, 10, hour: 23)
        let now = date(2026, 5, 11, hour: 1)
        XCTAssertEqual(DateMath.daysBetween(roast, now), 1)
    }

    // MARK: - Phases per roast level (§7)

    func testLightRoastPhases() {
        // rest 3–7, window 7–28
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 0, today: today).phase, .resting)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 2, today: today).phase, .resting)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 3, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 6, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 7, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 27, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 28, today: today).phase, .declining)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 60, today: today).phase, .declining)
    }

    func testMediumRoastPhases() {
        // rest 2–5, window 5–21
        XCTAssertEqual(reading(level: .medium, roastedDaysAgo: 1, today: today).phase, .resting)
        XCTAssertEqual(reading(level: .medium, roastedDaysAgo: 2, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .medium, roastedDaysAgo: 4, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .medium, roastedDaysAgo: 5, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .medium, roastedDaysAgo: 20, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .medium, roastedDaysAgo: 21, today: today).phase, .declining)
    }

    func testMediumDarkRoastPhases() {
        // rest 1–3, window 3–14
        XCTAssertEqual(reading(level: .mediumDark, roastedDaysAgo: 0, today: today).phase, .resting)
        XCTAssertEqual(reading(level: .mediumDark, roastedDaysAgo: 1, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .mediumDark, roastedDaysAgo: 2, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .mediumDark, roastedDaysAgo: 3, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .mediumDark, roastedDaysAgo: 13, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .mediumDark, roastedDaysAgo: 14, today: today).phase, .declining)
    }

    func testDarkRoastSharesTheMediumDarkWindow() {
        // The §7 table treats 中深烘 and 深烘 as one row. They stay separate
        // edible rows in the editor, but the numbers start out identical.
        let dark = DefaultPhaseRules.data(for: .dark)
        let mediumDark = DefaultPhaseRules.data(for: .mediumDark)
        XCTAssertEqual(dark.restMinDays, mediumDark.restMinDays)
        XCTAssertEqual(dark.restMaxDays, mediumDark.restMaxDays)
        XCTAssertEqual(dark.peakStartDay, mediumDark.peakStartDay)
        XCTAssertEqual(dark.peakEndDay, mediumDark.peakEndDay)
        XCTAssertEqual(dark.declineStartDay, mediumDark.declineStartDay)
        XCTAssertNotEqual(dark.roastLevel, mediumDark.roastLevel)
    }

    func testEspressoBlendRestsLongerThanItPeaks() {
        // rest 5–14 with a window starting at 7: the exhaust overlaps the window,
        // but the peak still starts on day 7 as the table says.
        XCTAssertEqual(reading(level: .espressoBlend, roastedDaysAgo: 4, today: today).phase, .resting)
        XCTAssertEqual(reading(level: .espressoBlend, roastedDaysAgo: 5, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .espressoBlend, roastedDaysAgo: 6, today: today).phase, .opening)
        XCTAssertEqual(reading(level: .espressoBlend, roastedDaysAgo: 7, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .espressoBlend, roastedDaysAgo: 20, today: today).phase, .peak)
        XCTAssertEqual(reading(level: .espressoBlend, roastedDaysAgo: 21, today: today).phase, .declining)
    }

    func testEveryDefaultRuleProducesAllFourPhases() {
        // A phase that no default rule can reach would be dead vocabulary.
        for level in RoastLevel.allCases {
            let rule = DefaultPhaseRules.data(for: level)
            let bounds = PhaseEngine.boundaries(for: rule)
            let reached = Set((0...60).map { PhaseEngine.phase(dayAfterRoast: $0, rule: rule) })
            XCTAssertEqual(reached.count, 4, "\(level) only reaches \(reached)")
            XCTAssertLessThan(bounds.restEnd, bounds.peakStart)
            XCTAssertLessThan(bounds.peakStart, bounds.peakEnd)
        }
    }

    // MARK: - Horizons

    func testCountdownToWindowAndToDecline() {
        let r = reading(level: .light, roastedDaysAgo: 16, today: today)
        XCTAssertEqual(r.phase, .peak)
        XCTAssertEqual(r.daysUntilPeakStart, 0)
        XCTAssertEqual(r.daysUntilWindowEnd, 12)   // day 28 − day 16
    }

    func testDaysUntilPeakStartCountsDownWhileResting() {
        let r = reading(level: .light, roastedDaysAgo: 2, today: today)
        XCTAssertEqual(r.daysUntilPeakStart, 5)
    }

    func testWindowEndGoesNegativeAfterTheWindow() {
        let r = reading(level: .light, roastedDaysAgo: 30, today: today)
        XCTAssertEqual(r.daysUntilWindowEnd, -2)
    }

    // MARK: - Track geometry

    func testTrackSegmentsCoverTheWholeBar() {
        for level in RoastLevel.allCases {
            let r = reading(level: level, roastedDaysAgo: 10, today: today)
            let segments = r.trackSegments
            XCTAssertEqual(segments.first?.start ?? -1, 0, accuracy: 0.0001)
            XCTAssertEqual(segments.last?.end ?? -1, 1, accuracy: 0.0001)
            for (a, b) in zip(segments, segments.dropFirst()) {
                XCTAssertEqual(a.end, b.start, accuracy: 0.0001, "\(level) has a gap in the track")
            }
            for segment in segments {
                XCTAssertGreaterThan(segment.width, 0)
            }
        }
    }

    func testTrackProgressStaysInsideTheBar() {
        for days in [0, 3, 7, 16, 28, 90] {
            let r = reading(level: .light, roastedDaysAgo: days, today: today)
            XCTAssertGreaterThanOrEqual(r.progress, 0)
            XCTAssertLessThanOrEqual(r.progress, 1)
        }
    }

    func testProgressAdvancesWithTime() {
        let early = reading(level: .light, roastedDaysAgo: 2, today: today).progress
        let late = reading(level: .light, roastedDaysAgo: 20, today: today).progress
        XCTAssertLessThan(early, late)
    }

    // MARK: - Awkward records (§31)

    func testMissingRoastDateIsReportedNotGuessed() {
        let snapshot = BeanSnapshot(name: "No date", roastLevel: .light, roastDate: nil,
                                    weightG: 200, remainingG: 100)
        let r = PhaseEngine.reading(for: snapshot, today: today)
        XCTAssertNil(r.dayAfterRoast)
        XCTAssertEqual(r.problem, .missingRoastDate)
        XCTAssertEqual(r.progress, 0)
        XCTAssertFalse(PhaseEngine.isJudgeable(snapshot))
        XCTAssertFalse(r.problem!.message.isEmpty)
    }

    func testFutureRoastDateIsFlaggedAndClampedToDayZero() {
        let snapshot = BeanSnapshot(name: "From the future", roastLevel: .light,
                                    roastDate: DateMath.add(days: 5, to: today),
                                    weightG: 200, remainingG: 200)
        let r = PhaseEngine.reading(for: snapshot, today: today)
        XCTAssertEqual(r.problem, .roastDateInFuture)
        XCTAssertEqual(r.dayAfterRoast, 0)
        XCTAssertEqual(r.phase, .resting)
    }

    func testOpenDateIsOptional() {
        // Still optional, and a bag with no open date is judged exactly as it was
        // before the open date was allowed to matter.
        let snapshot = BeanSnapshot(name: "Sealed", roastLevel: .light,
                                    roastDate: DateMath.add(days: -10, to: today),
                                    weightG: 200, remainingG: 200)
        let r = PhaseEngine.reading(for: snapshot, today: today)
        XCTAssertEqual(r.phase, .peak)
        XCTAssertEqual(r.sealedShiftDays, 0)
        XCTAssertEqual(r.effectiveDay, r.dayAfterRoast)
    }

    func testZeroRemainingStillHasAPhase() {
        let r = reading(level: .light, roastedDaysAgo: 10, today: today, remaining: 0)
        XCTAssertEqual(r.phase, .peak)
    }

    // MARK: - The open date

    func testOpeningBeforeTheWindowChangesNothing() {
        // The ordinary case: you opened the bag during (or before) the exhaust
        // period, so the roast date remains the only clock. Light roasts open on
        // day 7, so anything at or before that must be a no-op.
        //
        // `openedDaysAgo` counts back from *today*; this test thinks in "which day
        // after roast was it opened". A bag roasted 20 days ago and opened on day
        // N was therefore opened `20 - N` days ago. Passing the day number
        // straight into `openedDaysAgo` asks about a bag opened on day 20/18/15/13
        // — all of which sit *past* the window opening, and are supposed to shift.
        func readingOpened(onDay openedOnDay: Int) -> PhaseReading {
            reading(level: .light, roastedDaysAgo: 20,
                    openedDaysAgo: 20 - openedOnDay, today: today)
        }

        for openedOnDay in [0, 2, 5, 7] {
            let r = readingOpened(onDay: openedOnDay)
            XCTAssertEqual(r.sealedShiftDays, 0,
                           "opening on day \(openedOnDay) should not shift anything")
            XCTAssertEqual(r.effectiveDay, 20)
        }

        // And the boundary is real, not a comfortable margin: the very next day
        // already costs a sealed half-day, which is what "at or before day 7"
        // means. Without this the test would also pass if the discount never
        // started at all.
        let justLate = readingOpened(onDay: 8)
        XCTAssertEqual(justLate.sealedShiftDays, 1, "opening on day 8 should already cost a day")
        XCTAssertEqual(justLate.effectiveDay, 19)
    }

    func testOpeningLateKeepsABagInItsWindow() {
        // Roasted 30 days ago but only opened 10 days ago: it sat sealed for 20
        // days, 13 of them past the day its window opened. On day 30 the raw
        // count says "declining"; the coffee has not been exposed that long.
        let raw = reading(level: .light, roastedDaysAgo: 30, today: today)
        XCTAssertEqual(raw.phase, .declining)
        XCTAssertEqual(raw.sealedShiftDays, 0)

        let late = reading(level: .light, roastedDaysAgo: 30, openedDaysAgo: 10, today: today)
        XCTAssertEqual(late.phase, .peak)
        XCTAssertGreaterThan(late.sealedShiftDays, 0)
        XCTAssertEqual(late.effectiveDay, 30 - late.sealedShiftDays)
        // The reported age is still the honest one — only the phase moved.
        XCTAssertEqual(late.dayAfterRoast, 30)
    }

    func testSealedDaysAreDiscountedNotIgnored() {
        // A bag forgotten in a cupboard for four months must not still read as
        // peak. The discount is a rate, not a reset.
        let r = reading(level: .light, roastedDaysAgo: 150, openedDaysAgo: 30, today: today)
        XCTAssertEqual(r.phase, .declining)
    }

    func testTheDiscountAccruesAndNeverRunsBackwards() {
        // A bag that is *still sealed* must not be judged by a discount it has
        // not earned yet, so the effective day has to increase with the real day.
        let snapshot = BeanSnapshot(name: "T", roastLevel: .light,
                                    roastDate: DateMath.add(days: -40, to: today),
                                    openDate: DateMath.add(days: -20, to: today),
                                    weightG: 200, remainingG: 200)
        let openDay = PhaseEngine.openDayAfterRoast(snapshot)!
        XCTAssertEqual(openDay, 20)

        var previous = -1
        for day in 0...60 {
            let effective = PhaseEngine.effectiveDay(dayAfterRoast: day,
                                                     openDayAfterRoast: openDay,
                                                     rule: DefaultPhaseRules.data(for: .light))
            XCTAssertGreaterThanOrEqual(effective, previous, "phase clock went backwards at day \(day)")
            XCTAssertLessThanOrEqual(effective, day, "the phase clock can never run ahead")
            previous = effective
        }
        // Past the open day the discount is fixed, so the clock runs at 1:1 again.
        let a = PhaseEngine.effectiveDay(dayAfterRoast: 40, openDayAfterRoast: openDay, rule: DefaultPhaseRules.data(for: .light))
        let b = PhaseEngine.effectiveDay(dayAfterRoast: 50, openDayAfterRoast: openDay, rule: DefaultPhaseRules.data(for: .light))
        XCTAssertEqual(b - a, 10)
    }

    func testDayReachingIsTheExactInverseOfEffectiveDay() {
        // Reminders fire on a calendar morning but are about a moment on the
        // phase clock, so this inverse is what keeps them telling the truth.
        let rule = DefaultPhaseRules.data(for: .light)
        for openDay in [nil, 3, 9, 20, 40] as [Int?] {
            for target in [3, 7, 12, 17, 26, 28] {
                let day = PhaseEngine.dayReaching(target, rule: rule, openDayAfterRoast: openDay)
                let reached = PhaseEngine.effectiveDay(dayAfterRoast: day,
                                                       openDayAfterRoast: openDay, rule: rule)
                XCTAssertGreaterThanOrEqual(reached, target,
                                            "openDay \(String(describing: openDay)), target \(target)")
                if day > target {
                    let before = PhaseEngine.effectiveDay(dayAfterRoast: day - 1,
                                                          openDayAfterRoast: openDay, rule: rule)
                    XCTAssertLessThan(before, target, "day \(day) is not the earliest for target \(target)")
                }
            }
        }
    }

    func testTimelinePhaseUsesTheSameDiscountAsTheReading() {
        // Otherwise the dot colours would contradict the phase card on the very
        // same screen.
        let snapshot = BeanSnapshot(name: "T", roastLevel: .light,
                                    roastDate: DateMath.add(days: -30, to: today),
                                    openDate: DateMath.add(days: -10, to: today),
                                    weightG: 200, remainingG: 200)
        let reading = PhaseEngine.reading(for: snapshot, today: today)
        let timelinePhase = PhaseEngine.phase(dayAfterRoast: reading.dayAfterRoast!,
                                              bean: snapshot,
                                              rule: DefaultPhaseRules.data(for: .light))
        XCTAssertEqual(timelinePhase, reading.phase)
    }

    // MARK: - Custom rules

    func testCustomRuleMovesTheWindow() {
        let fast = PhaseRuleData(roastLevel: .light, restMinDays: 1, restMaxDays: 2,
                                 peakStartDay: 2, peakEndDay: 6, declineStartDay: 6, enabled: true)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 4, today: today, rule: fast).phase, .peak)
        XCTAssertEqual(reading(level: .light, roastedDaysAgo: 7, today: today, rule: fast).phase, .declining)
    }

    func testDisabledDefaultRuleIsNotUsedWhenACustomRuleIsSupplied() {
        let r = reading(level: .light, roastedDaysAgo: 10, today: today, rule: nil)
        XCTAssertTrue(r.usesDefaultRule)
        let custom = reading(level: .light, roastedDaysAgo: 10, today: today,
                             rule: DefaultPhaseRules.data(for: .light))
        XCTAssertFalse(custom.usesDefaultRule)
    }

    func testNormalizationRepairsNonsense() {
        let broken = PhaseRuleData(roastLevel: .light, restMinDays: -5, restMaxDays: 2,
                                   peakStartDay: 9, peakEndDay: 3, declineStartDay: 0, enabled: true)
        let fixed = broken.normalized()
        XCTAssertEqual(fixed.restMinDays, 0)
        XCTAssertGreaterThan(fixed.restMaxDays, fixed.restMinDays - 1)
        XCTAssertLessThanOrEqual(fixed.restMaxDays, fixed.peakStartDay)
        XCTAssertGreaterThan(fixed.peakEndDay, fixed.peakStartDay)
        XCTAssertGreaterThanOrEqual(fixed.declineStartDay, fixed.peakStartDay + 1)

        // The engine must still answer sensibly for a broken rule.
        let bounds = PhaseEngine.boundaries(for: broken)
        XCTAssertLessThan(bounds.restEnd, bounds.peakEnd)
        XCTAssertLessThan(bounds.peakStart, bounds.peakEnd)
    }

    func testPeakEndEarlierThanDeclineStartStillYieldsAWindow() {
        // A hand-edited rule where the window "ends" before decline "begins".
        let odd = PhaseRuleData(roastLevel: .medium, restMinDays: 2, restMaxDays: 3,
                                peakStartDay: 4, peakEndDay: 10, declineStartDay: 20, enabled: true)
        let bounds = PhaseEngine.boundaries(for: odd)
        XCTAssertEqual(bounds.peakEnd, 20)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: 15, rule: odd), .peak)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: 20, rule: odd), .declining)
    }
}
