import SwiftUI

/// 阶段卡 (§11): where this bag is, and how long it has left.
///
/// The reading is always framed as an estimate and always attributed to the rule
/// that produced it — never as a fact about the coffee, and never with the word
/// "过期".
struct PhaseCard: View {

    let insight: BeanInsight
    let onEditRules: () -> Void

    private var reading: PhaseReading { insight.reading }
    private var verdict: PriorityVerdict { insight.verdict }
    private var color: Color {
        PhasePresentation.color(phase: reading.phase, tier: verdict.tier)
    }

    var body: some View {
        Card(lifted: true) {
            VStack(alignment: .leading, spacing: 15) {
                topRow
                headline
                PhaseTrack(reading: reading, showsMarker: true, showsLegend: true)
                footnote
            }
        }
    }

    private var topRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(Fmt.day(reading.dayAfterRoast))
                .font(TypeScale.bigNumeral)
                .foregroundStyle(Palette.ink)

            Spacer(minLength: 0)

            PhaseBadge(phase: reading.phase, tier: verdict.tier)
        }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(PhasePresentation.title(phase: reading.phase, tier: verdict.tier))
                .font(TypeScale.title)
                .foregroundStyle(color)

            Text(horizonText)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
        }
    }

    /// The one number a drinker actually wants: how long is left, or how long
    /// until it is worth opening.
    private var horizonText: String {
        guard reading.dayAfterRoast != nil else {
            return reading.problem?.message ?? "填上烘焙日期就能看到阶段"
        }
        switch reading.phase {
        case .resting, .opening:
            return Fmt.untilPeak(reading.daysUntilPeakStart)
        case .peak, .declining:
            return Fmt.untilWindowEnd(reading.daysUntilWindowEnd)
        }
    }

    private var footnote: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let problem = reading.problem, problem != .missingRoastDate {
                Text(problem.message)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.priority)
            }

            // Said out loud, because a bag whose "Day 16" sits next to "peak"
            // while its raw age says otherwise is exactly the kind of thing that
            // reads as arbitrary. The number is the bag's real age; the phase is
            // read at the age the coffee is actually at.
            if reading.sealedShiftDays > 0 {
                Text(L("这包较晚才开封，封着的 %@ 天按半速计入，阶段相应顺延。",
                       String(reading.sealedShiftDays)))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 6) {
                Text(L("排气期约 %@–%@ 天", String(reading.restMinDays), String(reading.restMaxDays)))
                Text(verbatim: "·")
                Text(verbatim: insight.bean.roastLevel.label)
                    .foregroundStyle(Palette.roast)
                Text(verbatim: "·")
                Text(verbatim: reading.estimateNote)
            }
            .font(TypeScale.caption)
            .foregroundStyle(Palette.inkFaint)

            if reading.usesDefaultRule {
                Button(action: onEditRules) {
                    Text("这些是默认窗口，可以自己改")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.roast)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
