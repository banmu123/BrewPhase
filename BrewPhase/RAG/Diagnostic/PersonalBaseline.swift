import Foundation

/// 五条味觉轴在**用户自己高评分记录**里的分布。
///
/// 存在的理由是把「甜感偏低」说成「比你自己觉得好喝的那几杯更低」，而不是拿一个
/// 外部标准去卡（规格 §十三）。没人喝的杯子里的「甜度 2」和你的 2 不是一回事。
struct AxisStats: Equatable, Sendable {
    let acidity: FieldStats?
    let sweetness: FieldStats?
    let bitterness: FieldStats?
    let body: FieldStats?
    let aftertaste: FieldStats?

    static let empty = AxisStats(acidity: nil, sweetness: nil, bitterness: nil,
                                body: nil, aftertaste: nil)

    func stats(of axis: TasteAxis) -> FieldStats? {
        switch axis {
        case .acidity: return acidity
        case .sweetness: return sweetness
        case .bitterness: return bitterness
        case .body: return body
        case .aftertaste: return aftertaste
        }
    }

    var isEmpty: Bool {
        [acidity, sweetness, bitterness, body, aftertaste].allSatisfy { $0 == nil }
    }
}

/// 个人基线（规格 §十三/§十四/§十五）。
///
/// 它是「你自己过去较好的一次长什么样」——只统计**你打过高分**的记录，因为
/// 基准该来自你自己满意的那些杯子，低分记录掺进来只会把常用值往坏的方向拉。
///
/// 三层回退的顺序是刻意的：越具体越好。
/// 同一包豆 + 同一冲法 → 同一包豆 → 同一冲法。任何一层达到最小样本就停在那里，
/// 并在报告里如实说明取的是哪一层；一层都不够时**不编**基线，只报还差几条。
struct PersonalBaseline: Equatable, Sendable {

    enum Scope: Equatable, Sendable {
        /// 同一包豆 + 同一冲法。
        case beanAndMethod(String)
        /// 同一包豆（不分冲法）。
        case bean
        /// 同一冲法（不分豆）。
        case method(String)
        /// 还没有任何可用的历史。
        case none

        var label: String {
            switch self {
            case .beanAndMethod(let method): return L("这包豆 + %@", method)
            case .bean: return L("这包豆")
            case .method(let method): return L("%@ 的做法", method)
            case .none: return L("你的记录")
            }
        }

        /// 是不是「针对这包豆」的基线——界面据此决定措辞的力度。
        var isBeanSpecific: Bool {
            switch self {
            case .beanAndMethod, .bean: return true
            case .method, .none: return false
            }
        }
    }

    let scope: Scope
    /// 打过分的记录数（含低分）。
    let scoredCount: Int
    /// 高评分记录数。
    let highRatedCount: Int
    /// 建立基线需要几条高评分记录。
    let requiredHighRated: Int

    let averageScore: Double?
    let bestScore: Int
    let bestDate: Date?
    let bestRecipe: BrewRecipe?

    let temperature: FieldStats?
    let timeSeconds: FieldStats?
    let ratio: FieldStats?
    let dose: FieldStats?
    let axes: AxisStats

    static let none = PersonalBaseline(
        scope: .none, scoredCount: 0, highRatedCount: 0,
        requiredHighRated: IntelligenceConfig.minimumSamplesForComparison,
        averageScore: nil, bestScore: 0, bestDate: nil, bestRecipe: nil,
        temperature: nil, timeSeconds: nil, ratio: nil, dose: nil, axes: .empty
    )

    /// 能不能拿它下结论（规格 §十五：小样本不许产生伪基线）。
    var isUsable: Bool { highRatedCount >= requiredHighRated }

    /// 还差几条。
    var shortfall: Int { max(0, requiredHighRated - highRatedCount) }

    /// 这份基线能支撑多强的结论（规格 §十五：小样本不许说死）。
    ///
    /// 样本量直接封住置信度上限，与证据本身有多齐无关——三条证据指向同一个方向，
    /// 但只有一次参考记录时，那仍然是「方向性的」，不是「确定的」。
    /// 三个档位与 `minimumSamplesForComparison` 对齐，不需要记住第二个数。
    var confidenceCeiling: Insight.Confidence {
        if highRatedCount >= IntelligenceConfig.minimumSamplesForComparison { return .high }
        if highRatedCount >= 2 { return .medium }
        return .low
    }

    func stats(of parameter: BrewParameter) -> FieldStats? {
        switch parameter {
        case .temperature: return temperature
        case .time: return timeSeconds
        case .ratio: return ratio
        case .dose: return dose
        }
    }

    /// 这个参数在你高评分记录里的区间。诊断的「偏离」判据就是它。
    func range(of parameter: BrewParameter) -> ClosedRange<Double>? {
        stats(of: parameter)?.range
    }

