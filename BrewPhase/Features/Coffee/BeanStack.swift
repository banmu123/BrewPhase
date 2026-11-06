import SwiftUI

/// 豆仓的主体：一次只把一包豆推到前面，其余的在后面叠着。
///
/// The deck is driven by one continuous value rather than by a page index plus a
/// separate animation: `progress` moves with the finger, and every card derives
/// its scale, offset and opacity from its distance to that value. Releasing the
/// finger animates `index` and `pan` together, so the outgoing card keeps
/// travelling left while the next one grows into place — one motion, not two.
///
/// Ordering is whatever `PriorityEngine` already decided; this view only stacks
/// it. Nothing here is a deletion: sliding to the next bag is browsing.
struct BeanStack: View {

    let items: [BeanInsight]
    @Binding var index: Int
    let onOpen: (BeanInsight) -> Void
    let onBrew: (BeanInsight) -> Void

    @State private var pan: CGFloat = 0
    @State private var width: CGFloat = 1
    /// The bag the deck is showing, by identity rather than by position, so a
    /// re-rank (after logging a brew, say) does not silently swap what the user
    /// is looking at for a different bag. When that bag leaves the shelf
    /// (finished or deleted), the focus re-anchors to the card now on screen —
    /// see `BeanDeck.resolvedFocus`.
    @State private var focusedID: UUID?

    private var count: Int { items.count }

    /// `index` plus the fraction of a card the finger has already travelled.
    /// Dragging left increases it (next card), dragging right decreases it.
    private var progress: CGFloat {
        BeanDeck.progress(index: index, pan: pan, width: width)
    }

    var body: some View {
        VStack(spacing: 14) {
            deck
            if count > 1 {
                indicator
            }
        }
        .onAppear {
            // 首次出现与列表变化走**同一条**状态规则：focusedID 还是 nil，
            // resolvedFocus 走「重锚」分支——index 越界就被钳回（调试启动可以
            // 指定第 4 张卡，而架上只有 1 包豆；不钳的话 visiblePositions
            // 会算出空窗口，页面一张卡都不剩），焦点落在屏幕上的卡。
            let resolved = BeanDeck.resolvedFocus(
                focusedID: focusedID, index: index, ids: items.map(\.id))
            index = resolved.index
            focusedID = resolved.focusedID
        }
        .onChange(of: index) { _, newValue in
            focusedID = items.indices.contains(newValue) ? items[newValue].id : nil
        }
        .onChange(of: items) { _, newItems in
            let resolved = BeanDeck.resolvedFocus(
                focusedID: focusedID, index: index, ids: newItems.map(\.id))
            index = resolved.index
            focusedID = resolved.focusedID
        }
    }

    // MARK: - Deck

