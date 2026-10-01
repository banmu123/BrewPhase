import Foundation

/// 混合检索（协议 §7）。
///
/// 三层各管一件事：
/// * **结构化直查** 回答「日期、评分、剩多少、怎么冲的」——有唯一正确答案的问题；
/// * **向量检索** 回答「有没有类似的」「哪次最接近」——没有精确匹配说法的问题；
/// * **元数据过滤** 把上面两条限制在正确的对象上（哪包豆、哪种冲法、什么时间段）。
///
/// 为什么不能只做向量检索：把「这包豆什么时候开封的」也拿去算相似度，你会拿到
/// 一堆「读起来像在说开封」的记录，而真正的答案是数据库里的一个字段。反之，
/// 只做结构化查询则答不了「我之前有没有遇到过类似的干涩」。
@MainActor
final class HybridRetriever {

    struct Outcome: Sendable {
        var plan: QueryPlan
        var passages: [RetrievedPassage]
        var report: IndexCoordinator.Report
        /// 检索过程中值得告诉用户的话（索引降级、有些资料没算出来…）。
        var notes: [String] = []
        /// 这一轮锁定的豆子解析出的检索上下文（规格 §七）。
        ///
        /// 放在这里而不是让调用方再算一遍：`Bean` 是 `@Model`，解析必须在使用它的
        /// 那一层做一次，两处各算一次只会让两侧可能不一致。
        var beanContext: BeanContext?
    }

    private let index: SwiftDataVectorIndex
    private let coordinator: IndexCoordinator

    init(index: SwiftDataVectorIndex, coordinator: IndexCoordinator) {
        self.index = index
        self.coordinator = coordinator
    }

    func retrieve(
        question: String,
        focusBeanID: UUID?,
        conversation: ConversationContext = .empty,
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook?,
        settings: RAGSettings,
        languageCode: String,
        analyzer: QueryAnalyzer,
        now: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) async -> Outcome {
        var notes: [String] = []

        // 1 — 先决定怎么查。
        let analyzed = analyzer.plan(
            for: question,
            beans: beans.map(BeanHint.init(bean:)),
            focusBeanID: focusBeanID,
            conversation: conversation,
            now: now,
            calendar: calendar
        )

        // 1.5 — 把对话上下文并轨进计划（规格 §十三/§十四）。
        //
        // 解析出来的指代可能指向**另一包**豆子（「那 Colombia Huila 呢」），所以
        // 实体解析要按并轨之后的豆子来——候选豆子先取「分析器定的」，没有才退到
        // 上一轮锁定的那包。
        let candidateBeanID = analyzed.focusBeanID ?? analyzed.resolution?.beanID ?? conversation.focusBeanID
        let beanContext = candidateBeanID
            .flatMap { id in beans.first { $0.id == id } }
            .map { BeanContextResolver().context(for: $0, today: now) }
        var plan = ConversationQueryPlanner.apply(
            analyzed, conversation: conversation, beanContext: beanContext, languageCode: languageCode
        )

        // 1.6 — 指代没有落点：这一轮不检索。
        //
        // 明确说一句「缺对象」比硬查一堆无关资料更接近用户要的（规格 §三十五/§五十四）。
        // 也顺带省掉一次无意义的索引同步。
        if plan.clarification != nil {
            return Outcome(
                plan: plan, passages: [], report: IndexCoordinator.Report(),
                notes: notes, beanContext: beanContext
            )
        }

        // 2 — 让索引追上数据。只有变了的那几条会真的去算向量。
        let report = await coordinator.sync(
            beans: beans, brews: brews, tastings: tastings, book: book,
            settings: settings, languageCode: languageCode, now: now
        )
        if let note = report.note { notes.append(note) }
        if report.isFallback {
            notes.append(L("选用的向量模型在这台设备上不可用，已退到%@。", report.backend.label))
        }

        // 3 — 结构化直查。
        //
        // 诊断只在「问这一杯」的时候算一次（规则 + 个人历史，确定性、无模型）：
        // 它既是给用户的答案（结构化事实），也是这一轮的调整建议（进对话状态）。
        var diagnosis: BrewDiagnosis?
        if plan.intents.contains(.diagnosis), plan.focusBeanID != nil {
            let focusBean = plan.focusBeanID.flatMap { id in beans.first { $0.id == id } }
            diagnosis = focusBean.flatMap {
                BrewDiagnosisService.diagnose(bean: $0, allBrews: brews, languageCode: languageCode)
            }
            plan.suggestion = diagnosis?.suggestion.map {
                SuggestionState(parameter: $0.parameter, direction: $0.direction)
            }
        }

        var facts: [RetrievedPassage] = []
        if plan.wantsStructuredFacts {
            facts = StructuredRetriever.facts(
                plan: plan, beans: beans, brews: brews, tastings: tastings,
                book: book, diagnosis: diagnosis, now: now, calendar: calendar
            )
        }

        // 4 — 向量检索。
        var documents: [RetrievedPassage] = []
        if plan.wantsVectorSearch {
            // 用**扩写后**的查询文本算 embedding：省略句（「那水温呢」）单独去算
            // 相似度没有主体，继承来的上下文把它补成一句带语境的话。
            documents = await vectorPassages(
                question: plan.effectiveRetrievalQuery, plan: plan, settings: settings,
                languageCode: languageCode, now: now
            )
            if documents.isEmpty, report.total == 0 {
                notes.append(L("索引里还没有任何资料，这一轮只用了直接查询。"))
            }
        }

        // 5 — 融合。
        let limit = plan.passageLimit(default: settings.passageLimit)
        let fused = fuse(facts: facts, documents: documents, plan: plan, limit: limit, now: now)

        return Outcome(plan: plan, passages: fused, report: report, notes: notes, beanContext: beanContext)
    }

