import Foundation

/// Where a bag stands, and everything the UI needs to say about it.
struct PhaseReading: Equatable, Sendable {

    enum Problem: Equatable, Sendable {
        case missingRoastDate
        case roastDateInFuture

        var message: String {
            switch self {
            case .missingRoastDate:
                return L("填上烘焙日期，就能看到它现在处在哪个阶段")
            case .roastDateInFuture:
                return L("烘焙日期在未来，请检查一下")
            }
        }
    }

    /// nil when there is no roast date at all.
    var dayAfterRoast: Int?
    var phase: BeanPhase

    /// The day count the *phase* was read at, after the sealed stretch has been
    /// discounted. Equal to `dayAfterRoast` unless the bag was opened late.
    var effectiveDay: Int
    /// Days the sealed stretch bought this bag. Zero for a bag that was opened
    /// before its window opened, or that has no open date.
    var sealedShiftDays: Int

    /// Rule boundaries, in days after roast.
    var restEndDay: Int
    var peakStartDay: Int
    var peakEndDay: Int

    var restMinDays: Int
    var restMaxDays: Int

    /// Days until the good window opens (0 once it has).
    var daysUntilPeakStart: Int
    /// Days until the good window closes. Negative once it has.
    var daysUntilWindowEnd: Int

    /// Today's position on the drawn track, 0…1.
    var progress: Double
    var trackSegments: [TrackSegment]

    var problem: Problem?
    var usesDefaultRule: Bool

    var isInWindow: Bool { phase.isInWindow }

    /// One line explaining the estimate, never an absolute claim.
    var estimateNote: String { DefaultPhaseRules.disclaimer }
}

/// The single source of truth for "what day is this bag on, and where does that
/// put it" (§30).
///
/// Deliberately has no state, no clock of its own and no reference to a store:
/// give it a snapshot, a rule and a date, and it returns a reading. That is what
/// makes every boundary case in §31 a one-line test instead of a bug hunt.
enum PhaseEngine {

    /// The three day-numbers that define a bag's life. Resolved in exactly one
    /// place, so the phase track, the reminders and the phase itself can never
    /// disagree about where the window is.
    ///
    /// The reading of §7's table that makes all four phases real:
    ///
    ///     排气期 3–7 天        最佳窗口 7–28 天        衰退起点 28 天
    ///     ├── 太新 ──┤├─ 进入窗口 ─┤├──── 黄金窗口 ────┤├─ 衰退
    ///     0         3            7                   28
    ///
    /// "Resting" is the first stretch where the coffee is unambiguously too
    /// fresh; "Opening" is the exhaust winding down, which is exactly the window
    /// the table's two numbers bracket.
    struct Boundaries: Equatable, Sendable {
        var restEnd: Int
        var peakStart: Int
        var peakEnd: Int
    }

    static func boundaries(for rule: PhaseRuleData) -> Boundaries {
        let normalized = rule.normalized()
        let peakStart = max(1, normalized.peakStartDay)
        let restEnd = min(max(normalized.restMinDays, 1), max(peakStart - 1, 1))
        let peakEnd = max(peakStart + 1, max(normalized.peakEndDay, normalized.declineStartDay))
        return Boundaries(restEnd: restEnd, peakStart: peakStart, peakEnd: peakEnd)
    }

    /// Which phase a given day after roast falls in.
    ///
    /// Used by the flavour timeline, so a tasting recorded on day 9 is coloured
    /// by the phase it was actually in — which is what turns a list of notes into
    /// a lifecycle you can read at a glance.
    static func phase(dayAfterRoast day: Int, rule: PhaseRuleData) -> BeanPhase {
        let bounds = boundaries(for: rule)
        if day < bounds.restEnd { return .resting }
        if day < bounds.peakStart { return .opening }
        if day < bounds.peakEnd { return .peak }
        return .declining
    }

    // MARK: - The open date

