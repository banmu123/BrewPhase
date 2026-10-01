import Foundation

/// 从诊断推出「下一杯改哪一个」（规格 §十六/§十七）。
///
/// 这一个函数承担了整个功能最重要的一条纪律：**一次只改一个主要变量**。
/// 所以它返回的是单数的 `AdjustmentSuggestion`（一个旋钮 + 一个方向），而不是一串
/// 待办。用户下次变好时才能回答「是不是因为这个改动」——那是这套闭环能不能被
/// 验证的前提。
///
/// 第二条纪律是**不硬算数值**：方向 + 相对措辞（「细一档」「调高一点」）。
/// 唯一可以写出的精确数字，是用户自己的历史区间——那是真实数据，不是我们算出来的。
enum AdjustmentPlanner {

    static func suggestion(
        for finding: DiagnosticFinding,
        current: BrewObservation,
        baseline: PersonalBaseline,
        evidence: [String]
    ) -> AdjustmentSuggestion? {
        switch finding {
        case .suspectedUnderExtraction:
            return grind(.finer, current: current, baseline: baseline,
                         reason: L("时间偏短是萃取不足最常见的信号，磨细是最直接的补救。"),
                         expected: L("萃取更充分：甜感上来，酸质变柔和。"))
        case .fastFlow:
            return grind(.finer, current: current, baseline: baseline,
                         reason: L("先把流速拉回你自己的区间，再谈别的。"),
                         expected: L("水流慢一点，萃取更完整。"))
        case .suspectedOverExtraction:
            return grind(.coarser, current: current, baseline: baseline,
                         reason: L("时间偏长，又有苦或干涩，通常是磨得太细。"),
                         expected: L("少萃一点：苦和干涩会退下去。"))
        case .highBitterness:
            return grind(.coarser, current: current, baseline: baseline,
                         reason: L("苦味明显高于你自己的记录，先往粗的方向试。"),
                         expected: L("苦味变轻，甜感更容易露出来。"))
        case .slowFlow:
            return grind(.coarser, current: current, baseline: baseline,
                         reason: L("让水流快一点，回到你自己的区间。"),
                         expected: L("总时间缩短，风味更干净。"))
        case .lowSweetness:
            return temperature(.higher, current: current, baseline: baseline,
                               reason: L("时间不短但甜感没上来时，升温通常比磨细更有效。"),
                               expected: L("甜感和香气更容易出来。"))
        case .thinBody:
            return dose(.more, current: current, baseline: baseline,
                        reason: L("水量不变、多加一点粉，浓度和口感都会厚起来。"),
                        expected: L("口感更饱满，风味更集中。"))
        case .parameterDeviation:
            return deviation(current: current, baseline: baseline, evidence: evidence)
        }
    }

    // MARK: - 三种旋钮

    private static func grind(
        _ direction: AdjustmentDirection,
        current: BrewObservation,
        baseline: PersonalBaseline,
        reason: String,
        expected: String
    ) -> AdjustmentSuggestion {
        AdjustmentSuggestion(
            parameter: .grind,
            direction: direction,
            reason: reason,
            expectedEffect: expected,
            keep: keepLines(for: current, changing: .grind),
            observe: observeUnderOrOver(direction),
            referenceRange: timeRangeLine(baseline)
        )
    }

    private static func temperature(
        _ direction: AdjustmentDirection,
        current: BrewObservation,
        baseline: PersonalBaseline,
        reason: String,
        expected: String
    ) -> AdjustmentSuggestion {
        AdjustmentSuggestion(
            parameter: .temperature,
            direction: direction,
            reason: reason,
            expectedEffect: expected,
            keep: keepLines(for: current, changing: .temperature),
            observe: [L("甜感"), L("香气"), L("苦味")],
            referenceRange: rangeLine(.temperature, baseline)
        )
    }

    private static func dose(
        _ direction: AdjustmentDirection,
        current: BrewObservation,
        baseline: PersonalBaseline,
        reason: String,
        expected: String
    ) -> AdjustmentSuggestion {
        AdjustmentSuggestion(
            parameter: .dose,
            direction: direction,
            reason: reason,
            expectedEffect: expected,
            keep: keepLines(for: current, changing: .dose),
            observe: [L("醇感"), L("余韵"), L("总时间")],
            referenceRange: rangeLine(.dose, baseline)
        )
    }

