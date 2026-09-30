import Foundation

/// 一个数值字段在「高评分记录」里的分布。
struct FieldStats: Equatable, Sendable {
    let average: Double
    let minimum: Double
    let maximum: Double
    let count: Int

    var range: ClosedRange<Double> { minimum...maximum }
}

/// Rule 2（协议 §19）：用户过去表现最好的冲煮是什么样。
///
/// 「最好」的定义刻意收窄为**他自己的高分记录**，而不是全部记录：问的是
/// 「我怎么冲这包最好」，基准当然是他打过高分的那几次。低分记录参与统计只会
/// 把「常用值」往坏的方向拉。
///
/// 统计的是值类型而不是 `Brew` 本身——这些数要跨线程进界面、进测试，
/// `@Model` 对象做不到。
@MainActor
enum PersonalBestAnalyzer {

    struct Analysis {
        /// 打过分的记录数（含低分）。用来在「证据不足」时说清现在有多少。
        let scoredCount: Int
        /// 高评分（≥ `IntelligenceConfig.highRatingThreshold`）记录数。
        let highRatedCount: Int
        /// 评分最高的那一次（同分取最近）。
        let bestScore: Int
        let bestDate: Date?
        let bestRecipe: BrewRecipe?
        let bestFlavorTags: [String]
        let bestNotes: String
        /// 全部打过分记录的平均分——代表「这包豆整体表现」，和高分区间分开。
        let averageScore: Double?
        let temperature: FieldStats?
        let timeSeconds: FieldStats?
        let ratio: FieldStats?
        let dose: FieldStats?

        /// 证据是否足够下结论（协议 Case 5）。
        var hasEnoughData: Bool {
            highRatedCount >= IntelligenceConfig.minimumSamplesForComparison
        }
    }

    static func analyze(brews: [Brew]) -> Analysis {
        let scored = brews.filter { $0.score > 0 }
        // 同分取最近的一次：两次都是 5 分时，你更记得住的是新的那次。
        let highRated = brews
            .filter { $0.score >= IntelligenceConfig.highRatingThreshold }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.date > rhs.date
            }
        let best = highRated.first

        func stats(of values: [Double]) -> FieldStats? {
            let usable = values.filter { $0 > 0 }
            guard !usable.isEmpty else { return nil }
            return FieldStats(
                average: usable.reduce(0, +) / Double(usable.count),
                minimum: usable.min() ?? 0,
                maximum: usable.max() ?? 0,
                count: usable.count
            )
        }

        return Analysis(
            scoredCount: scored.count,
            highRatedCount: highRated.count,
            bestScore: best?.score ?? 0,
            bestDate: best?.date,
            bestRecipe: best?.recipe,
            bestFlavorTags: best?.flavorTags ?? [],
            bestNotes: best?.notes ?? "",
            averageScore: scored.isEmpty
                ? nil
                : Double(scored.map(\.score).reduce(0, +)) / Double(scored.count),
            temperature: stats(of: highRated.map(\.waterTemp)),
            timeSeconds: stats(of: highRated.map { Double($0.timeSeconds) }),
            ratio: stats(of: highRated.map(\.ratio)),
            dose: stats(of: highRated.map(\.coffeeG))
        )
    }
}
