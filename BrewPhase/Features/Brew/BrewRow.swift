import SwiftUI

/// One brew, in a list.
///
/// The line the eye should catch is the recipe — `18g / 300g · 92°C · 2:35` —
/// because that is the thing worth repeating (§11).
struct BrewRow: View {

    let brew: Brew
    var showsBeanName: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            recipeLine
            verdict
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(brew.method.isEmpty ? "冲煮" : brew.method)
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)

            if showsBeanName, let bean = brew.bean {
                Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            Text(Fmt.short(brew.date))
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
        }
    }

    private var recipeLine: some View {
        HStack(spacing: 0) {
            if brew.coffeeG > 0 || brew.waterG > 0 {
                Text(brew.doseLine)
                    .font(TypeScale.callout.monospacedDigit())
                    .foregroundStyle(Palette.inkSoft)
            }
            if brew.ratio > 0 {
                Text(" · ")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
                Text(brew.ratioText)
                    .font(TypeScale.callout.monospacedDigit())
                    .foregroundStyle(Palette.inkFaint)
            }
            if brew.waterTemp > 0 {
                Text(" · ")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
                Text("\(Int(brew.waterTemp.rounded()))°C")
                    .font(TypeScale.callout.monospacedDigit())
                    .foregroundStyle(Palette.inkFaint)
            }
            if brew.timeSeconds > 0 {
                Text(" · ")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
                Text(brew.timeText)
                    .font(TypeScale.callout.monospacedDigit())
                    .foregroundStyle(Palette.inkFaint)
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
    }

    @ViewBuilder
    private var verdict: some View {
        if brew.score > 0 || !brew.flavorTags.isEmpty || !brew.notes.trimmed.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if brew.score > 0 {
                    StarRating(score: brew.score, size: 11)
                }
                if !brew.flavorTags.isEmpty {
                    Text(verbatim: FlavorLibrary.displayList(brew.flavorTags))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.roast.opacity(0.9))
                        .lineLimit(1)
                }
                if !brew.notes.trimmed.isEmpty {
                    Text(brew.notes)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
