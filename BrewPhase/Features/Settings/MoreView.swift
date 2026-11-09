import SwiftData
import SwiftUI

/// 更多 (§18): 按「咖啡 / 本地智能 / 数据 / 应用」四组整理的设置页。
///
/// 组头是小号的 tracked 标题；组内每个块用加粗的小标题开场。Tab 名保持
/// 「更多」不变，这一批只动层级不动入口。
struct MoreView: View {

    @Environment(\.modelContext) private var context
    @Query private var beans: [Bean]
    @Query private var records: [Record]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.defaultMethod) private var defaultMethod: String = "V60"
    @AppStorage(PrefKey.defaultDoseG) private var defaultDoseG: Double = 15
    @AppStorage(PrefKey.defaultWaterG) private var defaultWaterG: Double = 240
    @AppStorage(PrefKey.defaultWaterTemp) private var defaultWaterTemp: Double = 92
    @AppStorage(PrefKey.experimentalFlavorPrediction) private var predictsFlavorWindow: Bool = true

    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var pendingReminderCount = 0
    @State private var isExporting = false
    @State private var isBackingUp = false
    @State private var orphanCount = 0
    @State private var imageBytes: Int64 = 0
    @State private var imageCount = 0
    @State private var cleanupMessage: String?
    /// 示例数据开关的待确认动作。数据真相是 `beans` 里的 isSample 标记，
    /// 开关只反映它；打开/关闭都要先过一次确认，因为两侧都是破坏性的——
    /// 一侧往库里加数据，一侧删数据。
    @State private var pendingSampleAction: SampleAction?
    @State private var sampleMessage: String?

    enum SampleAction { case install, remove }

    @ObservedObject private var language = LanguageManager.shared

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Metric.sectionGap) {
                    // 咖啡：默认参数、阶段规则、提醒——都是「怎么喝」的设定。
                    SectionHeader(title: "咖啡")
                    defaultsBlock
                    rulesBlock
                    reminderBlock

                    // 本地智能：洞察与问一问的入口与总开关；调参项在高级设置里。
                    SectionHeader(title: "本地智能")
                    AskSettingsSection()

                    // 数据：导出与图片，全部在本机。桌面同步把手机数据送到电脑。
                    SectionHeader(title: "数据", detail: "都在本机")
                    dataBlock

                    // 应用：语言、实验功能、关于。
                    SectionHeader(title: "应用")
                    LanguageSection(language: language, showsHeader: false)
                    experimentalBlock
                    aboutCard
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            .navigationTitle("更多")
            .navigationBarTitleDisplayMode(.large)
            .task { await refreshStatus() }
            .sheet(isPresented: $isExporting) {
                ExportView()
            }
            .sheet(isPresented: $isBackingUp) {
                NavigationStack { BackupView() }
            }
        }
    }

    /// 组内小标题：与组头（tracked 小字）区分——更重、更近墨色、不追踪。
    private func subHeader(_ title: LocalizedStringKey, detail: LocalizedStringKey? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(TypeScale.callout.weight(.medium))
                .foregroundStyle(Palette.ink)
            if let detail {
                Text(detail)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: - 咖啡

    private var defaultsBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            subHeader("默认冲煮参数", detail: "新记录会从这里开始")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    EditorRow(title: "器具") {
                        EditorTextField(placeholder: "V60", text: $defaultMethod, alignment: .trailing)
                    }
                    EditorRow(title: "粉量") {
                        NumberField(placeholder: "0", value: $defaultDoseG, unit: "g")
                    }
                    EditorRow(title: "水量") {
                        NumberField(placeholder: "0", value: $defaultWaterG, unit: "g")
                    }
                    EditorRow(title: "水温", showsDivider: false) {
                        NumberField(placeholder: "0", value: $defaultWaterTemp, unit: "°C")
                    }
                }
            }
        }
    }

    private var rulesBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            NavigationLink {
                PhaseRulesView()
            } label: {
                Card(padding: 0) {
                    navRow(title: "阶段规则",
                            detail: book.isPristine
                                ? LocalizedStringKey("都是默认值")
                                : .alreadyLocalized(L("已自定义 %@ 项", String(book.customized.count))))
                }
            }
            .buttonStyle(.plain)

            Text(L("这些数字只是「%@」，不是保质期，也不会说某包豆子过期了。", DefaultPhaseRules.disclaimer))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var reminderBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            subHeader("提醒",
                      detail: pendingReminderCount > 0
                          ? .alreadyLocalized(L("%@ 条待送达", String(pendingReminderCount)))
                          : nil)

            Card(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(ReminderKind.allCases.enumerated()), id: \.element) { index, kind in
                        ReminderToggleRow(kind: kind) {
                            // 关掉一类提醒必须把已经排在系统里的那几条撤掉，
                            // 否则它们会一直响到下次启动重排为止。
                            Task {
                                await resyncReminders()
                                await refreshStatus()
                            }
                        }
                        if index != ReminderKind.allCases.count - 1 {
                            CardDivider()
                        }
                    }
                }
            }

            Text("推荐提醒默认打开：进入黄金风味期、黄金期将尽、喝不完提示。养豆完成与黄金期过半默认关闭，按需开启。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)

            statusNote
        }
    }

    @ViewBuilder
    private var statusNote: some View {
        switch notificationStatus {
        case .denied:
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "bell.slash")
                    .font(.system(size: 12))
                Text(NotificationManager.shared.statusExplanation)
                    .font(TypeScale.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Palette.priority)
            .padding(.horizontal, 4)

        case .notDetermined:
            Text(NotificationManager.shared.statusExplanation)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)

        default:
            Text("提醒会根据烘焙日期一次排好，不需要 App 在后台运行。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
        }
    }

    // MARK: - 数据

    private var dataBlock: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                Button {
                    isExporting = true
                } label: {
                    navRow(title: "导出", detail: "JSON · CSV 表格（不含图片）")
                }
                .buttonStyle(.plain)

                CardDivider()

                NavigationLink {
                    DesktopSyncView()
                } label: {
                    navRow(title: "桌面同步", detail: "扫码配对 · iPhone → 电脑")
                }
                .buttonStyle(.plain)

                CardDivider()

                // 完整备份：单文件 + 图片，能整机还原；与上面的「导出」不是一回事。
                Button {
                    isBackingUp = true
                } label: {
                    navRow(title: "完整备份与恢复", detail: "单文件 · 含图片 · 可整机还原")
                }
                .buttonStyle(.plain)

                CardDivider()

                // 示例数据：给审核员和试用用户一条「有完整数据可玩」的路。
                // 开关只反映库里的 isSample 标记；两侧切换都要确认。
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("示例数据")
                                .font(TypeScale.body)
                                .foregroundStyle(Palette.ink)
                            Text(hasSampleData
                                 ? "示例豆已在库中，关闭即整批移除"
                                 : "载入 7 包演示豆，体验完整功能")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 8)
                        Toggle("", isOn: Binding(
                            get: { hasSampleData },
                            set: { pendingSampleAction = $0 ? .install : .remove }
                        ))
                        .labelsHidden()
                        .tint(Palette.roast)
                        .accessibilityLabel(Text("示例数据"))
                    }
                    if let sampleMessage {
                        Text(sampleMessage)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .confirmationDialog(
                    "加入示例数据？",
                    isPresented: Binding(
                        get: { pendingSampleAction == .install },
                        set: { if !$0 { pendingSampleAction = nil } }
                    ),
                    titleVisibility: .visible
                ) {
                    Button("载入示例数据") { performSampleAction(.install) }
                    Button("取消", role: .cancel) {}
                } message: {
                    Text("将加入 7 包演示豆（含冲煮与风味记录）。你自己的记录不受影响，之后关闭开关即可整批移除。")
                }
                .confirmationDialog(
                    "删除示例数据？",
                    isPresented: Binding(
                        get: { pendingSampleAction == .remove },
                        set: { if !$0 { pendingSampleAction = nil } }
                    ),
                    titleVisibility: .visible
                ) {
                    Button("删除示例数据", role: .destructive) { performSampleAction(.remove) }
                    Button("取消", role: .cancel) {}
                } message: {
                    Text("将删除全部示例豆及其冲煮与风味记录。你自己的记录不受影响。")
                }

                CardDivider()

                VStack(alignment: .leading, spacing: 10) {
                    navRow(title: "图片",
                            detail: .alreadyLocalized(
                                L("%@ 个文件 · %@", String(imageCount), Fmt.bytes(imageBytes))
                            ),
                            showsChevron: false)

                    Button {
                        cleanUpImages()
                    } label: {
                        Text(orphanCount > 0
                             ? LocalizedStringKey.alreadyLocalized(L("清理 %@ 个无用的图片", String(orphanCount)))
                             : LocalizedStringKey("没有需要清理的图片"))
                            .font(TypeScale.caption)
                            .foregroundStyle(orphanCount > 0 ? Palette.roast : Palette.inkFaint)
                    }
                    .buttonStyle(.plain)
                    .disabled(orphanCount == 0)

                    if let cleanupMessage {
                        Text(cleanupMessage)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
        }
    }

    /// 库里有没有示例数据——开关显示的就是这个事实，不是一份独立偏好。
    private var hasSampleData: Bool {
        beans.contains { $0.isSample }
    }

    private func performSampleAction(_ action: SampleAction) {
        switch action {
        case .install:
            DemoData.install(context: context)
            sampleMessage = L("示例数据已载入：7 包演示豆，覆盖养豆到喝完的完整生命周期。")
            // 刚插进来的豆子还没有任何提醒；下一次启动才会整体重排。这里顺手
            // 排一遍，开关打开之后提醒就是真的在队列里。
            Task { await resyncReminders() }
        case .remove:
            // 系统通知只认豆子 ID：删完再查就查不到该清谁了，所以先取下来。
            let identifiers = DemoData.sampleBeans(context: context)
                .flatMap { NotificationPlanner.allIdentifiers(beanID: $0.id) }
            if DemoData.removeInstalled(context: context) {
                NotificationManager.shared.unschedule(identifiers: identifiers)
                sampleMessage = L("示例数据已移除，你的记录未受影响。")
                Task { await resyncReminders() }
            } else {
                sampleMessage = nil
            }
        }
    }

    private func navRow(title: LocalizedStringKey, detail: LocalizedStringKey?, showsChevron: Bool = true) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                if let detail {
                    Text(detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }
            Spacer(minLength: 8)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    // MARK: - 应用

    private var experimentalBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Card(padding: 0) {
                EditorToggleRow(
                    title: "实验性风味预测",
                    detail: "用合成数据训练的模型估算每包豆子的最佳风味窗口",
                    isOn: Binding(
                        get: { predictsFlavorWindow },
                        set: { newValue in
                            predictsFlavorWindow = newValue
                            // 打开时顺手把模型捂热：小树模型加载只要几十毫秒，
                            // 但没必要让用户第一次打开详情页时等它。
                            if newValue { FlavorWindowPredictor.shared.warmUp() }
                        }
                    ),
                    showsDivider: false
                )
            }

            Text(predictsFlavorWindow
                 ? LocalizedStringKey("预计风味窗口是实验功能，和阶段规则是两回事：一个是模型估计，一个是你自己定的规则。")
                 : LocalizedStringKey("预计风味窗口已经关掉，详情页不会显示它。"))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 关于

    private var aboutCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    Text("BrewPhase")
                        .font(TypeScale.title)
                        .foregroundStyle(Palette.ink)
                    Spacer(minLength: 0)
                    Text(verbatim: "v\(ExportManager.appVersion)")
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Palette.inkFaint)
                }

                // 产品价值，不是技术清单（规格 §二十四）：用户关心的是自己的
                // 豆子、记录和规律，不是实现方式。
                VStack(alignment: .leading, spacing: 6) {
                    bullet("一本属于你的咖啡实验手册：记录每一包豆，看到风味怎么变化。")
                    bullet("数据只存在这台设备上，没有账号，没有服务器。")
                    bullet("飞行模式下也能完整使用。")
                    bullet("所有数据随时可以导出带走。")
                }

                // 隐私政策入口（App Store 要求容易找到）：系统 Link 打开公开网页，
                // 地址只此一处定义（AppLinks.privacyPolicy）。
                Link(destination: AppLinks.privacyPolicy) {
                    HStack(spacing: 6) {
                        Text("隐私政策")
                            .font(TypeScale.callout)
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(Palette.roast)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(
                        RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                            .fill(Palette.well)
                    )
                }
                .accessibilityLabel(Text("隐私政策"))

                Text("Slow down. Taste it today.")
                    .font(TypeScale.signature)
                    .tracking(0.8)
                    .foregroundStyle(Palette.inkFaint)
                    .padding(.top, 2)
            }
        }
    }

    private func bullet(_ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Circle()
                .fill(Palette.latte)
                .frame(width: 4, height: 4)
                .padding(.top, 6)
            Text(text)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Actions

    private func refreshStatus() async {
        await NotificationManager.shared.refreshStatus()
        notificationStatus = NotificationManager.shared.status
        pendingReminderCount = await NotificationManager.shared.pendingCount()
        refreshImageStats()
    }

    /// 按当前规则与开关重排全部提醒。偏好刚刚变过，`refreshAll` 里的
    /// `ReminderPreferences.current()` 读到的就是新值。
    private func resyncReminders() async {
        let all = (try? context.fetch(FetchDescriptor<Bean>())) ?? []
        await NotificationManager.shared.refreshAll(beans: all, book: book, context: context)
    }

    /// 图片目录里真正被引用的文件名：豆子图片 + 记录的两类图片
    /// （链接预览图、图片记录的正文图 .jpg）。引用集合漏掉记录图片会把
    /// 它们当垃圾删掉（与 BackupRestorer 恢复后的清孤儿同一口径）。
    private func referencedImageNames() -> Set<String> {
        let recordImages = records.flatMap { record -> [String?] in
            [record.previewPath, (record.mediaPath?.hasSuffix(".jpg") ?? false) ? record.mediaPath : nil]
        }
        return Set(beans.compactMap(\.imagePath) + recordImages.compactMap { $0 })
    }

    private func refreshImageStats() {
        imageCount = ImageStore.shared.fileCount()
        imageBytes = ImageStore.shared.totalBytes()
        orphanCount = ImageStore.shared.orphanedFiles(referenced: referencedImageNames()).count
    }

    private func cleanUpImages() {
        let removed = ImageStore.shared.clearOrphans(referenced: referencedImageNames())
        cleanupMessage = removed > 0 ? L("已清理 %@ 个文件", String(removed)) : nil
        refreshImageStats()
    }
}

/// One reminder switch. Owns its own `@AppStorage` entry, because the keys are
/// per-kind and cannot be declared as a fixed set of properties.
private struct ReminderToggleRow: View {

    let kind: ReminderKind
    let onChange: () -> Void

    @AppStorage private var isOn: Bool

    init(kind: ReminderKind, onChange: @escaping () -> Void) {
        self.kind = kind
        self.onChange = onChange
        // 默认值与 `ReminderPreferences.current()` 同一处定义：推荐提醒默认开，
        // 其余默认关。用户动过之后以他写下的值为准。
        _isOn = AppStorage(wrappedValue: kind.recommendedByDefault, PrefKey.reminderEnabled(kind))
    }

    var body: some View {
        EditorToggleRow(
            title: .alreadyLocalized(kind.label),
            detail: .alreadyLocalized(kind.detail),
            isOn: Binding(
                get: { isOn },
                set: { newValue in
                    isOn = newValue
                    onChange()
                }
            ),
            showsDivider: false
        )
    }
}
