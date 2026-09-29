import SwiftData
import SwiftUI

/// Recording a brew (§12, §13).
///
/// The brief is "quick recording, not filling in a lab report". So: the recipe
/// and the verdict are on the surface, the five taste axes are folded away, and
/// the single most valuable button in the app — copy the last brew — sits at the
/// top where the eye lands first.
struct BrewEditorView: View {

    let bean: Bean
    /// Non-nil when editing an existing brew rather than adding one.
    let existing: Brew?
    /// When set, the previous brew's recipe is filled in on open — the same
    /// outcome as tapping "复制上次冲煮", for the entry points that are already a
    /// repeat of last time.
    let autoCopyLast: Bool

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var recipe: BrewRecipe
    @State private var date: Date
    @State private var timeText: String
    @State private var score: Int
    @State private var acidity: Int
    @State private var sweetness: Int
    @State private var bitterness: Int
    @State private var body_: Int
    @State private var aftertaste: Int
    @State private var flavorTags: [String]
    @State private var notes: String
    @State private var showsAdvanced = false
    @State private var copiedLast = false
    @State private var errorMessage: String?

    init(bean: Bean, existing: Brew? = nil, autoCopyLast: Bool = false) {
        self.bean = bean
        self.existing = existing
        self.autoCopyLast = autoCopyLast

        let defaults = BrewDefaults.current()
        let previous = existing == nil ? bean.brewsNewestFirst.first : nil
        let start = existing?.recipe
            ?? (autoCopyLast ? previous?.recipe : nil)
            ?? defaults.asRecipe

        _recipe = State(initialValue: start)
        _date = State(initialValue: existing?.date ?? Date())
        _timeText = State(initialValue: existing?.timeText ?? (autoCopyLast ? previous?.timeText ?? "" : ""))
        _score = State(initialValue: existing?.score ?? 0)
        _acidity = State(initialValue: existing?.acidity ?? 0)
        _sweetness = State(initialValue: existing?.sweetness ?? 0)
        _bitterness = State(initialValue: existing?.bitterness ?? 0)
        _body_ = State(initialValue: existing?.body ?? 0)
        _aftertaste = State(initialValue: existing?.aftertaste ?? 0)
        _flavorTags = State(initialValue: existing?.flavorTags ?? [])
        _notes = State(initialValue: existing?.notes ?? "")
        _showsAdvanced = State(initialValue: existing?.hasTasteDetail ?? false)
        _copiedLast = State(initialValue: autoCopyLast && previous != nil && existing == nil)
    }

    // MARK: - Derived

    private var lastBrew: Brew? {
        guard existing == nil else { return nil }
        return bean.brewsNewestFirst.first
    }

    private var ratioText: String {
        Fmt.ratio(coffeeG: recipe.coffeeG, waterG: recipe.waterG)
    }

    private var dayLabel: String {
        Fmt.day(bean.dayAfterRoast(on: date))
    }

    /// Remaining stock as it will be after saving, shown live so the number never
    /// comes as a surprise.
    private var projectedRemaining: Double {
        let dose = recipe.coffeeG
        guard dose > 0 else { return bean.remainingG }
        let delta = dose - (existing?.coffeeG ?? 0)
        return BrewMath.remainingAfter(current: bean.remainingG, dose: delta, total: bean.weightG)
    }

    private var validation: BrewValidation {
        var draft = recipe
        draft.timeSeconds = BrewMath.parseTime(timeText) ?? 0
        return BrewMath.validate(draft)
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header

                    if let lastBrew {
                        copyCard(lastBrew)
                    }

                    recipeSection

                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: "这杯怎么样")
                        Card {
                            VStack(alignment: .leading, spacing: 14) {
                                StarRatingInput(score: $score)
                                CardDivider()
                                advancedTaste
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: "风味标签", detail: "可以以后再补")
                        Card {
                            FlavorTagEditor(tags: $flavorTags)
                        }
                    }

                    EditorSection(title: "一句话总结") {
                        EditorRow(showsDivider: false) {
                            EditorTextField(placeholder: "比如 甜感明显，下把可以再粗一点", text: $notes)
                        }
                    }

