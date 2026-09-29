import SwiftUI

/// 今日建议 (§4).
///
/// The one card that is allowed to be bigger than everything else. It says which
/// bag, how far into its life it is, how much is left, and — crucially — *why*.
/// It never shows a score.
struct TodayCard: View {

    let insight: BeanInsight
    let bean: Bean
    let onBrew: () -> Void

    private var reading: PhaseReading { insight.reading }
    private var estimate: ConsumptionEstimate { insight.estimate }
    private var verdict: PriorityVerdict { insight.verdict }
    private var phaseColor: Color {
        PhasePresentation.color(phase: reading.phase, tier: verdict.tier)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            stats
            PhaseTrack(reading: reading, showsMarker: true, showsLegend: false)
            reason
            PrimaryButton(title: "开始冲煮", systemImage: "cup.and.saucer.fill", action: onBrew)
        }
        .padding(Metric.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .fill(Palette.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .strokeBorder(Palette.hairline.opacity(0.9), lineWidth: 0.7)
        )
        .shadow(color: Palette.liftedShadow, radius: 16, x: 0, y: 7)
    }

    // MARK: - Pieces

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("今天建议")
                    .font(TypeScale.micro)
                    .tracking(0.8)
                    .foregroundStyle(Palette.inkFaint)
                Spacer(minLength: 0)
                Text(Fmt.day(reading.dayAfterRoast))
                    .font(TypeScale.micro.monospacedDigit())
                    .foregroundStyle(Palette.inkFaint)
            }

            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                        .font(TypeScale.cardTitle)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                    if !bean.roaster.isEmpty {
                        Text(bean.roaster)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                    }
                }
                Spacer(minLength: 0)
                BeanThumbnail(imageName: bean.imagePath, size: 54, cornerRadius: 13)
            }

            HStack(spacing: 7) {
                PhaseDot(color: phaseColor, size: 8, halo: true)
                Text(PhasePresentation.title(phase: reading.phase, tier: verdict.tier))
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(phaseColor)
                Text(PhasePresentation.subtitle(phase: reading.phase, tier: verdict.tier))
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
            }
        }
    }

    private var stats: some View {
        HStack(spacing: 0) {
            stat(Fmt.grams(bean.remainingG), "剩余")
            divider
            stat(estimate.brewsText, "还能冲")
            divider
            stat(reading.dayAfterRoast == nil ? "—" : Fmt.days(estimate.daysRemaining), "预计喝完")
        }
    }

    private func stat(_ value: String, _ label: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: value)
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(label)
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var divider: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(width: 0.7, height: 26)
            .padding(.horizontal, 10)
    }

    /// The "why" (§4). Plain sentences, in this order: where the bag is, what
    /// that implies, then a nudge only if the app is genuinely asking for one.
    private var reason: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verdict.headline)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)

            ForEach(verdict.details, id: \.self) { detail in
                Text(detail)
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)
            }

            if let closing = verdict.closing {
                Text(closing)
                    .font(TypeScale.callout.weight(.medium))
                    .foregroundStyle(phaseColor)
                    .padding(.top, 1)
            }

            if let problem = reading.problem {
                Text(problem.message)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.priority)
                    .padding(.top, 2)
            }
        }
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
