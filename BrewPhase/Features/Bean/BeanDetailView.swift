import SwiftData
import SwiftUI

/// 豆子详情 (§11): the whole life of one bag on a single page.
struct BeanDetailView: View {

    let bean: Bean

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var rules: [PhaseRule]

    @State private var isEditing = false
    @State private var isAddingBrew = false
    @State private var isAddingTasting = false
    @State private var editingBrew: Brew?
    @State private var isAdjustingStock = false
    @State private var isConfirmingDelete = false
    @State private var showsAllBrews = false
    /// Drives the "copy the last recipe, then adjust" path into the brew editor.
    @State private var isCopyingLastBrew = false

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    private var insight: BeanInsight {
        InsightFactory.insight(for: bean, book: book)
    }

    private var rule: PhaseRuleData { book.rule(for: bean.roastLevel) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                hero
                PhaseCard(insight: insight) { isEditing = true }
                stockSection
                brewsSection
                TastingTimelineView(
                    tastings: bean.tastingsOldestFirst,
                    bean: bean.snapshot,
                    rule: rule,
                    onAdd: { isAddingTasting = true },
                    onDelete: delete(tasting:)
                )
                notesSection
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 4)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        isEditing = true
                    } label: {
                        Label("编辑豆子", systemImage: "pencil")
                    }
                    Button {
                        isAdjustingStock = true
                    } label: {
                        Label("调整剩余量", systemImage: "scalemass")
                    }
                    Button {
                        markFinished()
                    } label: {
                        Label("标记为已喝完", systemImage: "checkmark.circle")
                    }
                    Divider()
                    Button(role: .destructive) {
                        isConfirmingDelete = true
                    } label: {
                        Label("删除这包豆子", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Palette.roast)
                }
            }
        }
        .sheet(isPresented: $isEditing) {
            BeanEditorView(mode: .edit, bean: bean)
        }
        .sheet(isPresented: $isAddingBrew) {
            BrewEditorView(bean: bean)
        }
        .sheet(isPresented: $isAddingTasting) {
            TastingEditorView(bean: bean)
        }
        .sheet(item: $editingBrew) { brew in
            BrewEditorView(bean: bean, existing: brew)
        }
        .sheet(isPresented: $isAdjustingStock) {
            StockAdjustView(bean: bean)
        }
        .sheet(isPresented: $isCopyingLastBrew) {
            BrewEditorView(bean: bean, autoCopyLast: true)
        }
        .confirmationDialog(
            "删除这包豆子？",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) { deleteBean() }
            Button("取消", role: .cancel) {}
        } message: {
            Text(L("删除这包豆子后，它关联的 %@ 条冲煮记录和 %@ 条风味记录也会一起被删除，无法恢复。",
                   String(bean.brewsCount), String(bean.tastingsOldestFirst.count)))
        }
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let image = ImageStore.shared.image(named: bean.imagePath, thumbnail: false) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(height: 190)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                            .strokeBorder(Palette.hairline, lineWidth: 0.7)
                    )
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : LocalizedStringKey.alreadyLocalized(bean.name))
                    .font(TypeScale.cardTitle)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                if !bean.roaster.isEmpty {
                    Text(verbatim: bean.roaster)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                }

                if !metadataChips.isEmpty {
                    FlowLayout(spacing: 6, lineSpacing: 6) {
                        ForEach(metadataChips, id: \.self) { text in
                            Chip(text: text, tint: Palette.inkSoft, background: Palette.well)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    private var metadataChips: [String] {
        var chips: [String] = [bean.roastLevel.label]
        if !bean.origin.isEmpty { chips.append(bean.origin) }
        if !bean.process.isEmpty { chips.append(bean.process) }
        if let roastDate = bean.roastDate { chips.append(L("烘焙 %@", Fmt.short(roastDate))) }
        return chips
    }

    // MARK: - Stock

    private var stockSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "库存", detail: .alreadyLocalized(bean.status.label))
            Card {
                VStack(alignment: .leading, spacing: 13) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Fmt.grams(bean.remainingG))
                            .font(TypeScale.bigNumeral)
                            .foregroundStyle(Palette.ink)
                        Text("/ \(Fmt.grams(bean.weightG))")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.inkFaint)
                        Spacer(minLength: 0)
                        Button("调整") { isAdjustingStock = true }
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.roast)
                    }

                    // A thin fill bar: the one place stock is shown as a quantity
                    // rather than a number.
                    GeometryReader { geo in
                        let fraction = bean.weightG > 0
                            ? min(max(bean.remainingG / bean.weightG, 0), 1)
                            : 0
                        ZStack(alignment: .leading) {
                            Capsule().fill(Palette.well)
                            Capsule()
                                .fill(Palette.latte)
                                .frame(width: max(0, geo.size.width * fraction))
                        }
                    }
                    .frame(height: 6)

                    HStack(spacing: 10) {
                        Text(insight.estimate.usedDefaults
                             ? L("按默认 %@/次 估算", Fmt.gramsShort(insight.estimate.averageDoseG))
                             : L("平均 %@/次", Fmt.gramsShort(insight.estimate.averageDoseG)))
                        Text(verbatim: "·")
                        Text(insight.estimate.brewsText)
                        if insight.reading.dayAfterRoast != nil, bean.remainingG > 0 {
                            Text(verbatim: "·")
                            Text(Fmt.daysLeftPhrase(insight.estimate.daysRemaining))
                        }
                    }
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                }
            }
        }
    }

    // MARK: - Brews

    private var brewsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "冲煮记录",
                          detail: bean.brewsCount == 0
                              ? nil
                              : .alreadyLocalized(L("%@ 次", String(bean.brewsCount))))

            Card {
                VStack(alignment: .leading, spacing: 16) {
                    if bean.brewsCount == 0 {
                        Text("还没有冲煮记录\n冲一次，然后记下今天这杯怎么样。")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.inkSoft)
                            .lineSpacing(3)
                        addBrewButtons
                    } else {
                        let brews = visibleBrews
                        ForEach(Array(brews.enumerated()), id: \.element.id) { index, brew in
                            Button {
                                editingBrew = brew
                            } label: {
                                BrewRow(brew: brew)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)

                            if index != brews.count - 1 {
                                CardDivider()
                            }
                        }

                        if bean.brewsCount > brews.count {
                            Button {
                                withAnimation(Motion.settle) { showsAllBrews = true }
                            } label: {
                                Text(L("查看全部 %@ 条", String(bean.brewsCount)))
                                    .font(TypeScale.callout)
                                    .foregroundStyle(Palette.roast)
                            }
                            .buttonStyle(.plain)
                        }

                        CardDivider()
                        addBrewButtons
                    }
                }
            }
        }
    }

    private var visibleBrews: [Brew] {
        let all = bean.brewsNewestFirst
        return showsAllBrews ? all : Array(all.prefix(3))
    }

    private var addBrewButtons: some View {
        HStack(spacing: 10) {
            SecondaryButton(title: "记一次冲煮", systemImage: "plus") {
                isAddingBrew = true
            }
            if bean.latestBrew != nil {
                // §11: the recipe worth repeating is one tap away.
                SecondaryButton(title: "复制参数再来一次", systemImage: "doc.on.doc") {
                    isCopyingLastBrew = true
                }
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var notesSection: some View {
        if !bean.notes.trimmed.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "备注")
                Card {
                    Text(bean.notes)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.inkSoft)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Actions

    private func delete(tasting: Tasting) {
        context.delete(tasting)
        bean.touch()
        try? context.save()
    }

    private func markFinished() {
        bean.status = .finished
        bean.remainingG = 0
        bean.touch()
        try? context.save()
        NotificationManager.shared.cancel(bean: bean, context: context)
    }

    /// Deleting a bag takes its brews, tastings and images with it (§21, §33).
    private func deleteBean() {
        let imagePath = bean.imagePath
        NotificationManager.shared.cancel(bean: bean, context: context)
        context.delete(bean)
        try? context.save()
        // Only after the record is gone — if the save failed, the picture would
        // otherwise be orphaned while the bean still points at it.
        ImageStore.shared.delete(imagePath)
        dismiss()
    }
}

/// Adjusting remaining stock by hand, for the times a brew was not logged.
struct StockAdjustView: View {

    let bean: Bean

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var value: Double

    init(bean: Bean) {
        self.bean = bean
        _value = State(initialValue: bean.remainingG)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: "剩余克数")
                    Card(padding: 0) {
                        EditorRow(title: "剩余", showsDivider: false) {
                            NumberField(placeholder: "0", value: $value, unit: "g")
                        }
                    }
                }

                HStack(spacing: 8) {
                    ForEach([-18.0, -15.0, 15.0, 18.0], id: \.self) { delta in
                        Button {
                            withAnimation(Motion.quick) {
                                value = max(0, value + delta)
                            }
                        } label: {
                            Text(delta > 0 ? "+\(Int(delta))g" : "\(Int(delta))g")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.roast)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(Capsule(style: .continuous).fill(Palette.cream.opacity(0.5)))
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }

                if value > bean.weightG {
                    Text(L("剩余量比总克数还多，保存时会按 %@ 调整总克数。", Fmt.grams(value)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                }

                PrimaryButton(title: "保存") {
                    bean.remainingG = min(max(value, 0), max(bean.weightG, value))
                    if bean.remainingG > bean.weightG { bean.weightG = bean.remainingG }
                    if bean.remainingG > 0, bean.status == .finished { bean.status = .active }
                    bean.touch()
                    try? context.save()
                    dismiss()
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 10)
            .background(Palette.paper)
            .navigationTitle("调整剩余量")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
            }
        }
    }
}
