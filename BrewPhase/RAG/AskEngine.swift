import Foundation
import SwiftData

/// 一次问答的完整结果。
struct AskAnswer: Identifiable, Equatable, Sendable {
    let id: UUID
    let question: String
    let text: String
    /// 实际生成这段回答的引擎。
    let engine: AnswerEngine
    /// 是不是没能用上用户选的那个引擎。
    let usedFallback: Bool
    /// 用户选的那个为什么没用上。
    let failureNote: String?
    /// 这次用到的证据，已经分好组编好号。
    let context: BuiltContext
    let plan: QueryPlan
    let report: IndexCoordinator.Report
    /// 值得告诉用户的过程信息（索引降级、日志式说明）。
    let notes: [String]
    let elapsed: TimeInterval

    var citations: [BuiltContext.Block] { context.allBlocks }
    var hasEvidence: Bool { !context.isEmpty }
}

/// 整条链路（协议 §3）：
///
/// ```
/// 用户问题
///    ↓
/// Question Analyzer        → QueryPlan（查什么、怎么查、条数）
///    ↓
/// 查询策略                  → 结构化直查 / 向量检索 / 元数据过滤
///    ↓
/// Context Builder          → 分组的、编号的、有预算的证据
///    ↓
/// Local LLM                → 回答（带引用）
///    ↓
/// Answer
/// ```
///
/// 这个类只做编排：它自己不解析问题、不检索、不拼提示词，也不生成回答。这样每一段
/// 都能单独测——协议要求的第一阶段是「验证这个核心体验」，而链路清楚是验证的前提。
@MainActor
final class AskEngine {

    private let retriever: HybridRetriever
    private let coordinator: IndexCoordinator
    private let analyzer: QueryAnalyzer

    init(context: ModelContext, analyzer: QueryAnalyzer = RuleQueryAnalyzer()) {
        let index = SwiftDataVectorIndex(context: context)
        let coordinator = IndexCoordinator(index: index)
        self.coordinator = coordinator
        self.retriever = HybridRetriever(index: index, coordinator: coordinator)
        self.analyzer = analyzer
    }

    /// 提问。
    ///
    /// - Parameters:
    ///   - focusBeanID: 从某包豆子的页面提问时带上它，这样「这包豆…」不必念名字。
    ///   - languageCode: 界面语言。它决定向量空间，也决定回答语言。
    func ask(
        _ question: String,
        focusBeanID: UUID? = nil,
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook?,
        settings: RAGSettings,
        languageCode: String,
        now: Date = Date()
    ) async -> AskAnswer {
        let started = Date()
        let trimmed = question.trimmed

        guard !trimmed.isEmpty else {
            return emptyAnswer(question: trimmed, started: started)
        }

        let outcome = await retriever.retrieve(
            question: trimmed,
            focusBeanID: focusBeanID,
            beans: beans,
            brews: brews,
            tastings: tastings,
            book: book,
            settings: settings,
            languageCode: languageCode,
            analyzer: analyzer,
            now: now
        )

        let context = ContextBuilder.build(
            question: trimmed,
            passages: outcome.passages,
            terms: outcome.plan.terms
        )

        var notes = outcome.notes
        if context.droppedForBudget > 0 {
            notes.append(L("还有 %@ 条相关资料因为篇幅没有放进来。", String(context.droppedForBudget)))
        }

        let composed = await AnswerComposer.compose(context: context, settings: settings)

        AppLog.rag.info("""
        ask: intents=\(outcome.plan.intents.map(\.rawValue).sorted().joined(separator: ","), privacy: .public) \
        passages=\(context.allBlocks.count) engine=\(composed.engine.rawValue, privacy: .public) \
        index=\(outcome.report.total)
        """)

        return AskAnswer(
            id: UUID(),
            question: trimmed,
            text: composed.text,
            engine: composed.engine,
            usedFallback: composed.usedFallback,
            failureNote: composed.failureNote,
            context: context,
            plan: outcome.plan,
            report: outcome.report,
            notes: notes,
            elapsed: Date().timeIntervalSince(started)
        )
    }

    /// 空问题不该走完整条链路——那只会浪费一次索引同步和一次模型调用。
    private func emptyAnswer(question: String, started: Date) -> AskAnswer {
        AskAnswer(
            id: UUID(),
            question: question,
            text: L("想问我什么？比如「这包豆什么时候开封的」「我最近三次怎么冲的」「V60 一般用多少水温」。"),
            engine: .onDeviceSummary,
            usedFallback: false,
            failureNote: nil,
            context: BuiltContext(question: question),
            plan: QueryPlan(question: question),
            report: IndexCoordinator.Report(),
            notes: [],
            elapsed: Date().timeIntervalSince(started)
        )
    }

    // MARK: - 索引维护

    /// 重建索引。给设置页里那个按钮用。
    @discardableResult
    func rebuildIndex(
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook?,
        settings: RAGSettings,
        languageCode: String
    ) async -> IndexCoordinator.Report {
        coordinator.invalidateProvider()
        return await coordinator.sync(
            beans: beans, brews: brews, tastings: tastings, book: book,
            settings: settings, languageCode: languageCode, force: true
        )
    }

    /// 设置变了（换 embedding 后端、换语言）之后调它。
    func settingsChanged() {
        coordinator.invalidateProvider()
    }
}
