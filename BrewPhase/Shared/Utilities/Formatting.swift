import Foundation

/// Every user-facing number and date string in the app comes from here, so the
/// vocabulary stays consistent and nothing leaks a raw `Date` into a view.
enum Fmt {

    // MARK: - Weight

    /// `86g`, `86.5g`, `1.02kg`
    ///
    /// Not localised on purpose: `g` and `kg` are the units the coffee is weighed
    /// in everywhere, and a bag of beans is not sold in ounces.
    static func grams(_ value: Double) -> String {
        if value >= 1000 {
            return String(format: "%.2fkg", value / 1000)
        }
        if value.rounded() == value {
            return "\(Int(value))g"
        }
        return String(format: "%.1fg", value)
    }

    static func gramsShort(_ value: Double) -> String {
        value.rounded() == value ? "\(Int(value))g" : String(format: "%.1fg", value)
    }

    // MARK: - Bare numbers

    /// `92`, `16.7`, `4.8` — a number with no unit attached.
    ///
    /// The one place a raw decimal reaches the screen: temperatures, sub-scores
    /// and averages. Those sit inside a sentence built elsewhere, so they cannot
    /// carry their own unit, and `92.0°C` reads like a measurement where `92°C`
    /// reads like a setting.
    static func number(_ value: Double) -> String {
        let rounded = value.tidy
        return rounded == rounded.rounded() ? "\(Int(rounded))" : String(format: "%.1f", rounded)
    }

    // MARK: - Day after roast

    /// `Day 16`, or an em dash when the roast date is unknown.
    ///
    /// Left in English in both languages: it is the app's own notation for a
    /// bag's age — the same in the brief's own mock-ups — rather than prose, and
    /// it reads the same to a Chinese drinker.
    static func day(_ dayAfterRoast: Int?) -> String {
        guard let d = dayAfterRoast else { return "—" }
        if d < 0 { return "Day 0" }
        return "Day \(d)"
    }

    // MARK: - Dates

    /// `9月24日` / `Sep 24`
    static func short(_ date: Date, calendar: Calendar = DateMath.calendar) -> String {
        localized(date, template: "MMMd", calendar: calendar)
    }

    /// `2026年9月24日` / `Sep 24, 2026`
    static func precise(_ date: Date, calendar: Calendar = DateMath.calendar) -> String {
        localized(date, template: "yMMMd", calendar: calendar)
    }

    /// `9月24日 18:04` / `Sep 24, 6:04 PM`
    static func dayTime(_ date: Date) -> String {
        localized(date, template: "MMMdjm", calendar: DateMath.calendar)
    }

    /// `周四` / `Thu`
    static func weekday(_ date: Date, calendar: Calendar = DateMath.calendar) -> String {
        localized(date, template: "EEE", calendar: calendar)
    }

    /// `2026年9月` / `September 2026` — the heading a month's brews are grouped
    /// under.
    static func monthHeading(_ date: Date, calendar: Calendar = DateMath.calendar) -> String {
        localized(date, template: "yMMMM", calendar: calendar)
    }

    // MARK: - Counts (always approximate, never authoritative)

    /// `约 4 次` / `About 4 brews`
    static func brews(_ n: Int) -> String { L("约 %@ 次", String(n)) }
    /// `约 4 天` / `About 4 days`
    static func days(_ n: Int) -> String { L("约 %@ 天", String(n)) }
    /// `还能喝 4 天` / `今天喝完`
    static func daysLeftPhrase(_ n: Int) -> String {
        n <= 0 ? L("已经见底") : L("预计还能喝 %@ 天", String(n))
    }

    /// `距离窗口结束约 9 天`
    static func untilWindowEnd(_ n: Int) -> String {
        if n < 0 { return L("已过窗口 %@ 天", String(abs(n))) }
        if n == 0 { return L("窗口今天结束") }
        return L("距离窗口结束约 %@ 天", String(n))
    }

    static func untilPeak(_ n: Int) -> String {
        if n <= 0 { return L("已经进入窗口") }
        return L("还有约 %@ 天进入窗口", String(n))
    }

    // MARK: - Ratio

    /// `1:16.7`, rounded so it reads like a recipe rather than a measurement.
    static func ratio(coffeeG: Double, waterG: Double) -> String {
        guard coffeeG > 0, waterG > 0 else { return "—" }
        let r = waterG / coffeeG
        if r.rounded() == r { return "1:\(Int(r))" }
        return String(format: "1:%.1f", r)
    }

    // MARK: - Recipe line

    /// `18g / 300g` — the line that appears under every brew.
    static func doseLine(coffeeG: Double, waterG: Double) -> String {
        "\(gramsShort(coffeeG)) / \(gramsShort(waterG))"
    }

    // MARK: - Date formatting

    /// Formats from a *template* rather than a fixed pattern, so the field order
    /// is the one the active language actually uses — `9月24日` and `Sep 24` come
    /// out of the same call, and the hour decides between `18:04` and `6:04 PM`
    /// by itself.
    private static func localized(_ date: Date, template: String, calendar: Calendar) -> String {
        let formatter = DateFormatterCache.formatter(
            template: template,
            localeCode: currentLocaleCode(),
            calendar: calendar
        )
        return formatter.string(from: date)
    }
}

/// Formatters are expensive to build, and `setLocalizedDateFormatFromTemplate`
/// has to be redone whenever the language changes, so they are kept per
/// (language, template, calendar).
///
/// The calendar is part of the key rather than assigned after the fact: the
/// cached instance is handed to callers on any thread, and mutating a formatter
/// that someone else is formatting with is a data race waiting to happen.
private enum DateFormatterCache {

    private static let lock = NSLock()
    /// `nonisolated(unsafe)` because this is mutable static state, which Swift 6
    /// refuses by default. It is safe for a reason the compiler cannot see: the
    /// only function below takes `lock` before touching it and releases it with
    /// `defer`, so there is no path in or out that skips the lock.
    nonisolated(unsafe) private static var cache: [String: DateFormatter] = [:]

    static func formatter(template: String, localeCode: String, calendar: Calendar) -> DateFormatter {
        let key = "\(localeCode)|\(template)|\(calendar.identifier)|\(calendar.timeZone.identifier)"
        lock.lock()
        defer { lock.unlock() }

        if let cached = cache[key] { return cached }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: localeCode)
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(template)
        cache[key] = formatter
        return formatter
    }
}

extension Double {
    /// Rounds to one decimal place for display, leaving the stored value alone.
    var tidy: Double { (self * 10).rounded() / 10 }
}
