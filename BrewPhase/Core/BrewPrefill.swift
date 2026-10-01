import Foundation

/// 这一杯的预填从哪来（规格 §六）。
///
/// 三个来源的优先级是刻意的：**同一包豆上一次 → 任何豆子的上一次 → 用户设的默认值**。
/// 中间那一档不是凑数的：换了一包新豆，冲法（器具、粉量、水温）通常还是沿用你
/// 习惯的那套，让人从零重填是没必要的劳动。
struct BrewPrefill: Equatable, Sendable {

    enum Source: Equatable, Sendable {
        /// 这包豆子上一次（可能还是同一个冲法）。
        case lastBrewOfSameBean
        /// 别的豆子的上一次——换豆时沿用习惯的那套参数。
        case lastBrewAnyBean
        /// 用户自己在设置里定的默认值。
        case userDefaults

        var isFromHistory: Bool { self != .userDefaults }
    }

    /// 预填依据的那一杯。没有历史时为空。
    struct Basis: Equatable, Sendable {
        let id: UUID
        let date: Date
        /// 那一杯的参数摘要（`BrewRecipe.summaryParts` 拼好的）。
        let summary: String
        /// 那一杯的评分（0 = 没打分）。
        let score: Int
        /// 是不是同一包豆。
        let sameBean: Bool
    }

    let source: Source
    let recipe: BrewRecipe
    /// 时间以文本形式预填（编辑器里那个字段就是文本）。
    let timeText: String
    let basis: Basis?

    /// 依据哪一天、哪一杯。界面用它写「沿用 9月28日 那杯」。
    var hasHistory: Bool { basis != nil }

    /// 没有任何历史、只能用默认值。
    var isBareDefault: Bool { source == .userDefaults }
}

/// 把「最近一次相关冲煮」翻译成这次要填的表（规格 §六）。
///
/// 纯函数：只吃值类型（`[Brew]` 是调用方传进来的既有记录，`BrewRecipe` 是值类型），
/// 不查库、不写库，所以「预填对不对」可以直接用几条记录测。
enum BrewPrefillBuilder {

    /// 预填。
    ///
    /// - Parameters:
    ///   - beanBrews: 这包豆子的记录（新到旧）。
    ///   - allBrews: 全部记录（新到旧），只在换豆时兜底。
    ///   - method: 用户已经选定的冲法。给了它就先找「同一包豆 + 同一冲法」的那一杯——
    ///     「用同一包豆但换了个器具」时，把别的器具的参数顶上去是错的。
    ///   - defaults: 用户设置的默认值，最后一档兜底。
    static func prefill(
        beanBrews: [Brew],
        allBrews: [Brew],
        method: String? = nil,
        defaults: BrewDefaults = .current()
    ) -> BrewPrefill {

        let wanted = method?.trimmed ?? ""

        func matches(_ brew: Brew) -> Bool {
            guard !wanted.isEmpty else { return true }
            return brew.method.trimmed.caseInsensitiveCompare(wanted) == .orderedSame
        }

        if let basis = beanBrews.first(where: matches) {
            return from(basis, source: .lastBrewOfSameBean, method: wanted, sameBean: true)
        }
        if let basis = allBrews.first(where: matches) {
            return from(basis, source: .lastBrewAnyBean, method: wanted, sameBean: false)
        }
        // 同一包豆有记录、但都不是这个冲法：退到「同一包豆最近一次」，
        // 借它的粉量与水温，冲法保持用户刚选的那个。
        if let basis = beanBrews.first {
            return from(basis, source: .lastBrewOfSameBean, method: wanted, sameBean: true)
        }
        if let basis = allBrews.first {
            return from(basis, source: .lastBrewAnyBean, method: wanted, sameBean: false)
        }

        var recipe = defaults.asRecipe
        recipe.method = wanted.isEmpty ? recipe.method : wanted
        return BrewPrefill(source: .userDefaults, recipe: recipe, timeText: "", basis: nil)
    }

    private static func from(
        _ brew: Brew,
        source: BrewPrefill.Source,
        method: String,
        sameBean: Bool
    ) -> BrewPrefill {
        var recipe = brew.recipe
        // 用户已经选定的冲法优先：预填只补参数，不改他刚做的选择。
        if !method.isEmpty { recipe.method = method }
        return BrewPrefill(
            source: source,
            recipe: recipe,
            timeText: brew.timeText,
            basis: BrewPrefill.Basis(
                id: brew.id,
                date: brew.date,
                summary: brew.recipe.summaryParts.joined(separator: " · "),
                score: brew.score,
                sameBean: sameBean
            )
        )
    }
}
