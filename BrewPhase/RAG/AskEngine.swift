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
    /// 这一轮结束后的对话状态，交给下一轮用（规格 §二十七）。
    ///
    /// 由 `AskEngine` 算好、`AskView` 只负责写回——语义解析不落在视图层（规格 §二十八）。
    let conversationUpdate: ConversationContext

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
    ///   - conversation: 上一轮留下的对话状态（规格 §七）。第一次提问用 `.empty`；
    ///     之后每一轮把它换成上一轮 `AskAnswer.conversationUpdate`。
    ///   - languageCode: 界面语言。它决定向量空间，也决定回答语言。
    func ask(
        _ question: String,
        focusBeanID: UUID? = nil,
        conversation: ConversationContext = .empty,
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
            return emptyAnswer(question: trimmed, started: started, conversation: conversation)
        }

        let outcome = await retriever.retrieve(
            question: trimmed,
            focusBeanID: focusBeanID,
            conversation: conversation,
            beans: beans,
            brews: brews,
            tastings: tastings,
            book: book,
            settings: settings,
            languageCode: languageCode,
            analyzer: analyzer,
            now: now
        )

        // 指代没有落点：这一轮不检索，明确请用户补一句（规格 §三十五）。
        // 注意这里**照常推进轮次**，但不记任何证据、也不改对象状态——
        // 一次没问清的话不该把上一轮建立起来的上下文冲掉。
        if let clarification = outcome.plan.clarification {
            let update = ConversationStateUpdater.next(
                previous: conversation, plan: outcome.plan, evidence: [],
                beanContext: nil, languageCode: languageCode
            )
            AppLog.rag.info("""
            ask-clarify: kind=\(clarification.kind.rawValue, privacy: .public) \
            turn=\(update.turnIndex)
            """)
            return AskAnswer(
                id: UUID(),
                question: trimmed,
                text: clarificationText(for: clarification),
                engine: .onDeviceSummary,
                usedFallback: false,
                failureNote: nil,
                context: BuiltContext(question: trimmed),
                plan: outcome.plan,
                report: outcome.report,
                notes: [],
                elapsed: Date().timeIntervalSince(started),
                conversationUpdate: update
            )
        }

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

        // 下一轮的状态：只吃计划、指代解析与本轮证据的元数据，**不吃回答文本**
        // （规格 §四十六：抽取式拼出来的回答不是事实源）。
        let update = ConversationStateUpdater.next(
            previous: conversation,
            plan: outcome.plan,
            evidence: evidenceRefs(from: context),
            beanContext: outcome.beanContext,
            languageCode: languageCode
        )

        AppLog.rag.info("""
        ask: intents=\(outcome.plan.intents.map(\.rawValue).sorted().joined(separator: ","), privacy: .public) \
        passages=\(context.allBlocks.count) engine=\(composed.engine.rawValue, privacy: .public) \
        index=\(outcome.report.total) \
        turn=\(update.turnIndex) followUp=\(outcome.plan.resolution?.isFollowUp == true) \
        topic=\(outcome.plan.topic?.rawValue ?? "-", privacy: .public) \
        parameter=\(outcome.plan.parameter?.rawValue ?? "-", privacy: .public) \
        inherited=\(outcome.plan.inheritedEntityIDs.count)
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
            elapsed: Date().timeIntervalSince(started),
            conversationUpdate: update
        )
    }

    /// 本轮证据的标识（规格 §十五：只存标识，不存正文）。
    ///
    /// 轮次由 `ConversationStateUpdater` 盖戳——它才是轮次的唯一出处。
    private func evidenceRefs(from context: BuiltContext) -> [EvidenceRef] {
        context.allBlocks.map { block in
            EvidenceRef(
                id: block.passage.id,
                sourceType: block.passage.sourceType,
                beanID: block.passage.metadata.beanID,
                turnIndex: 0
            )
        }
    }

    /// 指代解析不出来时的答复（规格 §三十五）。
    ///
    /// 定式文案，按缺什么分句说清楚——**不猜**是这一层的产品承诺：回答只用用户
    /// 自己的记录和随包知识，所以「不知道你在说哪个」时，正确的做法是问一句。
    private func clarificationText(for ambiguity: ReferenceAmbiguity) -> String {
        let phrase = ambiguity.phrase
        let head: String
        switch ambiguity.kind {
        case .bean:
            head = L("「%@」我还不确定指哪包豆子。可以说一下豆名，或者从豆子的页面进来问我。", phrase)
        case .method:
            head = L("「%@」我还不确定指哪种冲法。直接说器具名就行，比如 V60、爱乐压。", phrase)
        case .equipment:
            head = L("「%@」我还不确定指哪台器具。说个型号我就知道了。", phrase)
        case .brew:
            head = L("「%@」我这边还没有能对上的冲煮记录。先说一次具体的冲煮，或者打开那次记录再问我。", phrase)
        case .parameter:
            head = L("「%@」我还不确定指哪个参数。是想说水温、研磨、时间，还是粉水比？", phrase)
        case .process, .origin, .variety, .roast:
            head = L("「%@」我还不确定指的是哪一个。先说说这包豆子的产区或处理法，我就能接上。", phrase)
        }
        return head + "\n" + L("回答只用你的记录和 BrewPhase 知识库，所以我不猜。")
    }

    /// 空问题不该走完整条链路——那只会浪费一次索引同步和一次模型调用。
    private func emptyAnswer(
        question: String,
        started: Date,
        conversation: ConversationContext
    ) -> AskAnswer {
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
            elapsed: Date().timeIntervalSince(started),
            conversationUpdate: conversation
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
