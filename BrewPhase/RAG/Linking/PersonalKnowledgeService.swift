import Foundation

/// 用户历史的关联层（规格 §二十四 / §二十五）。
///
/// 这是 BrewPhase 与普通咖啡百科的分界：百科只有「浅烘豆常用较高水温」，而这里
/// 还有「**你**在 91–92°C 打出过 5 分」。两者都要出现，且**不许混为一谈**——
/// 所以本服务产出的每个数字都带 `EvidenceAuthority` 标记（规格 §二十六），
/// 由格式化层决定措辞。
///
/// 全部统计复用 `PersonalBestAnalyzer`，不另算一套。重算一份迟早会和
/// 「我的最佳参数」卡片显示的数字对不上。
///
/// `@MainActor` 是被依赖方决定的，不是这里的选择：`PersonalBestAnalyzer` 与
/// `ParameterDeviationAnalyzer` 都是 `@MainActor`（它们要摸 SwiftData 的 `@Model`），
/// 所以本层也待在主 actor 上。计算量是几条记录的统计，不值得为它切上下文。
@MainActor
struct PersonalKnowledgeService {

    /// 一包豆子的个人证据摘要。字段刻意与 `PersonalBestAnalyzer.Analysis` 对齐：
    /// 不新增口径，只是把它和知识链接摆在一起。
    struct Summary: Equatable, Sendable {
        let beanID: UUID
        let scoredCount: Int
        let highRatedCount: Int
        let bestScore: Int
        let bestDate: Date?
        let bestRecipe: BrewRecipe?
        /// 全部打过分记录的平均分——和 `PersonalBestAnalyzer.Analysis` 同一个口径，
        /// 所以是 `Double?` 而不是 `FieldStats?`：后者只统计高评分记录，两者不能混。
        let averageScore: Double?
        let temperature: FieldStats?
        let timeSeconds: FieldStats?
        let ratio: FieldStats?
        let dose: FieldStats?
        /// 高评分记录里出现最多的风味（英文规范 id）。
        let topFlavorTags: [String]
        /// 冲煮次数最多的方式，按次数降序。
        let topMethods: [String]
        let tastingCount: Int

        /// 有没有足够的记录来支撑「个人最佳」这类结论。
        let hasEnoughData: Bool

        static func empty(beanID: UUID) -> Summary {
            Summary(
                beanID: beanID,
                scoredCount: 0,
                highRatedCount: 0,
                bestScore: 0,
                bestDate: nil,
                bestRecipe: nil,
                averageScore: nil,
                temperature: nil,
                timeSeconds: nil,
                ratio: nil,
                dose: nil,
                topFlavorTags: [],
                topMethods: [],
                tastingCount: 0,
                hasEnoughData: false
            )
        }
    }

    /// 个人证据是否强到应该盖过通用知识（规格 §四十四）。
    ///
    /// 判据就是既有阈值：高评分记录数达到 `minimumSamplesForComparison`。
    /// 没到时**不覆盖**，因为三条以内的「最佳参数」是噪声，用它去否决知识只会
    /// 让建议变得随机。
    static func personalSignalOutweighsKnowledge(_ summary: Summary) -> Bool {
        summary.hasEnoughData
    }

    func summary(for bean: Bean) -> Summary {
        let brews = bean.brewsNewestFirst
        guard !brews.isEmpty else { return .empty(beanID: bean.id) }

        let analysis = PersonalBestAnalyzer.analyze(brews: brews)

        var flavorCounts: [String: Int] = [:]
        for brew in brews where brew.score >= IntelligenceConfig.highRatingThreshold {
            for tag in brew.flavorTags { flavorCounts[tag, default: 0] += 1 }
        }
        let topFlavorTags = flavorCounts
            .sorted { ($0.value, $1.key) > ($1.value, $0.key) }
            .prefix(4)
            .map(\.key)

        var methodCounts: [String: Int] = [:]
        for brew in brews {
            let method = brew.method.trimmed
            guard !method.isEmpty else { continue }
            methodCounts[method, default: 0] += 1
        }
        let topMethods = methodCounts
            .sorted { ($0.value, $1.key) > ($1.value, $0.key) }
            .prefix(3)
            .map(\.key)

        return Summary(
            beanID: bean.id,
            scoredCount: analysis.scoredCount,
            highRatedCount: analysis.highRatedCount,
            bestScore: analysis.bestScore,
            bestDate: analysis.bestDate,
            bestRecipe: analysis.bestRecipe,
            averageScore: analysis.averageScore,
            temperature: analysis.temperature,
            timeSeconds: analysis.timeSeconds,
            ratio: analysis.ratio,
            dose: analysis.dose,
            topFlavorTags: topFlavorTags,
            topMethods: topMethods,
            tastingCount: (bean.tastings ?? []).count,
            hasEnoughData: analysis.hasEnoughData
        )
    }

    /// 规格 §二十五 要求把 `Bean ↔ Brew ↔ Tasting ↔ Knowledge` 串起来。
    /// 前两者由 `Summary` 承载；知识侧由 `KnowledgeLinkingService` 承载；
    /// 这里只补一个「两边都摆在一起」的容器，避免界面自己去拼。
    ///
    /// `personalComesFirst` 是**存下来的**而不是计算属性：本类型是 `@MainActor`
    /// 类型的嵌套类型，而嵌套类型不继承外层隔离，写成计算属性会在非隔离上下文里
    /// 调不到那个 `@MainActor` 判据。构造时算好最省事，也让它是纯值、可跨 actor 传。
    struct Linked: Equatable, Sendable {
        let knowledge: BeanKnowledgeContext
        let personal: Summary
        /// 个人证据是否强到应当优先于通用知识。
        let personalComesFirst: Bool
    }

    func linked(
        bean: Bean,
        method: String? = nil,
        languageCode: String,
        graph: EntityGraph? = nil,
        today: Date = Date()
    ) -> Linked {
        let linking = KnowledgeLinkingService(graph: graph)
        let personal = summary(for: bean)
        return Linked(
            knowledge: linking.context(for: bean, method: method, languageCode: languageCode, today: today),
            personal: personal,
            personalComesFirst: PersonalKnowledgeService.personalSignalOutweighsKnowledge(personal)
        )
    }
}