    /// How much slower coffee ages while the bag is still sealed.
    ///
    /// Not a measurement — a deliberate, explainable choice, and the app says as
    /// much everywhere it shows a phase. Counting sealed days as zero would let a
    /// bag forgotten in a cupboard for three months still read as "peak", which
    /// is plainly wrong; counting them in full is what made the open date
    /// irrelevant in the first place. Half is the honest middle: the coffee does
    /// keep ageing in the wrapper, just not as fast as in an open bag.
    static let sealedDayWeight = 0.5

    /// The day count the phase is read at, once the sealed stretch is discounted.
    ///
    /// Only the part of the sealed stretch that falls *after* the window would
    /// have opened counts. A bag of a light roast opened on day 3 has delayed
    /// nothing, because its window had not started either.
    ///
    /// The discount accrues as time passes rather than being applied once, for
    /// two reasons: the reading must never run backwards, and a bag that is still
    /// sealed today cannot be judged by a discount it has not earned yet. So a
    /// bag that will be opened on day 20 is judged almost as if it were open on
    /// day 8, and only slows down for the days it actually spends sealed past the
    /// window's start.
    static func effectiveDay(
        dayAfterRoast day: Int,
        openDayAfterRoast openDay: Int?,
        rule: PhaseRuleData
    ) -> Int {
        guard let openDay else { return day }
        let peakStart = boundaries(for: rule).peakStart
        let sealedPastWindowStart = max(0, min(day, openDay) - peakStart)
        let discount = Int((Double(sealedPastWindowStart) * sealedDayWeight).rounded())
        return max(0, day - discount)
    }

    /// Days between roasting and opening, or nil when either date is missing.
    static func openDayAfterRoast(
        _ bean: BeanSnapshot,
        calendar: Calendar = DateMath.calendar
    ) -> Int? {
        guard let roastDate = bean.roastDate, let openDate = bean.openDate else { return nil }
        return DateMath.daysBetween(roastDate, openDate, calendar: calendar)
    }

    /// The phase a bag was in on a given day.
    ///
    /// Takes the whole snapshot rather than just the rule, because the sealed
    /// stretch has to be discounted here too — otherwise the timeline would
    /// colour an entry with a phase the detail page disagrees with.
    static func phase(
        dayAfterRoast day: Int,
        bean: BeanSnapshot,
        rule: PhaseRuleData,
        calendar: Calendar = DateMath.calendar
    ) -> BeanPhase {
        let effective = effectiveDay(
            dayAfterRoast: day,
            openDayAfterRoast: openDayAfterRoast(bean, calendar: calendar),
            rule: rule
        )
        return phase(dayAfterRoast: effective, rule: rule)
    }

    /// How many days a sealed bag has bought itself, in total, by `day`.
    static func sealedShiftDays(
        dayAfterRoast day: Int,
        openDayAfterRoast openDay: Int?,
        rule: PhaseRuleData
    ) -> Int {
        day - effectiveDay(dayAfterRoast: day, openDayAfterRoast: openDay, rule: rule)
    }

    /// The first day after roast on which the phase clock has reached `target`.
    ///
    /// The inverse of `effectiveDay`, and the reason reminders still fire on the
    /// right morning: with a sealed stretch in play the offset is not a constant,
    /// because the discount is still accruing when the bag is closed. So it walks
    /// forward — but the walk is provably short: the discount can never exceed
    /// `maxDiscount`, so `target + maxDiscount` always satisfies the target.
    static func dayReaching(
        _ target: Int,
        rule: PhaseRuleData,
        openDayAfterRoast openDay: Int?
    ) -> Int {
        guard let openDay else { return max(0, target) }

        let peakStart = boundaries(for: rule).peakStart
        let maxDiscount = Int((Double(max(0, openDay - peakStart)) * sealedDayWeight).rounded())

        // `target` can be negative — the priority nudge asks for "the day you
        // would have had to start", which for a bag already past its window is in
        // the past. Clamp both ends so the range can never invert.
        let first = max(0, target)
        let last = max(first, target + maxDiscount)

        for day in first...last {
            if effectiveDay(dayAfterRoast: day, openDayAfterRoast: openDay, rule: rule) >= target {
                return day
            }
        }
        return last
    }

