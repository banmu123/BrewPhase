import Foundation

/// 证据的归属（规格 §二十六）。
///
/// 规格把「必须明确区分」写成硬要求，所以它出现在**类型**上而不是文案里：
/// 一张卡片里的每一行都得说清它是用户自己的数据、知识库、还是系统推断。
/// 只靠措辞区分的话，翻译一改就丢了。
enum EvidenceAuthority: String, CaseIterable, Sendable {
    /// 用户自己的记录。
    case userData = "user_data"
    /// 内置知识库（带来源与权威等级）。
    case knowledgeBase = "knowledge_base"
    /// 系统从数据里算出来的印象——**不是事实**，只是统计。
    case inference

    var label: String {
        switch self {
        case .userData: return L("你的记录")
        case .knowledgeBase: return L("知识库")
        case .inference: return L("分析")
        }
    }
}

/// 可解释结果（规格 §二十八）。
///
/// 与既有 `Insight` 的关系：`Insight` 是四张**统计卡**的输出类型
/// （今日建议 / 我的最佳参数 / 参数偏离 / 相似冲煮），本类型是**知识侧**的输出类型。
/// 两者并存而不合并，是因为知识结果有一项 `Insight` 没有的必需信息——
/// 每一行证据的 `authority`（规格 §二十六）。把 `authority` 塞进 `Insight.Evidence`
/// 会改动一个已经被 227 项测试钉住的类型，收益不抵风险。
struct InsightResult: Identifiable, Equatable, Sendable {

    /// 规格 §二十八 的类型清单。
    enum Kind: String, CaseIterable, Sendable {
        case beanStatus = "bean_status"
        case bestBrew = "best_brew"
        case similarBrew = "similar_brew"
        case parameterDeviation = "parameter_deviation"
        case knowledge
        case troubleshooting
        case equipmentGuidance = "equipment_guidance"

        var label: String {
            switch self {
            case .beanStatus: return L("这包豆的状态")
            case .bestBrew: return L("你的最佳参数")
            case .similarBrew: return L("相似冲煮")
            case .parameterDeviation: return L("参数偏离")
            case .knowledge: return L("相关知识")
            case .troubleshooting: return L("故障排查")
            case .equipmentGuidance: return L("设备指引")
            }
        }
    }

    /// 一行证据，带归属。
    struct EvidenceRow: Identifiable, Equatable, Sendable {
        let authority: EvidenceAuthority
        let text: String
        /// 知识行才有：出处署名。
        let source: String?
        var id: String { "\(authority.rawValue):\(text)" }
    }

    let id: UUID
    let kind: Kind
    let title: String
    let summary: String
    let facts: [String]
    let evidence: [EvidenceRow]
    /// 可执行建议。没有证据支撑时必须是 nil——规格 §四十九 禁止虚构个性化建议。
    let recommendation: String?
    let confidence: Insight.Confidence
    /// 为什么它可能不适用于你。这一项不是装饰：每条知识结论都带着范围。
    let limitations: [String]
}

/// 知识侧的确定性模板层（规格 §二十九 / §三十）。
///
/// 全部数字来自实际计算或知识库条目，模板只负责措辞。特别注意
/// **不许**出现「这款豆子非常适合花香型爱好者」这类句子（规格 §三十）：
/// 除非知识库有明确依据，或者用户自己有这样的记录，否则那句话就是在编。
///
/// 刻意**不标** `@MainActor`：`L()` 是带锁的非隔离全局函数，本层只做纯计算，
/// 视图层因此可以在自己的 actor 上调用它，不必为了取文案而切上下文。
enum BeanKnowledgeInsight {

