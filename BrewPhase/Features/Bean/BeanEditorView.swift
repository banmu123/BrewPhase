import SwiftData
import SwiftUI

enum BeanEditorMode: Equatable {
    case create
    case edit
}

/// Adding or editing a bag (§3).
///
/// Only four things are required — name, roast date, roast level, weight — and
/// they are the only things above the fold. Everything else, including the
/// flavour tags, is optional and sits below, so a bag can be registered in the
/// time it takes to read the label.
struct BeanEditorView: View {

    let mode: BeanEditorMode
    let bean: Bean?

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var rules: [PhaseRule]

    // Required
    @State private var name: String
    @State private var roastDate: Date?
    @State private var roastLevel: RoastLevel
    @State private var weightG: Double

    // Basics
    @State private var roaster: String

    // Optional
    @State private var origin: String
    @State private var process: String
    @State private var purchaseDate: Date?
    @State private var price: Double
    @State private var channel: String
    @State private var flavorTags: [String]
    @State private var notes: String

    // Stock
    @State private var isOpened: Bool
    @State private var openDate: Date?
    @State private var remainingG: Double

    // Photo
    @State private var pickedImage: UIImage?
    @State private var isImageRemoved = false

    @State private var showsMore = false
    @State private var hasAttemptedSave = false
    @State private var errorMessage: String?

    init(mode: BeanEditorMode, bean: Bean? = nil) {
        self.mode = mode
        self.bean = bean

        _name = State(initialValue: bean?.name ?? "")
        _roastDate = State(initialValue: bean?.roastDate ?? (mode == .create ? Date() : nil))
        _roastLevel = State(initialValue: bean?.roastLevel ?? .light)
        _weightG = State(initialValue: bean?.weightG ?? 0)
        _roaster = State(initialValue: bean?.roaster ?? "")
        _origin = State(initialValue: bean?.origin ?? "")
        _process = State(initialValue: bean?.process ?? "")
        _purchaseDate = State(initialValue: bean?.purchaseDate)
        _price = State(initialValue: bean?.price ?? 0)
        _channel = State(initialValue: bean?.channel ?? "")
        _flavorTags = State(initialValue: bean?.flavorTags ?? [])
        _notes = State(initialValue: bean?.notes ?? "")

        let opened = (bean?.openDate != nil) || ((bean?.remainingG ?? 0) != (bean?.weightG ?? 0))
        _isOpened = State(initialValue: opened)
        _openDate = State(initialValue: bean?.openDate)
        _remainingG = State(initialValue: bean?.remainingG ?? 0)

        _showsMore = State(initialValue: bean.map { !$0.origin.isEmpty || !$0.process.isEmpty || $0.purchaseDate != nil || $0.price > 0 || !$0.channel.isEmpty } ?? false)
    }

    // MARK: - Derived

    private var effectiveRemaining: Double {
        isOpened ? remainingG : weightG
    }

