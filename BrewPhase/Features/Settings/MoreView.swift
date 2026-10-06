import SwiftData
import SwiftUI

/// 更多 (§18): 按「咖啡 / 本地智能 / 数据 / 应用」四组整理的设置页。
///
/// 组头是小号的 tracked 标题；组内每个块用加粗的小标题开场。Tab 名保持
/// 「更多」不变，这一批只动层级不动入口。
struct MoreView: View {

    @Environment(\.modelContext) private var context
    @Query private var beans: [Bean]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.defaultMethod) private var defaultMethod: String = "V60"
    @AppStorage(PrefKey.defaultDoseG) private var defaultDoseG: Double = 15
    @AppStorage(PrefKey.defaultWaterG) private var defaultWaterG: Double = 240
    @AppStorage(PrefKey.defaultWaterTemp) private var defaultWaterTemp: Double = 92
    @AppStorage(PrefKey.experimentalFlavorPrediction) private var predictsFlavorWindow: Bool = true

    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var pendingReminderCount = 0
    @State private var isExporting = false
    @State private var orphanCount = 0
    @State private var imageBytes: Int64 = 0
    @State private var imageCount = 0
    @State private var cleanupMessage: String?

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

                    // 数据：导出与图片，全部在本机。
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
                            Task { await refreshStatus() }
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
                    navRow(title: "导出", detail: "JSON 完整备份 · CSV 表格")
                }
                .buttonStyle(.plain)

                CardDivider()

                VStack(alignment: .leading, spacing: 10) {
                    navRow(title: "图片",
                            detail: .alreadyLocalized(
                                L("%@ 个文件 · %@", String(imageCount), formattedBytes(imageBytes))
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

                VStack(alignment: .leading, spacing: 6) {
                    bullet("BrewPhase stores your coffee records locally on this device.")
                    bullet("没有账号，没有登录，没有服务器。")
                    bullet("飞行模式下也能完整使用。")
                    bullet("所有数据随时可以导出带走。")
                }

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

    private func refreshImageStats() {
        imageCount = ImageStore.shared.fileCount()
        imageBytes = ImageStore.shared.totalBytes()
        let referenced = Set(beans.compactMap(\.imagePath))
        orphanCount = ImageStore.shared.orphanedFiles(referenced: referenced).count
    }

    private func cleanUpImages() {
        let referenced = Set(beans.compactMap(\.imagePath))
        let removed = ImageStore.shared.clearOrphans(referenced: referenced)
        cleanupMessage = removed > 0 ? L("已清理 %@ 个文件", String(removed)) : nil
        refreshImageStats()
    }

    private func formattedBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
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
