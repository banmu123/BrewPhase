import UserNotifications
import XCTest
@testable import BrewPhase

/// The planner is pure and fully covered in `NotificationPlannerTests`. This covers
/// the other half of the reminder path: turning a planned instant into a real
/// `UNNotificationRequest`.
///
/// Worth testing because this is the part that fails *silently*. A trigger built
/// from the wrong date components looks fine in code and simply never fires, and —
/// as the last test here records — the system accepts a request without complaint
/// even when it is going to discard it.
///
/// What this deliberately does **not** test is delivery, or that a registered
/// request shows up as pending: both require the notification permission to have
/// been granted by a human, which no automated run can do. See the note in
/// `testAddingARequestIsSafeWhetherOrNotItIsAuthorised`.
@MainActor
final class NotificationSchedulingTests: XCTestCase {

    private let center = UNUserNotificationCenter.current()
    private let identifier = "brewphase.test.scheduling"

    override func setUp() async throws {
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    override func tearDown() async throws {
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    private func plan(at offset: TimeInterval, kind: ReminderKind = .windowOpens) -> PlannedReminder {
        PlannedReminder(kind: kind, fireDate: Date().addingTimeInterval(offset), identifier: identifier)
    }

    // MARK: - Shape

    func testTheRequestIsWellFormed() {
        let request = plan(at: 3600).makeRequest(beanName: "Ethiopia Guji")

        XCTAssertEqual(request.identifier, identifier)
        XCTAssertEqual(request.content.title, ReminderKind.windowOpens.title(beanName: "Ethiopia Guji"))
        XCTAssertEqual(request.content.body, ReminderKind.windowOpens.body(beanName: "Ethiopia Guji"))
        XCTAssertNotNil(request.content.sound)
        // The way back to the record, for anything that wants to open the bag.
        XCTAssertEqual(request.content.userInfo["kind"] as? String, ReminderKind.windowOpens.rawValue)
        XCTAssertEqual(request.content.userInfo["identifier"] as? String, identifier)
    }

    func testTheTriggerFiresOnceAtThePlannedMinute() throws {
        let fire = Date().addingTimeInterval(3600)
        let request = PlannedReminder(kind: .windowEnding, fireDate: fire, identifier: identifier)
            .makeRequest(beanName: "Guji")

        let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats, "a one-off milestone must not repeat")

        // The resolved instant must match the planned one to the minute. A dropped
        // component here is exactly the bug that makes reminders never arrive.
        let resolved = try XCTUnwrap(trigger.nextTriggerDate())
        let calendar = Calendar.current
        let planned = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
        let actual = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: resolved)
        XCTAssertEqual(actual.year, planned.year)
        XCTAssertEqual(actual.month, planned.month)
        XCTAssertEqual(actual.day, planned.day)
        XCTAssertEqual(actual.hour, planned.hour)
        XCTAssertEqual(actual.minute, planned.minute)
    }

    func testEveryKindProducesATriggerThatResolvesToADate() throws {
        // A reminder that cannot resolve to a date would be accepted and then
        // never fire, so every kind gets checked rather than just one.
        for kind in ReminderKind.allCases {
            let request = plan(at: 3600 + Double(ReminderKind.allCases.firstIndex(of: kind)!) * 3600, kind: kind)
                .makeRequest(beanName: "Guji")
            let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
            XCTAssertNotNil(trigger.nextTriggerDate(), "\(kind) produced a trigger with no date")
            XCTAssertEqual(request.content.title, kind.title(beanName: "Guji"))
        }
    }

    // MARK: - De-duplication (§39)

    func testTwoPlansOfTheSameKindShareOneRequestIdentifier() {
        // The dedupe guarantee is two facts together: the planner emits a kind at
        // most once (asserted in NotificationPlannerTests), and re-adding the same
        // identifier replaces rather than duplicates (this). Both are deterministic
        // without touching the notification system.
        let earlier = plan(at: 3600)
        let later = plan(at: 7200)

        XCTAssertEqual(earlier.makeRequest(beanName: "Guji").identifier,
                       later.makeRequest(beanName: "Guji").identifier)
    }

    func testDifferentKindsNeverCollide() {
        let identifiers = ReminderKind.allCases.map {
            PlannedReminder(kind: $0, fireDate: Date(), identifier: NotificationPlanner
                .identifier(beanID: UUID(uuidString: "00000000-0000-0000-0000-0000000000AB")!, kind: $0))
                .makeRequest(beanName: "Guji")
                .identifier
        }
        XCTAssertEqual(Set(identifiers).count, ReminderKind.allCases.count)
    }

    // MARK: - The silent-failure hazard

    func testAddingARequestIsSafeWhetherOrNotItIsAuthorised() async throws {
        // Recorded because it is the trap in this whole subsystem: adding a request
        // does not throw when the app is not authorised — it just quietly is not
        // retained. So a scheduler that judged success by "no error thrown" would
        // write reminder rows for notifications that can never be delivered.
        //
        // That is why `NotificationManager.sync` checks `isAuthorized` first and
        // records nothing when it is false. The assertion that would prove the
        // retention behaviour needs the permission to be granted by a human, so it
        // is deliberately not asserted here.
        try await center.add(plan(at: 3600).makeRequest(beanName: "Guji"))
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    func testTheManagerReportsItselfBeforeAnyPermissionIsGranted() {
        XCTAssertFalse(NotificationManager.shared.statusExplanation.isEmpty)
    }
}
