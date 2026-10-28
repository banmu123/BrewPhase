import SwiftData
import UserNotifications
import XCTest
@testable import BrewPhase

/// 恢复备份后的通知协调。
///
/// 用记账替身代替 `UNUserNotificationCenter`：能断言「清了什么、排了什么、
/// 有没有擅自申请权限」，又不会改模拟器的真实通知状态。
@MainActor
final class NotificationReconcileTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private var scheduler: FakeScheduler!
    private var manager: NotificationManager!

    override func setUpWithError() throws {
        let schema = Schema([Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self])
        container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        context = ModelContext(container)
        scheduler = FakeScheduler()
        manager = NotificationManager(scheduler: scheduler)
    }

    override func tearDown() {
        manager = nil
        scheduler = nil
        context = nil
        container = nil
    }

    private func bean(name: String,
                      roastDaysAgo: Int? = 2,
                      finished: Bool = false) -> Bean {
        let bean = Bean(name: name, roastLevel: .light,
                        roastDate: roastDaysAgo.map { DateMath.add(days: -$0, to: Date()) },
                        weightG: 200, remainingG: 200)
        if finished { bean.status = .finished }
        context.insert(bean)
        context.insert(PhaseReminder(kind: .windowOpens,
                                     fireDate: DateMath.add(days: 3, to: Date()),
                                     identifier: NotificationPlanner.identifier(beanID: bean.id,
                                                                               kind: .windowOpens),
                                     bean: bean))
        return bean
    }

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: []) }

    private func reconcile(_ beans: [Bean],
                           preferences: ReminderPreferences = .allEnabled) async -> NotificationManager.SyncReport {
        await manager.reconcileAfterRestore(beans: beans, book: book, context: context,
                                            preferences: preferences)
    }

    // MARK: - 旧通知清理

    func testStaleNotificationsFromRemovedBeansAreCleared() async throws {
        let oldBeanID = UUID()
        scheduler.pending = [NotificationPlanner.identifier(beanID: oldBeanID, kind: .windowOpens)]
        let survivor = bean(name: "留下的")

        await reconcile([survivor])

        XCTAssertEqual(scheduler.removedAllCount, 1, "恢复后必须整体清一次系统通知")
        XCTAssertFalse(scheduler.pending.contains(
            NotificationPlanner.identifier(beanID: oldBeanID, kind: .windowOpens)),
            "已被删除豆子的通知不能继续存在")
        XCTAssertTrue(scheduler.pending.allSatisfy { $0.contains(survivor.id.uuidString) },
                      "重新排上的只能是现存豆子的提醒")
    }

    func testReSchedulesEligibleRestoredBean() async throws {
        let survivor = bean(name: "应重排")
        await reconcile([survivor])

        XCTAssertFalse(scheduler.addedIdentifiers.isEmpty, "有烘焙日期的在喝豆子应重新排程")
        XCTAssertTrue(scheduler.addedIdentifiers.allSatisfy {
            $0.hasPrefix("brewphase.bean.\(survivor.id.uuidString).")
        })
        XCTAssertEqual((survivor.reminders ?? []).count, scheduler.addedIdentifiers.count,
                       "落库的提醒行应与系统待送达一致")
    }

    // MARK: - 不应留下陈旧提醒

    func testFinishedAndDatelessBeansGetNoReminders() async throws {
        let finished = bean(name: "已喝完", finished: true)
        let dateless = bean(name: "没有烘焙日期", roastDaysAgo: nil)
        let active = bean(name: "在喝")

        await reconcile([finished, dateless, active])

        for bean in [finished, dateless] {
            XCTAssertEqual((bean.reminders ?? []).count, 0, "\(bean.name) 不该留下提醒行")
            XCTAssertFalse(scheduler.addedIdentifiers.contains {
                $0.contains(bean.id.uuidString)
            }, "\(bean.name) 不该排程")
        }
        XCTAssertTrue(scheduler.addedIdentifiers.contains {
            $0.contains(active.id.uuidString)
        })
    }

    // MARK: - 权限与偏好

    func testDeniedPermissionClearsRowsAndSchedulesNothing() async throws {
        scheduler.status = .denied
        let survivor = bean(name: "无权限")
        XCTAssertEqual((survivor.reminders ?? []).count, 1)

        let report = await reconcile([survivor])

        XCTAssertTrue(scheduler.addedIdentifiers.isEmpty, "未授权时不得排程")
        XCTAssertEqual((survivor.reminders ?? []).count, 0, "未授权时也不能留下与系统不一致的提醒行")
        XCTAssertEqual(scheduler.requestAuthorizationCalls, 0, "恢复不得触发权限申请")
        XCTAssertTrue(report.isComplete, "未授权属于既定业务状态，不算排程失败")
        XCTAssertTrue(report.added.isEmpty)
    }

    func testAllRemindersDisabledByRestoredPreferences() async throws {
        let survivor = bean(name: "全关")
        let allOff = ReminderPreferences(disabled: Set(ReminderKind.allCases))

        await reconcile([survivor], preferences: allOff)

        XCTAssertTrue(scheduler.addedIdentifiers.isEmpty)
        XCTAssertEqual((survivor.reminders ?? []).count, 0)
    }

    func testReconcileNeverRequestsAuthorization() async throws {
        scheduler.status = .notDetermined
        let survivor = bean(name: "未决定")

        await reconcile([survivor])

        XCTAssertEqual(scheduler.requestAuthorizationCalls, 0)
        XCTAssertTrue(scheduler.addedIdentifiers.isEmpty, "未授权就不排，也不弹系统权限框")
        XCTAssertEqual((survivor.reminders ?? []).count, 0)
    }

    // MARK: - 幂等

    func testIdentifiersAreNotScheduledTwiceInOneReconcile() async throws {
        let survivor = bean(name: "只排一次")
        await reconcile([survivor])

        XCTAssertEqual(scheduler.addedIdentifiers.count,
                       Set(scheduler.addedIdentifiers).count,
                       "同一次协调里同一标识不能排两次")
    }

    // MARK: - 排程结果

    func testAllRemindersScheduledReportsComplete() async throws {
        let survivor = bean(name: "全部成功")
        let report = await reconcile([survivor])

        XCTAssertTrue(report.isComplete)
        XCTAssertTrue(report.clearedAllPending)
        XCTAssertTrue(report.failed.isEmpty)
        XCTAssertEqual(report.added.count, (survivor.reminders ?? []).count)
        XCTAssertEqual(Set(report.added), Set(scheduler.addedIdentifiers))
    }

    func testSingleRefusedReminderReportsPartialFailure() async {
        let survivor = bean(name: "一条失败")
        scheduler.shouldFail = { $0.hasSuffix(".\(ReminderKind.windowOpens.rawValue)") }

        let report = await reconcile([survivor])

        XCTAssertFalse(report.isComplete)
        XCTAssertEqual(report.failed.count, 1, "只应有一条被系统拒绝")
        XCTAssertGreaterThan(report.added.count, 0, "其余提醒仍应排上")
        XCTAssertEqual(report.added.count + report.failed.count,
                       scheduler.attemptedIdentifiers.count)
        XCTAssertEqual((survivor.reminders ?? []).count, report.added.count,
                       "库里只能有系统确认受理的提醒行")
    }

    /// 协调层返回的状态必须是 UI 实际使用的状态。
    func testPartialFailureIsSurfacedToRestoreFlow() async throws {
        _ = bean(name: "部分失败")
        try context.save()
        scheduler.shouldFail = { $0.hasSuffix(".\(ReminderKind.windowOpens.rawValue)") }

        let outcome = await PostRestoreSync.reconcile(container: container, manager: manager)

        XCTAssertEqual(outcome, .partialFailure, "UI 必须看到部分失败，而不是成功")
    }

    func testCompleteReconcileIsSurfacedAsReconciled() async throws {
        _ = bean(name: "全成功")
        try context.save()

        let outcome = await PostRestoreSync.reconcile(container: container, manager: manager)

        XCTAssertEqual(outcome, .reconciled)
    }

    /// 第一次被系统拒绝的提醒，下一次协调能够补上（启动自愈路径）。
    func testNextReconcileRecoversFailedReminder() async {
        let survivor = bean(name: "可恢复")
        scheduler.shouldFail = { $0.hasSuffix(".\(ReminderKind.windowOpens.rawValue)") }
        let first = await reconcile([survivor])
        XCTAssertEqual(first.failed.count, 1)

        scheduler.shouldFail = nil
        let second = await reconcile([survivor])

        XCTAssertTrue(second.isComplete)
        XCTAssertTrue(second.added.contains { $0.hasSuffix(".\(ReminderKind.windowOpens.rawValue)") })
        XCTAssertTrue(scheduler.pending.contains { $0.hasSuffix(".\(ReminderKind.windowOpens.rawValue)") })
    }

    /// 通知失败不能把已经成功的恢复说成回滚。
    func testPartialFailureDoesNotUndoRestoredData() async throws {
        _ = bean(name: "数据仍在新库")
        try context.save()
        scheduler.shouldFail = { _ in true }

        let outcome = await PostRestoreSync.reconcile(container: container, manager: manager)

        XCTAssertEqual(outcome, .partialFailure)
        let stored = try ModelContext(container).fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(stored.count, 1, "数据已恢复是既成事实，不因通知失败回退")
    }

    // MARK: - 恢复后的读取顺序

    /// 读不到恢复后的数据时，必须在清理系统通知之前停下。
    func testLoadFailureLeavesPendingNotificationsUntouched() async {
        scheduler.pending = [NotificationPlanner.identifier(beanID: UUID(), kind: .windowOpens)]

        let outcome = await PostRestoreSync.reconcile(container: container, manager: manager) { _ in
            throw BackupError.missingData
        }

        XCTAssertEqual(outcome, .dataUnavailable)
        XCTAssertEqual(scheduler.removedAllCount, 0, "读不到恢复后的数据时不得清理系统通知")
        XCTAssertFalse(scheduler.pending.isEmpty, "旧通知必须原样保留")
        XCTAssertTrue(scheduler.addedIdentifiers.isEmpty)
    }

    /// 读到了恢复后的数据，才清旧通知、按新数据重排。
    func testSuccessfulLoadReconcilesRestoredData() async throws {
        let restored = bean(name: "恢复后的豆子")
        try context.save()
        scheduler.pending = [NotificationPlanner.identifier(beanID: UUID(), kind: .windowOpens)]

        let outcome = await PostRestoreSync.reconcile(container: container, manager: manager)

        XCTAssertEqual(outcome, .reconciled)
        XCTAssertEqual(scheduler.removedAllCount, 1)
        XCTAssertTrue(scheduler.addedIdentifiers.contains { $0.contains(restored.id.uuidString) },
                      "恢复后的豆子必须重新排上提醒")
    }

    /// 通知层出问题时，库里的数据不受影响——恢复成功是既成事实。
    func testLoadFailureDoesNotAlterStoredData() async throws {
        _ = bean(name: "数据不受通知影响")
        try context.save()

        _ = await PostRestoreSync.reconcile(container: container, manager: manager) { _ in
            throw BackupError.missingData
        }

        let stored = try ModelContext(container).fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?.name, "数据不受通知影响")
    }
}

@MainActor
private final class FakeScheduler: NotificationScheduling {

    var status: UNAuthorizationStatus = .authorized
    var pending: Set<String> = []
    /// 返回 true 的标识在 add 时抛错，用来模拟系统拒绝某条提醒。
    var shouldFail: ((String) -> Bool)?
    private(set) var removedAllCount = 0
    private(set) var addedIdentifiers: [String] = []
    private(set) var attemptedIdentifiers: [String] = []
    private(set) var requestAuthorizationCalls = 0

    func notificationStatus() async -> UNAuthorizationStatus { status }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        requestAuthorizationCalls += 1
        return false
    }

    func removeAllPending() {
        removedAllCount += 1
        pending.removeAll()
    }

    func removePending(identifiers: [String]) {
        for identifier in identifiers { pending.remove(identifier) }
    }

    func add(_ request: UNNotificationRequest) async throws {
        attemptedIdentifiers.append(request.identifier)
        if shouldFail?(request.identifier) == true {
            throw NSError(domain: "FakeScheduler", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "system refused"])
        }
        addedIdentifiers.append(request.identifier)
        pending.insert(request.identifier)
    }

    func pendingCount() async -> Int { pending.count }
}
