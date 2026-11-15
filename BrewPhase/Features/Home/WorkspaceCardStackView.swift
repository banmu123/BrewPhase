import SwiftUI

/// 一个空间在首页的样子：标题一行，下面几张卡横向叠成一摞。
///
/// 三个分区**纵向**排列（每区一行），而不是三列并排：手机上三列会把内容挤在
/// 屏幕上半截，下半屏全是空白。三行铺满一屏，页面才站得住。
///
/// 整个分区就是一个按钮——点标题、点卡片、点空白，都是「进入这个空间」。
/// 首页卡片只是预览，不承担「打开某一条」的职责：真正的列表在空间页里，
/// 用户要的是先看见这一栏有什么，再进去翻。
///
/// Gravity Cards（Phase 2）：卡片受设备重力独立滑动，但**只改渲染偏移**
/// （`.offset` / `.rotationEffect`），布局 frame 与按钮语义原样——卡片滑到
/// 哪里都不影响点哪里，也不影响 ScrollView 的内容尺寸。分区标题不参与运动。
/// 物理时间线与引擎步进由宿主（`WorkspaceHomeView`）统一驱动，本视图只按
/// 稳定卡 ID 读取渲染值。
struct WorkspaceCardStackView: View {

    let space: AppTab
    let cards: [WorkspaceCard]
    /// 画布卡的节点缩略图需要模型对象。
    var canvases: [UUID: Canvas] = [:]
    let accent: Color
    let onOpenSpace: () -> Void

    /// Gravity Cards：首页重力场。nil = 关闭 / Reduce Motion / 无传感器，
    /// 完全沿用静态堆叠。
    var field: WorkspaceGravityField?
    /// 当前渲染帧的时刻。引擎状态不是可观察对象，靠这个值变化把
    /// 「这一帧该重画了」传给 SwiftUI（否则可能沿用上一帧的偏移）。
    var frameToken: Date = .distantPast

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
        .onAppear { field?.reconcile(cards: cards, for: space) }
        .onChange(of: cards) { field?.reconcile(cards: $0, for: space) }
    }

    private var accessibilityValue: String {
        guard let first = cards.first, first.kind != .empty else { return L("空着") }
        return L("%@ 条内容", String(cards.count))
    }

    // MARK: - 空间名（固定，不参与运动）

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
    /// 这样只有一张内容的分区和有三张的分区，卡片是同一个尺寸。否则空态卡
    /// 会被拉成整屏宽，看起来像另一套组件。
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
                    .modifier(WorkspaceGravityRenderModifier(
                        field: field,
                        space: space,
                        card: card,
                        frameToken: frameToken
                    ))
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

// MARK: - 重力渲染

/// 单张卡的重力渲染：读引擎快照画 offset / rotation，无状态、无计时器。
///
/// 刷新由宿主的 `TimelineView` 驱动；这里读的属性刻意不参与观察，
/// 否则 30Hz 的传感器输入会把整个分区反复重建。
struct WorkspaceGravityRenderModifier: ViewModifier {

    let field: WorkspaceGravityField?
    let space: AppTab
    let card: WorkspaceCard
    /// 帧令牌：只有它的变化才让这张卡重读到新的物理偏移。
    let frameToken: Date

    func body(content: Content) -> some View {
        if let field {
            let render = field.render(for: card.id, in: space, at: frameToken)
            content
                .offset(x: render.offset.x, y: render.offset.y)
                .rotationEffect(.radians(render.rotation))
        } else {
            content
        }
    }
}

// MARK: - 行程推导

/// 一个分区可用行程的推导。独立出来供测试：行程 = 布局留白与设置上限的交集。
///
/// 行程不是拍脑袋的常数——它由真实布局决定，再被设置上限收窄。任一方向
/// 的池子变小（更窄的机型、更大的动态字体把标题撑高），行程跟着缩。
enum WorkspaceGravityTravel {

    /// 首页的实际边界。
    ///
    /// - 水平：页面左右各 `Metric.gutter`（22pt）的留白，卡片左右各有 16pt
    ///   可去，永远出不了屏幕。
    /// - 垂直：卡片上方 8pt 就是本分区标题，下方 20pt 是下一个分区。上行留
    ///   2pt 安全边（6pt），下行不超过间距一半（10pt），取小者 = 6pt。
    ///   两端都小于相邻元素的间距，因此**任何一张卡都盖不住标题**。
    static var homeBounds: WorkspaceGravityBounds {
        let up = max(0, Metric.Space.xs - 2)
        let down = max(0, (Metric.Space.lg) / 2)
        let vertical = min(WorkspaceMotionSettings.maxVerticalTravel, min(up, down))
        let horizontal = min(WorkspaceMotionSettings.maxHorizontalTravel, Metric.gutter - 2)
        return WorkspaceGravityBounds(
            horizontalTravel: max(0, horizontal),
            verticalTravel: max(0, vertical)
        )
    }

    /// 通用推导：给可用留白池，得到实际行程。
    static func derive(
        horizontalPool: CGFloat,
        verticalPool: CGFloat
    ) -> WorkspaceGravityBounds {
        WorkspaceGravityBounds(
            horizontalTravel: min(
                WorkspaceMotionSettings.maxHorizontalTravel,
                max(0, horizontalPool) / 2
            ),
            verticalTravel: min(
                WorkspaceMotionSettings.maxVerticalTravel,
                max(0, verticalPool) / 2
            )
        )
    }
}

private extension WorkspaceCard {
    /// 画布卡的缩略图按这个 id 去取模型对象。
    var canvasID: UUID? {
        if case .canvas(let id) = target { return id }
        return nil
    }
}
