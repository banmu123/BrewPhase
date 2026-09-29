import Foundation

/// Date arithmetic for the whole app, in one place.
///
/// PhaseEngine is the only *business* consumer, but it is built on these, and
/// they are the things worth testing: leap years, month and year boundaries,
/// and the difference between "16 days ago" and "15 days ago" when the times of
/// day differ.
///
/// All day differences are computed between *start of day* instants, which is
/// what makes a roast date of "today" read as Day 0 no matter what time it is.
enum DateMath {

    /// A fixed Gregorian calendar in the user's time zone. Built once, never
    /// mutated; `Calendar` is a value type so sharing this is safe.
    ///
    /// The locale here is deliberately *not* the interface language: it takes no
    /// part in day arithmetic, which is what this calendar exists for, and pinning
    /// it keeps the engine's results identical whichever language the app is in —
    /// which is what the phase tests assert. Anything actually printed as a date
    /// goes through `Fmt`, which formats with the interface locale.
    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.locale = Locale(identifier: "en_US_POSIX")
        c.timeZone = TimeZone.current
        return c
    }

    static func startOfDay(_ date: Date, calendar: Calendar = DateMath.calendar) -> Date {
        calendar.startOfDay(for: date)
    }

    /// Whole days from `from` to `to`. Negative when `to` is in the past.
    ///
    /// Cross-month, cross-year and leap years all fall out of `Calendar`, which
    /// is exactly why we do not do this with `TimeInterval / 86400`.
    static func daysBetween(_ from: Date, _ to: Date, calendar: Calendar = DateMath.calendar) -> Int {
        let a = calendar.startOfDay(for: from)
        let b = calendar.startOfDay(for: to)
        return calendar.dateComponents([.day], from: a, to: b).day ?? 0
    }

    /// `date + days`, at the same time of day.
    static func add(days: Int, to date: Date, calendar: Calendar = DateMath.calendar) -> Date {
        calendar.date(byAdding: .day, value: days, to: date) ?? date
    }

    static func isSameDay(_ a: Date, _ b: Date, calendar: Calendar = DateMath.calendar) -> Bool {
        calendar.isDate(a, inSameDayAs: b)
    }

    /// The instant `days` after the start of `date`'s day, at `hour`.
    ///
    /// Used for reminders, which should always fire at a civilised hour rather
    /// than at whatever time the bean happened to be added.
    static func day(_ date: Date, plusDays days: Int, atHour hour: Int,
                    calendar: Calendar = DateMath.calendar) -> Date? {
        let base = calendar.startOfDay(for: date)
        guard let shifted = calendar.date(byAdding: .day, value: days, to: base) else { return nil }
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: shifted)
    }

    /// Whether the calendar agrees this object is in a leap year — exposed so a
    /// test can pin the behaviour rather than guess it.
    static func isLeapYear(_ year: Int, calendar: Calendar = DateMath.calendar) -> Bool {
        guard let feb = calendar.date(from: DateComponents(year: year, month: 2, day: 1)) else { return false }
        return calendar.range(of: .day, in: .month, for: feb)?.count == 29
    }

    /// Monday-first weekday label, used by the greeting.
    ///
    /// Delegates to `Fmt` because the name of a day is language, not arithmetic:
    /// a hand-written table of names could only ever be right in one language.
    static func weekday(_ date: Date, calendar: Calendar = DateMath.calendar) -> String {
        Fmt.weekday(date, calendar: calendar)
    }
}
