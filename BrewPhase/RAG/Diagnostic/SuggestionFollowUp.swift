import Foundation

/// 「上一杯的建议，这一杯照做了吗？有没有变好？」——只观察，不下因果。
///
/// 为什么它只能是观察性的：一杯咖啡的味道由六七个变量拉着走，把「变好」归因到
/// 单独某一个调整上是编造。所以这里只陈述三件可核实的事——上次建议是什么、
/// 这次相对上次变了什么、变化的方向与建议是否一致——判断留给用户。措辞只允许
/// 「与上次相比」「变化与建议方向一致」这类比较级，永远不出现「证明」「已验证」。
struct SuggestionFollowUp: Equatable {

    /// 上一杯给出的那条建议（「研磨度：细一档」）。上一杯没有给出建议时为 nil。
    let suggestionHeadline: String?

    /// 这次相对上一杯的变化，一行一条（「酸度 5 → 3」）。只列真的变了的。
    let changes: [Change]

    /// 建议点名的参数这次有没有朝建议的方向动。研磨度是自由文本比不了方向，为 nil。
    let followedDirection: Bool?

    /// 评分差（这次 − 上次）。两杯都有评分时才有值。
    let scoreDelta: Int?

    struct Change: Equatable, Identifiable {
        let label: String
        let from: String
        let to: String
        var id: String { label }
    }

    var hasChanges: Bool { !changes.isEmpty }

    /// 「这次：2:08 → 2:31 · 酸度 5 → 3」。没有变化时为 nil。
    var changesText: String? {
        guard hasChanges else { return nil }
        return changes
            .map { "\($0.label) \($0.from) → \($0.to)" }
            .joined(separator: " · ")
    }

    /// 「调整方向与上次建议一致。」/「这次没有朝建议的方向调整。」
    var directionText: String? {
        switch followedDirection {
        case .some(true): return L("调整方向与上次建议一致。")
        case .some(false): return L("这次没有朝建议的方向调整。")
        case .none: return nil
        }
    }

    /// 「这次评分比上一杯高。」/「这次评分比上一杯低。」打平或没打分时为 nil。
    var scoreText: String? {
        guard let scoreDelta, scoreDelta != 0 else { return nil }
        return scoreDelta > 0 ? L("这次评分比上一杯高。") : L("这次评分比上一杯低。")
    }

    // MARK: - 构建

    /// 比较「上一杯 → 这一杯」。`suggestion` 是上一杯当时得到的建议（没有就传 nil，
    /// 此时仍然给出变化对比——「与上次相比」不需要建议也成立）。
    static func between(
        previous: Brew,
        suggestion: AdjustmentSuggestion?,
        current: Brew
    ) -> SuggestionFollowUp {
        var changes: [Change] = []

        if previous.timeSeconds > 0, current.timeSeconds > 0,
           previous.timeSeconds != current.timeSeconds {
            changes.append(Change(
                label: L("时间"),
                from: BrewMath.formatTime(previous.timeSeconds),
                to: BrewMath.formatTime(current.timeSeconds)
            ))
        }

        // 建议点名的数值参数优先列出：用户最关心的就是「我调的那个东西」。
        if let suggestion {
            changes.append(contentsOf: parameterChanges(for: suggestion, previous: previous, current: current))
        }

        for (label, oldValue, newValue) in [
            (L("酸度"), previous.acidity, current.acidity),
            (L("甜度"), previous.sweetness, current.sweetness),
            (L("苦度"), previous.bitterness, current.bitterness),
            (L("醇厚"), previous.body, current.body),
            (L("余韵"), previous.aftertaste, current.aftertaste),
        ] where oldValue != newValue {
            changes.append(Change(label: label, from: String(oldValue), to: String(newValue)))
        }

        if changes.count > 6 {
            changes = Array(changes.prefix(6))
        }

        return SuggestionFollowUp(
            suggestionHeadline: suggestion?.headline,
            changes: changes,
            followedDirection: directionFollowed(suggestion: suggestion, previous: previous, current: current),
            scoreDelta: previous.score > 0 && current.score > 0 ? current.score - previous.score : nil
        )
    }

    /// 建议点名的那个参数这次变了多少。没点名、没填过或没变，就不列。
    private static func parameterChanges(
        for suggestion: AdjustmentSuggestion,
        previous: Brew,
        current: Brew
    ) -> [Change] {
        switch suggestion.parameter {
        case .grind:
            // 自由文本（「22 格」「中细」），只在两杯都填了且确实改了的时候列出来。
            guard !previous.grindSize.trimmed.isEmpty, !current.grindSize.trimmed.isEmpty,
                  previous.grindSize.trimmed != current.grindSize.trimmed else { return [] }
            return [Change(label: L("研磨度"), from: previous.grindSize.trimmed, to: current.grindSize.trimmed)]
        case .temperature:
            guard previous.waterTemp > 0, current.waterTemp > 0,
                  previous.waterTemp != current.waterTemp else { return [] }
            return [Change(label: L("水温"),
                           from: "\(Int(previous.waterTemp.rounded()))°C",
                           to: "\(Int(current.waterTemp.rounded()))°C")]
        case .dose:
            guard previous.coffeeG > 0, current.coffeeG > 0,
                  previous.coffeeG != current.coffeeG else { return [] }
            return [Change(label: L("粉量"),
                           from: Fmt.gramsShort(previous.coffeeG),
                           to: Fmt.gramsShort(current.coffeeG))]
        case .time:
            return []   // 时间已经在最前面列过了，不重复。
        }
    }

    /// 建议的参数有没有朝建议的方向动。只对能比方向的数值参数下结论；
    /// 没动过是 nil（「没动」不是「反着调」）。
    private static func directionFollowed(
        suggestion: AdjustmentSuggestion?,
        previous: Brew,
        current: Brew
    ) -> Bool? {
        guard let suggestion else { return nil }
        switch suggestion.parameter {
        case .grind:
            return nil
        case .temperature:
            let delta = current.waterTemp - previous.waterTemp
            guard abs(delta) >= 0.5 else { return nil }
            return (delta > 0) == (suggestion.direction == .higher)
        case .dose:
            let delta = current.coffeeG - previous.coffeeG
            guard abs(delta) >= 0.05 else { return nil }
            return (delta > 0) == (suggestion.direction == .more)
        case .time:
            let delta = current.timeSeconds - previous.timeSeconds
            guard delta != 0 else { return nil }
            return (delta > 0) == (suggestion.direction == .longer)
        }
    }
}