    // MARK: - Entry point

    static func reading(
        for bean: BeanSnapshot,
        rule: PhaseRuleData? = nil,
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> PhaseReading {
        let resolved = (rule ?? DefaultPhaseRules.data(for: bean.roastLevel)).normalized()
        let usesDefaultRule = rule == nil

        let bounds = boundaries(for: resolved)
        let restEnd = bounds.restEnd
        let peakStart = bounds.peakStart
        let peakEnd = bounds.peakEnd

        // No roast date: we cannot place the bean in time, so we say so rather
        // than inventing a day 0.
        guard let roastDate = bean.roastDate else {
            return PhaseReading(
                dayAfterRoast: nil,
                phase: .resting,
                effectiveDay: 0,
                sealedShiftDays: 0,
                restEndDay: restEnd,
                peakStartDay: peakStart,
                peakEndDay: peakEnd,
                restMinDays: resolved.restMinDays,
                restMaxDays: resolved.restMaxDays,
                daysUntilPeakStart: peakStart,
                daysUntilWindowEnd: peakEnd,
                progress: 0,
                trackSegments: segments(restEnd: restEnd, peakStart: peakStart, peakEnd: peakEnd),
                problem: .missingRoastDate,
                usesDefaultRule: usesDefaultRule
            )
        }

        let rawDay = DateMath.daysBetween(roastDate, today, calendar: calendar)
        let day = max(0, rawDay)

        // The bag's true age is what the UI prints ("Day 16" is honest either
        // way); the phase is read at the age the coffee is actually at, which is
        // lower when the bag sat sealed past its window.
        let openDay = openDayAfterRoast(bean, calendar: calendar)
        let phaseDay = effectiveDay(dayAfterRoast: day, openDayAfterRoast: openDay, rule: resolved)
        let shift = day - phaseDay
        let phase = phase(dayAfterRoast: phaseDay, rule: resolved)

        // The track shows a fixed-length declining tail so a bag that is past its
        // window still has somewhere to sit, instead of pinning to the end.
        let tail = max(7, (peakEnd - peakStart) / 2)
        let span = Double(peakEnd + tail)
        let progress = min(max(Double(phaseDay) / span, 0), 1)

        return PhaseReading(
            dayAfterRoast: day,
            phase: phase,
            effectiveDay: phaseDay,
            sealedShiftDays: shift,
            restEndDay: restEnd,
            peakStartDay: peakStart,
            peakEndDay: peakEnd,
            restMinDays: resolved.restMinDays,
            restMaxDays: resolved.restMaxDays,
            daysUntilPeakStart: max(0, peakStart - phaseDay),
            daysUntilWindowEnd: peakEnd - phaseDay,
            progress: progress,
            trackSegments: segments(restEnd: restEnd, peakStart: peakStart, peakEnd: peakEnd),
            problem: rawDay < 0 ? .roastDateInFuture : nil,
            usesDefaultRule: usesDefaultRule
        )
    }

    // MARK: - Track geometry

    private static func segments(restEnd: Int, peakStart: Int, peakEnd: Int) -> [TrackSegment] {
        let tail = max(7, (peakEnd - peakStart) / 2)
        let span = Double(peakEnd + tail)
        let restFrac = Double(restEnd) / span
        let startFrac = Double(peakStart) / span
        let endFrac = Double(peakEnd) / span

        return [
            TrackSegment(phase: .resting, start: 0, end: restFrac),
            TrackSegment(phase: .opening, start: restFrac, end: startFrac),
            TrackSegment(phase: .peak, start: startFrac, end: endFrac),
            TrackSegment(phase: .declining, start: endFrac, end: 1),
        ]
        .filter { $0.width > 0.0001 }
    }

    // MARK: - Convenience

    /// A bag with no roast date cannot be judged, and should not be recommended.
    static func isJudgeable(_ bean: BeanSnapshot) -> Bool {
        bean.roastDate != nil
    }
}
