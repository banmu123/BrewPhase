import XCTest
@testable import BrewPhase

/// §39: reminder dates are computed correctly, nothing is registered twice, and a
/// refused permission is a no-op rather than a crash.
final class NotificationPlannerTests: XCTestCase {

    // MARK: - Helpers

    private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 6) -> Date {
        DateMath.calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    /// Early morning, so a reminder at 09:00 on the same day is still ahead.
    private var now: Date { date(2026, 6, 15) }

    private func plan(
        level: RoastLevel = .light,
        roastedDaysAgo: Int,
        openedDaysAgo: Int? = nil,
        remaining: Double = 200,
        samples: [BrewSample] = [],
        preferences: ReminderPreferences = .allEnabled,
        rule: PhaseRuleData? = nil
    ) -> [PlannedReminder] {
        let roastDate = DateMath.add(days: -roastedDaysAgo, to: now)
        let estimate = ConsumptionEstimator.estimate(remainingG: remaining, samples: samples, today: now)
        return NotificationPlanner.plan(
            beanID: UUID(),
            beanName: "Ethiopia Guji",
            roastDate: roastDate,
            openDate: openedDaysAgo.map { DateMath.add(days: -$0, to: now) },
            rule: rule ?? DefaultPhaseRules.data(for: level),
            estimate: estimate,
            preferences: preferences,
            now: now
        )
    }

    // MARK: - Dates

    func testLightRoastPlansFourMomentsAtNineInTheMorning() {
        // Roasted yesterday, so every default milestone is still ahead.
        let planned = plan(roastedDaysAgo: 1)
        XCTAssertEqual(planned.map(\.kind), [.restComplete, .windowOpens, .windowHalfway, .windowEnding])

        // Exhaust ends on day 3, the window opens on day 7, halfway is day 17,
        // and the closing nudge is two days before day 28.
        let roast = DateMath.add(days: -1, to: now)
        XCTAssertEqual(planned[0].fireDate, DateMath.day(roast, plusDays: 3, atHour: 9))
        XCTAssertEqual(planned[1].fireDate, DateMath.day(roast, plusDays: 7, atHour: 9))
        XCTAssertEqual(planned[2].fireDate, DateMath.day(roast, plusDays: 17, atHour: 9))
        XCTAssertEqual(planned[3].fireDate, DateMath.day(roast, plusDays: 26, atHour: 9))

        for reminder in planned {
            XCTAssertEqual(DateMath.calendar.component(.hour, from: reminder.fireDate), 9)
            XCTAssertGreaterThan(reminder.fireDate, now)
        }
    }

    func testRemindersAreOrderedByDate() {
        let planned = plan(roastedDaysAgo: 1)
        XCTAssertEqual(planned.map(\.fireDate), planned.map(\.fireDate).sorted())
    }

    func testEveryRoastLevelPlansWithoutCrashing() {
        for level in RoastLevel.allCases {
            let planned = plan(level: level, roastedDaysAgo: 1)
            XCTAssertFalse(planned.isEmpty, "\(level) planned nothing")
        }
    }

    // MARK: - De-duplication (§39)

    func testEachKindIsPlannedAtMostOnce() {
        let planned = plan(roastedDaysAgo: 1)
        XCTAssertEqual(Set(planned.map(\.kind)).count, planned.count)
    }

    func testIdentifiersAreUniqueAndStable() {
        let id = UUID()
        let first = NotificationPlanner.identifier(beanID: id, kind: .windowOpens)
        let second = NotificationPlanner.identifier(beanID: id, kind: .windowOpens)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first, "brewphase.bean.\(id.uuidString).windowOpens")

        let all = NotificationPlanner.allIdentifiers(beanID: id)
        XCTAssertEqual(all.count, ReminderKind.allCases.count)
        XCTAssertEqual(Set(all).count, all.count)
        XCTAssertTrue(all.contains(first))
    }

    func testPlanningTwiceProducesTheSamePlan() {
        // The scheduler removes a bean's identifiers before re-adding them, so a
        // repeated plan is what makes re-syncing safe.
        let a = plan(roastedDaysAgo: 4)
        let b = plan(roastedDaysAgo: 4)
        XCTAssertEqual(a.map(\.kind), b.map(\.kind))
        XCTAssertEqual(a.map(\.fireDate), b.map(\.fireDate))
    }

    // MARK: - Skipping

    func testMomentsAlreadyInThePastAreNotScheduled() {
        // Roasted 20 days ago: the exhaust, opening and halfway moments are gone.
        let planned = plan(roastedDaysAgo: 20)
        XCTAssertFalse(planned.contains { $0.kind == .restComplete })
        XCTAssertFalse(planned.contains { $0.kind == .windowOpens })
        XCTAssertFalse(planned.contains { $0.kind == .windowHalfway })
        XCTAssertTrue(planned.contains { $0.kind == .windowEnding })
        for reminder in planned {
            XCTAssertGreaterThan(reminder.fireDate, now)
        }
    }

    func testDisablingAKindRemovesItButKeepsTheRest() {
        var preferences = ReminderPreferences.allEnabled
        preferences.set(.windowHalfway, enabled: false)
        preferences.set(.windowEnding, enabled: false)

        let planned = plan(roastedDaysAgo: 1, preferences: preferences)
        XCTAssertEqual(planned.map(\.kind), [.restComplete, .windowOpens])
        XCTAssertFalse(preferences.isEnabled(.windowHalfway))
        XCTAssertTrue(preferences.isEnabled(.restComplete))
        XCTAssertEqual(preferences.enabledCount, 3)
    }

    func testTurningEveryReminderOffPlansNothing() {
        var preferences = ReminderPreferences.allEnabled
        for kind in ReminderKind.allCases { preferences.set(kind, enabled: false) }
        XCTAssertFalse(preferences.allowsAny)
        XCTAssertTrue(plan(roastedDaysAgo: 1, preferences: preferences).isEmpty)
    }

    @MainActor
    func testARefusedPermissionSimplyMeansNothingIsPlanned() {
        // Nothing here touches UNUserNotificationCenter, which is the point: the
        // planner is pure, so a denied app schedules nothing and cannot fail.
        var allOff = ReminderPreferences.allEnabled
        for kind in ReminderKind.allCases { allOff.set(kind, enabled: false) }
        XCTAssertTrue(plan(roastedDaysAgo: 2, preferences: allOff).isEmpty)

        // And the manager can still explain itself when permission is refused,
        // rather than the settings screen showing a blank line.
        let explanation = NotificationManager.shared.statusExplanation
        XCTAssertFalse(explanation.isEmpty)
    }

    // MARK: - The priority nudge

    func testThePriorityNudgeAppearsWhenTheBagCannotBeFinishedInTime() {
        // 200g at the default 15g a day is 14 days of coffee, but only 8 days of
        // window remain. The nudge should land on the day you would need to
        // start drinking faster.
        let planned = plan(roastedDaysAgo: 20, remaining: 200)
        let nudge = planned.first { $0.kind == .brewPriority }
        XCTAssertNotNil(nudge, "expected a priority nudge, got \(planned.map(\.kind))")

        let roast = DateMath.add(days: -20, to: now)
        XCTAssertEqual(nudge?.fireDate, DateMath.day(roast, plusDays: 21, atHour: 9))
        XCTAssertLessThan(nudge!.fireDate, DateMath.day(roast, plusDays: 28, atHour: 9)!)
    }

    func testThePriorityNudgeStaysSilentWhenTheBagWillBeFinishedInTime() {
        // Roasted 20 days ago but nearly empty: it will be gone before the window
        // shuts, so there is nothing to nag about.
        let planned = plan(roastedDaysAgo: 20, remaining: 20)
        XCTAssertFalse(planned.contains { $0.kind == .brewPriority })
    }

    func testThePriorityNudgeIsNeverScheduledInThePast() {
        let planned = plan(roastedDaysAgo: 20, remaining: 200)
        for reminder in planned where reminder.kind == .brewPriority {
            XCTAssertGreaterThan(reminder.fireDate, now)
        }
    }

    func testABagPastItsWindowGetsNoPriorityNudge() {
        let planned = plan(roastedDaysAgo: 40, remaining: 200)
        XCTAssertFalse(planned.contains { $0.kind == .brewPriority })
    }

    // MARK: - Copy

    func testReminderCopyNamesTheBean() {
        for kind in ReminderKind.allCases {
            XCTAssertTrue(kind.title(beanName: "Guji").contains("Guji"))
            XCTAssertTrue(kind.body(beanName: "Guji").contains("Guji"))
            XCTAssertFalse(kind.label.isEmpty)
            XCTAssertFalse(kind.detail.isEmpty)
        }
        // An unnamed bag still reads like a sentence.
        XCTAssertFalse(ReminderKind.windowOpens.title(beanName: "  ").isEmpty)
    }

    // MARK: - Preferences storage

    func testReminderPreferencesRoundTripThroughUserDefaults() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: "brewphase.tests.reminders"))
        suite.removePersistentDomain(forName: "brewphase.tests.reminders")

        // Everything defaults to on.
        XCTAssertEqual(ReminderPreferences.current(from: suite).enabledCount, ReminderKind.allCases.count)

        suite.set(false, forKey: PrefKey.reminderEnabled(.windowEnding))
        let loaded = ReminderPreferences.current(from: suite)
        XCTAssertFalse(loaded.isEnabled(.windowEnding))
        XCTAssertTrue(loaded.isEnabled(.windowOpens))

        suite.removePersistentDomain(forName: "brewphase.tests.reminders")
    }

    func testBrewDefaultsRoundTripThroughUserDefaults() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: "brewphase.tests.defaults"))
        suite.removePersistentDomain(forName: "brewphase.tests.defaults")

        XCTAssertEqual(BrewDefaults.current(from: suite), .standard)

        suite.set("爱乐压", forKey: PrefKey.defaultMethod)
        suite.set(18.0, forKey: PrefKey.defaultDoseG)
        let loaded = BrewDefaults.current(from: suite)
        XCTAssertEqual(loaded.method, "爱乐压")
        XCTAssertEqual(loaded.doseG, 18)
        XCTAssertEqual(loaded.asRecipe.method, "爱乐压")
        XCTAssertEqual(loaded.asRecipe.coffeeG, 18)

        suite.removePersistentDomain(forName: "brewphase.tests.defaults")
    }

    // MARK: - The open date

    func testABagOpenedOnTimeIsScheduledExactlyAsBefore() {
        let onTime = plan(roastedDaysAgo: 1, openedDaysAgo: 1)
        let noOpenDate = plan(roastedDaysAgo: 1)
        XCTAssertEqual(onTime.map(\.fireDate), noOpenDate.map(\.fireDate))
    }

    func testABagOpenedLateGetsItsWindowRemindersPushedBack() throws {
        // Roasted 20 days ago, opened 2 days ago. Every reminder about the end of
        // the window has to move with the phase clock, or the notification would
        // arrive while the app still says the bag is in its window.
        let onTime = plan(roastedDaysAgo: 20)
        let late = plan(roastedDaysAgo: 20, openedDaysAgo: 2)

        let roast = DateMath.add(days: -20, to: now)
        XCTAssertEqual(late.map(\.kind), [.windowHalfway, .windowEnding])
        XCTAssertEqual(late[0].fireDate, DateMath.day(roast, plusDays: 23, atHour: 9))
        XCTAssertEqual(late[1].fireDate, DateMath.day(roast, plusDays: 32, atHour: 9))

        // And the same bag on time closes earlier, which is the whole point.
        //
        // The closing reminder is picked out by kind rather than by position. A
        // bag this old with this much left also earns the priority nudge (see
        // `testThePriorityNudgeAppearsWhenTheBagCannotBeFinishedInTime`, which
        // asks for exactly that with these very inputs), so `onTime[0]` is the
        // nudge, not the closing reminder. `late`'s two kinds are pinned above,
        // so `late[1]` is still safe to index.
        let onTimeClosing = try XCTUnwrap(onTime.first { $0.kind == .windowEnding })
        XCTAssertEqual(onTimeClosing.fireDate, DateMath.day(roast, plusDays: 26, atHour: 9))
        XCTAssertLessThan(onTimeClosing.fireDate, late[1].fireDate)
    }

    func testTheWindowStillOpensOnTheRoastSchedule() {
        // A sealed bag's window starts when the table says it does; only its
        // *end* moves, because the discount only begins once the window is open.
        let planned = plan(roastedDaysAgo: 1, openedDaysAgo: 0)
        let roast = DateMath.add(days: -1, to: now)
        let opens = planned.first { $0.kind == .windowOpens }
        XCTAssertEqual(opens?.fireDate, DateMath.day(roast, plusDays: 7, atHour: 9))
    }
}
