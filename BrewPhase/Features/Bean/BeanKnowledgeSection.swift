import SwiftUI

/// Bean Detail 的「关于这包豆」区块（规格 §三十一）。
///
/// 放在 `FlavorWindowCard` 之后：先看「它现在处于什么阶段」，再问「那我该知道什么」。
/// 这一块的每一次渲染都是**同步、离线、确定性**的——没有 embedding、没有网络，
/// 所以不需要 loading 态之外的任何降级路径。
struct BeanKnowledgeSection: View {

    let bean: Bean
    let languageCode: String

    @State private var result: InsightResult?

    /// 重算的触发条件：豆子内容变了、或界面语言换了（换了语言要重新取知识文案）。
    private var taskKey: String {
        "\(bean.id.uuidString)|\(bean.updatedAt.timeIntervalSince1970)|\(languageCode)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "关于这包豆")
            Card {
                if let result {
                    InsightResultCard(result: result, languageCode: languageCode)
                } else {
                    Text("正在关联知识…")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }
        }
        .task(id: taskKey) { await load() }
    }

    /// 在 MainActor 上算：`Bean` 是 SwiftData 的 `@Model`，读它的关系（`brews`）
    /// 必须待在它自己的上下文里。计算本身很轻（十几个知识条目、一次字符串匹配），
    /// 所以放在主 actor 上不会卡界面。
    @MainActor
    private func load() async {
        let linked = PersonalKnowledgeService().linked(bean: bean, languageCode: languageCode)
        result = BeanKnowledgeInsight.beanKnowledge(linked, languageCode: languageCode)
    }
}

/// 冲煮页的「与本杯相关」区块（规格 §三十二）。
struct RelevantKnowledgeSection: View {

    let bean: Bean
    /// 当前正在录的冲煮方式。用户改器具时这一块要跟着变。
    let method: String
    let languageCode: String

    @State private var result: InsightResult?

    private var taskKey: String {
        "\(bean.id.uuidString)|\(method)|\(bean.updatedAt.timeIntervalSince1970)|\(languageCode)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "与本杯相关")
            Card {
                if let result {
                    InsightResultCard(result: result, languageCode: languageCode)
                } else {
                    Text("正在找相关知识与记录…")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }
        }
        .task(id: taskKey) { await load() }
    }

    @MainActor
    private func load() async {
        let linked = PersonalKnowledgeService().linked(
            bean: bean,
            method: method.nonEmpty,
            languageCode: languageCode
        )
        result = BeanKnowledgeInsight.brewRelevant(linked, method: method, languageCode: languageCode)
    }
}

/// `InsightResult` 的通用渲染（规格 §二十八/§二十九）。
///
/// 每一行证据前面都带**归属标记**（你的记录 / 知识库 / 分析）——规格 §二十六 把
/// 这个区分当成硬要求，所以它出现在每一行上，而不是整张卡只标一次。
/// 知识行还带出处署名（规格 §四十一：不许出现没有来源的知识）。
struct InsightResultCard: View {

    let result: InsightResult
    let languageCode: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(result.summary)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)

            if !result.facts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(result.facts.prefix(8), id: \.self) { fact in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(Palette.roast)
                                .frame(width: 4, height: 4)
                                .padding(.top, 7)
                            Text(fact)
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkSoft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            if !result.evidence.isEmpty {
                CardDivider()
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(result.evidence) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(row.authority.label)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.roast)
                                Text(row.text)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let source = row.source, !source.isEmpty {
                                Text(source)
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.inkFaint)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }

            if let recommendation = result.recommendation {
                CardDivider()
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Palette.roast)
                    Text(recommendation)
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !result.limitations.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(result.limitations, id: \.self) { line in
                        Text(line)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}
