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
    /// is looking at for a different bag.
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
            focusedID = items.indices.contains(index) ? items[index].id : nil
        }
        .onChange(of: index) { _, newValue in
            focusedID = items.indices.contains(newValue) ? items[newValue].id : nil
        }
        .onChange(of: items) { _, newItems in
            guard !newItems.isEmpty else { index = 0; return }
            if let focusedID, let position = newItems.firstIndex(where: { $0.id == focusedID }) {
                if position != index { index = position }
            } else if index >= newItems.count {
                index = max(0, newItems.count - 1)
            }
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
/// One bag, at the front of the stack.
///
/// Seven things and no more: picture, name, where it is from, its phase, its age,
/// how much is left, and the one action. Everything else — the tally, the full
/// flavour analysis, the estimate, the history — lives on the detail page. The
/// card is an invitation, not a dashboard.
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
            VStack(alignment: .leading, spacing: 0) {
                phaseRow
                identity.padding(.top, 16)
                if let reason {
                    Text(LocalizedStringKey.alreadyLocalized(reason))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                }
                PhaseTrack(reading: reading, showsMarker: true, showsLegend: false, barHeight: 5)
                    .padding(.top, 20)
                stockRow.padding(.top, 13)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)

            Spacer(minLength: 22)

            PrimaryButton(title: "开始冲煮", systemImage: "cup.and.saucer.fill", action: onBrew)
        }
        .padding(Metric.cardPadding)
        .frame(maxWidth: .infinity, minHeight: 330, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .fill(Palette.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
        .shadow(color: Palette.liftedShadow, radius: 18, x: 0, y: 8)
    }

    // MARK: - Rows

    private var phaseRow: some View {
        HStack(spacing: 6) {
            PhaseDot(color: phaseColor, size: 7)
            Text(PhasePresentation.title(phase: reading.phase, tier: verdict.tier))
                .font(TypeScale.caption.weight(.medium))
                .foregroundStyle(phaseColor)
            Spacer(minLength: 8)
            Text(verbatim: Fmt.day(reading.dayAfterRoast))
                .font(TypeScale.caption.monospacedDigit())
                .foregroundStyle(Palette.inkFaint)
        }
    }

    private var identity: some View {
        HStack(alignment: .top, spacing: 15) {
            BeanThumbnail(imageName: bean.imagePath, size: 92, cornerRadius: 12)

            VStack(alignment: .leading, spacing: 6) {
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
            .padding(.top, 2)

            Spacer(minLength: 0)
        }
    }

    private var stockRow: some View {
        Text(L("剩余 %@", Fmt.grams(bean.remainingG)))
            .font(TypeScale.numeral)
            .foregroundStyle(Palette.ink)
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