    private var validation: BeanValidation {
        BrewMath.validateBean(name: name, roastDate: roastDate, weightG: weightG, remainingG: effectiveRemaining)
    }

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    /// A live preview of where this bag will land, shown while choosing a roast
    /// level so the rules stop being abstract.
    private var rulePreview: PhaseReading? {
        guard let roastDate else { return nil }
        let draft = BeanSnapshot(
            name: name,
            roastLevel: roastLevel,
            roastDate: roastDate,
            weightG: max(weightG, 1),
            remainingG: max(effectiveRemaining, 0)
        )
        return PhaseEngine.reading(for: draft, rule: book.rule(for: roastLevel))
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    basicsSection
                    roastSection
                    optionalSection
                    flavorSection
                    notesSection
                    feedback
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            .navigationTitle(mode == .create ? "添加豆子" : "编辑豆子")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存", action: save)
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.roast)
                }
            }
        }
    }

    // MARK: - Sections

    private var basicsSection: some View {
        EditorSection(title: "这包豆子") {
            EditorRow(title: "豆名") {
                EditorTextField(placeholder: "比如 Ethiopia Guji", text: $name)
            }
            EditorRow(title: "烘焙商") {
                EditorTextField(placeholder: "谁烘的", text: $roaster)
            }
            EditorRow(title: "照片", showsDivider: false) {
                PhotoFieldView(storedName: bean?.imagePath,
                               pickedImage: $pickedImage,
                               isRemoved: $isImageRemoved)
            }
        }
    }

    private var roastSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "烘焙与重量")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    DateRow(title: "烘焙日期", date: $roastDate)

                    VStack(alignment: .leading, spacing: 9) {
                        Text("烘焙度")
                            .font(TypeScale.body)
                            .foregroundStyle(Palette.inkSoft)
                        FlowLayout(spacing: 7, lineSpacing: 7) {
                            ForEach(RoastLevel.pickerOrder) { level in
                                SelectableTag(text: level.label, isOn: roastLevel == level) {
                                    withAnimation(Motion.pop) { roastLevel = level }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)

                    CardDivider()

                    EditorRow(title: "总克数") {
                        NumberField(placeholder: "0", value: $weightG, unit: "g")
                    }

                    EditorToggleRow(title: "已经开袋",
                                    detail: isOpened ? "记录开封日期和剩余量" : "剩余量按总克数算",
                                    isOn: $isOpened)

                    if isOpened {
                        DateRow(title: "开封日期", date: $openDate)
                        EditorRow(title: "剩余克数", showsDivider: false) {
                            NumberField(placeholder: "0", value: $remainingG, unit: "g")
                        }
                    }
                }
            }

            if let preview = rulePreview {
                phasePreview(preview)
            }
        }
    }

    /// "按默认窗口：7 天后进入窗口，28 天后开始衰退" — the rule in one line, so
    /// the number the app will use is never a mystery.
    private func phasePreview(_ reading: PhaseReading) -> some View {
        let rule = book.rule(for: roastLevel)
        return HStack(spacing: 8) {
            PhaseDot(color: Palette.tint(reading.phase), size: 7)
            Text(L("排气 %@–%@ 天 · 窗口 %@–%@ 天 · %@",
                   String(rule.restMinDays), String(rule.restMaxDays),
                   String(rule.peakStartDay), String(rule.peakEndDay),
                   DefaultPhaseRules.disclaimer))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }

    private var optionalSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsMore {
                EditorSection(title: "更多信息") {
                    EditorRow(title: "产区") {
                        EditorTextField(placeholder: "比如 埃塞俄比亚 · Guji", text: $origin)
                    }
                    EditorRow(title: "处理法") {
                        EditorTextField(placeholder: "水洗 / 日晒 / 厌氧", text: $process)
                    }
                    DateRow(title: "购买日期", date: $purchaseDate)
                    EditorRow(title: "价格") {
                        NumberField(placeholder: "0", value: $price, unit: "元", decimal: true)
                    }
                    EditorRow(title: "渠道", showsDivider: false) {
                        EditorTextField(placeholder: "在哪里买的", text: $channel)
                    }
                }
            } else {
                Button {
                    withAnimation(Motion.settle) { showsMore = true }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus.circle")
                            .font(.system(size: 13, weight: .medium))
                        Text("补充产区、处理法、价格")
                            .font(TypeScale.callout)
                    }
                    .foregroundStyle(Palette.roast)
                    .padding(.horizontal, 4)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var flavorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "风味标签", detail: "可以以后再补")
            Card {
                FlavorTagEditor(tags: $flavorTags)
            }
        }
    }

    private var notesSection: some View {
        EditorSection(title: "备注") {
            EditorRow(showsDivider: false) {
                EditorTextField(placeholder: "想记的事情，比如冲煮建议", text: $notes)
            }
        }
    }

    @ViewBuilder
    private var feedback: some View {
        if let errorMessage {
            messageCard(errorMessage, color: Palette.priority)
        } else if hasAttemptedSave {
            if !validation.blocking.isEmpty {
                messageCard(validation.blocking.first ?? "", color: Palette.priority)
            } else if let hint = validation.hints.first {
                messageCard(hint, color: Palette.inkSoft)
            }
        }
    }

    private func messageCard(_ text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle")
                .font(.system(size: 13))
            Text(text)
                .font(TypeScale.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(color)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(Palette.well)
        )
    }

    // MARK: - Saving

    private func save() {
        hasAttemptedSave = true
        errorMessage = nil

        let result = BrewMath.validateBean(name: name, roastDate: roastDate,
                                           weightG: weightG, remainingG: effectiveRemaining)
        guard result.canSave, let roastDate else {
            errorMessage = result.blocking.first
            return
        }

        let target: Bean
        switch mode {
        case .create:
            let created = Bean(
                name: name.trimmed,
                roaster: roaster.trimmed,
                origin: origin.trimmed,
                process: process.trimmed,
                roastLevel: roastLevel,
                roastDate: roastDate,
                purchaseDate: purchaseDate,
                openDate: isOpened ? (openDate ?? Date()) : nil,
                weightG: result.weightG,
                remainingG: result.remainingG,
                price: price,
                channel: channel.trimmed,
                flavorTags: flavorTags,
                notes: notes.trimmed
            )
            context.insert(created)
            target = created

        case .edit:
            guard let bean else { return }
            bean.name = name.trimmed
            bean.roaster = roaster.trimmed
            bean.origin = origin.trimmed
            bean.process = process.trimmed
            bean.roastLevel = roastLevel
            bean.roastDate = roastDate
            bean.purchaseDate = purchaseDate
            bean.openDate = isOpened ? (openDate ?? bean.openDate ?? Date()) : nil
            bean.weightG = result.weightG
            bean.remainingG = result.remainingG
            bean.price = price
            bean.channel = channel.trimmed
            bean.flavorTags = flavorTags
            bean.notes = notes.trimmed
            bean.touch()
            target = bean
        }

        applyImageChange(to: target)

        do {
            try context.save()
        } catch {
            errorMessage = L("没能保存下来，请再试一次")
            AppLog.store.error("bean save failed: \(error.localizedDescription, privacy: .public)")
            return
        }

        let saved = target
        let context = context
        Task { await rescheduleReminders(for: saved, context: context) }
        dismiss()
    }

    private func applyImageChange(to bean: Bean) {
        if let pickedImage {
            do {
                bean.imagePath = try ImageStore.shared.replace(pickedImage, previous: bean.imagePath)
            } catch {
                AppLog.images.error("image save failed: \(error.localizedDescription, privacy: .public)")
            }
        } else if isImageRemoved, let existing = bean.imagePath {
            // Deleting the bean deletes its images (§21); removing just the photo
            // has to do the same thing by hand.
            ImageStore.shared.delete(existing)
            bean.imagePath = nil
        }
    }

    /// Reminders are planned on save, never on a timer (§10).
    private func rescheduleReminders(for bean: Bean, context: ModelContext) async {
        await NotificationManager.shared.requestAuthorizationIfNeeded()
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
