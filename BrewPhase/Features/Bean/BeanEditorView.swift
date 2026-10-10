import SwiftData
import SwiftUI

enum BeanEditorMode: Equatable {
    case create
    case edit
}

/// 打开编辑器那一刻豆子的值。
///
/// 存在的理由是一条实测出来的 SwiftData 行为：保存失败后 `rollback()` 只撤得掉
/// 插入与删除，**撤不回既有对象的属性改动**（见 `PersistenceTests`）。所以编辑
/// 豆子之后如果落库失败，必须拿这份快照把豆子逐字段写回原样——否则失败的编辑
/// 会留在内存里，被之后某一次无关的保存顺手写进库里，而用户收到的消息是「没保存」。
private struct BeanOriginalValues {
    var name: String
    var roaster: String
    var origin: String
    var process: String
    var roastLevel: RoastLevel
    var roastDate: Date?
    var purchaseDate: Date?
    var openDate: Date?
    var weightG: Double
    var remainingG: Double
    var price: Double
    var channel: String
    var flavorTags: [String]
    var notes: String
    var imagePath: String?

    init(_ bean: Bean) {
        name = bean.name
        roaster = bean.roaster
        origin = bean.origin
        process = bean.process
        roastLevel = bean.roastLevel
        roastDate = bean.roastDate
        purchaseDate = bean.purchaseDate
        openDate = bean.openDate
        weightG = bean.weightG
        remainingG = bean.remainingG
        price = bean.price
        channel = bean.channel
        flavorTags = bean.flavorTags
        notes = bean.notes
        imagePath = bean.imagePath
    }

    func restore(to bean: Bean) {
        bean.name = name
        bean.roaster = roaster
        bean.origin = origin
        bean.process = process
        bean.roastLevel = roastLevel
        bean.roastDate = roastDate
        bean.purchaseDate = purchaseDate
        bean.openDate = openDate
        bean.weightG = weightG
        bean.remainingG = remainingG
        bean.price = price
        bean.channel = channel
        bean.flavorTags = flavorTags
        bean.notes = notes
        bean.imagePath = imagePath
    }
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
    /// 烘焙程度**必须明确选择**：它决定阶段、窗口、推荐与提醒。新建时为 nil
    /// （什么都不预选），保存前没选就明确拦下——绝不允许悄悄落成浅烘或中烘。
    @State private var roastLevel: RoastLevel?
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
    /// 双击防护：保存成功后本页不再重复提交（新建会多出一包豆）。
    @State private var didSave = false

    /// 编辑前的那份值，落库失败时用来把豆子写回去（见 `BeanOriginalValues`）。
    private let original: BeanOriginalValues?

    init(mode: BeanEditorMode, bean: Bean? = nil) {
        self.mode = mode
        self.bean = bean
        original = bean.map(BeanOriginalValues.init)

        _name = State(initialValue: bean?.name ?? "")
        _roastDate = State(initialValue: bean?.roastDate ?? (mode == .create ? Date() : nil))
        // 编辑已有豆子时它总有值；新建时不预选（规格：关键数据不允许被默认值悄悄决定）。
        _roastLevel = State(initialValue: bean?.roastLevel)
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

        _showsMore = State(initialValue: bean.map {
            !$0.origin.isEmpty || !$0.process.isEmpty || $0.purchaseDate != nil
                || $0.price > 0 || !$0.channel.isEmpty || !$0.roaster.isEmpty || $0.imagePath != nil
        } ?? false || DebugLaunch.beanEditorExpand)
    }

    // MARK: - Derived

    private var effectiveRemaining: Double {
        isOpened ? remainingG : weightG
    }

    /// 烘焙程度还没选时的拦截文案。它决定阶段与窗口，不能默认。
    private var roastLevelMissing: String? {
        roastLevel == nil ? L("选一个烘焙程度吧，阶段判断要靠它") : nil
    }