    private var deck: some View {
        ZStack {
            ForEach(visiblePositions, id: \.self) { position in
                let depth = CGFloat(position) - progress
                let isFront = position == index
                // A card being pulled back to the right is still the front card:
                // it follows the finger at full size instead of shrinking into
                // the deck before it has actually left.
                let visual = isFront ? min(depth, 0) : depth
                FocusedBeanCard(
                    insight: items[position],
                    onOpen: { onOpen(items[position]) },
                    onBrew: { onBrew(items[position]) }
                )
                .scaleEffect(scale(visual), anchor: .top)
                .offset(x: horizontal(visual, isFront: isFront), y: vertical(visual))
                .opacity(opacity(visual))
                .zIndex(-depth)
                // Only the front card takes taps; the rest are scenery.
                .allowsHitTesting(isFront)
                .accessibilityHidden(!isFront)
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .contentShape(Rectangle())
        // Simultaneous rather than exclusive: the page still scrolls vertically,
        // and a tap still reaches the card's own button. `pan` only ever moves
        // for a gesture that is predominantly horizontal.
        .simultaneousGesture(swipeGesture)
        .sensoryFeedback(.selection, trigger: index)
    }

    /// Everything within reach of the front card, so a long cellar does not keep
    /// twenty off-screen cards (and their images) in the tree.
    private var visiblePositions: [Int] {
        guard count > 0 else { return [] }
        let lower = max(0, index - 1)
        let upper = min(count - 1, index + 2)
        guard lower <= upper else { return [] }
        return Array(lower...upper)
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                // A vertical drag belongs to the scroll view.
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                var dx = value.translation.width
                let atStart = index == 0 && dx > 0
                let atEnd = index == count - 1 && dx < 0
                if atStart || atEnd { dx *= 0.28 }
                pan = dx
            }
            .onEnded { value in
                guard pan != 0 else { return }
                // 组件专用的滑动阈值（v1.1 QA §4）：跟手 20% 卡宽、下限 44pt
                // （一个点击区的宽度）、上限 84pt（防轻扫过灵）。调试时动过它，
                // 三张切卡截图都要复核。
                let threshold = min(84, max(width * 0.2, 44))
                let momentum = value.predictedEndTranslation.width
                var target = index

                if value.translation.width < -threshold || momentum < -width * 0.55 {
                    target = min(index + 1, count - 1)
                } else if value.translation.width > threshold || momentum > width * 0.55 {
                    target = max(index - 1, 0)
                }

                withAnimation(Motion.swipe) {
                    index = target
                    pan = 0
                }
            }
    }

    // MARK: - Geometry of one card

    private func scale(_ depth: CGFloat) -> CGFloat { BeanDeck.scale(depth) }

    /// A card on its way out follows the finger; the cards behind it stay
    /// centred until they become the one being swiped.
    private func horizontal(_ depth: CGFloat, isFront: Bool) -> CGFloat {
        if depth < 0 { return BeanDeck.horizontal(depth, width: width) }
        return isFront ? pan : 0
    }

    private func vertical(_ depth: CGFloat) -> CGFloat { BeanDeck.vertical(depth) }

    private func opacity(_ depth: CGFloat) -> Double { BeanDeck.opacity(depth) }

    // MARK: - Indicator

    private var indicator: some View {
        HStack(spacing: 10) {
            Text(verbatim: String(format: "%02d / %02d", index + 1, count))
                .font(TypeScale.micro.monospacedDigit())
                .foregroundStyle(Palette.inkFaint)
                .contentTransition(.numericText())
                .animation(Motion.quick, value: index)

            Spacer(minLength: 0)

            HStack(spacing: 2) {
                stepButton(systemImage: "chevron.left", label: "上一包", enabled: index > 0) {
                    move(by: -1)
                }
                stepButton(systemImage: "chevron.right", label: "下一包", enabled: index < count - 1) {
                    move(by: 1)
                }
            }
        }
        .padding(.horizontal, 2)
    }

    private func stepButton(
        systemImage: String,
        label: LocalizedStringKey,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            withAnimation(Motion.swipe) { action() }
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(enabled ? Palette.inkSoft : Palette.inkFaint.opacity(0.35))
                .frame(width: 30, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }

    private func move(by delta: Int) {
        let target = min(max(index + delta, 0), count - 1)
        if target != index { index = target }
    }
}

// MARK: - The arithmetic of the deck

/// Where each card sits, given how far the deck has travelled.
///
/// Kept out of the view so the rules are one readable page and can be checked
/// without a screen: a card's depth is its distance from the front. Depth 0 is
/// full size and centred; positive depths sit behind, smaller and lifted by a
/// constant peck; negative depths are cards already swiped away, travelling left
/// and fading.
enum BeanDeck {

    /// Focus, resolved after the ranked list changed.
    ///
    /// Two pieces of state, two jobs: `index` is where the deck rests;
    /// `focusedID` is *which bean the user is reading*. Identity is what lets a
    /// re-rank slide the deck along with the bean instead of swapping cards
    /// under the user's eyes — but only while that bean is on the shelf.
    ///
    /// When the focused bean leaves (finished, deleted), the card that took its
    /// place is what the user is now looking at: the focus re-anchors to it.
    /// The old behaviour kept the stale id around, so if that bean later
    /// returned to the shelf, the deck yanked itself back to it without any
    /// gesture — a silent swap of exactly the kind identity-focus exists to
    /// prevent. Re-anchoring is the whole fix; nothing else about the contract
    /// changes.
    ///
    /// - Parameters:
    ///   - focusedID: which bean the user was reading (`nil` before first layout).
    ///   - index: where the deck was resting.
    ///   - ids: the new ranked list, by id only — this must stay checkable
    ///     without a screen.
    /// - Returns: the new `(index, focusedID)` pair.
    static func resolvedFocus(focusedID: UUID?, index: Int,
                              ids: [UUID]) -> (index: Int, focusedID: UUID?) {
        guard !ids.isEmpty else { return (0, nil) }
        if let focusedID, let position = ids.firstIndex(of: focusedID) {
            // Still on the shelf: the deck follows the bean through re-ranks.
            return (position, focusedID)
        }
        // The focused bean is gone: rest where the deck rests — clamped, in
        // case the list shrank past the current position — and let the card on
        // screen own the focus from here on.
        let clamped = min(max(index, 0), ids.count - 1)
        return (clamped, ids[clamped])
    }

    /// A card's width is unknown on the very first layout pass; a gesture that
    /// arrived before it was measured must not fling the deck, so an unmeasured
    /// width simply means "resting on the current card".
    static func progress(index: Int, pan: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 1 else { return CGFloat(index) }
        return CGFloat(index) - pan / width
    }

    static func scale(_ depth: CGFloat) -> CGFloat {
        guard depth > 0 else { return 1 }
        return 1 - Metric.stackDepthScale * min(depth, 2)
    }

    /// Only cards that have been swiped away move horizontally — and they move
    /// a full card plus a margin, so they are fully off the page by depth −1.
    static func horizontal(_ depth: CGFloat, width: CGFloat) -> CGFloat {
        depth < 0 ? depth * (max(width, 1) + 24) : 0
    }

    static func vertical(_ depth: CGFloat) -> CGFloat {
        depth > 0 ? -Metric.stackPeek * min(depth, 2) : 0
    }

    static func opacity(_ depth: CGFloat) -> Double {
        depth < 0 ? Double(max(0, 1 + depth * 1.15)) : 1
    }
}

// MARK: - The card itself
/// One bag, at the front of the stack — an archive card on the studio bench.
///
/// The photo leads (a real picture when the user has one, a quiet ceramic
/// placeholder when they don't), the name follows, then the phase, the track,
/// what's left, and exactly two actions: brew it, or read the archive.
/// Everything else — the tally, the full flavour analysis, the estimate, the
/// history — lives on the detail page. The card is an invitation, not a dashboard.
struct FocusedBeanCard: View {

    let insight: BeanInsight
    let onOpen: () -> Void
    let onBrew: () -> Void

    private var bean: BeanSnapshot { insight.bean }
    private var reading: PhaseReading { insight.reading }
    private var verdict: PriorityVerdict { insight.verdict }
    private var phaseColor: Color {
        PhasePresentation.color(phase: reading.phase, tier: verdict.tier)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            hero

            VStack(alignment: .leading, spacing: 0) {
                identity.padding(.top, CardLayout.identityGap)
                phaseRow.padding(.top, CardLayout.phaseGap)
                if let reason {
                    Text(LocalizedStringKey.alreadyLocalized(reason))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, CardLayout.reasonGap)
                }
                PhaseTrack(reading: reading, showsMarker: true, showsLegend: false, barHeight: 6)
                    .padding(.top, CardLayout.trackGap)
                stockRow.padding(.top, CardLayout.stockGap)
            }
            .padding(.horizontal, Metric.cardPadding)
            .padding(.top, CardLayout.identityGap)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)

            Spacer(minLength: CardLayout.actionGap)

            PrimaryButton(title: "开始冲煮", systemImage: "cup.and.saucer.fill", action: onBrew)
                .padding(.horizontal, Metric.cardPadding)
                .padding(.bottom, Metric.cardPadding)
        }
        .frame(maxWidth: .infinity, minHeight: CardLayout.minHeight, alignment: .topLeading)
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: Metric.radiusLarge, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radiusLarge, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
        .shadow(color: Palette.liftedShadow, radius: 18, x: 0, y: 8)
    }

    // MARK: - Hero

    /// The bag's own picture, full width and flush with the card's top corners.
    /// Loaded from the **400px thumbnail** (v1.1 QA §1): the deck keeps up to
    /// four cards alive, and a 1400px display copy per card costs ~9× the
    /// decoded memory of a thumbnail for a band that renders at 148pt. The
    /// detail page still reads the full-size image. `ImageStore` falls back to
    /// the display copy when a thumbnail file is missing (older backups), so
    /// the deck never shows an empty frame for a bean that has a photo.
    private var hero: some View {
        Group {
            if let image = ImageStore.shared.image(named: bean.imagePath, thumbnail: true) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ceramic
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: CardLayout.heroHeight)
        .clipped()
        .accessibilityHidden(true)
    }

    /// 无照片时的陶瓷展示区（v1.1 QA §2）。灰面上部受光、底部落影——两段
    /// 极淡的透明渐变做出陶面哑光，中央一粒手绘的豆形原画托在细线圈里，
    /// 左下一行拉丁 overline 收尾。它与照片 hero 同高同宽，保证整个 deck
    /// 只有一个节奏；不用网络图、不做大面积渐变、不加装饰纹理。
    private var ceramic: some View {
        ZStack {
            Palette.well

            LinearGradient(colors: [Palette.card.opacity(0.55), .clear],
                           startPoint: .top,
                           endPoint: UnitPoint(x: 0.5, y: 0.6))
            LinearGradient(colors: [.clear, Palette.wellDeep.opacity(0.9)],
                           startPoint: UnitPoint(x: 0.5, y: 0.55),
                           endPoint: .bottom)

            ZStack {
                Circle()
                    .strokeBorder(Palette.latte.opacity(0.4), lineWidth: 0.8)
                BeanGlyph()
                    .stroke(Palette.latte, lineWidth: 1.3)
                    .rotationEffect(.degrees(-14))
                    .frame(width: 38, height: 26)
            }
            .frame(width: 66, height: 66)

            VStack {
                Spacer()
                HStack {
                    Text(verbatim: "AWAITING PHOTOGRAPH")
                        .font(TypeScale.brandMark)
                        .italic()
                        .tracking(2.2)
                        .foregroundStyle(Palette.inkSoft)
                    Spacer()
                }
                .padding(.leading, Metric.cardPadding)
                .padding(.bottom, 12)
            }
        }
    }

    // MARK: - Rows

    private var identity: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                .font(TypeScale.beanName)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .fixedSize(horizontal: false, vertical: true)

            Text(originLine)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineLimit(1)
        }
    }

    private var phaseRow: some View {
        HStack(spacing: 6) {
            PhaseDot(color: phaseColor, size: 7)
            Text(PhasePresentation.title(phase: reading.phase, tier: verdict.tier))
                .font(TypeScale.caption.weight(.medium))
                .foregroundStyle(phaseColor)
            Spacer(minLength: 8)
            Text(verbatim: Fmt.day(reading.dayAfterRoast))
                .font(TypeScale.dataSmall)
                .foregroundStyle(Palette.inkFaint)
        }
    }

    /// What's left, in monospaced data; the archive opens from the other end
    /// of the same line, so the card keeps exactly two actions.
    private var stockRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(L("剩余 %@", Fmt.grams(bean.remainingG)))
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.ink)

            Spacer(minLength: 8)

            Button(action: onOpen) {
                HStack(spacing: 3) {
                    Text("查看详情")
                        .font(TypeScale.caption)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(Palette.roast)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("查看详情")
        }
    }

    // MARK: - Words

    /// The roaster, or the roast level when there is no roaster — one line only.
    private var originLine: String {
        bean.roaster.isEmpty ? bean.roastLevel.label : bean.roaster
    }

    /// At most one supporting fact, from the verdict the engine already built.
    /// It is the *why*, never a second recommendation.
    private var reason: String? {
        if let detail = verdict.details.first { return detail }
        if let closing = verdict.closing { return closing }
        return reading.phase == .resting ? verdict.headline : nil
    }
}

