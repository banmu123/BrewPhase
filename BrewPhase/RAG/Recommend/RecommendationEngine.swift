import Foundation
import SwiftData

/// 把结构化数据、语义证据和规则组合成建议（协议 §22）。
///
/// 四个入口对应协议 §三的四种问题，各自走不同的路：
/// * `todayPick` 只走结构化查询 + 既有规则引擎（协议 §23：不要用 embedding）；
/// * `personalBest` / `deviation` 是纯统计（协议 §19–20）；
/// * `similarHistory` 是唯一的语义检索入口（协议 §21）。
///
/// 它拥有自己的索引实例——`AskEngine` 也是。两个引擎各持一份向量缓存，按几十条
/// × 640 维算不到 100KB，换来的是两个组件互不牵扯生命周期。真要共享的话，被共享
/// 的应该是索引层，而不是其中某一个引擎。
@MainActor
final class RecommendationEngine {

    private let index: SwiftDataVectorIndex
    private let coordinator: IndexCoordinator

    init(context: ModelContext) {
        let index = SwiftDataVectorIndex(context: context)
        let coordinator = IndexCoordinator(index: index)
        self.index = index
        self.coordinator = coordinator
    }

    // MARK: 今日建议（协议 §23）

    /// 排序与理由全部来自既有的 `PriorityEngine`——那是这个项目已经在首页跑了
    /// 很久的规则。V1 的职责是把它的结论配上真实证据，而不是再发明一套排序。
    ///
    /// `weather` 只做**同档 tie-break**（§今天喝哪包）：PriorityEngine 给出的
    /// 紧迫档位永远优先，天气只在「两包同档」时帮忙挑一包，且差距要超过
    /// `weatherTieBreakMinimumMargin` 才动手——否则推荐会随天气抖来抖去。
    func todayPick(
        beans: [Bean],
        book: PhaseRuleBook,
        defaults: BrewDefaults = .current(),
        today: Date = Date(),
        weather: WeatherContext? = nil
    ) -> Insight? {
        guard let pick = InsightFactory.todaysPick(beans, book: book, defaults: defaults, today: today),
              let bean = beans.first(where: { $0.id == pick.id })
        else { return nil }

        var appliedWeather: WeatherContext?
        if let weather, weather.isSet {
            let ranked = InsightFactory.ranked(beans, book: book, defaults: defaults, today: today)
            let peers = ranked.filter { $0.verdict.tier == pick.verdict.tier }
            if peers.count > 1 {
                // BeanInsight 携带的是值快照（BeanSnapshot），契合度要看原始
                // @Model 上的 roastLevel/process，按 id 回原数组取。
                let scored = peers.compactMap { insight -> (insight: BeanInsight, bean: Bean, affinity: Double)? in
                    guard let bean = beans.first(where: { $0.id == insight.bean.id }) else { return nil }
                    return (insight, bean, IntelligenceConfig.weatherAffinity(for: weather.scene, bean: bean))
                }
                let best = scored.max { $0.affinity < $1.affinity }
                if let best,
                   best.bean.id != pick.id,
                   best.affinity - IntelligenceConfig.weatherAffinity(for: weather.scene, bean: bean)
                    >= IntelligenceConfig.weatherTieBreakMinimumMargin {
                    // 换成同档里更契合天气的那包。档位信息跟着人走。
                    if let swappedInsight = ranked.first(where: { $0.bean.id == best.bean.id }) {
                        return InsightFormatter.todayPick(swappedInsight, bean: best.bean, today: today,
                                                          weather: weather, swappedForWeather: true)
                    }
                }
            }
            appliedWeather = weather
        }

        return InsightFormatter.todayPick(pick, bean: bean, today: today, weather: appliedWeather)
    }

    // MARK: 今天喝什么做法

