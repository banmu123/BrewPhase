import Foundation

/// 一条可解释的结论（协议 §29）。
///
/// 四个成员对应协议要求的四件事：`headline` 是结果，`reasons` 是理由，
/// `evidence` 是可追溯的数据行，`confidence` 是内部质量指标。证据不足时
/// `confidence` 是 `.insufficientEvidence`，`reasons` 里会写清缺什么——
/// 而不是硬给一个建议。
///
/// 全部成员是值类型：结论可以在任何线程之间传递，也可以在测试里逐项比较。
struct Insight: Identifiable, Equatable, Sendable {

    struct Evidence: Identifiable, Equatable, Sendable {
        let text: String
        var id: String { text }
    }

    enum Kind: Equatable, Sendable {
        case todayPick
        case personalBest
        case deviation
        case similarHistory
        /// 「今天手冲还是意式/奶咖」——天气场景 × 用户历史做法统计。
        case methodSuggestion
    }

    enum Confidence: Equatable, Sendable {
        case high
        case medium
        case low
        case insufficientEvidence
    }

    let id: UUID
    let kind: Kind
    let headline: String
    let reasons: [String]
    let evidence: [Evidence]
    let confidence: Confidence
    /// 结论关于哪包豆子。相似冲煮这类跨包结论为 nil。
    let beanID: UUID?
}
