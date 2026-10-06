import SwiftUI

/// The five words the app uses for a bag's state.
///
/// The engine only knows four time-based phases; "建议优先消耗" is the fifth
/// state in the product vocabulary and is derived from phase + priority, so the
/// user never sees a score, only a sentence.
enum PhasePresentation {
    static func title(phase: BeanPhase, tier: PriorityTier) -> String {
        switch (phase, tier) {
        case (.declining, .high), (.declining, .urgent): return L("建议优先消耗")
        case (.declining, _): return L("风味衰减")
        case (.peak, _): return L("黄金风味期")
        case (.opening, _): return L("风味打开")
        case (.resting, _): return L("养豆期")
        }
    }

    static func subtitle(phase: BeanPhase, tier: PriorityTier) -> String {
        switch (phase, tier) {
        case (.declining, .high), (.declining, .urgent): return L("尽快喝完")
        case (.declining, _): return L("建议优先饮用")
        case (.peak, _): return L("现在喝")
        case (.opening, _): return L("风味开始打开")
        case (.resting, _): return L("正在养豆")
        }
    }

    static func color(phase: BeanPhase, tier: PriorityTier) -> Color {
        if phase == .declining, tier >= .high { return Palette.priority }
        return Palette.tint(phase)
    }
}

// MARK: - Building blocks

/// An 8pt state dot. This is the app's smallest unit of meaning.
struct PhaseDot: View {
    let color: Color
    var size: CGFloat = 8
    var halo: Bool = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay {
                if halo {
                    Circle()
                        .strokeBorder(color.opacity(0.22), lineWidth: 3)
                        .frame(width: size + 6, height: size + 6)
                }
            }
    }
}

/// Generic capsule. Used for flavour tags, counts and the phase badge.
struct Chip: View {
    let text: String
    var tint: Color = Palette.inkSoft
    var background: Color = Palette.well
    var dot: Color?
    var font: Font = TypeScale.caption
    var horizontalPadding: CGFloat = 9

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: 6, height: 6)
            }
            Text(text)
                .font(font)
                .foregroundStyle(tint)
                .lineLimit(1)
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, 5)
        .background(Capsule(style: .continuous).fill(background))
    }
}

/// Phase badge: dot + word. Never a filled background block — §23.
struct PhaseBadge: View {
    let phase: BeanPhase
    var tier: PriorityTier = .normal
    var showsSubtitle: Bool = false

    private var color: Color { PhasePresentation.color(phase: phase, tier: tier) }

    var body: some View {
        HStack(spacing: 6) {
            PhaseDot(color: color, size: 7)
            Text(PhasePresentation.title(phase: phase, tier: tier))
                .font(TypeScale.caption.weight(.medium))
                .foregroundStyle(color)
            if showsSubtitle {
                Text(PhasePresentation.subtitle(phase: phase, tier: tier))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
        }
    }
}

/// Flavour tag capsule. Cream ground, roast ink — the app's one warm pairing.
struct FlavorChip: View {
    let text: String
    var body: some View {
        Text(text)
            .font(TypeScale.caption)
            .foregroundStyle(Palette.roast)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Capsule(style: .continuous).fill(Palette.cream.opacity(0.55)))
    }
}

/// Selectable flavour tag used in the brew and tasting editors.
struct SelectableTag: View {
    let text: String
    let isOn: Bool
    var tint: Color = Palette.roast
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(TypeScale.caption)
                .foregroundStyle(isOn ? Palette.card : Palette.inkSoft)
                .lineLimit(1)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(
                    Capsule(style: .continuous)
                        .fill(isOn ? tint : Palette.well)
                )
        }
        .buttonStyle(.plain)
        .animation(Motion.pop, value: isOn)
    }
}

/// Small bordered tag for tags the user typed themselves.
struct CustomTag: View {
    let text: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 5) {
            Text(text)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.roast)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Palette.roast.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(
            Capsule(style: .continuous)
                .strokeBorder(Palette.latte.opacity(0.5), lineWidth: 1)
        )
    }
}
