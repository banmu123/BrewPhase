import SwiftUI

/// The one container shape. A card is a white rounded rectangle with a single
/// warm shadow and an optional hairline — no gradients, no glass, no stacked
/// elevations.
struct Card<Content: View>: View {
    var lifted: Bool = false
    var padding: CGFloat = Metric.cardPadding
    var hairline: Bool = true
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .strokeBorder(Palette.hairline.opacity(hairline ? 0.9 : 0), lineWidth: 0.7)
            )
            .shadow(
                color: lifted ? Palette.liftedShadow : Palette.cardShadow,
                radius: lifted ? 14 : 7,
                x: 0,
                y: lifted ? 6 : 3
            )
    }
}

/// Small uppercase-ish label that opens a group of content on the page.
///
/// Keys rather than strings so a literal written at the call site is translated;
/// a caller holding a value it built itself (a month heading, a count) passes
/// `LocalizedStringKey(thatString)`.
struct SectionHeader: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(TypeScale.section)
                .tracking(1.2)
                .foregroundStyle(Palette.inkSoft)
            Spacer(minLength: 0)
            if let detail {
                Text(detail)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
        }
    }
}

/// A hairline that respects the card's inner margins.
struct CardDivider: View {
    var inset: CGFloat = 0
    var body: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(height: 0.7)
            .padding(.leading, inset)
    }
}

/// Card-shaped button wrapper: gives a card the press feedback of a control
/// without turning it into a `Button` with default styling.
struct CardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(Motion.quick, value: configuration.isPressed)
    }
}
