import Foundation
import SwiftData
import UserNotifications

/// Schedules (and re-schedules) the five local reminders (§10).
///
/// The app never runs in the background to work these out: every reminder for a
/// bag is computed up front, at the moment the bag is added or changed, and
/// handed to the system. That is why all the date arithmetic lives in
/// `NotificationPlanner` — it runs once, here, and cannot be corrected later.
@MainActor
final class NotificationManager {

    /// 一次排程尝试的结果。
    ///
    /// `added` 只包含**系统确认受理**的标识：只有 add 成功之后才写提醒行，
    /// 所以库里「有行」和系统「有请求」始终一致。`failed` 里的提醒不会留下
    /// 半真半假的记录，下次启动 `refreshAll` 会重新计算并补排。
    struct SyncReport: Equatable {
        /// 是否已清空本 App 的全部待送达请求（只有恢复协调会做这件事）。
        var clearedAllPending = false
        var added: [String] = []
        var failed: [String] = []

        var isComplete: Bool { failed.isEmpty }

        mutating func absorb(_ other: SyncReport) {
            clearedAllPending = clearedAllPending || other.clearedAllPending
            added.append(contentsOf: other.added)
            failed.append(contentsOf: other.failed)
        }
    }

    static let shared = NotificationManager()

    private let scheduler: NotificationScheduling

    /// Last known permission state, for the settings screen to explain itself.
    private(set) var status: UNAuthorizationStatus = .notDetermined

    /// 默认走系统通知中心；测试可以注入一个只记账的替身，验证「清了哪些、
    /// 排了哪些」而不真的触碰模拟器的通知状态。
    init(scheduler: NotificationScheduling? = nil) {
        self.scheduler = scheduler ?? SystemNotificationScheduler()
    }

    // MARK: - Permission

    func refreshStatus() async {
        status = await scheduler.notificationStatus()
    }

    /// Asks once. Never crashes when permission is refused — a denied app just
    /// stops scheduling (§31).
    @discardableResult
    func requestAuthorizationIfNeeded(defaults: UserDefaults = .standard) async -> Bool {
        await refreshStatus()

        switch status {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied:
            return false
        case .notDetermined:
            guard !defaults.bool(forKey: PrefKey.askedForNotifications) else { return false }
            defaults.set(true, forKey: PrefKey.askedForNotifications)
            do {
                let granted = try await scheduler.requestAuthorization(options: [.alert, .sound, .badge])
                await refreshStatus()
                AppLog.notifications.info("authorization granted: \(granted)")
                return granted
            } catch {
                AppLog.notifications.error("authorization failed: \(error.localizedDescription, privacy: .public)")
                await refreshStatus()
                return false
            }
        @unknown default:
            return false
        }
    }

    var isAuthorized: Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    var statusExplanation: String {
        switch status {
        case .authorized, .provisional, .ephemeral:
            return L("提醒会根据每包豆子的烘焙日期自动排好")
        case .denied:
            return L("系统通知权限已关闭，提醒不会送达。可以在「设置 › 通知 › BrewPhase」里重新打开。")
        case .notDetermined:
            return L("还没有请求通知权限，添加第一包豆子时会问一次")
        @unknown default:
            return ""
        }
    }

    // MARK: - Syncing one bag

