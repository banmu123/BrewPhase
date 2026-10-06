import SwiftUI

/// 风味变化 (§16): this bag's life as a vertical timeline.
///
/// Each dot is coloured by the phase that day actually fell in, so the column of
/// dots *is* the story — grey while it was too fresh, amber as it opened, green
/// through the window, clay as it faded. No chart library involved (§16).
struct TastingTimelineView: View {

    let tastings: [Tasting]
    /// The bag the notes belong to. Carried whole rather than as a rule alone,
    /// because the dot colour is the phase that day, and the phase depends on
    /// when the bag was opened.
    let bean: BeanSnapshot
    let rule: PhaseRuleData
    let onAdd: () -> Void
    let onDelete: (Tasting) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "风味变化",
                          detail: tastings.isEmpty
                              ? nil
                              : .alreadyLocalized(L("%@ 条", String(tastings.count))))

            Card {
                VStack(alignment: .leading, spacing: 0) {
                    if tastings.isEmpty {
                        emptyState
                    } else {
                        ForEach(Array(tastings.enumerated()), id: \.element.id) { index, tasting in
                            // 与上一条的间隔：时间连续感就在这几行小字里——
                            // 「Day 5 → Day 9」中间隔着几天，一眼可见。
                            row(
                                tasting,
                                gapDays: index == 0
                                    ? nil
                                    : tasting.dayAfterRoast - tastings[index - 1].dayAfterRoast,
                                isLast: index == tastings.count - 1
                            )
                        }
                        addButton.padding(.top, 14)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("这包豆还没有风味记录\n记一杯或随手记一笔，它的变化就会出现在这里。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(3)
            addButton
        }
    }

    private var addButton: some View {
        SecondaryButton(title: "记一笔风味", systemImage: "plus", action: onAdd)
    }

    // MARK: - Row

    private func row(_ tasting: Tasting, gapDays: Int?, isLast: Bool) -> some View {
        let phase = PhaseEngine.phase(dayAfterRoast: tasting.dayAfterRoast, bean: bean, rule: rule)
        let color = Palette.tint(phase)

        return HStack(alignment: .top, spacing: 12) {
            // The rail.
            VStack(spacing: 0) {
                PhaseDot(color: color, size: 9)
                    .padding(.top, 3)
                if !isLast {
                    Rectangle()
                        .fill(Palette.hairline)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .padding(.top, 3)
                }
            }
            .frame(width: 10)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Fmt.day(tasting.dayAfterRoast))
                        .font(TypeScale.caption.weight(.medium).monospacedDigit())
                        .foregroundStyle(color)

                    if tasting.score > 0 {
                        StarRating(score: tasting.score, size: 10)
                    }

                    Spacer(minLength: 0)

                    if let gapDays, gapDays >= 2 {
                        Text(LocalizedStringKey.alreadyLocalized(L("+%@ 天", String(gapDays))))
                            .font(TypeScale.micro.monospacedDigit())
                            .foregroundStyle(Palette.latte)
                    }

                    Text(Fmt.short(tasting.date))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                }

                if !tasting.notes.isEmpty {
                    Text(tasting.notes)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.ink)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !tasting.flavorTags.isEmpty {
                    FlavorTagList(tags: tasting.flavorTags, emptyText: "")
                }

                // 来源标识（规格：两条来源不再混成一种）：这条笔记是冲煮带出来的，
                // 还是用户在吧台随手记的。micro + inkFaint，在场但不抢焦点。
                Text(LocalizedStringKey.alreadyLocalized(tasting.source.label))
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
            }
            .padding(.bottom, isLast ? 0 : 16)
        }
        // 长按唤起删除；真正删除前还有一层确认（在宿主页面上）。
        .contextMenu {
            Button(role: .destructive) {
                onDelete(tasting)
            } label: {
                Label("删除这条记录", systemImage: "trash")
            }
        }
        .accessibilityElement(children: .combine)
    }
}
