import SwiftUI

/// One bag in a plain list — the finished cellar, where a bag no longer needs a
/// card of its own.
///
/// Two lines at most: the name, then where it ended up. Nothing is hidden; the
/// detail page holds the rest.
struct BeanRow: View {

    let insight: BeanInsight

    private var bean: BeanSnapshot { insight.bean }
    private var reading: PhaseReading { insight.reading }

    var body: some View {
        HStack(spacing: 12) {
            BeanThumbnail(imageName: bean.imagePath, size: 40, cornerRadius: 9)

            VStack(alignment: .leading, spacing: 3) {
                Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)

                Text(metaLine)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Palette.inkFaint)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    /// `Day 34 · 已喝完` — the two facts a finished bag still has.
    private var metaLine: String {
        let day = Fmt.day(reading.dayAfterRoast)
        return day == "—" ? bean.status.label : "\(day) · \(bean.status.label)"
    }
}
