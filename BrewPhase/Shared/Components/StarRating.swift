import SwiftUI

/// Five stars. The rating is the app's coarsest but most-used judgement, so it
/// gets the largest tap target in any form and fills with a small spring.
struct StarRating: View {
    let score: Int
    var size: CGFloat = 13
    var color: Color = Palette.roast

    var body: some View {
        HStack(spacing: size * 0.18) {
            ForEach(1...5, id: \.self) { i in
                Image(systemName: i <= score ? "star.fill" : "star")
                    .font(.system(size: size, weight: .medium))
                    .foregroundStyle(i <= score ? color : Palette.inkFaint.opacity(0.5))
            }
        }
        .animation(Motion.pop, value: score)
    }
}

/// Interactive variant. Tapping the already-selected star clears the rating,
/// because "I don't want to rate this" should cost one tap, not none.
struct StarRatingInput: View {
    @Binding var score: Int
    var size: CGFloat = 30
    var color: Color = Palette.roast

    var body: some View {
        HStack(spacing: 10) {
            ForEach(1...5, id: \.self) { i in
                Button {
                    withAnimation(Motion.pop) {
                        score = (score == i) ? 0 : i
                    }
                } label: {
                    Image(systemName: i <= score ? "star.fill" : "star")
                        .font(.system(size: size, weight: .regular))
                        .foregroundStyle(i <= score ? color : Palette.inkFaint.opacity(0.55))
                        .scaleEffect(i <= score ? 1.0 : 0.94)
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(L("%@ 星", String(i))))
            }
        }
        .animation(Motion.pop, value: score)
    }
}

/// A 1–5 judgement axis (acid / sweet / bitter / body / aftertaste).
///
/// Deliberately *not* a numeric slider: five discrete dots read as "a feeling",
/// a slider with a number reads as a form field, which is exactly what §14 says
/// to avoid.
struct TasteScale: View {
    let title: LocalizedStringKey
    @Binding var value: Int
    var lowLabel: String?
    var highLabel: String?

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(TypeScale.body)
                .foregroundStyle(Palette.inkSoft)
                .frame(width: 44, alignment: .leading)

            HStack(spacing: 8) {
                ForEach(1...5, id: \.self) { i in
                    Button {
                        withAnimation(Motion.pop) {
                            value = (value == i) ? 0 : i
                        }
                    } label: {
                        Capsule(style: .continuous)
                            .fill(i <= value ? Palette.roast.opacity(0.25 + 0.15 * Double(i)) : Palette.well)
                            .overlay(
                                Capsule(style: .continuous)
                                    .strokeBorder(i <= value ? Palette.roast.opacity(0.55) : Palette.hairline,
                                                  lineWidth: 1)
                            )
                            .frame(height: 20)
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        Text(title) + Text(verbatim: " ") + Text(L("%@ 分", String(i)))
                    )
                }
            }
            .frame(maxWidth: .infinity)
        }
        .animation(Motion.pop, value: value)
    }
}