    // MARK: - 向量检索

    private func vectorPassages(
        question: String,
        plan: QueryPlan,
        settings: RAGSettings,
        languageCode: String,
        now: Date
    ) async -> [RetrievedPassage] {
        let resolution = await coordinator.resolution(settings: settings, languageCode: languageCode)

        // 端侧模型是同步 CPU 工作，挪出主 actor 再算。
        let provider = resolution.provider
        guard let queryVector = await Task.detached(priority: .userInitiated, operation: {
            await provider.embed(question)
        }).value, !queryVector.isEmpty else {
            AppLog.rag.error("query embedding failed")
            return []
        }

        let wanted = max(6, plan.passageLimit(default: settings.passageLimit) * 2)
        let allowed = plan.filter.sourceTypes.isEmpty
            ? Set(KnowledgeSourceType.allCases)
            : plan.filter.sourceTypes

        var hits: [VectorHit] = []

        // 用户数据：吃完整的过滤条件。
        var userFilter = plan.filter
        userFilter.sourceTypes = allowed.intersection(KnowledgeSourceType.allCases.filter(\.isUserData))
        if !userFilter.sourceTypes.isEmpty {
            do {
                hits = try index.search(vector: queryVector, filter: userFilter, limit: wanted)
            } catch {
                AppLog.rag.error("vector search failed: \(error.localizedDescription, privacy: .public)")
                return []
            }
        }

        // 知识库：只按「来源是知识库」筛，问题里带出来的其它条件一律不带。
        //
        // 这一条很容易被当成冗余，但少了它两类问题会答不上来：
        // * 「这包豆现在能喝吗」——`beanID` 会把知识库一起筛掉，而「休息期」那条
        //   常识恰恰是回答需要的；
        // * 「V60 一般用多少水温」——「V60」让 `methods` 过滤生效，而知识条目根本
        //   没有「冲煮方式」这个字段，于是关于 V60 的那篇会被它自己筛掉。
        //
        // 根因是同一个：这些维度是**记录**的属性，不是知识的属性。知识条目写的是
        // 通用说法，不该被某一包豆、某一次冲煮的条件限制。
        if allowed.contains(.knowledge) {
            var knowledgeFilter = MetadataFilter()
            knowledgeFilter.sourceTypes = [.knowledge]
            if let found = try? index.search(
                vector: queryVector,
                filter: knowledgeFilter,
                limit: max(2, plan.passageLimit(default: settings.passageLimit) / 2)
            ) {
                hits.append(contentsOf: found)
            }
        }

        // 去重：两轮检索可能命中同一条。
        var seen: Set<String> = []
        let unique = hits.filter { seen.insert($0.passage.recordKey).inserted }

        return rank(unique, plan: plan, now: now)
    }