    private var validation: BeanValidation {
        BrewMath.validateBean(name: name, roastDate: roastDate, weightG: weightG, remainingG: effectiveRemaining)
    }

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    /// A live preview of where this bag will land, shown while choosing a roast
    /// level so the rules stop being abstract.
    private var rulePreview: PhaseReading? {
        guard let roastDate, let roastLevel else { return nil }
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

    /// 首屏只回答「这是什么豆」：豆名、烘焙日期、烘焙程度、重量。
    /// 烘焙商、照片、产区、价格都在「更多信息」里（规格：可选信息不上首屏）。
    private var basicsSection: some View {
        EditorSection(title: "这包豆子") {
            EditorRow(title: "豆名", showsDivider: false) {
                EditorTextField(placeholder: "比如 Ethiopia Guji", text: $name)
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
                        HStack(spacing: 6) {
                            Text("烘焙度")
                                .font(TypeScale.body)
                                .foregroundStyle(Palette.inkSoft)
                            if roastLevel == nil {
                                Text("必选")
                                    .font(TypeScale.micro)
                                    .foregroundStyle(Palette.priority)
                            }
                        }
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
        guard let roastLevel else { return AnyView(EmptyView()) }
        let rule = book.rule(for: roastLevel)
        return AnyView(HStack(spacing: 8) {
            PhaseDot(color: Palette.tint(reading.phase), size: 7)
            Text(L("排气 %@–%@ 天 · 窗口 %@–%@ 天 · %@",
                   String(rule.restMinDays), String(rule.restMaxDays),
                   String(rule.peakStartDay), String(rule.peakEndDay),
                   DefaultPhaseRules.disclaimer))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4))
    }

    private var optionalSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsMore {
                EditorSection(title: "更多信息") {
                    EditorRow(title: "烘焙商") {
                        EditorTextField(placeholder: "谁烘的", text: $roaster)
                    }
                    EditorRow(title: "照片") {
                        PhotoFieldView(storedName: bean?.imagePath,
                                       pickedImage: $pickedImage,
                                       isRemoved: $isImageRemoved)
                    }
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
                        Text("补充烘焙商、产区与价格")
                            .font(TypeScale.callout)
                    }
                    .foregroundStyle(Palette.roast)
                    .padding(.horizontal, 4)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("补充烘焙商、产区与价格"))
            }
        }
    }

    private var flavorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "风味标签", detail: "可以以后再补")
            Card {
                CollapsibleFlavorTags(tags: $flavorTags)
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
            if let missing = roastLevelMissing {
                messageCard(missing, color: Palette.priority)
            } else if !validation.blocking.isEmpty {
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

    /// 保存的完整顺序是这一版的重点：**写图片 → 落库 → 删旧图片**。
    ///
    /// 原来的顺序（先在内存里换掉 `imagePath`、顺手删掉旧文件、最后才落库）在
    /// 落库失败时会留下最难看的一种残局：记录还指着旧文件，旧文件已经没了。
    /// 现在的约定是每一步的失败都有出路：
    ///
    /// * 图片写不进去 → 直接说，什么都不改；
    /// * 落库失败 → 删掉刚写的新文件、回滚上下文，旧文件和编辑状态都原样留着；
    /// * 只有落库确认成功，被替换（或移除）的旧文件才可以删。
    ///
    /// 中途被杀进程最坏留下一个孤儿文件——「清理无用的图片」会收走它，而记录
    /// 永远不会指向不存在的文件。
    private func save() {
        // 双击防护：成功才置位，失败后可重试（新建模式重复提交会产生两包豆）。
        guard !didSave else { return }
        hasAttemptedSave = true
        errorMessage = nil

        let result = BrewMath.validateBean(name: name, roastDate: roastDate,
                                           weightG: weightG, remainingG: effectiveRemaining)
        guard result.canSave, let roastDate else {
            errorMessage = result.blocking.first
            return
        }
        // 烘焙程度必须明确选择（规格：关键数据不允许被默认值悄悄决定——
        // 它决定阶段、窗口、推荐与提醒）。
        guard let roastLevel else {
            errorMessage = roastLevelMissing
            return
        }

        // 1/3 —— 先写新文件。
        let newImageName: String?
        if let pickedImage {
            do {
                newImageName = try ImageStore.shared.save(pickedImage)
            } catch {
                AppLog.images.error("image save failed: \(error.localizedDescription, privacy: .public)")
                // ImageStore 能出的错基本只有「编码不出来」，文案和它自己的一致，
                // 保证界面上同一个问题只有一种说法。
                errorMessage = L("这张图片没能保存下来，可以换一张试试")
                return
            }
        } else {
            newImageName = nil
        }

        // 2/3 —— 更新记录，然后落库。
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

        // 图片字段：换新摘旧都在这里改，真正删文件要等落库成功。
        let previousImage = target.imagePath
        if let newImageName {
            target.imagePath = newImageName
        } else if isImageRemoved {
            target.imagePath = nil
        }

        do {
            try context.save()
        } catch {
            AppLog.store.error("bean save failed: \(error.localizedDescription, privacy: .public)")
            // 落库没成：撤掉刚写的新文件、回滚插入/删除，再把豆子逐字段写回
            // 打开编辑器时的样子——`rollback()` 撤不回属性改动（实测），
            // 不写回的话这次失败的编辑会留在内存里，被之后某次无关的保存
            // 顺手写进库里。用户填的东西都在视图自己的 @State 里，一样没丢。
            if let newImageName { ImageStore.shared.delete(newImageName) }
            context.rollback()
            if let original, let bean { original.restore(to: bean) }
            errorMessage = L("没能保存下来，请再试一次")
            return
        }

        // 3/3 —— 入库成功，被替换 / 被移除的旧文件现在才可以删。
        didSave = true
        if newImageName != nil || isImageRemoved, let previousImage {
            ImageStore.shared.delete(previousImage)
        }

        let saved = target
        let context = context
        Task { await rescheduleReminders(for: saved, context: context) }
        dismiss()
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