    /// 参数偏离：朝个人区间调回去。
    ///
    /// 优先水温——它是这几个旋钮里唯一「动了立刻能感觉到」的。只有粉水比偏离时
    /// 返回 nil：那件事在操作上靠粉量调，硬给一个「粉水比旋钮」只会让用户困惑。
    private static func deviation(
        current: BrewObservation,
        baseline: PersonalBaseline,
        evidence: [String]
    ) -> AdjustmentSuggestion? {
        let reason = evidence.first ?? L("这一杯和你自己表现较好的记录差得比较远。")

        if let value = current.value(of: .temperature),
           let range = baseline.range(of: .temperature) {
            if value < range.lowerBound - BrewParameter.temperature.tolerance {
                return temperature(.higher, current: current, baseline: baseline,
                                   reason: reason, expected: L("回到你自己表现更好的温度区间。"))
            }
            if value > range.upperBound + BrewParameter.temperature.tolerance {
                return temperature(.lower, current: current, baseline: baseline,
                                   reason: reason, expected: L("回到你自己表现更好的温度区间。"))
            }
        }

        if let value = current.value(of: .dose),
           let range = baseline.range(of: .dose) {
            if value < range.lowerBound - BrewParameter.dose.tolerance {
                return dose(.more, current: current, baseline: baseline,
                            reason: reason, expected: L("回到你常用的粉量，浓度更接近你的记录。"))
            }
            if value > range.upperBound + BrewParameter.dose.tolerance {
                return dose(.less, current: current, baseline: baseline,
                            reason: reason, expected: L("回到你常用的粉量，浓度更接近你的记录。"))
            }
        }
        return nil
    }

    // MARK: - 保持不变 / 观察什么

    /// 要**保持不变**的是「你能拧的旋钮」，不含时间。
    ///
    /// 时间不是能设定的东西——它是结果。把它列进「保持不变」是外行话；它属于
    /// 「下一杯留意什么」。
    static func keepLines(for current: BrewObservation, changing parameter: AdjustmentParameter) -> [String] {
        var lines: [String] = []
        if parameter != .grind, !current.recipe.grindSize.trimmed.isEmpty {
            lines.append(L("研磨 %@", current.recipe.grindSize.trimmed))
        }
        if parameter != .temperature, current.recipe.waterTemp > 0 {
            lines.append(L("水温 %@", BrewParameter.temperature.formatted(current.recipe.waterTemp)))
        }
        if parameter != .dose, current.recipe.coffeeG > 0 {
            lines.append(L("粉量 %@", BrewParameter.dose.formatted(current.recipe.coffeeG)))
        }
        // 改粉量时粉水比会跟着变，所以只说水量（那个是不动的输入）。
        if current.recipe.waterG > 0 {
            lines.append(L("水量 %@", Fmt.gramsShort(current.recipe.waterG)))
        }
        if !current.recipe.method.trimmed.isEmpty {
            lines.append(L("器具 %@", current.recipe.method.trimmed))
        }
        return lines
    }

    private static func observeUnderOrOver(_ direction: AdjustmentDirection) -> [String] {
        switch direction {
        case .finer: return [L("总时间"), L("甜感"), L("酸质"), L("醇感")]
        case .coarser: return [L("余韵"), L("苦味"), L("干涩")]
        default: return [L("总时间"), L("甜感")]
        }
    }

    /// 「你的较好记录集中在 2:25–2:40」——真实数据，写出来是帮手不是障碍。
    private static func timeRangeLine(_ baseline: PersonalBaseline) -> String? {
        guard let range = baseline.range(of: .time) else { return nil }
        return L("你的较好记录集中在 %@–%@",
                 BrewMath.formatTime(Int(range.lowerBound.rounded())),
                 BrewMath.formatTime(Int(range.upperBound.rounded())))
    }

    private static func rangeLine(_ parameter: BrewParameter, _ baseline: PersonalBaseline) -> String? {
        guard let range = baseline.range(of: parameter) else { return nil }
        return L("你较好的记录在 %@–%@",
                 parameter.formatted(range.lowerBound), parameter.formatted(range.upperBound))
    }
}
