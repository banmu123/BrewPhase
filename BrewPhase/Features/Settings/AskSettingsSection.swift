import SwiftData
import SwiftUI

/// 更多页里的「本地智能」区块。
///
/// 普通用户只需要三样东西：两个入口、一个总开关、一句数据不会上传的说明。
/// 向量模型、检索条数、重建索引这些是引擎的调参项，全部收进「高级设置」——
/// 能力一个没删，只是不再出现在第一层。
struct AskSettingsSection: View {

    @Environment(\.modelContext) private var context

    @AppStorage(PrefKey.askEnabled) private var isEnabled: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Card(padding: 0) {
                VStack(spacing: 0) {
                    if isEnabled {
                        NavigationLink {
                            InsightsView()
                        } label: {
                            navRow(title: "洞察", detail: "它主动告诉你现在最值得关注什么")
                        }
                        .buttonStyle(.plain)

                        CardDivider()

                        NavigationLink {
                            AskView()
                        } label: {
                            navRow(title: "问一问", detail: "你有问题，直接问")
                        }
                        .buttonStyle(.plain)

                        CardDivider()
                    }

                    EditorToggleRow(
                        title: "开启本地智能",
                        detail: "关掉之后不再维护索引，也不会做任何分析",
                        isOn: $isEnabled,
                        showsDivider: false
                    )
                }
            }

            Text("BrewPhase 会结合你的咖啡记录和本地知识进行分析，数据不会上传到服务器。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)

            if isEnabled {
                NavigationLink {
                    AskAdvancedSettingsView()
                } label: {
                    Card(padding: 0) {
                        navRow(title: "高级设置", detail: "检索模型 · 取条数 · 重建索引")
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func navRow(
        title: LocalizedStringKey,
        detail: LocalizedStringKey?,
        showsChevron: Bool = true,
        enabled: Bool = true
    ) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(TypeScale.body)
                    .foregroundStyle(enabled ? Palette.ink : Palette.inkFaint)
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
}

/// 「高级设置 → 本地智能」：向量模型、检索条数、索引维护都住在这里。
///
/// 它们原本平铺在更多页的第一层，对不关心实现的人来说是噪音；对确实要调的人
/// 来说，收进一层只是多一次点击。配置能力本身一行没动。
struct AskAdvancedSettingsView: View {

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.askEmbeddingBackend) private var embeddingRaw: String = EmbeddingBackend.onDevice.rawValue
    @AppStorage(PrefKey.askPassageLimit) private var passageLimit: Int = RAGSettings.defaultPassageLimit

    @State private var isRebuilding = false
    @State private var rebuildMessage: String?

    private var settings: RAGSettings { RAGSettings.current() }
    private var embedding: EmbeddingBackend { EmbeddingBackend(rawValue: embeddingRaw) ?? .onDevice }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                retrievalCard
                rebuildCard

                Text("这些选项影响问一问与洞察的检索方式；不改也完全能用。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("高级设置")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - 检索档位

    private var retrievalCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "检索")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    EditorRow(title: "向量模型") {
                        Picker("", selection: $embeddingRaw) {
                            ForEach(EmbeddingBackend.allCases) { backend in
                                Text(LocalizedStringKey.alreadyLocalized(backend.label)).tag(backend.rawValue)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }

                    Text(embedding.detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)

                    CardDivider()

                    EditorRow(title: "每次取多少条资料", showsDivider: false) {
                        Stepper(value: $passageLimit, in: 3...20) {
                            Text(LocalizedStringKey.alreadyLocalized(L("%@ 条", String(passageLimit))))
                                .font(TypeScale.numeral)
                                .foregroundStyle(Palette.ink)
                        }
                    }
                }
            }

            Text("取太多会让相似记录挤在一起，太少又可能漏掉你真正想问的那条记录。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 索引维护

    private var rebuildCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "索引")
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text(isRebuilding
                         ? LocalizedStringKey.alreadyLocalized(L("正在重建…"))
                         : LocalizedStringKey("换了向量模型或界面语言之后需要重建"))
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        rebuild()
                    } label: {
                        Text(isRebuilding ? LocalizedStringKey("正在重建…") : LocalizedStringKey("开始重建"))
                            .font(TypeScale.caption)
                            .foregroundStyle(isRebuilding ? Palette.inkFaint : Palette.roast)
                    }
                    .buttonStyle(.plain)
                    .disabled(isRebuilding)

                    if let rebuildMessage {
                        Text(LocalizedStringKey.alreadyLocalized(rebuildMessage))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func rebuild() {
        guard !isRebuilding else { return }
        isRebuilding = true
        rebuildMessage = nil

        let engine = AskEngine(context: context)
        let settings = self.settings
        let languageCode = LanguageManager.shared.current.resolvedCode
        let beans = self.beans
        let brews = self.brews
        let tastings = self.tastings
        let book = PhaseRuleBook.make(stored: rules)

        Task {
            let report = await engine.rebuildIndex(
                beans: beans, brews: brews, tastings: tastings,
                book: book, settings: settings, languageCode: languageCode
            )
            rebuildMessage = L("完成了：索引里现在有 %@ 条，这次重算了 %@ 条。",
                               String(report.total), String(report.embedded))
            isRebuilding = false
        }
    }
}