    /// Rebuilds every reminder for a bag.
    ///
    /// Idempotent by construction: all of the bag's identifiers are removed
    /// first, and the planner emits each kind at most once, so calling this twice
    /// cannot produce two notifications for the same moment (§39).
    @discardableResult
    func sync(
        bean: Bean,
        rule: PhaseRuleData,
        estimate: ConsumptionEstimate,
        context: ModelContext,
        preferences: ReminderPreferences = .current(),
        now: Date = Date()
    ) async -> SyncReport {
        var report = SyncReport()
        let ids = NotificationPlanner.allIdentifiers(beanID: bean.id)
        scheduler.removePending(identifiers: ids)

        // Forget what we previously intended for this bag.
        for row in bean.reminders ?? [] { context.delete(row) }
        bean.reminders = []

        guard let roastDate = bean.roastDate else {
            commit(context, note: "cleared bag without roast date")
            return report
        }

        guard preferences.allowsAny else {
            commit(context, note: "cleared bag with reminders disabled")
            AppLog.notifications.debug("all reminders disabled; cleared bag")
            return report
        }

        let planned = NotificationPlanner.plan(
            beanID: bean.id,
            beanName: bean.name,
            roastDate: roastDate,
            openDate: bean.openDate,
            rule: rule,
            estimate: estimate,
            preferences: preferences,
            now: now
        )

        guard isAuthorized else {
            // Record nothing: an unscheduled reminder in the export would be a
            // lie about what the app will actually do.
            commit(context, note: "cleared bag without notification permission")
            AppLog.notifications.debug("not authorized; planned \(planned.count) but scheduled none")
            return report
        }

        for plan in planned {
            do {
                try await scheduler.add(plan.makeRequest(beanName: bean.name))
                let row = PhaseReminder(kind: plan.kind, fireDate: plan.fireDate,
                                        identifier: plan.identifier, bean: bean)
                context.insert(row)
                report.added.append(plan.identifier)
            } catch {
                // 系统拒绝的不写行：宁可在库里缺这一条、下次启动重试，
                // 也不能让导出显示一条其实永远不会响的提醒。
                report.failed.append(plan.identifier)
                AppLog.notifications.error("failed to schedule \(plan.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }

        commit(context, note: "reminder rows for \(bean.name)")
        AppLog.notifications.info("scheduled \(report.added.count)/\(planned.count) reminder(s) for \(bean.name, privacy: .public)")
        return report
    }

    /// Removes a bag's reminders, both from the system and from the store. Called
    /// before a bean is deleted so no notification arrives for a bag that is gone.
    func cancel(bean: Bean, context: ModelContext) {
        scheduler.removePending(identifiers: NotificationPlanner.allIdentifiers(beanID: bean.id))
        for row in bean.reminders ?? [] { context.delete(row) }
        bean.reminders = []
        commit(context, note: "cancelled reminders for \(bean.name)")
    }

    /// 只清系统里的待送达提醒，不碰库。删除豆子时用它收尾：库里的提醒行已经
    /// 随级联删除走了，不需要（也不能）再动上下文。
    func unschedule(identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        scheduler.removePending(identifiers: identifiers)
    }

    /// Drops every identifier for every bag. Used by "turn reminders off" and by
    /// the settings screen when permission is revoked.
    func cancelAll() {
        scheduler.removeAllPending()
    }

    // MARK: - Launch refresh

    /// Re-plans on launch.
    ///
    /// This is also the recovery path for a bag whose window moved because the
    /// user edited its rule, and for stale reminders left over from a previous
    /// version of the rules.
    @discardableResult
    func refreshAll(
        beans: [Bean],
        book: PhaseRuleBook,
        context: ModelContext,
        preferences: ReminderPreferences = .current()
    ) async -> SyncReport {
        await refreshStatus()

        var report = SyncReport()
        for bean in beans where !bean.isFinished {
            guard bean.roastDate != nil else { continue }
            let insight = InsightFactory.insight(for: bean, book: book)
            let one = await sync(bean: bean,
                                 rule: book.rule(for: bean.roastLevel),
                                 estimate: insight.estimate,
                                 context: context,
                                 preferences: preferences)
            report.absorb(one)
        }
        return report
    }

    // MARK: - 恢复备份之后

    /// 用备份替换数据库之后重建提醒。
    ///
    /// 必须由调用方在**数据库保存成功之后**调用：这里的每一步都会动系统状态，
    /// 恢复失败时提前清通知会让用户丢掉原本还会响的提醒。
    ///
    /// 备份里的 `PhaseReminder` 行是派生数据——每次启动都会按当时的规则与偏好
    /// 整体重排，所以不能因为备份里有这些行就认为系统通知已恢复。次序：
    /// 1. 清掉本 App 的全部待送达请求（已删除豆子的旧提醒也在这里被清掉；
    ///    `refreshAll` 只遍历现存豆子，做不到这件事）；
    /// 2. 删除所有提醒行——包括已结束、没有烘焙日期的豆子，`refreshAll` 会跳过
    ///    它们，若不清就会留下与规则不一致的陈旧行；
    /// 3. 按恢复后的豆子、规则、偏好与当前授权状态重新排程。未授权时只清不排，
    ///    不触发权限申请。
    @discardableResult
    func reconcileAfterRestore(
        beans: [Bean],
        book: PhaseRuleBook,
        context: ModelContext,
        preferences: ReminderPreferences = .current()
    ) async -> SyncReport {
        await refreshStatus()
        AppLog.notifications.info("reconciling notifications after restore")

        cancelAll()

        for bean in beans {
            for row in bean.reminders ?? [] { context.delete(row) }
            bean.reminders = []
        }
        commit(context, note: "cleared derived reminders after restore")

        var report = await refreshAll(beans: beans, book: book, context: context,
                                      preferences: preferences)
        report.clearedAllPending = true

        // 一条日志说清「清了什么、排上了什么、失败了几条」——排查提醒丢失时
        // 这是唯一能还原现场的地方。失败明细在 `sync` 里逐条记过。
        AppLog.notifications.info(
            "notification reconciliation finished: clearedAll=\(report.clearedAllPending), added=\(report.added.count), failed=\(report.failed.count)"
        )
        if !report.isComplete {
            AppLog.notifications.error(
                "some reminders could not be scheduled; they will be retried on next launch"
            )
        }
        return report
    }

    /// How many reminders are actually waiting, for the settings screen.
    func pendingCount() async -> Int {
        await scheduler.pendingCount()
    }

    // MARK: - Writing

    /// 落库提醒行；失败记日志并回滚，不往上抛。
    ///
    /// 提醒是**派生数据**：每次启动都会按当前规则整体重排，一次落库失败会在
    /// 下次启动自愈。所以这里不做 UI 反馈——但也不能像以前那样悄悄吞掉，
    /// 日志是排查「提醒为什么没排上」时唯一的线索。
    private func commit(_ context: ModelContext, note: String) {
        do {
            try context.save()
        } catch {
            AppLog.notifications.error(
                "save failed after \(note, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
            context.rollback()
        }
    }
}

extension PlannedReminder {

    /// The system request this plan becomes.
    ///
    /// Built here rather than inline in the scheduler so the trigger's date
    /// components can be asserted on directly — a trigger built from the wrong
    /// components is the one failure mode that looks correct in code and silently
    /// never fires.
    func makeRequest(beanName: String) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = kind.title(beanName: beanName)
        content.body = kind.body(beanName: beanName)
        content.sound = .default
        // The identifier already carries the bean's UUID, so it is the way back.
        content.userInfo = ["kind": kind.rawValue, "identifier": identifier]

        let components = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute], from: fireDate
        )
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        return UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
    }
}

/// `UNUserNotificationCenter` 的最小可替身接口。
///
/// 只抽恢复流程需要的那几个动作，不重写提醒系统：生产用系统实现，测试用记账
/// 替身验证「清了什么、排了什么」。权限查询与申请也在这里，方便断言
/// 「未授权时不排程、也绝不申请权限」。
@MainActor
protocol NotificationScheduling: AnyObject {
    func notificationStatus() async -> UNAuthorizationStatus
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func removeAllPending()
    func removePending(identifiers: [String])
    func add(_ request: UNNotificationRequest) async throws
    func pendingCount() async -> Int
}

@MainActor
final class SystemNotificationScheduler: NotificationScheduling {

    private let center = UNUserNotificationCenter.current()

    func notificationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await center.requestAuthorization(options: options)
    }

    func removeAllPending() {
        center.removeAllPendingNotificationRequests()
    }

    func removePending(identifiers: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await center.add(request)
    }

    func pendingCount() async -> Int {
        await center.pendingNotificationRequests().count
    }
}
