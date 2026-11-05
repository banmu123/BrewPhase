import SwiftUI

/// 一枚筛选胶囊：选中的是深色实心，未选中的是白底细边。
///
/// 记录页用它区分六个分类；将来别处要筛选也可以直接用，不必再定义一套
/// 「选中/未选中」的按钮样式。
struct FilterChip: View {

    let title: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(TypeScale.caption.weight(isOn ? .semibold : .regular))
                .foregroundStyle(isOn ? Palette.card : Palette.inkSoft)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule(style: .continuous)
                        .fill(isOn ? Palette.espresso : Palette.card)
                )
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(isOn ? .clear : Palette.hairline, lineWidth: 0.8)
                )
        }
        .buttonStyle(.plain)
        .animation(Motion.quick, value: isOn)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}