    /// 把相似度换算成可比较的相关度。
    ///
    /// **用排名归一化，不用绝对相似度**，理由不是偏好而是实测：Apple 的句向量
    /// 对「相关」和「不相关」的余弦值都在 0.9 上下（实测水温问句对水温知识 0.958、
    /// 对豆子记录 0.931），而词法向量的相关值只有 0.2–0.4。拿绝对阈值去卡，
    /// 换一个 provider 整条排序就崩了。排名归一化是 provider 无关的。
    ///
    /// 代价是丢掉了「全都不相关」这个信息。这一点由上层的两条判据兜住：有没有
    /// 结构化事实，以及有没有任何命中——都空的时候会明说检索不到东西。
    private func rank(_ hits: [VectorHit], plan: QueryPlan, now: Date) -> [RetrievedPassage] {
        guard !hits.isEmpty else { return [] }
        let similarities = hits.map(\.similarity)
        let lowest = similarities.min() ?? 0
        let spread = max((similarities.max() ?? 0) - lowest, 0.0001)

        return hits.map { hit in
            let rankScore = (hit.similarity - lowest) / spread
            let metadata = hit.passage.metadata

            // 评分：打过分才有值，没打分的按中性算，不能当成 0 分。
            let ratingScore: Double = {
                guard let score = metadata.score, score > 0 else { return 0.5 }
                return Double(score) / 5
            }()

            // 时效：只有「发生过的事」才谈新旧。知识库和豆子档案没有时效，
            // 按中性算——否则一条十年前也成立的常识会被判为过时。
            let recencyScore: Double = {
                guard hit.passage.sourceType == .brew || hit.passage.sourceType == .tasting,
                      let date = metadata.docDate
                else { return 0.5 }
                let days = max(0, DateMath.daysBetween(date, now))
                return exp(-Double(days) / 30)
            }()

            // 用户自己的数据优先（协议 §4：「优先级最高」）。
            //
            // 例外的形状值得说清楚：**知识型提问 + 没指向具体哪包豆**时反过来偏向
            // 知识库。「V60 一般用多少水温」同时命中了 knowledge 和 recipe（因为
            // 「水温」也是配方词），但它问的显然是通用常识，不是自己的某次记录。
            var sourceAdjust = 0.0
            let knowledgeFocused = plan.intents.contains(.knowledge) && plan.focusBeanID == nil
            if knowledgeFocused {
                sourceAdjust = hit.passage.sourceType == .knowledge ? 0.08 : -0.06
            } else if plan.intents.contains(where: \.isAboutUserData) {
                sourceAdjust = hit.passage.sourceType.isUserData ? 0.05 : -0.02
            }

            // warm 证据（多轮对话）：同一包豆子继续聊时，上一轮引用过的资料算热候选。
            //
            // 它**只加一点权重**，不改取舍：上一轮的证据仍然是这一轮的备选，而不是
            // 这一轮的答案（规格 §四十七）。加太多会变成「因为看过了所以一直是它」。
            let warmAdjust = plan.warmEvidenceIDs.contains(hit.passage.recordKey)
                ? IntelligenceConfig.warmEvidenceBoost
                : 0

            // 权重集中在 `IntelligenceConfig`（协议 §17）：调这三个数不需要改任何
            // 检索代码，将来换 reranker 时也只换这一处。
            let relevance = min(max(
                IntelligenceConfig.similarityWeight * rankScore
                    + IntelligenceConfig.qualityWeight * ratingScore
                    + IntelligenceConfig.recencyWeight * recencyScore
                    + sourceAdjust
                    + warmAdjust,
                0
            ), 1)

            return RetrievedPassage(
                id: hit.passage.recordKey,
                origin: .indexedDocument,
                sourceType: hit.passage.sourceType,
                title: hit.passage.title,
                content: hit.passage.content,
                metadata: metadata,
                relevance: relevance,
                similarity: hit.similarity,
                updatedAt: hit.passage.updatedAt
            )
        }
        .sorted { $0.relevance > $1.relevance }
    }

    // MARK: - 融合

    /// 结构化事实排在前面，剩下的名额给检索到的资料。
    ///
    /// 限额不是简单地把两边合起来排序：事实是**答案**，资料是**线索**。一条相关度
    /// 0.8 的资料不该把「最高分是 5 分」这个结论挤出上下文。所以事实先占位，
    /// 且最多占一半，保证总有资料进来提供细节。
    private func fuse(
        facts: [RetrievedPassage],
        documents: [RetrievedPassage],
        plan: QueryPlan,
        limit: Int,
        now: Date
    ) -> [RetrievedPassage] {
        let factCap = max(1, limit / 2)
        var chosen = Array(facts.prefix(factCap))

        // 事实已经在正文里包含了那些记录的要点，所以同一包豆子的同类资料
        // 放进上下文只会重复一遍。按 key 去重。
        var seen = Set(chosen.map(\.id))
        for document in documents where !seen.contains(document.id) {
            guard chosen.count < limit else { break }
            chosen.append(document)
            seen.insert(document.id)
        }

        if chosen.isEmpty, !documents.isEmpty {
            // 事实一个都没有，但检索到了资料——这种情况下多给几条资料，
            // 让模型有东西可依。
            chosen = Array(documents.prefix(limit))
        }
        return chosen
    }
}
