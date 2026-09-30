import Foundation

/// Bean → Knowledge Linking 的编排层（规格 §十四）。
///
/// 它做三件事，顺序固定：
/// 1. 建边：把 `BeanContext` 的实体解析变成 `BeanKnowledgeLink`，并按规格 §十五
///    的优先级分成 `direct` 与 `related` 两组。
/// 2. 取知识：在**直接**实体范围内取知识，再补上「靠层级落到的」「与冲煮方式相关的」
///    「通用的」三档，且互不重复、合并后按相关度排序。
/// 3. 保证**不编造**：实体一个都没有时返回「通用知识」，而不是假装找到了针对
///    这包豆的资料（规格 §四十九/§五十）。
///
/// 全程同步、无 embedding、无网络。同一包豆子、同一语言 → 同一结果。
struct KnowledgeLinkingService {

    let graph: EntityGraph
    let search: KnowledgeSearchService

    init(graph: EntityGraph? = nil, search: KnowledgeSearchService? = nil) {
        let resolvedGraph = graph ?? .loaded
        self.graph = resolvedGraph
        self.search = search ?? KnowledgeSearchService(graph: resolvedGraph)
    }

    // MARK: - 建边（规格 §十一 / §十五）

    /// 按命中方式把解析结果分成「直接」与「关联」两组。
    ///
    /// 分界线是 `hierarchy` / `generalContext`：这两种不是用户写下的东西命中的，
    /// 而是**推出来或沾上的**，规格 §十二 要求它们不能和直接命中等量齐观。
    func links(for context: BeanContext) -> (direct: [BeanKnowledgeLink], related: [BeanKnowledgeLink]) {
        var direct: [BeanKnowledgeLink] = []
        var related: [BeanKnowledgeLink] = []

        for resolution in context.resolutions {
            let link = BeanKnowledgeLink(
                beanID: context.beanID,
                entity: resolution.entity,
                relation: RelationType.forEntityType(resolution.entity.type),
                match: resolution.match,
                confidence: BeanKnowledgeLink.confidence(for: resolution.match),
                evidence: evidenceText(for: resolution, context: context)
            )
            switch resolution.match {
            case .exact, .normalized, .alias, .inferred, .userSelected:
                direct.append(link)
            case .hierarchy, .generalContext:
                related.append(link)
            }
        }

        // 排序：命中方式 → 关系 → id。同一次调用永远得到同一顺序。
        direct.sort { ($0.match.priority, $0.relation.rawValue, $0.entity.id) < ($1.match.priority, $1.relation.rawValue, $1.entity.id) }
        related.sort { ($0.match.priority, $0.relation.rawValue, $0.entity.id) < ($1.match.priority, $1.relation.rawValue, $1.entity.id) }
        return (direct, related)
    }

    // MARK: - 完整上下文（规格 §十四 / §二十）

    func context(
        for bean: Bean,
        method: String? = nil,
        languageCode: String,
        today: Date = Date()
    ) -> BeanKnowledgeContext {
        let beanContext = BeanContextResolver(graph: graph).context(for: bean, method: method, today: today)
        return context(forBeanContext: beanContext, languageCode: languageCode)
    }

    func context(forBeanContext beanContext: BeanContext, languageCode: String) -> BeanKnowledgeContext {
        guard !beanContext.isEmpty else {
            // 一包什么都没填的豆子：只给通用知识，一句个性化的都不说。
            return BeanKnowledgeContext(
                context: beanContext,
                directLinks: [],
                relatedLinks: [],
                directKnowledge: [],
                relatedKnowledge: [],
                genericKnowledge: search.genericEvidence(languageCode: languageCode),
                recommendedKnowledge: []
            )
        }

        let (direct, related) = links(for: beanContext)

        var used: Set<String> = []
        func unique(_ items: [KnowledgeEvidence]) -> [KnowledgeEvidence] {
            var out: [KnowledgeEvidence] = []
            for item in items where !used.contains(item.id) {
                used.insert(item.id)
                out.append(item)
            }
            return out
        }

        // 1) 直接命中实体的知识——这是唯一能被称为「与这包豆子有关」的一档。
        let directKnowledge = unique(search.evidence(
            forEntityIDs: direct.map(\.entity.id),
            languageCode: languageCode,
            // 用 docs 数量兜底，避免「实体命中了但知识被 limit 截掉」。
            limit: max(4, search.documents.count)
        ))

        // 2) 与当前冲煮方式相关的知识（规格 §二十一 的 ①② 层）。
        let methodText = beanContext.methodText ?? ""
        let recommendedKnowledge = unique(search.searchByMethod(
            methodText,
            languageCode: languageCode,
            limit: max(2, search.documents.count)
        ))

        // 3) 靠层级/背景落到的知识（规格 §五十：没有具体资料时，明确回退到更上层）。
        let relatedKnowledge = unique(search.evidence(
            forEntityIDs: related.map(\.entity.id),
            languageCode: languageCode,
            limit: max(4, search.documents.count)
        ))

        // 4) 通用兜底。
        let genericKnowledge = unique(search.genericEvidence(
            languageCode: languageCode,
            limit: max(4, search.documents.count)
        ))

        return BeanKnowledgeContext(
            context: beanContext,
            directLinks: direct,
            relatedLinks: related,
            directKnowledge: directKnowledge,
            relatedKnowledge: relatedKnowledge,
            genericKnowledge: genericKnowledge,
            recommendedKnowledge: recommendedKnowledge
        )
    }

    // MARK: - 私有

    /// 一条链接的「为什么」。用的是**上下文里已有的原文**，不新造句子——
    /// 界面上一句「因为你的产地写的是『埃塞俄比亚 · Guji』」比任何描述都诚实。
    private func evidenceText(for resolution: EntityResolution, context: BeanContext) -> String {
        switch resolution.entity.type {
        case .origin, .region:
            return context.rawOrigin.trimmed.isEmpty ? resolution.matchedAlias : context.rawOrigin
        case .variety, .varietyGroup:
            return resolution.matchedAlias
        case .process:
            return context.rawProcess.trimmed.isEmpty ? resolution.matchedAlias : context.rawProcess
        case .roast:
            return context.roastLevelLabel
        case .brewMethod, .brewFamily:
            return context.methodText ?? resolution.matchedAlias
        case .sensory:
            return resolution.matchedAlias
        default:
            return resolution.matchedAlias
        }
    }
}