/// 档案卡的构图值（v1.1 QA §4）。这些尺寸不属于 4pt 梯子——它们是这张卡
/// 专属的版式：hero 决定整个 deck 的节奏，minHeight 保证一屏放得下主卡，
/// 行间距是逐行收紧再放宽的「档案秩序」。改任何一个，七张验收截图都要重拍。
private enum CardLayout {
    /// 照片 hero 与陶瓷占位的共同高度——deck 的节奏由它定。
    static let heroHeight: CGFloat = 148
    /// 卡片下限：单行名字 + 单行理由的卡在 16 Pro 上的自然高度；内容更多时
    /// 卡片向下生长，不裁文字。
    static let minHeight: CGFloat = 372
    /// 名称区（上、下两处：hero 之后与卡身顶部同值，保持一个呼吸单位）。
    static let identityGap: CGFloat = 16
    /// 名称 → 阶段行。
    static let phaseGap: CGFloat = 13
    /// 阶段行 → 理由。
    static let reasonGap: CGFloat = 11
    /// 理由 → 阶段轨道。
    static let trackGap: CGFloat = 17
    /// 轨道 → 余量行。
    static let stockGap: CGFloat = 14
    /// 内容 → 主按钮之间的最小空隙。
    static let actionGap: CGFloat = 20
}

/// 一粒咖啡豆的线性原画：外轮廓椭圆，中缝一条缓 S 曲线。没有图片资源——
/// 纯 `Path`，它是陶瓷占位里唯一的图形语言。
private struct BeanGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addEllipse(in: rect)
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addQuadCurve(
            to: CGPoint(x: rect.midX, y: rect.maxY),
            control: CGPoint(x: rect.width * 0.8, y: rect.height * 0.5)
        )
        return path
    }
}
