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

    static let shared = NotificationManager()

    private let center = UNUserNotificationCenter.current()

    /// Last known permission state, for the settings screen to explain itself.
    private(set) var status: UNAuthorizationStatus = .notDetermined

    private init() {}

    // MARK: - Permission

    func refreshStatus() async {
        let settings = await center.notificationSettings()
        status = settings.authorizationStatus
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
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
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
    func sync(
        bean: Bean,
        rule: PhaseRuleData,
        estimate: ConsumptionEstimate,
        context: ModelContext,
        preferences: ReminderPreferences = .current(),
        now: Date = Date()
    ) async {
        let ids = NotificationPlanner.allIdentifiers(beanID: bean.id)
        center.removePendingNotificationRequests(withIdentifiers: ids)

        // Forget what we previously intended for this bag.
        for row in bean.reminders ?? [] { context.delete(row) }
        bean.reminders = []

        guard let roastDate = bean.roastDate else {
            commit(context, note: "cleared bag without roast date")
            return
        }

        guard preferences.allowsAny else {
            commit(context, note: "cleared bag with reminders disabled")
            AppLog.notifications.debug("all reminders disabled; cleared bag")
            return
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
            return
        }

        for plan in planned {
            do {
                try await center.add(plan.makeRequest(beanName: bean.name))
                let row = PhaseReminder(kind: plan.kind, fireDate: plan.fireDate,
                                        identifier: plan.identifier, bean: bean)
                context.insert(row)
            } catch {
                AppLog.notifications.error("failed to schedule \(plan.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }

        commit(context, note: "reminder rows for \(bean.name)")
        AppLog.notifications.info("scheduled \(planned.count) reminder(s) for \(bean.name, privacy: .public)")
    }

    /// Removes a bag's reminders, both from the system and from the store. Called
    /// before a bean is deleted so no notification arrives for a bag that is gone.
    func cancel(bean: Bean, context: ModelContext) {
        center.removePendingNotificationRequests(withIdentifiers: NotificationPlanner.allIdentifiers(beanID: bean.id))
        for row in bean.reminders ?? [] { context.delete(row) }
        bean.reminders = []
        commit(context, note: "cancelled reminders for \(bean.name)")
    }

    /// 只清系统里的待送达提醒，不碰库。删除豆子时用它收尾：库里的提醒行已经
    /// 随级联删除走了，不需要（也不能）再动上下文。
    func unschedule(identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    /// Drops every identifier for every bag. Used by "turn reminders off" and by
    /// the settings screen when permission is revoked.
    func cancelAll() {
        center.removeAllPendingNotificationRequests()
    }

    // MARK: - Launch refresh

    /// Re-plans on launch.
    ///
    /// This is also the recovery path for a bag whose window moved because the
    /// user edited its rule, and for stale reminders left over from a previous
    /// version of the rules.
    func refreshAll(beans: [Bean], book: PhaseRuleBook, context: ModelContext) async {
        await refreshStatus()
        let preferences = ReminderPreferences.current()

        for bean in beans where !bean.isFinished {
            guard bean.roastDate != nil else { continue }
            let insight = InsightFactory.insight(for: bean, book: book)
            await sync(bean: bean,
                       rule: book.rule(for: bean.roastLevel),
                       estimate: insight.estimate,
                       context: context,
                       preferences: preferences)
        }
    }

    /// How many reminders are actually waiting, for the settings screen.
    func pendingCount() async -> Int {
        await center.pendingNotificationRequests().count
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
