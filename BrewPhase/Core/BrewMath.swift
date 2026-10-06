import Foundation

/// A brew's recipe, detached from any record.
///
/// This is what "复制上次冲煮" copies: seven values, no judgement, no date.
struct BrewRecipe: Equatable, Sendable {
    var method: String
    var grinder: String
    var grindSize: String
    var waterTemp: Double
    var coffeeG: Double
    var waterG: Double
    var timeSeconds: Int

    static let empty = BrewRecipe(
        method: "", grinder: "", grindSize: "",
        waterTemp: 0, coffeeG: 0, waterG: 0, timeSeconds: 0
    )

    var ratioText: String { Fmt.ratio(coffeeG: coffeeG, waterG: waterG) }
    var timeText: String { BrewMath.formatTime(timeSeconds) }

    /// Whether anything at all was filled in.
    var isEmpty: Bool {
        method.trimmed.isEmpty && grinder.trimmed.isEmpty && grindSize.trimmed.isEmpty
            && waterTemp <= 0 && coffeeG <= 0 && waterG <= 0 && timeSeconds <= 0
    }

    /// The values worth showing next to a "copy last brew" button.
    var summaryParts: [String] {
        var parts: [String] = []
        if !method.trimmed.isEmpty { parts.append(method) }
        if coffeeG > 0 || waterG > 0 { parts.append(Fmt.doseLine(coffeeG: coffeeG, waterG: waterG)) }
        if waterTemp > 0 { parts.append("\(Int(waterTemp.rounded()))°C") }
        if timeSeconds > 0 { parts.append(timeText) }
        return parts
    }

    /// 粉水比的数值形式（1:16.7 → 16.7）。两边都有值时才成立，否则是 0。
    ///
    /// 与 `Brew.ratio` 同一套算法：一个数字，不是字符串——差异比较与个人区间
    /// 都要拿它算。
    var ratioValue: Double {
        BrewMath.ratioValue(coffeeG: coffeeG, waterG: waterG)
    }
}

/// All the arithmetic a brew needs. Pure, so the ratio, the time parsing and the
/// stock deduction can be tested without a database or a screen.
enum BrewMath {

    // MARK: - Ratio

    static func ratioValue(coffeeG: Double, waterG: Double) -> Double {
        guard coffeeG > 0, waterG > 0 else { return 0 }
        return waterG / coffeeG
    }

    /// Water needed for a given dose and 1:x ratio.
    static func water(coffeeG: Double, ratio: Double) -> Double {
        guard coffeeG > 0, ratio > 0 else { return 0 }
        return (coffeeG * ratio).rounded()
    }

    /// Dose for a given water and 1:x ratio.
    static func coffee(waterG: Double, ratio: Double) -> Double {
        guard waterG > 0, ratio > 0 else { return 0 }
        return ((waterG / ratio) * 10).rounded() / 10
    }

    // MARK: - Time

    /// `155` → `2:35`. Anything under a minute renders as `0:45`.
    static func formatTime(_ seconds: Int) -> String {
        guard seconds > 0 else { return "" }
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%d:%02d", m, s)
    }

    /// Accepts `2:35`, `2.35`, `155`, `1:05`. Returns seconds, or nil if the text
    /// cannot be read as a time. Deliberately forgiving: this is a diary, not a
    /// laboratory log.
    ///
    /// 全角数字/冒号/句点一并收下（`２：３５`、`2．35`）——中文键盘上这些是常态，
    /// 读者没有理由为键盘的宽度付账。
    static func parseTime(_ text: String) -> Int? {
        // ICU 的 Fullwidth-Halfwidth 变换：`２：３５` → `2:35`、`２．５` → `2.5`。
        let narrow = text.applyingTransform(StringTransform("Fullwidth-Halfwidth"), reverse: false) ?? text
        let trimmed = narrow.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.contains(":") || trimmed.contains("：") {
            let normalized = trimmed.replacingOccurrences(of: "：", with: ":")
            let parts = normalized.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let m = Int(parts[0].trimmingCharacters(in: .whitespaces)),
                  let s = Int(parts[1].trimmingCharacters(in: .whitespaces)),
                  m >= 0, s >= 0, s < 60 else { return nil }
            return m * 60 + s
        }

        if let plain = Int(trimmed) {
            return plain >= 0 ? plain : nil
        }

        // `2.35` read as minutes.seconds — how people type it when in a hurry.
        if let value = Double(trimmed) {
            let minutes = Int(value)
            let seconds = Int(((value - Double(minutes)) * 100).rounded())
            guard seconds < 60 else { return nil }
            return minutes * 60 + seconds
        }

        return nil
    }

