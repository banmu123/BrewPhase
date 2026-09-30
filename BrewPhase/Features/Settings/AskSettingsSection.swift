import SwiftData
import SwiftUI

/// 更多页里的「洞察」区块。
///
/// V1（协议 §二）不使用 LLM，所以这一页只有三类东西：两个入口（洞察卡片页和
/// 问一问）、一个总开关，以及语义检索的档位与索引维护。曾经在这里的「回答引擎
/// 选择」和 Ollama 地址随 V1 一起移出了界面——provider 文件保留为接口，将来
/// 引入可选 LLM 层时从这里挂回来。
struct AskSettingsSection: View {

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query private var rules: [PhaseRule]

    @AppStorage(PrefKey.askEnabled) private var isEnabled: Bool = true
    @AppStorage(PrefKey.askEmbeddingBackend) private var embeddingRaw: String = EmbeddingBackend.onDevice.rawValue
    @AppStorage(PrefKey.askPassageLimit) private var passageLimit: Int = RAGSettings.defaultPassageLimit

    @State private var isRebuilding = false
    @State private var rebuildMessage: String?

    private var settings: RAGSettings { RAGSettings.current() }
    private var embedding: EmbeddingBackend { EmbeddingBackend(rawValue: embeddingRaw) ?? .onDevice }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "洞察", detail: "本地智能，不联网")

            Card(padding: 0) {
                VStack(spacing: 0) {
                    if isEnabled {
                        NavigationLink {
                            InsightsView()
                        } label: {
                            navRow(title: "洞察", detail: "今日建议 · 我的最佳参数 · 相似冲煮")
                        }
                        .buttonStyle(.plain)

                        CardDivider()

                        NavigationLink {
                            AskView()
                        } label: {
                            navRow(title: "问一问", detail: "用你自己的记录回答问题")
                        }
                        .buttonStyle(.plain)

                        CardDivider()
                    }

                    EditorToggleRow(
                        title: "开启本地智能",
                        detail: "关掉之后不再维护向量索引，也不会算任何向量",
                        isOn: $isEnabled,
                        showsDivider: false
                    )
                }
            }

            if isEnabled {
                retrievalCard
                rebuildCard
            }

            Text("建议与分析只依据这台设备上的记录和 App 自带的知识条目。检索在本机完成，没有账号，也没有服务器。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 检索档位

    private var retrievalCard: some View {
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

                EditorRow(title: "每次取多少条资料") {
                    Stepper(value: $passageLimit, in: 3...20) {
                        Text(LocalizedStringKey.alreadyLocalized(L("%@ 条", String(passageLimit))))
                            .font(TypeScale.numeral)
                            .foregroundStyle(Palette.ink)
                    }
                }

                Text("取太多会让相似记录挤在一起，太少又可能漏掉你真正想问的那条记录。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
            }
        }
    }

    // MARK: - 索引维护

    private var rebuildCard: some View {
        Card(padding: 0) {
            VStack(alignment: .leading, spacing: 10) {
                navRow(title: "重建索引",
                        detail: .alreadyLocalized(isRebuilding ? L("正在重建…") : L("换了向量模型或界面语言之后需要重建")),
                        showsChevron: false)

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
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
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
