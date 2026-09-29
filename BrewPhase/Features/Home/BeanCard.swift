import SwiftUI

/// One row in the cellar (§5).
///
/// Ordered by drink-me-first rather than by when it was added, and built so the
/// eye lands on three things in sequence: the phase dot, the day, and how much
/// is left.
struct BeanCard: View {

    let insight: BeanInsight

    private var bean: BeanSnapshot { insight.bean }
    private var reading: PhaseReading { insight.reading }
    private var verdict: PriorityVerdict { insight.verdict }
    private var phaseColor: Color {
        PhasePresentation.color(phase: reading.phase, tier: verdict.tier)
    }

    var body: some View {
        Card(padding: 14) {
            HStack(alignment: .top, spacing: 14) {
                BeanThumbnail(imageName: bean.imagePath, size: 58, cornerRadius: 14)

                VStack(alignment: .leading, spacing: 7) {
                    titleRow
                    phaseRow
                    PhaseTrackMini(reading: reading)
                    footerRow
                }
            }
        }
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)

            Spacer(minLength: 4)

            Text(Fmt.day(reading.dayAfterRoast))
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Palette.inkFaint)
        }
    }

    private var phaseRow: some View {
        HStack(spacing: 6) {
            PhaseDot(color: phaseColor, size: 7)
            Text(PhasePresentation.title(phase: reading.phase, tier: verdict.tier))
                .font(TypeScale.caption.weight(.medium))
                .foregroundStyle(phaseColor)

            Spacer(minLength: 4)

            Text(Fmt.grams(bean.remainingG))
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Palette.inkSoft)
        }
    }

    /// Flavour tags as one line, the way §5's own example writes them.
    private var footerRow: some View {
        HStack(spacing: 6) {
            if bean.flavorTags.isEmpty {
                Text(bean.roaster.isEmpty ? LocalizedStringKey("—") : .alreadyLocalized(bean.roaster))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
            } else {
                Text(verbatim: FlavorLibrary.displayList(bean.flavorTags, limit: 3))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.roast.opacity(0.85))
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if let score = insight.candidate.lastScore, score > 0 {
                StarRating(score: score, size: 10)
            }
        }
    }
}
