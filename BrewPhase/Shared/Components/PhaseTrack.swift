import SwiftUI

/// The visual heart of the app (§8): a horizontal track showing where a bag is
/// between "roasted" and "faded", with today's position marked on it.
///
///   养豆 ─── 进入窗口 ────── 黄金窗口 ────── 衰退
///                              ▲ 今天
///
/// Segment widths are proportional to the real day counts from the active phase
/// rule, so a short-window espresso blend genuinely looks shorter than a light
/// roast. Colour is carried by the bar and the dot only — the rest is text.
struct PhaseTrack: View {

    let reading: PhaseReading
    var showsMarker: Bool = true
    var showsLegend: Bool = true
    var barHeight: CGFloat = 7

    private var markerX: CGFloat { CGFloat(min(max(reading.progress, 0.04), 0.96)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            GeometryReader { geo in
                let w = max(geo.size.width, 1)
                VStack(alignment: .leading, spacing: 4) {
                    if showsMarker {
                        markerLabel(width: w)
                    }
                    bar(width: w)
                }
                .frame(width: w, alignment: .leading)
            }
            .frame(height: showsMarker ? 30 : max(barHeight, 12))

            if showsLegend {
                legend.padding(.top, 9)
            }
        }
    }

    // MARK: - Bar

    private func bar(width: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            // The rail underneath keeps very short segments from looking like gaps.
            Capsule(style: .continuous)
                .fill(Palette.well)
                .frame(width: width, height: barHeight)

            HStack(spacing: 1.5) {
                ForEach(reading.trackSegments) { seg in
                    Capsule(style: .continuous)
                        .fill(Palette.tint(seg.phase))
                        .frame(width: max(3, CGFloat(seg.width) * width), height: barHeight)
                }
            }

            if showsMarker {
                Circle()
                    .fill(Palette.card)
                    .overlay(Circle().strokeBorder(markerColor, lineWidth: 2.4))
                    .frame(width: 11, height: 11)
                    .shadow(color: Palette.cardShadow, radius: 2, y: 1)
                    .offset(x: markerX * width - 5.5)
                    .animation(Motion.glide, value: reading.progress)
            }
        }
        .frame(height: max(barHeight, 11))
    }

    private var markerColor: Color {
        Palette.tint(reading.phase)
    }

    // MARK: - Today label

    private func markerLabel(width: CGFloat) -> some View {
        let labelWidth: CGFloat = 52
        let x = min(max(markerX * width - labelWidth / 2, 0), max(width - labelWidth, 0))
        return HStack(spacing: 0) {
            Text("今天")
                .font(TypeScale.micro)
                .foregroundStyle(markerColor)
                .frame(width: labelWidth)
                .offset(x: x)
            Spacer(minLength: 0)
        }
        .frame(height: 14)
    }

    // MARK: - Legend

    private var legend: some View {
        HStack(spacing: 0) {
            ForEach(BeanPhase.allCases) { phase in
                Text(phase.shortTitle)
                    .font(isCurrent(phase)
                          ? TypeScale.caption.weight(.semibold)
                          : TypeScale.caption)
                    .foregroundStyle(isCurrent(phase) ? Palette.tint(phase) : Palette.inkFaint)
                    .frame(maxWidth: .infinity, alignment: alignment(for: phase))
            }
        }
        .animation(Motion.quick, value: reading.phase)
    }

    private func isCurrent(_ phase: BeanPhase) -> Bool {
        phase == reading.phase
    }

    private func alignment(for phase: BeanPhase) -> Alignment {
        switch phase {
        case .resting: return .leading
        case .declining: return .trailing
        default: return .center
        }
    }
}

/// Compact variant for list rows: no legend, no label, just the marked bar.
struct PhaseTrackMini: View {
    let reading: PhaseReading
    var body: some View {
        PhaseTrack(reading: reading, showsMarker: true, showsLegend: false, barHeight: 5)
            .frame(height: 18)
    }
}
