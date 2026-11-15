import SwiftUI

/// 空间之间怎么走。三个模块页共享同一份，由 `RootView` 注入。
///
/// 不用 `@Environment` 值：这里只有两个闭包，显式传参比给环境加一个只有
/// 导航用的键更直白，也不会在预览里悄悄拿到一个空的默认实现。
struct SpaceNavigation {
    var goHome: () -> Void = {}
    var open: (AppTab) -> Void = { _ in }
}

/// 模块页顶部的空间切换条：返回工作台，以及直接换到另一个空间。
///
/// 它挂在每个模块 `NavigationStack` 的**根页面**上（`safeAreaInset`），所以
/// 推开一包豆、一条记录、一块画布时它自然消失——详情页只需要系统的返回按钮，
/// 不该同时出现两套导航。
struct SpaceSwitcherBar: View {

    let current: AppTab
    var navigation = SpaceNavigation()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                homeButton
                Spacer(minLength: 4)
                HStack(spacing: 1) {
                    ForEach(AppTab.allCases) { space in
                        chip(space)
                    }
                }
            }
            .padding(.horizontal, Metric.gutter)
            .frame(height: 44)

            Hairline()
        }
        .background(Palette.paper)
    }

    private var homeButton: some View {
        Button {
            navigation.goHome()
        } label: {
            HStack(spacing: 2) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 10, weight: .semibold))
                Text(verbatim: L("工作台"))
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(Palette.inkSoft)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: L("返回工作台")))
    }

    private func chip(_ space: AppTab) -> some View {
        let isSelected = space == current

        return Button {
            guard !isSelected else { return }
            navigation.open(space)
        } label: {
            Text(verbatim: space.title)
                .font(.system(size: 11.5, weight: isSelected ? .semibold : .medium))
                .foregroundStyle(isSelected ? Palette.ink : Palette.inkFaint)
                .lineLimit(1)
                .padding(.horizontal, 9)
                .frame(height: 30)
                .background(
                    Capsule(style: .continuous)
                        .fill(isSelected ? Palette.cream.opacity(0.7) : .clear)
                )
                // 视觉是 30pt 的胶囊，触摸区仍是 44pt。
                .frame(height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: space.title))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}