    /// 这个参数在你高评分记录里的常用值。
    func typical(of parameter: BrewParameter) -> Double? {
        stats(of: parameter)?.average
    }

    /// 基线可用时的一句话交代：依据是什么、几条。
    var basisNote: String {
        L("依据：%@ 的 %@ 次高评分记录。", scope.label, String(highRatedCount))
    }

    /// 数据不足时给用户看的话（规格 §十五/§二十六）。
    ///
    /// 两个「不」：不说「这是你的最佳参数」（样本不够时那是编的），也不说
    /// 「正在学习你的口味」这种像云端模型的暗示——这里做的是本地统计。
    var shortfallMessage: String {
        L("目前「%@」有 %@ 次带评分的记录，还差 %@ 次才能形成稳定的个人基线。",
          scope.label, String(scoredCount), String(shortfall))
    }

    /// 记录还不够时的建议（规格 §二十六）。
    ///
    /// 计算属性而不是 `let`：`let` 会在第一次取值时把当时那种语言的文案冻住，
    /// 用户切换语言之后它还写着旧语言（`FlavorLibrary` 里记着同一个坑）。
    static var keepRecordingAdvice: String {
        L("继续记几杯，BrewPhase 会用你自己的数据给出建议。")
    }
}

/// 从记录里算出个人基线（规格 §十四）。
///
/// 纯函数：吃值类型，不碰数据库。三层回退的顺序写在代码里，因为顺序本身就是规则。
enum PersonalBaselineBuilder {

    static func baseline(
        method: String,
        beanHistory: [BrewObservation],
        allHistory: [BrewObservation],
        requiredHighRated: Int = IntelligenceConfig.minimumSamplesForComparison
    ) -> PersonalBaseline {
        let wanted = method.trimmed.lowercased()
        func sameMethod(_ observation: BrewObservation) -> Bool {
            guard !wanted.isEmpty else { return true }
            return observation.method.trimmed.lowercased() == wanted
        }

        let layers: [(PersonalBaseline.Scope, [BrewObservation])] = [
            (.beanAndMethod(method.trimmed), beanHistory.filter(sameMethod)),
            (.bean, beanHistory),
            (.method(method.trimmed), allHistory.filter(sameMethod)),
        ]

        for (scope, pool) in layers {
            let highRated = pool.filter(\.isHighRated).count
            if highRated >= requiredHighRated {
                return make(scope: scope, pool: pool, required: requiredHighRated)
            }
        }

        // 一层都不够：取信息最贴题的一层，如实报告差多少。
        let fallbackPool = beanHistory.isEmpty ? allHistory.filter(sameMethod) : beanHistory
        let fallbackScope: PersonalBaseline.Scope = beanHistory.isEmpty
            ? (wanted.isEmpty ? .none : .method(method.trimmed))
            : .bean
        return make(scope: fallbackScope, pool: fallbackPool, required: requiredHighRated)
    }

    private static func make(
        scope: PersonalBaseline.Scope,
        pool: [BrewObservation],
        required: Int
    ) -> PersonalBaseline {
        let scored = pool.filter(\.hasScore)
        let highRated = pool
            .filter(\.isHighRated)
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.date > rhs.date
            }
        let best = highRated.first

        func stats(_ values: [Double]) -> FieldStats? {
            let usable = values.filter { $0 > 0 }
            guard !usable.isEmpty else { return nil }
            return FieldStats(
                average: usable.reduce(0, +) / Double(usable.count),
                minimum: usable.min() ?? 0,
                maximum: usable.max() ?? 0,
                count: usable.count
            )
        }

        func axisStats(_ axis: TasteAxis) -> FieldStats? {
            stats(highRated.map { Double($0.axis(axis)) })
        }

        return PersonalBaseline(
            scope: scope,
            scoredCount: scored.count,
            highRatedCount: highRated.count,
            requiredHighRated: required,
            averageScore: scored.isEmpty
                ? nil
                : Double(scored.map(\.score).reduce(0, +)) / Double(scored.count),
            bestScore: best?.score ?? 0,
            bestDate: best?.date,
            bestRecipe: best?.recipe,
            temperature: stats(highRated.map(\.recipe.waterTemp)),
            timeSeconds: stats(highRated.map { Double($0.timeSeconds) }),
            ratio: stats(highRated.map(\.recipe.ratioValue)),
            dose: stats(highRated.map(\.recipe.coffeeG)),
            axes: AxisStats(
                acidity: axisStats(.acidity),
                sweetness: axisStats(.sweetness),
                bitterness: axisStats(.bitterness),
                body: axisStats(.body),
                aftertaste: axisStats(.aftertaste)
            )
        )
    }
}