    /// 「今天手冲还是美式/卡布奇诺」——天气场景给出方向，用户自己的历史给
    /// 出依据。两者怎么融合是刻意的：
    ///
    /// * **历史是硬依据**：某个做法家族的平均分和样本数直接来自记录，建议里
    ///   必须引用真实数字；
    /// * **天气是软方向**：它决定先看哪个家族、以及措辞（「热天来杯冰手冲」），
    ///   但永远不会把历史高分压下去——你手冲一直 5 分，35°C 的天也照推荐手冲。
    ///
    /// 这包豆自己的历史优先；不够时退到全部豆子的历史（并如实说明统计范围）。
    func methodSuggestion(for bean: Bean, weather: WeatherContext?, allBrews: [Brew]) -> Insight {
        let minimumSamples = IntelligenceConfig.minimumSamplesForComparison - 1 // 做法 ≥2 次才有参考价值
        let ownBrews = bean.brewsNewestFirst

        // 统计范围：优先这包豆，不够再看全局——并在证据里如实标出来。
        var scope: (brews: [Brew], isOwn: Bool) = (ownBrews, true)
        if ownBrews.count < minimumSamples + 1, allBrews.count > ownBrews.count {
            scope = (allBrews, false)
        }

        var familyRows: [(family: MethodFamily, count: Int, average: Double)] = []
        for family in MethodFamily.allCases {
            if let stats = MethodRules.stats(for: family, brews: scope.brews) {
                familyRows.append((family, stats.count, stats.average))
            }
        }

        guard let eligible = familyRows.filter({ $0.count >= minimumSamples }).sorted(by: { $0.average > $1.average }).first else {
            // 协议 Case 5：没有足够历史就不给建议，N 必须是真实阈值。
            let counted = familyRows.reduce(0) { $0 + $1.count }
            return Insight(
                id: UUID(),
                kind: .methodSuggestion,
                headline: L("这包豆的历史还不够给出做法建议"),
                reasons: [L("同一个做法至少要冲过 %@ 次才能比较；现在有 %@ 次带评分的记录。",
                            String(minimumSamples), String(counted))],
                evidence: [],
                confidence: .insufficientEvidence,
                beanID: bean.id
            )
        }

        // 场景方向只是**排序偏好**：方向上第一个有资格的家族获得平票优先权，
        // 但平均分差距大时（≥0.5）历史赢——天气不推翻你真实的高分记录。
        let direction = weather.map { IntelligenceConfig.preferredFamilies(for: $0.scene) }
            ?? [.filter, .espresso, .cold]
        var winner = eligible
        if eligible.family != direction.first,
           let preferred = familyRows.first(where: { $0.family == direction.first && $0.count >= minimumSamples }),
           eligible.average - preferred.average < 0.5 {
            winner = preferred
        }

        var reasons: [String] = []
        if let weather, weather.isSet, weather.scene != .unknown {
            reasons.append(L("今天%@，通常更想喝%@。",
                             weather.scene.label, direction.first?.label ?? winner.family.label))
        }
        reasons.append(L("你用%@平均打了 %@ 分（%@ 次）。",
                         winner.family.label, Fmt.number(winner.average), String(winner.count)))
        if !scope.isOwn {
            reasons.append(L("这包豆自己还没有足够的记录，这次按你全部豆子的历史统计。"))
        }
        switch bean.roastLevel {
        case .light:
            reasons.append(L("浅烘的果酸和花香在手冲里最放得开。"))
        case .medium:
            reasons.append(L("中烘两头都搭，手冲和加奶都稳。"))
        case .mediumDark, .dark, .espressoBlend:
            reasons.append(L("偏深的烘焙压得住奶，做意式或加奶都不闷。"))
        }

        var evidence: [Insight.Evidence] = familyRows.map { row in
            Insight.Evidence(text: L("%@：平均 %@ 分（%@ 次）",
                                      row.family.label, Fmt.number(row.average), String(row.count)))
        }
        if let temperature = weather?.temperatureCelsius {
            evidence.insert(Insight.Evidence(text: L("现在 %@°C", Fmt.number(temperature))), at: 0)
        }

        return Insight(
            id: UUID(),
            kind: .methodSuggestion,
            headline: L("今天适合%@：%@", winner.family.label, bean.displayName),
            reasons: reasons,
            evidence: evidence,
            confidence: .medium,
            beanID: bean.id
        )
    }

    // MARK: 我的最佳参数（协议 §19）

    func personalBest(for bean: Bean) -> Insight {
        InsightFormatter.personalBest(
            PersonalBestAnalyzer.analyze(brews: bean.brewsNewestFirst),
            bean: bean
        )
    }

    // MARK: 参数偏离（协议 §20）

    /// 「这次」取这包豆最近的一次冲煮。将来若要从冲煮编辑器里发起比较，
    /// 把那一条传进来即可——分析函数已经接受任意一条。
    func deviation(for bean: Bean) -> Insight {
        InsightFormatter.deviation(
            ParameterDeviationAnalyzer.analyze(current: bean.latestBrew, history: bean.brewsNewestFirst),
            bean: bean
        )
    }

    // MARK: 相似冲煮（协议 §21）

    func similarHistory(
        matching text: String,
        focus bean: Bean?,
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook?,
        settings: RAGSettings,
        languageCode: String,
        now: Date = Date()
    ) async -> Insight {
        // 先让索引追上数据——和提问走的是同一条增量同步路径。
        let report = await coordinator.sync(
            beans: beans, brews: brews, tastings: tastings, book: book,
            settings: settings, languageCode: languageCode, now: now
        )
        let trimmed = text.trimmed
        guard !trimmed.isEmpty, report.total > 0 else {
            return InsightFormatter.similarHistory(hits: [], query: trimmed, beans: beans)
        }

        let resolution = await coordinator.resolution(settings: settings, languageCode: languageCode)
        let provider = resolution.provider
        // 向量化是同步的 CPU 工作，挪出主 actor 再算。
        guard let vector = await Task.detached(priority: .userInitiated, operation: {
            await provider.embed(trimmed)
        }).value, !vector.isEmpty else {
            AppLog.rag.error("similarity query embedding failed")
            return InsightFormatter.similarHistory(hits: [], query: trimmed, beans: beans)
        }

        var filter = MetadataFilter()
        // 只在用户自己的记录里找。知识库讲的是通用常识，不是「你的历史」——
        // 协议 §27 要求两者分开，这条过滤就是那道分界线。
        filter.sourceTypes = [.brew, .tasting]
        if let bean { filter.beanID = bean.id }

        let hits = (try? index.search(
            vector: vector,
            filter: filter,
            limit: IntelligenceConfig.similarHistoryLimit
        )) ?? []

        return InsightFormatter.similarHistory(hits: hits, query: trimmed, beans: beans)
    }

    // MARK: 能力状态（协议 §36）

    func capability(settings: RAGSettings, languageCode: String) async -> IntelligenceCapability {
        let resolution = await coordinator.resolution(settings: settings, languageCode: languageCode)
        return IntelligenceCapability(
            structuredQueryAvailable: true,
            semanticSearchAvailable: true,
            semanticBackend: resolution.provider.backend,
            semanticModelIdentifier: resolution.provider.modelIdentifier,
            knowledgeBaseAvailable: !KnowledgeBase.payload.documents.isEmpty,
            recommendationAvailable: true
        )
    }
}