    // MARK: - Stock

    /// Remaining grams after a brew, clamped into [0, total] (§32).
    static func remainingAfter(current: Double, dose: Double, total: Double) -> Double {
        let next = current - dose
        return min(max(next, 0), max(total, 0))
    }

    // MARK: - Score

    static func clampScore(_ value: Int) -> Int { min(max(value, 0), 5) }

    // MARK: - Validation

    /// Validation messages are written the way a person would say them out loud.
    /// There is no such thing as "invalid input" in this app.
    static func validate(_ recipe: BrewRecipe) -> BrewValidation {
        var validation = BrewValidation()

        if recipe.coffeeG <= 0 {
            validation.blocking.append(L("先填粉量吧，这样才能从库存里扣掉"))
        }
        if recipe.coffeeG > 0, recipe.waterG <= 0 {
            validation.hints.append(L("水量还没填，粉水比会留空"))
        }
        if recipe.waterTemp <= 0 {
            validation.hints.append(L("水温还没填"))
        }
        if recipe.timeSeconds <= 0 {
            validation.hints.append(L("冲煮时间还没填"))
        }
        return validation
    }

    /// Validation for the bean editor. Returns the (possibly corrected) values
    /// alongside the messages, because some "errors" are better fixed for the
    /// user than handed back to them.
    static func validateBean(
        name: String,
        roastDate: Date?,
        weightG: Double,
        remainingG: Double
    ) -> BeanValidation {
        var validation = BeanValidation()
        validation.weightG = weightG
        validation.remainingG = remainingG

        if name.trimmed.isEmpty {
            validation.blocking.append(L("给它起个名字吧"))
        }
        if roastDate == nil {
            validation.blocking.append(L("烘焙日期还没选，风味阶段要靠它来算"))
        }
        if weightG <= 0 {
            validation.blocking.append(L("总克数要大于 0"))
        }
        if remainingG < 0 {
            validation.blocking.append(L("剩余克数不能是负数"))
            validation.remainingG = 0
        }
        if weightG > 0, remainingG > weightG {
            // Real bags are sometimes heavier than advertised. Rather than
            // refusing the number, trust it and widen the bag.
            validation.hints.append(L("剩余量比总克数还多，已把总克数调到 %@", Fmt.grams(remainingG)))
            validation.weightG = remainingG
        }
        return validation
    }
}

struct BrewValidation: Equatable, Sendable {
    var blocking: [String] = []
    var hints: [String] = []

    var canSave: Bool { blocking.isEmpty }
    var isEmpty: Bool { blocking.isEmpty && hints.isEmpty }
}

struct BeanValidation: Equatable, Sendable {
    var blocking: [String] = []
    var hints: [String] = []
    var weightG: Double = 0
    var remainingG: Double = 0

    var canSave: Bool { blocking.isEmpty }
    var isEmpty: Bool { blocking.isEmpty && hints.isEmpty }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    /// 去掉首尾空白后的自身，全是空白则返回 nil。
    ///
    /// 和 `trimmed` 放在一起，因为它们是同一件事的两种答案：界面想显示「（空）」时
    /// 用 `trimmed`，而想把空字段整句略过时用这个。数据库里存的是 `""` 而不是
    /// `nil`，所以「有没有填」只能这么问出来。
    var nonEmpty: String? {
        let trimmed = self.trimmed
        return trimmed.isEmpty ? nil : trimmed
    }
}
