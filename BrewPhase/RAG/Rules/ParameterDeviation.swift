import Foundation

/// 参与偏离比较的参数。
enum BrewParameter: String, CaseIterable, Sendable {
    case temperature
    case time
    case ratio
    case dose

    var label: String {
        switch self {
        case .temperature: return L("水温")
        case .time: return L("萃取时间")
        case .ratio: return L("粉水比")
        case .dose: return L("粉量")
        }
    }

    /// 当前值/常用值的展示格式。
    func formatted(_ value: Double) -> String {
        switch self {
        case .temperature: return "\(Fmt.number(value))°C"
        case .time: return BrewMath.formatTime(Int(value.rounded()))
        case .ratio: return "1:\(Fmt.number(value))"
        case .dose: return Fmt.gramsShort(value)
        }
    }

    /// 偏差量的展示格式（带符号语义，由调用方决定「高/低」的措辞）。
    func formattedDelta(_ value: Double) -> String {
        switch self {
        case .temperature: return "\(Fmt.number(value))°C"
        case .time: return L("%@ 秒", String(Int(value.rounded())))
        case .ratio: return Fmt.number(value)
        case .dose: return Fmt.gramsShort(value)
        }
    }

    var tolerance: Double {
        switch self {
        case .temperature: return IntelligenceConfig.temperatureTolerance
        case .time: return IntelligenceConfig.timeTolerance
        case .ratio: return IntelligenceConfig.ratioTolerance
        case .dose: return IntelligenceConfig.doseTolerance
        }
    }
}

/// 一项参数的偏离。
struct DeviationField: Sendable {
    let parameter: BrewParameter
    let current: Double
    /// 高评分记录的平均值——「你自己的常用值」。
    let typical: Double
    let delta: Double

    /// 是否超出容差。容差是**展示**判据（见 `IntelligenceConfig`），不是咖啡标准。
    var isOutside: Bool { abs(delta) > parameter.tolerance }
    var directionIsHigher: Bool { delta > 0 }
}

/// Rule 3（协议 §20）：这次冲煮 vs 个人高评分记录。
///
/// 输出刻意**不说「错了」**：它比较的对象是用户自己的历史，不是任何外部标准，
/// 所以措辞永远是「和你常用的不一样」，判断留给他自己。
@MainActor
enum ParameterDeviationAnalyzer {

    struct Analysis {
        enum Verdict: Equatable, Sendable {
            case withinPersonalRange
            case outsidePersonalRange
            case insufficientEvidence
        }

        enum Shortcoming: Equatable, Sendable {
            /// 一条冲煮记录都没有。
            case noBrews
            /// 高评分记录不够 `minimumSamplesForComparison` 条。
            case notEnoughSamples
        }

        let verdict: Verdict
        let fields: [DeviationField]
        let shortcoming: Shortcoming?
        let personalBest: PersonalBestAnalyzer.Analysis?

        var outsideFields: [DeviationField] { fields.filter(\.isOutside) }
    }

    static func analyze(current: Brew?, history: [Brew]) -> Analysis {
        guard let current else {
            return Analysis(verdict: .insufficientEvidence, fields: [],
                            shortcoming: .noBrews, personalBest: nil)
        }

        let best = PersonalBestAnalyzer.analyze(brews: history)
        guard best.hasEnoughData else {
            return Analysis(verdict: .insufficientEvidence, fields: [],
                            shortcoming: .notEnoughSamples, personalBest: best)
        }

        var fields: [DeviationField] = []

        // 只比较两边都真有的字段：这次没填水温，就不硬比。
        if current.waterTemp > 0, let stats = best.temperature {
            fields.append(field(.temperature, current: current.waterTemp, typical: stats.average))
        }
        if current.timeSeconds > 0, let stats = best.timeSeconds {
            fields.append(field(.time, current: Double(current.timeSeconds), typical: stats.average))
        }
        if current.coffeeG > 0, current.waterG > 0, let stats = best.ratio {
            fields.append(field(.ratio, current: current.ratio, typical: stats.average))
        }
        if current.coffeeG > 0, let stats = best.dose {
            fields.append(field(.dose, current: current.coffeeG, typical: stats.average))
        }

        let outside = fields.contains(where: \.isOutside)
        return Analysis(
            verdict: outside ? .outsidePersonalRange : .withinPersonalRange,
            fields: fields,
            shortcoming: nil,
            personalBest: best
        )
    }

    private static func field(_ parameter: BrewParameter, current: Double, typical: Double) -> DeviationField {
        DeviationField(parameter: parameter, current: current, typical: typical, delta: current - typical)
    }
}
