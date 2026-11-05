import SwiftUI

/// The one container shape. A card is a white rounded rectangle with a single
/// hairline. No shadow by default — the page's grey is enough separation, and a
/// page of floating cards is exactly what this redesign is moving away from.
///
/// `lifted` is reserved for the one thing that is genuinely in front of
/// everything else: the focused bag on the home screen.
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
                    .strokeBorder(Palette.hairline.opacity(hairline ? 1 : 0), lineWidth: 0.7)
            )
            .shadow(
                color: lifted ? Palette.liftedShadow : .clear,
                radius: lifted ? 18 : 0,
                x: 0,
                y: lifted ? 8 : 0
            )
    }
}

/// Small label that opens a group of content on the page.
///
/// Keys rather than strings so a literal written at the call site is translated;
/// a caller holding a value it built itself (a month heading, a count) passes
/// `LocalizedStringKey(thatString)`.
/// Small label that opens a group of content on the page.
///
/// Keys rather than strings so a literal written at the call site is translated;
/// a caller holding a value it built itself (a month heading, a count) passes
/// `LocalizedStringKey(thatString)`.
struct SectionLabel: View {
    let title: LocalizedStringKey

    var body: some View {
        Text(title)
            .font(TypeScale.section)
            .tracking(1.1)
            .foregroundStyle(Palette.inkSoft)
    }
}

/// Label plus an optional count on the other end of the line.
struct SectionHeader: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            SectionLabel(title: title)
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

/// The page's separator: one hairline across the content width.
///
/// Pages that are not made of cards still need to say where one thought ends and
/// the next begins; this is that line, and the only one they use.
struct Hairline: View {
    var body: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(height: 0.7)
    }
}

/// Card-shaped button wrapper: gives a card the press feedback of a control
/// without turning it into a `Button` with default styling.
struct CardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(Motion.quick, value: configuration.isPressed)
    }
}
