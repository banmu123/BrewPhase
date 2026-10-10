import Foundation

/// 冲煮方法的粗分类。「手冲还是美式/卡布奇诺」这类建议的对象是**家族**，
/// 不是某个具体名字——用户写「V60」还是「手冲」，统计时必须是同一回事。
enum MethodFamily: String, Codable, Sendable, CaseIterable {
    case filter
    case espresso
    case cold

    var label: String {
        switch self {
        case .filter: return L("手冲/滤泡")
        case .espresso: return L("意式/奶咖")
        case .cold: return L("冷萃/冰饮")
        }
    }
}

/// 家族归一化。别名表在 `brew_method_rules.json`——中文词表不能写进 Swift
/// 字面量，否则会被本地化流水线收成待翻译文案（和 query_rules.json 同理）。
///
/// 没有 `@MainActor`：唯一的状态是一张不可变的 `Sendable` 别名字典（`static let`
/// 本身就是线程安全的），而它的调用方不止界面——`BrewMath.validate` 要在写入路径上
/// 按家族决定提示语，那条路不能被主线程隔离卡住。
enum MethodRules {

    private static let aliases: [MethodFamily: [String]] = load()

    private static func load() -> [MethodFamily: [String]] {
        guard let url = BundleResource.url(named: "brew_method_rules", extensions: ["json"]),
              let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else {
            AppLog.rag.error("brew_method_rules.json missing; method suggestions disabled")
            return [:]
        }
        var result: [MethodFamily: [String]] = [:]
        for (key, words) in payload.families {
            guard let family = MethodFamily(rawValue: key) else { continue }
            result[family] = words.map { $0.lowercased() }
        }
        return result
    }

    private struct Payload: Codable {
        let revision: Int
        let families: [String: [String]]
    }

    /// 一段方法文本属于哪个家族。多个家族都命中时按 cold > espresso > filter：
    /// 「冰手冲」字面上两边都沾，用户想说的多半是冰的那杯。
    static func family(of methodText: String) -> MethodFamily? {
        let lowered = methodText.lowercased()
        for family in [MethodFamily.cold, .espresso, .filter] {
            if let words = aliases[family], words.contains(where: lowered.contains) {
                return family
            }
        }
        return nil
    }

    /// 一个家族的评分统计。只有打过分的记录参与——「没打分」是没意见，不是低分。
    static func stats(for target: MethodFamily, brews: [Brew]) -> (count: Int, average: Double)? {
        let scored = brews.filter { brew in
            brew.score > 0 && family(of: brew.method) == target
        }
        guard !scored.isEmpty else { return nil }
        let total = scored.reduce(0) { $0 + $1.score }
        return (scored.count, Double(total) / Double(scored.count))
    }
}
