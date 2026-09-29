import SwiftUI

/// Empty states (§27). One sentence, one line of guidance, one button.
///
/// The text is `LocalizedStringKey` rather than `String` on purpose: that is the
/// type SwiftUI looks up in the language bundle, so a literal handed to one of
/// these components is translated. Callers that have already built a string —
/// with `L()`, or from user data — wrap it themselves.
struct EmptyStateView: View {
    let symbol: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    var actionLabel: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Palette.well)
                    .frame(width: 72, height: 72)
                Image(systemName: symbol)
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(Palette.latte)
            }
            .padding(.bottom, 2)

            Text(title)
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)

            Text(message)
                .font(TypeScale.body)
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(maxWidth: 280)

            if let actionLabel, let action {
                Button(action: action) {
                    Text(actionLabel)
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.card)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 11)
                        .background(Capsule(style: .continuous).fill(Palette.roast))
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
    }
}

/// The primary action button, used for "开始冲煮" and "保存".
struct PrimaryButton: View {
    let title: LocalizedStringKey
    var systemImage: String?
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 14, weight: .semibold))
                }
                Text(title)
                    .font(TypeScale.bodyMedium)
            }
            .foregroundStyle(Palette.card)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(isEnabled ? Palette.roast : Palette.latte.opacity(0.45))
            )
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .animation(Motion.quick, value: isEnabled)
    }
}

/// Quiet secondary action — "复制上次参数", "添加风味记录".
struct SecondaryButton: View {
    let title: LocalizedStringKey
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 12.5, weight: .semibold))
                }
                Text(title)
                    .font(TypeScale.callout.weight(.medium))
            }
            .foregroundStyle(Palette.roast)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                Capsule(style: .continuous)
                    .fill(Palette.cream.opacity(0.6))
            )
        }
        .buttonStyle(.plain)
    }
}
