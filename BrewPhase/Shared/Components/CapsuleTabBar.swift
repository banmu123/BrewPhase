import SwiftUI

/// 底部导航：一枚浮起来的胶囊，三个入口。
///
/// 系统 Tab Bar 被隐藏了，原因很直接——它的形状、图标与选中态都无法改成这个
/// 样子，而自定义一个「看起来像 Tab Bar」的排版本质上是在和系统打架。这里只
/// 保留它真正需要承担的东西：三个目的地、清楚的选中态、以及足够大的点击区域。
///
/// 它通过 `safeAreaInset` 参与安全区，所以页面内容永远不会被压在下面——包括
/// 滚动到底部的列表。
struct CapsuleTabBar: View {

    @Binding var selection: AppTab

    var body: some View {
        HStack(spacing: 2) {
            ForEach(AppTab.allCases) { tab in
                item(tab)
            }
        }
        .padding(5)
        .background(
            Capsule(style: .continuous)
                .fill(Palette.card)
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.8)
        )
        .shadow(color: Palette.cardShadow, radius: 14, x: 0, y: 5)
    }

    private func item(_ tab: AppTab) -> some View {
        let isSelected = selection == tab
        return Button {
            guard !isSelected else { return }
            withAnimation(Motion.pop) { selection = tab }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.symbol)
                    .font(.system(size: 16, weight: isSelected ? .semibold : .regular))
                    .frame(height: 18)
                Text(tab.title)
                    .font(.system(size: 10.5, weight: isSelected ? .semibold : .medium))
            }
            .foregroundStyle(isSelected ? Palette.espresso : Palette.inkFaint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(
                Capsule(style: .continuous)
                    .fill(isSelected ? Palette.cream.opacity(0.55) : .clear)
            )
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}
