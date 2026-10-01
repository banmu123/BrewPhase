import Foundation

/// 两次冲煮之间改了什么（规格 §七）。
///
/// 为什么这一层值得单独存在：用户改了一个参数，两天后就记不住改的是哪个、改了多少。
/// 差异应该是**算出来的**，不该靠用户回忆——而这正是「下一杯建议」能不能被验证的前提：
/// 不知道这次改了什么，就永远说不清下次变好是不是因为它。
///
/// 数值参数（水温/时间/粉水比/粉量）与自由文本参数（器具/磨豆机/研磨度）分开处理：
/// 前者能算差值、能用既有的 `BrewParameter` 格式化；后者只能展示「从什么改成什么」，
/// 硬算会编出用户没写过的数字。
struct BrewDelta: Equatable, Sendable {

    /// 差异发生在哪个字段。
    enum Field: Equatable, Sendable {
        /// 可比较的数值参数。复用既有词汇，免得这里长出一套平行的「参数名」。
        case parameter(BrewParameter)
        /// 自由文本字段。
        case method
        case grinder
        case grindSize

        var label: String {
            switch self {
            case .parameter(let parameter): return parameter.label
            case .method: return L("器具")
            case .grinder: return L("磨豆机")
            case .grindSize: return L("研磨度")
            }
        }

        /// 数值字段在「一次只改一个变量」的排序里优先（用户更容易控制它们）。
        var numeric: Bool {
            if case .parameter = self { return true }
            return false
        }
    }

    struct Change: Equatable, Sendable, Identifiable {
        let field: Field
        /// 上一次的值（已格式化，直接可显示）。
        let from: String
        /// 这一次的值。
        let to: String
        /// 数值变化量。自由文本字段为 nil。
        let delta: Double?

        var id: String { "\(field)" }
        var label: String { field.label }

        /// 「高 1°C」「快 22 秒」这类一句话说明；没有数值变化时为 nil。
        var phrase: String? {
            guard let delta, abs(delta) > 0.0001 else { return nil }
            guard case .parameter(let parameter) = field else { return nil }
            let magnitude = parameter.formattedDelta(abs(delta))
            return delta > 0
                ? L("%@ %@", parameter.risingLabel, magnitude)
                : L("%@ %@", parameter.fallingLabel, magnitude)
        }
    }

    /// 发生变化的字段，按「数值在前、自由文本在后」排列。
    let changes: [Change]

    static let none = BrewDelta(changes: [])

    var isEmpty: Bool { changes.isEmpty }
    var hasChanges: Bool { !changes.isEmpty }

    var numericChanges: [Change] { changes.filter { $0.field.numeric } }

    /// 只改了**一个**数值参数时返回它——这是「一次只改一个变量」最干净的情况。
    var singleNumericChange: Change? {
        let numeric = numericChanges
        return numeric.count == 1 ? numeric[0] : nil
    }

    /// 这一次与上一次的差异。
    ///
    /// 只比较**两边都有值**的字段：上一次没填水温，就不该报「水温从空变成 92」——
    /// 那不是用户改的，是他第一次填。
    static func between(previous: BrewRecipe, current: BrewRecipe) -> BrewDelta {
        var changes: [Change] = []

        func numeric(_ parameter: BrewParameter, _ from: Double, _ to: Double) {
            guard from > 0, to > 0, from != to else { return }
            changes.append(Change(
                field: .parameter(parameter),
                from: parameter.formatted(from),
                to: parameter.formatted(to),
                delta: to - from
            ))
        }

        numeric(.temperature, previous.waterTemp, current.waterTemp)
        numeric(.time, Double(previous.timeSeconds), Double(current.timeSeconds))
        numeric(.ratio, previous.ratioValue, current.ratioValue)
        numeric(.dose, previous.coffeeG, current.coffeeG)

        func text(_ field: Field, _ from: String, _ to: String) {
            let cleanFrom = from.trimmed
            let cleanTo = to.trimmed
            guard !cleanFrom.isEmpty, !cleanTo.isEmpty, cleanFrom != cleanTo else { return }
            changes.append(Change(field: field, from: cleanFrom, to: cleanTo, delta: nil))
        }

        text(.method, previous.method, current.method)
        text(.grinder, previous.grinder, current.grinder)
        text(.grindSize, previous.grindSize, current.grindSize)

        return BrewDelta(changes: changes)
    }
}

extension BrewParameter {
    /// 数值变大时的措辞。措辞跟着物理意义走，而不是「+/−」：
    /// 水多粉少是「变淡」，粉多水少是「变浓」——这正是用户在杯子里感受到的东西。
    var risingLabel: String {
        switch self {
        case .temperature: return L("升温")
        case .time: return L("延长")
        case .ratio: return L("变淡")
        case .dose: return L("加粉")
        }
    }

    var fallingLabel: String {
        switch self {
        case .temperature: return L("降温")
        case .time: return L("缩短")
        case .ratio: return L("变浓")
        case .dose: return L("减粉")
        }
    }
}