                    if let errorMessage {
                        messageCard(errorMessage)
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            .navigationTitle(existing == nil ? "记一次冲煮" : "编辑冲煮")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { save() }
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.roast)
                }
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 10) {
            BeanThumbnail(imageName: bean.imagePath, size: 42, cornerRadius: 11)
            VStack(alignment: .leading, spacing: 3) {
                Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                    .font(TypeScale.title)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Text(L("%@ · 剩余 %@", dayLabel, Fmt.grams(bean.remainingG)))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            Spacer(minLength: 0)
        }
    }

    /// §13. One tap fills the recipe; the user then changes only what changed.
    private func copyCard(_ last: Brew) -> some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: copiedLast ? "checkmark.circle.fill" : "arrow.counterclockwise.circle")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(copiedLast ? Palette.peak : Palette.roast)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(copiedLast ? "已填入上次的参数" : "复制上次冲煮")
                            .font(TypeScale.bodyMedium)
                            .foregroundStyle(Palette.ink)
                        Text(last.recipe.summaryParts.joined(separator: " · "))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }

                if !copiedLast {
                    SecondaryButton(title: "复制", systemImage: "doc.on.doc") {
                        withAnimation(Motion.settle) {
                            recipe = last.recipe
                            timeText = last.timeText
                            copiedLast = true
                        }
                    }
                }
            }
        }
    }

    private var recipeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "参数")

            Card(padding: 0) {
                VStack(spacing: 0) {
                    EditorChipsRow(
                        title: "器具",
                        options: BrewCatalog.methods,
                        isOn: { $0 == recipe.method },
                        onPick: { recipe.method = $0 }
                    ) {
                        EditorTextField(placeholder: "V60", text: $recipe.method)
                    }

                    EditorRow(title: "粉量") {
                        NumberField(placeholder: "0", value: $recipe.coffeeG, unit: "g")
                    }
                    EditorRow(title: "水量") {
                        NumberField(placeholder: "0", value: $recipe.waterG, unit: "g")
                    }

                    CardDivider()

                    EditorChipsRow(
                        title: "粉水比",
                        options: Self.ratioPresets,
                        isOn: { $0 == ratioText },
                        onPick: applyRatio
                    ) {
                        HStack(spacing: 0) {
                            Spacer(minLength: 0)
                            Text(ratioText)
                                .font(TypeScale.numeral)
                                .foregroundStyle(ratioText == "—" ? Palette.inkFaint : Palette.roast)
                        }
                    }

                    EditorChipsRow(
                        title: "水温",
                        options: Self.temperaturePresets,
                        isOn: isCurrentTemperature,
                        onPick: applyTemperature
                    ) {
                        NumberField(placeholder: "0", value: $recipe.waterTemp, unit: "°C")
                    }

                    EditorRow(title: "时间") {
                        HStack(spacing: 6) {
                            Spacer(minLength: 0)
                            TextField("", text: $timeText,
                                      prompt: Text("2:35").foregroundStyle(Palette.inkFaint))
                                .font(TypeScale.numeral)
                                .foregroundStyle(Palette.ink)
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numbersAndPunctuation)
                            if !timeText.isEmpty, BrewMath.parseTime(timeText) == nil {
                                Image(systemName: "exclamationmark.circle")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Palette.priority)
                            }
                        }
                    }
                    EditorRow(title: "研磨度") {
                        EditorTextField(placeholder: "比如 22 格", text: $recipe.grindSize, alignment: .trailing)
                    }
                    EditorRow(title: "磨豆机", showsDivider: false) {
                        EditorTextField(placeholder: "比如 司令官 C40", text: $recipe.grinder, alignment: .trailing)
                    }

                    CardDivider()

                    EditorRow(title: "日期", showsDivider: false) {
                        HStack(spacing: 8) {
                            Spacer(minLength: 0)
                            Text(dayLabel)
                                .font(TypeScale.caption.monospacedDigit())
                                .foregroundStyle(Palette.roast)
                            DatePicker("", selection: $date, displayedComponents: .date)
                                .labelsHidden()
                                .datePickerStyle(.compact)
                        }
                    }
                }
            }

            stockLine
        }
    }

    // MARK: - Quick-fill presets

    /// Written the way `Fmt.ratio` writes a ratio, so the chip matching the
    /// current recipe lights up by plain string comparison.
    private static let ratioPresets = ["1:15", "1:16", "1:17"]

    /// Bare numbers here: the row is labelled 水温 and the field beside it already
    /// carries the °C, so repeating the unit on all seven chips would only buy a
    /// second line of chips.
    private static let temperaturePresets = BrewCatalog.temperatures.map { "\(Int($0))" }

    private func isCurrentTemperature(_ text: String) -> Bool {
        guard let value = Double(text) else { return false }
        return abs(recipe.waterTemp - value) < 0.5
    }

    private func applyTemperature(_ text: String) {
        guard let value = Double(text) else { return }
        recipe.waterTemp = value
    }

    private func applyRatio(_ text: String) {
        guard let value = Double(text.replacingOccurrences(of: "1:", with: "")),
              recipe.coffeeG > 0 else { return }
        recipe.waterG = BrewMath.water(coffeeG: recipe.coffeeG, ratio: value)
    }

    private var advancedTaste: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(Motion.settle) { showsAdvanced.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Text("味觉细项")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                    Image(systemName: showsAdvanced ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.inkFaint)
                    Spacer(minLength: 0)
                    Text("可留空")
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                }
            }
            .buttonStyle(.plain)

            if showsAdvanced {
                VStack(spacing: 11) {
                    TasteScale(title: "酸", value: $acidity)
                    TasteScale(title: "甜", value: $sweetness)
                    TasteScale(title: "苦", value: $bitterness)
                    TasteScale(title: "醇厚", value: $body_)
                    TasteScale(title: "余韵", value: $aftertaste)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    /// "保存后剩余 68g · 约 3 次" — the consequence of this brew, before saving it.
    private var stockLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "scalemass")
                .font(.system(size: 11, weight: .medium))
            Text(L("保存后剩余 %@", Fmt.grams(projectedRemaining)))
            if recipe.coffeeG > bean.remainingG, bean.remainingG > 0 {
                Text("· 这次用掉的比剩下的还多")
                    .foregroundStyle(Palette.priority)
            }
        }
        .font(TypeScale.caption)
        .foregroundStyle(Palette.inkFaint)
        .padding(.horizontal, 4)
    }

    private func messageCard(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").font(.system(size: 13))
            Text(text).font(TypeScale.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Palette.priority)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(Palette.well)
        )
    }

    // MARK: - Saving

    private func save() {
        errorMessage = nil

        var draft = recipe
        draft.timeSeconds = BrewMath.parseTime(timeText) ?? 0

        let result = BrewMath.validate(draft)
        guard result.canSave else {
            errorMessage = result.blocking.first
            return
        }

        let parsedTime = draft.timeSeconds

        if let existing {
            // Editing: adjust stock by the difference, so correcting a typo does
            // not silently double-deduct.
            let delta = draft.coffeeG - existing.coffeeG
            existing.date = date
            existing.method = draft.method.trimmed
            existing.grinder = draft.grinder.trimmed
            existing.grindSize = draft.grindSize.trimmed
            existing.waterTemp = draft.waterTemp
            existing.coffeeG = draft.coffeeG
            existing.waterG = draft.waterG
            existing.timeSeconds = parsedTime
            existing.score = BrewMath.clampScore(score)
            existing.acidity = acidity
            existing.sweetness = sweetness
            existing.bitterness = bitterness
            existing.body = body_
            existing.aftertaste = aftertaste
            existing.flavorTags = flavorTags
            existing.notes = notes.trimmed

            if delta != 0 { bean.consume(delta) }
            updateLinkedTasting(for: existing)
        } else {
            let brew = Brew(
                date: date,
                method: draft.method.trimmed,
                grinder: draft.grinder.trimmed,
                grindSize: draft.grindSize.trimmed,
                waterTemp: draft.waterTemp,
                coffeeG: draft.coffeeG,
                waterG: draft.waterG,
                timeSeconds: parsedTime,
                score: BrewMath.clampScore(score),
                acidity: acidity,
                sweetness: sweetness,
                bitterness: bitterness,
                body: body_,
                aftertaste: aftertaste,
                flavorTags: flavorTags,
                notes: notes.trimmed,
                bean: bean
            )
            context.insert(brew)
            bean.consume(draft.coffeeG)

            // §40: recording a brew also leaves a mark on the flavour timeline,
            // but only when there is something to say.
            if brew.hasTimelineMaterial {
                let tasting = brew.makeTasting()
                tasting.bean = bean
                context.insert(tasting)
            }
        }

        bean.touch()

        do {
            try context.save()
        } catch {
            errorMessage = L("没能保存下来，请再试一次")
            AppLog.store.error("brew save failed: \(error.localizedDescription, privacy: .public)")
            return
        }

        Task { await rescheduleReminders() }
        dismiss()
    }

    /// Keeps the auto-generated note in step with its brew, or removes it when the
    /// brew no longer says anything.
    private func updateLinkedTasting(for brew: Brew) {
        let linked = (bean.tastings ?? []).first { $0.brewID == brew.id }
        if brew.hasTimelineMaterial {
            if let linked {
                linked.date = brew.date
                linked.dayAfterRoast = brew.dayAfterRoast ?? 0
                linked.score = brew.score
                linked.flavorTags = brew.flavorTags
                linked.notes = brew.notes
            } else {
                let tasting = brew.makeTasting()
                tasting.bean = bean
                context.insert(tasting)
            }
        } else if let linked {
            context.delete(linked)
        }
    }

    /// The stock changed, so the consumption estimate — and therefore the
    /// priority nudge — may have moved too.
    private func rescheduleReminders() async {
        let stored = (try? context.fetch(FetchDescriptor<PhaseRule>())) ?? []
        let book = PhaseRuleBook.make(stored: stored)
        let insight = InsightFactory.insight(for: bean, book: book)
        await NotificationManager.shared.sync(
            bean: bean,
            rule: book.rule(for: bean.roastLevel),
            estimate: insight.estimate,
            context: context
        )
    }
}
