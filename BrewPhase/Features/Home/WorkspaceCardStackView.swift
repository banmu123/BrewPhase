import SwiftUI

/// 一个空间在首页的样子：标题一行，下面几张卡横向叠成一摞。
///
/// 三个分区**纵向**排列（每区一行），而不是三列并排：手机上三列会把内容挤在
/// 屏幕上半截，下半截全是空白。三行铺满一屏，页面才站得住。
///
/// 整个分区就是一个按钮——点标题、点卡片、点空白，都是「进入这个空间」。
/// 首页卡片只是预览，不承担「打开某一条」的职责：真正的列表在空间页里，
/// 用户要的是先看见这一栏有什么，再进去翻。
struct WorkspaceCardStackView: View {

    let space: AppTab
    let cards: [WorkspaceCard]
    /// 画布卡的节点缩略图需要模型对象。
    var canvases: [UUID: Canvas] = [:]
    let accent: Color
    let onOpenSpace: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: [WorkspaceCard] {
        Array(cards.prefix(WorkspaceStackLayout.visibleLimit))
    }

    var body: some View {
        Button(action: onOpenSpace) {
            VStack(alignment: .leading, spacing: Metric.Space.xs) {
                header
                stack
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: L("进入%@", space.title)))
        .accessibilityValue(Text(verbatim: accessibilityValue))
        .accessibilityAddTraits(.isButton)
    }

    private var accessibilityValue: String {
        guard let first = cards.first, first.kind != .empty else { return L("空着") }
        return L("%@ 条内容", String(cards.count))
    }

    // MARK: - 空间名

    private var header: some View {
        HStack(spacing: 6) {
            Text(verbatim: space.title)
                .font(TypeScale.section)
                .tracking(0.8)
                .foregroundStyle(accent)
                .lineLimit(1)

            if let first = cards.first, first.kind != .empty {
                Text(verbatim: String(cards.count))
                    .font(.system(size: 10, weight: .medium).monospacedDigit())
                    .foregroundStyle(Palette.inkFaint)
            }

            Spacer(minLength: 4)

            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(height: 22)
        .contentShape(Rectangle())
    }

    // MARK: - 叠放的卡片

    /// 负间距把卡片叠起来：后一张压在前一张下面，只露出一条边。
    ///
    /// **永远画满三个卡位**（不足的用透明占位）：卡片宽度由「整行 ÷ 3」决定，
    /// 这样只有一张内容的分区和有三张的分区，卡片是同一个尺寸。否则空态卡会
    /// 被拉成整屏宽，看起来像另一套组件。
    private var stack: some View {
        HStack(alignment: .top, spacing: -WorkspaceStackLayout.cardOverlap) {
            ForEach(0..<WorkspaceStackLayout.visibleLimit, id: \.self) { depth in
                if depth < visible.count {
                    let card = visible[depth]
                    WorkspaceCardView(
                        card: card,
                        canvas: card.canvasID.flatMap { canvases[$0] },
                        accent: accent
                    )
                    .frame(maxWidth: .infinity)
                    .offset(y: WorkspaceStackLayout.lift(depth: depth))
                    .opacity(WorkspaceStackLayout.opacity(depth: depth))
                    .zIndex(Double(-depth))
                } else {
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .zIndex(Double(-depth))
                }
            }
        }
        .padding(.bottom, WorkspaceStackLayout.sectionBottomPadding(itemCount: cards.count))
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? Motion.fade : Motion.settle, value: visible.map(\.id))
    }
}

private extension WorkspaceCard {
    /// 画布卡的缩略图按这个 id 去取模型对象。
    var canvasID: UUID? {
        if case .canvas(let id) = target { return id }
        return nil
    }
}