    /// 「关于这包豆」。用于 Bean Detail（规格 §三十一）。
    static func beanKnowledge(
        _ linked: PersonalKnowledgeService.Linked,
        languageCode: String
    ) -> InsightResult {
        let context = linked.knowledge.context

        var facts: [String] = []
        for link in linked.knowledge.directLinks {
            facts.append(L("%@：%@（%@）",
                           link.relation.label,
                           link.entity.displayName(for: languageCode),
                           link.match.label))
        }

        var evidence: [InsightResult.EvidenceRow] = []
        for item in linked.knowledge.directKnowledge.prefix(6) {
            evidence.append(InsightResult.EvidenceRow(
                authority: .knowledgeBase,
                text: item.title,
                source: item.source
            ))
        }
        // 与这包豆直接相关的知识为空时，明确回退到更上层的通用知识
        // （规格 §五十：宁可说「没有具体资料」，也不假装找到了）。
        if linked.knowledge.directKnowledge.isEmpty {
            for item in linked.knowledge.relatedKnowledge.prefix(3) {
                evidence.append(InsightResult.EvidenceRow(
                    authority: .knowledgeBase,
                    text: item.title,
                    source: item.source
                ))
            }
            for item in linked.knowledge.genericKnowledge.prefix(3) {
                evidence.append(InsightResult.EvidenceRow(
                    authority: .knowledgeBase,
                    text: item.title,
                    source: item.source
                ))
            }
        }

        // 个人证据：有就摆出来，没有就说没有（规格 §四十九）。
        var inference: [InsightResult.EvidenceRow] = []
        if linked.personal.hasEnoughData, let temperature = linked.personal.temperature {
            inference.append(InsightResult.EvidenceRow(
                authority: .inference,
                text: L("你的高评分记录集中在 %@ 到 %@°C。",
                        Fmt.number(temperature.minimum), Fmt.number(temperature.maximum)),
                source: nil
            ))
        }
        if linked.personal.scoredCount > 0 {
            evidence.append(InsightResult.EvidenceRow(
                authority: .userData,
                text: L("这包豆有 %@ 次带评分的冲煮记录。", String(linked.personal.scoredCount)),
                source: nil
            ))
        }

        let summary: String
        if context.isEmpty {
            summary = L("这包豆子还没填产地、处理法或风味，暂时无法关联知识。")
        } else if linked.knowledge.directKnowledge.isEmpty {
            summary = L("暂时没有这包豆子的专属资料，下面显示的是更上层的通用知识。")
        } else {
            summary = L("已关联 %@ 条与这包豆子直接相关的知识。",
                        String(linked.knowledge.directKnowledge.count))
        }

        var limitations: [String] = []
        if !context.missingFields.isEmpty {
            let names = context.missingFields.map(\.label).joined(separator: "、")
            limitations.append(L("还没有填：%@。填上之后关联会更准。", names))
        }
        limitations.append(L("知识是通用起点，不是这包豆子唯一正确的参数。"))
        if !linked.personal.hasEnoughData {
            limitations.append(L("带评分的记录还不够 %@ 条，所以这次不给个人化结论。",
                                 String(IntelligenceConfig.minimumSamplesForComparison)))
        }

        return InsightResult(
            id: UUID(),
            kind: .knowledge,
            title: L("关于这包豆"),
            summary: summary,
            facts: facts,
            evidence: evidence + inference,
            recommendation: nil,
            confidence: linked.knowledge.directKnowledge.isEmpty ? .low : .medium,
            limitations: limitations
        )
    }

    /// 「与本杯相关」。用于冲煮页（规格 §三十二 / §三十三）。
    static func brewRelevant(
        _ linked: PersonalKnowledgeService.Linked,
        method: String?,
        languageCode: String
    ) -> InsightResult {
        let context = linked.knowledge.context

        var evidence: [InsightResult.EvidenceRow] = []
        for item in linked.knowledge.recommendedKnowledge.prefix(4) {
            evidence.append(InsightResult.EvidenceRow(
                authority: .knowledgeBase,
                text: item.title,
                source: item.source
            ))
        }
        for item in linked.knowledge.directKnowledge.prefix(2) {
            evidence.append(InsightResult.EvidenceRow(
                authority: .knowledgeBase,
                text: item.title,
                source: item.source
            ))
        }

        // 用户历史在「我自己怎么冲最好」这类问题上必须优先（规格 §二十七）。
        var recommendation: String?
        if linked.personal.hasEnoughData {
            var parts: [String] = []
            if let temperature = linked.personal.temperature {
                parts.append(L("水温 %@–%@°C", Fmt.number(temperature.minimum), Fmt.number(temperature.maximum)))
            }
            if let time = linked.personal.timeSeconds {
                parts.append(L("时间 %@–%@",
                               BrewMath.formatTime(Int(time.minimum.rounded())),
                               BrewMath.formatTime(Int(time.maximum.rounded()))))
            }
            if !parts.isEmpty {
                recommendation = L("先从你自己的高评分区间试：%@。", parts.joined(separator: "，"))
                evidence.insert(InsightResult.EvidenceRow(
                    authority: .inference,
                    text: L("这是从 %@ 次高评分记录里算出来的区间，不是通用建议。",
                            String(linked.personal.highRatedCount)),
                    source: nil
                ), at: 0)
            }
        } else if linked.personal.scoredCount > 0 {
            evidence.insert(InsightResult.EvidenceRow(
                authority: .userData,
                text: L("这包豆目前只有 %@ 次带评分的记录，还形不成区间。",
                        String(linked.personal.scoredCount)),
                source: nil
            ), at: 0)
        }

        let methodName = (method?.nonEmpty ?? context.methodText) ?? L("这次冲煮")
        let summary: String
        if evidence.isEmpty {
            summary = L("这次用的是 %@，暂时没有与之直接相关的知识。", methodName)
        } else {
            summary = L("这次用的是 %@，找到 %@ 条相关知识与记录。",
                        methodName, String(evidence.count))
        }

        var limitations: [String] = []
        if !linked.personal.hasEnoughData {
            limitations.append(L("个人最佳参数还不可用：至少需要 %@ 条带评分的记录。",
                                 String(IntelligenceConfig.minimumSamplesForComparison)))
        }
        limitations.append(L("一次只改一个变量，否则事后不知道是哪一项起的作用。"))

        return InsightResult(
            id: UUID(),
            kind: .knowledge,
            title: L("与本杯相关"),
            summary: summary,
            facts: linked.knowledge.recommendedKnowledge.map(\.title),
            evidence: evidence,
            recommendation: recommendation,
            confidence: linked.personal.hasEnoughData ? .medium : .low,
            limitations: limitations
        )
    }
}
