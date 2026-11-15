import SwiftUI

/// 一个空间在首页的样子：一列错位叠放的小卡片。
///
/// 三列共用同一套几何（`WorkspaceStackLayout`）、同一个上限、同一种卡片，
/// 所以 Coffee 不会比 Records 更重——这是这一版首页的硬约束。
///
/// 点击分两层：
/// * 点**最前面那张卡** → 打开这条内容；
/// * 点**标题、露出的卡片边缘、或空态卡** → 进入这个空间。
///
/// 后面的卡片 `allowsHitTesting(false)`：它们是纵深，不是按钮。这样重叠区域
/// 不会出现「点到了看不见的那张」的错乱。
struct WorkspaceCardStackView: View {

    let space: AppTab
    let cards: [WorkspaceCard]
    /// 画布卡的节点缩略图需要模型对象。
    var canvases: [UUID: Canvas] = [:]
    let accent: Color
    let onOpenSpace: () -> Void
    let onOpenCard: (WorkspaceCard) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: [WorkspaceCard] {
        Array(cards.prefix(WorkspaceStackLayout.visibleLimit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metric.Space.xs) {
            header
            stack
        }
    }

    // MARK: - 空间名

    private var header: some View {
        Button(action: onOpenSpace) {
            HStack(spacing: 3) {
                Text(verbatim: space.title)
                    .font(TypeScale.section)
                    .tracking(0.8)
                    .foregroundStyle(accent)
                    .lineLimit(1)

                Spacer(minLength: 2)

                if !cards.isEmpty, cards.first?.kind != .empty {
                    Text(verbatim: String(cards.count))
                        .font(.system(size: 10, weight: .medium).monospacedDigit())
                        .foregroundStyle(Palette.inkFaint)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
            // 24pt 的可视高度 + 上下各 10pt 的触摸余量 = 44pt。
            .frame(height: 24)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: L("进入%@", space.title)))
    }

    // MARK: - 堆叠

    private var stack: some View {
        ZStack(alignment: .top) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { depth, card in
                cardLayer(card, depth: depth)
                    .offset(
                        x: WorkspaceStackLayout.shift(depth: depth),
                        y: WorkspaceStackLayout.drop(depth: depth)
                    )
                    .opacity(WorkspaceStackLayout.opacity(depth: depth))
                    .zIndex(Double(-depth))
                    .allowsHitTesting(depth == 0)
                    .accessibilityHidden(depth != 0)
            }
        }
        .padding(.bottom, WorkspaceStackLayout.stackBottomPadding(itemCount: cards.count))
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpenSpace)
        .animation(reduceMotion ? Motion.fade : Motion.settle, value: visible.map(\.id))
    }

    @ViewBuilder
    private func cardLayer(_ card: WorkspaceCard, depth: Int) -> some View {
        let view = WorkspaceCardView(
            card: card,
            canvas: card.canvasID.flatMap { canvases[$0] },
            accent: accent
        )

        if depth == 0, card.target != .none {
            Button { onOpenCard(card) } label: { view }
                .buttonStyle(CardButtonStyle())
                .accessibilityHint(Text(verbatim: L("打开%@", card.overline)))
        } else {
            view
        }
    }
}

private extension WorkspaceCard {
    /// 画布卡的缩略图按这个 id 去取模型对象。
    var canvasID: UUID? {
        if case .canvas(let id) = target { return id }
        return nil
    }
}
