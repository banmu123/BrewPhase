import Foundation

/// The five moments the app is allowed to interrupt someone about (§10).
enum ReminderKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case restComplete
    case windowOpens
    case windowHalfway
    case windowEnding
    case brewPriority

    var id: String { rawValue }

    var label: String {
        switch self {
        case .restComplete: return L("养豆完成")
        case .windowOpens: return L("进入风味窗口")
        case .windowHalfway: return L("窗口过半")
        case .windowEnding: return L("窗口即将结束")
        case .brewPriority: return L("建议优先饮用")
        }
    }

    var detail: String {
        switch self {
        case .restComplete: return L("排气期结束，风味开始打开时提醒")
        case .windowOpens: return L("进入最佳风味窗口时提醒")
        case .windowHalfway: return L("窗口走过一半时提醒")
        case .windowEnding: return L("窗口结束前两天提醒")
        case .brewPriority: return L("这包可能喝不完它的窗口时提醒")
        }
    }

    func title(beanName: String) -> String {
        let name = beanName.trimmed.isEmpty ? L("这包豆子") : beanName
        switch self {
        case .restComplete: return L("%@ 养豆结束", name)
        case .windowOpens: return L("%@ 进入风味窗口", name)
        case .windowHalfway: return L("%@ 的窗口过半了", name)
        case .windowEnding: return L("%@ 的窗口快结束了", name)
        case .brewPriority: return L("%@ 建议优先喝", name)
        }
    }

    func body(beanName: String) -> String {
        let name = beanName.trimmed.isEmpty ? L("这包豆子") : beanName
        switch self {
        case .restComplete: return L("%@ 的排气期基本结束，风味开始打开了。", name)
        case .windowOpens: return L("%@ 现在进入最佳风味窗口，可以开始喝了。", name)
        case .windowHalfway: return L("%@ 的窗口已经过半，接下来的风味会慢慢变平。", name)
        case .windowEnding: return L("%@ 的窗口还剩两天，想喝到最好的状态就趁现在。", name)
        case .brewPriority: return L("%@ 的窗口比你的消耗速度更短，建议优先喝完。", name)
        }
    }
}

/// Which reminders the user still wants (§10: "设置中可以关闭某类通知").
struct ReminderPreferences: Equatable, Sendable {
    var disabled: Set<ReminderKind>

    init(disabled: Set<ReminderKind> = []) {
        self.disabled = disabled
    }

    func isEnabled(_ kind: ReminderKind) -> Bool {
        !disabled.contains(kind)
    }

    mutating func set(_ kind: ReminderKind, enabled: Bool) {
        if enabled { disabled.remove(kind) } else { disabled.insert(kind) }
    }

    var enabledCount: Int { ReminderKind.allCases.filter { isEnabled($0) }.count }
    var allowsAny: Bool { enabledCount > 0 }

    static let allEnabled = ReminderPreferences()
}

/// A reminder that should exist, before it is handed to the system.
struct PlannedReminder: Equatable, Sendable, Identifiable {
    var kind: ReminderKind
    var fireDate: Date
    var identifier: String

    var id: String { identifier }
}

/// Works out *when* to remind, and nothing else.
///
/// Pure on purpose. Scheduling is the part that is hard to debug once it is
/// inside `UNUserNotificationCenter`, and §39 asks for the date arithmetic to be
/// tested — so the arithmetic lives here, where a test can read it.
enum NotificationPlanner {

    /// Reminders land at 9am on the relevant day rather than at whatever hour the
    /// bag happened to be added.
    static let fireHour = 9

    /// How many days before the window closes the "closing" reminder fires.
    static let closingLeadDays = 2

    static func plan(
        beanID: UUID,
        beanName: String,
        roastDate: Date,
        openDate: Date?,
        rule: PhaseRuleData,
        estimate: ConsumptionEstimate,
        preferences: ReminderPreferences = .allEnabled,
        now: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> [PlannedReminder] {
        let bounds = PhaseEngine.boundaries(for: rule)
        let openDay = openDate.map { DateMath.daysBetween(roastDate, $0, calendar: calendar) }

        // A reminder happens on a *calendar* morning, but the moment it is about
        // is a point on the phase clock — and the phase clock runs slower while
        // the bag is sealed. Every offset therefore goes through the inverse.
        func fireDay(_ target: Int) -> Int {
            PhaseEngine.dayReaching(target, rule: rule, openDayAfterRoast: openDay)
        }

        let peakEndDay = fireDay(bounds.peakEnd)
        let halfway = fireDay(bounds.peakStart + max(1, (bounds.peakEnd - bounds.peakStart) / 2))

        // (kind, day-after-roast) — the day offsets each reminder wants.
        var wanted: [(ReminderKind, Int)] = [
            (.restComplete, fireDay(bounds.restEnd)),
            (.windowOpens, fireDay(bounds.peakStart)),
            (.windowHalfway, halfway),
            (.windowEnding, peakEndDay - closingLeadDays),
        ]

        // The priority nudge is not a fixed offset: it fires on the day the
        // drinker would need to *start* drinking faster, and only when the
        // numbers actually say the bag cannot be finished inside its window.
        let currentDay = max(0, DateMath.daysBetween(roastDate, now, calendar: calendar))
        let currentEffectiveDay = PhaseEngine.effectiveDay(
            dayAfterRoast: currentDay, openDayAfterRoast: openDay, rule: rule
        )
        let remainingWindow = bounds.peakEnd - currentEffectiveDay
        if estimate.brewsRemaining > 1,
           estimate.daysRemaining > remainingWindow,
           remainingWindow > 0 {
            // Never in the past — a reminder about a moment that already passed
            // is just noise, so it lands tomorrow at the earliest.
            let dayToStart = max(fireDay(bounds.peakEnd - estimate.daysRemaining), currentDay + 1)
            if dayToStart < peakEndDay {
                wanted.append((.brewPriority, dayToStart))
            }
        }

        // One entry per kind, in day order, dropping anything already past or
        // switched off, and de-duplicating so a kind can never be scheduled twice
        // (§39).
        var seen = Set<ReminderKind>()
        var planned: [PlannedReminder] = []

        for (kind, day) in wanted.sorted(by: { $0.1 < $1.1 }) {
            guard preferences.isEnabled(kind), !seen.contains(kind) else { continue }
            seen.insert(kind)
            guard let fireDate = DateMath.day(roastDate, plusDays: day, atHour: fireHour, calendar: calendar),
                  fireDate > now else { continue }
            planned.append(
                PlannedReminder(kind: kind, fireDate: fireDate, identifier: identifier(beanID: beanID, kind: kind))
            )
        }

        return planned
    }

    /// Stable, greppable identifier. Replacing a reminder is then an exact
    /// operation rather than "remove all for this bean and hope".
    static func identifier(beanID: UUID, kind: ReminderKind) -> String {
        "brewphase.bean.\(beanID.uuidString).\(kind.rawValue)"
    }

    /// The catalogue of identifiers a bean may own, so stale ones can be cleared
    /// even after the rule changes and the planned set shrinks.
    static func allIdentifiers(beanID: UUID) -> [String] {
        ReminderKind.allCases.map { identifier(beanID: beanID, kind: $0) }
    }
}
