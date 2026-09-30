import Foundation

/// 知识检索服务（规格 §十九 / §二十）。
///
/// **它与既有 `HybridRetriever` 不是一回事，也不重复它。** 分工：
///
/// | | 输入 | 做什么 | 是否用 embedding |
/// |---|---|---|---|
/// | `HybridRetriever`（既有） | 用户的一句**问题** | 意图 → 结构化 + 向量 + 融合 | 是 |
/// | `KnowledgeSearchService`（本文件） | 一包**豆子的属性** | 实体 → 结构过滤 → 知识证据 | 否（语义入口单独提供） |
///
/// 这正是规格 §三 的意思：Bean 侧不是「问题 → embedding → TopK」，而是
/// 「先知道这是什么豆，再知道该看什么知识」。所以本服务的主路径是**确定性**的：
/// 给同一包豆子，永远返回同一批知识、同一个顺序。只有 `semanticEvidence` 是语义的，
/// 而它复用既有的 `VectorIndex` + `EmbeddingProvider`，不新造向量层。
///
/// 全部方法读的是随包的 `knowledge_base.json`（v2，含 `entityIds` / `scope` /
/// `authorityTier`），离线可用，无网络、无模型依赖。
struct KnowledgeSearchService {

    let documents: [KnowledgeDocument]
    let graph: EntityGraph

    /// 传 `nil` 表示用随包的默认值。用可选参数而不是直接写默认值，是为了让
    /// 测试能塞一份构造好的知识集进来而不碰真实资源。
    init(documents: [KnowledgeDocument]? = nil, graph: EntityGraph? = nil) {
        self.documents = documents ?? KnowledgeBase.payload.documents
        self.graph = graph ?? .loaded
    }

    // MARK: - §十九 基础检索

    func allDocuments() -> [KnowledgeDocument] { documents }

    func document(withID id: String) -> KnowledgeDocument? {
        documents.first { $0.id == id }
    }

    /// 自由文本检索：词法重合度排序。
    ///
    /// 刻意**不**用 embedding：这个方法被链接层同步调用，必须确定性、零依赖。
    /// 真正的语义检索走 `semanticEvidence`，那里复用既有向量索引。
    func search(_ query: String, languageCode: String, limit: Int = 8) -> [KnowledgeEvidence] {
        let trimmed = query.trimmed
        guard !trimmed.isEmpty else { return [] }

        var resolved: [String] = []
        for resolution in graph.resolve(trimmed, limit: 6) {
            if !resolved.contains(resolution.id) { resolved.append(resolution.id) }
        }

        return documents
            .map { document -> KnowledgeEvidence in
                let matched = matchedEntityIDs(in: document, against: resolved)
                return evidence(
                    for: document,
                    languageCode: languageCode,
                    matchedEntityIDs: matched,
                    query: trimmed
                )
            }
            .filter { $0.relevance > 0.35 }
            .sorted { ($0.relevance, $1.documentID) > ($1.relevance, $0.documentID) }
            .prefix(limit)
            .map { $0 }
    }

    /// 某包豆子相关的知识（规格 §二十 的核心入口）。
    ///
    /// 等价于 `KnowledgeLinkingService` 里的知识部分，单独留一个入口是为了让
    /// 「只想要知识、不要链接边」的调用方不必先建上下文。
    func searchByBean(
        _ bean: Bean,
        method: String? = nil,
        languageCode: String,
        limit: Int = 8
    ) -> [KnowledgeEvidence] {
        let context = BeanContextResolver(graph: graph).context(for: bean, method: method)
        return evidence(forEntityIDs: context.entityIDs, languageCode: languageCode, limit: limit)
    }

    func searchByEntity(_ entityID: String, languageCode: String, limit: Int = 8) -> [KnowledgeEvidence] {
        evidence(forEntityIDs: [entityID], languageCode: languageCode, limit: limit)
    }

    func searchByScope(_ scopes: Set<EntityScope>, languageCode: String, limit: Int = 12) -> [KnowledgeEvidence] {
        let wanted = Set(scopes.map(\.rawValue))
        return documents
            .filter { $0.scope.map { wanted.contains($0) } ?? false }
            .map { evidence(for: $0, languageCode: languageCode, matchedEntityIDs: [], query: nil) }
            .sorted { ($0.relevance, $1.documentID) > ($1.relevance, $0.documentID) }
            .prefix(limit)
            .map { $0 }
    }

    /// 冲煮方式相关的知识（规格 §二十一/§二十二 的 ①② 层）。
    func searchByMethod(_ method: String, languageCode: String, limit: Int = 6) -> [KnowledgeEvidence] {
        let ids = graph.resolve(method, types: [.brewMethod, .brewFamily], limit: 4).map(\.id)
        guard !ids.isEmpty else { return [] }
        return evidence(forEntityIDs: ids, languageCode: languageCode, limit: limit)
    }

    /// 设备相关的知识（规格 §二十三）。
    ///
    /// **V1 的能力边界，写在签名里而不是藏起来**（架构审查决策 C1）：仓库里没有
    /// Equipment 模型，实体图谱也还没有 `equipment_brand` / `equipment_model` 节点，
    /// 所以「品牌/型号级」的设备知识这一版不提供。但设备串常常同时是**冲煮方式**
    /// （「V60」既是滤杯也是方法），这种情况退到方式级知识是诚实且有用的；
    /// 认不出方式时返回空，界面据此说「没有该型号的具体资料」。
    func searchByEquipment(_ model: String, languageCode: String, limit: Int = 6) -> [KnowledgeEvidence] {
        searchByMethod(model, languageCode: languageCode, limit: limit)
    }

    /// 规格 §二十：给定实体集合，取回知识证据。
    func evidence(
        forEntityIDs entityIDs: [String],
        languageCode: String,
        limit: Int = 12
    ) -> [KnowledgeEvidence] {
        guard !entityIDs.isEmpty else {
            return genericEvidence(languageCode: languageCode, limit: limit)
        }
        return documents
            .compactMap { document -> KnowledgeEvidence? in
                let matched = matchedEntityIDs(in: document, against: entityIDs)
                guard !matched.isEmpty else { return nil }
                return evidence(for: document, languageCode: languageCode, matchedEntityIDs: matched, query: nil)
            }
            .sorted { ($0.relevance, $1.documentID) > ($1.relevance, $0.documentID) }
            .prefix(limit)
            .map { $0 }
    }

    /// 与豆子无关、但普遍适用的知识（规格 §十七：只输入「埃塞俄比亚」时，
    /// 除了产地知识还应该有通用冲煮/通用新鲜度）。
    func genericEvidence(languageCode: String, limit: Int = 10) -> [KnowledgeEvidence] {
        documents
            .filter { $0.scope == EntityScope.generic.rawValue }
            .map { evidence(for: $0, languageCode: languageCode, matchedEntityIDs: [], query: nil) }
            .sorted { ($0.relevance, $1.documentID) > ($1.relevance, $0.documentID) }
            .prefix(limit)
            .map { $0 }
    }

    // MARK: - 语义检索（复用既有向量索引，规格 §三十七/§三十九）

    /// 在**给定实体集合**内做语义检索。
    ///
    /// 这是唯一用到 embedding 的入口，而且它做的是「先收窄范围，再算相似度」——
    /// 与规格 §三 的反对做法正好相反。`VectorIndex` 与 `EmbeddingProvider` 由调用方
    /// 注入（`AskEngine` 已经持有这两个对象），本层不自己造索引。
    @MainActor
    func semanticEvidence(
        query: String,
        languageCode: String,
        entityIDs: [String] = [],
        provider: EmbeddingProvider,
        index: VectorIndex,
        limit: Int = 6
    ) async -> [KnowledgeEvidence] {
        let trimmed = query.trimmed
        guard !trimmed.isEmpty, let vector = await provider.embed(trimmed) else { return [] }

        let filter = MetadataFilter(sourceTypes: [.knowledge], entityIDs: entityIDs)
        let hits = (try? index.search(vector: vector, filter: filter, limit: limit)) ?? []

        return hits.map { hit in
            KnowledgeEvidence(
                documentID: hit.passage.sourceId,
                title: hit.passage.title,
                body: hit.passage.content,
                category: hit.passage.metadata.category ?? "",
                source: hit.passage.metadata.reference ?? L("内置知识库"),
                sourceIDs: [],
                authorityTier: hit.passage.metadata.authorityTier,
                scope: hit.passage.metadata.scope,
                matchedEntities: displayNames(for: hit.passage.metadata.entityIds ?? [], languageCode: languageCode),
                relevance: min(1.0, max(0.0, (hit.similarity + 1) / 2))
            )
        }
    }

    // MARK: - 组装

    /// 一条知识 → 证据。排序分是**确定性公式**，不用模型打分：
    /// 是否命中实体 0.25 + 范围具体度 0.15 + 权威等级 0.10 + 词法重合 0.30（仅查询时），
    /// 基线 0.45。改动这些常数就改排序，不需要动任何检索代码。
    func evidence(
        for document: KnowledgeDocument,
        languageCode: String,
        matchedEntityIDs: [String],
        query: String?
    ) -> KnowledgeEvidence {
        KnowledgeEvidence(
            documentID: document.id,
            title: document.title.text(for: languageCode) ?? document.id,
            body: document.content.text(for: languageCode) ?? "",
            category: document.category,
            source: document.source,
            sourceIDs: document.sourceIds,
            authorityTier: document.authorityTier,
            scope: document.scope,
            matchedEntities: displayNames(for: matchedEntityIDs, languageCode: languageCode),
            relevance: Self.relevance(
                document: document,
                matchedCount: matchedEntityIDs.count,
                query: query,
                languageCode: languageCode
            )
        )
    }

    func displayNames(for entityIDs: [String], languageCode: String) -> [String] {
        var names: [String] = []
        for id in entityIDs {
            guard let entity = graph.entity(withID: id) else { continue }
            let name = entity.displayName(for: languageCode)
            if !names.contains(name) { names.append(name) }
        }
        return names
    }

    private func matchedEntityIDs(in document: KnowledgeDocument, against wanted: [String]) -> [String] {
        let owned = Set(document.entityIds)
        guard !owned.isEmpty else { return [] }
        return wanted.filter { owned.contains($0) }
    }

    // MARK: - 打分

    static func relevance(
        document: KnowledgeDocument,
        matchedCount: Int,
        query: String?,
        languageCode: String
    ) -> Double {
        var score = 0.45
        if matchedCount > 0 { score += 0.25 }
        score += 0.15 * scopeWeight(document.scope)
        score += 0.10 * authorityWeight(document.authorityTier)
        if let query {
            score += 0.30 * lexicalOverlap(query, document: document, languageCode: languageCode)
        }
        return min(1.0, max(0.0, score))
    }

    private static func scopeWeight(_ scope: String?) -> Double {
        guard let scope, let parsed = EntityScope(rawValue: scope) else { return 0.1 }
        return Double(parsed.rank) / 100.0
    }

    private static func authorityWeight(_ tier: Int?) -> Double {
        switch tier {
        case 1: return 1.0
        case 2: return 0.75
        case 3: return 0.5
        case 4: return 0.25
        default: return 0.5
        }
    }

    /// 词法重合：查询与（标题 + 正文前段）的 token 交集比。
    ///
    /// 用 `LexicalEmbeddingProvider.tokens` 的同一套切词，中文走单字 + 二字组，
    /// 拉丁按连续段——这样「干涩」能对上「尾段发干」里的「干」，而中英混写也不会失效。
    static func lexicalOverlap(_ query: String, document: KnowledgeDocument, languageCode: String) -> Double {
        let documentText = (document.title.text(for: languageCode) ?? "") + " "
            + String((document.content.text(for: languageCode) ?? "").prefix(400))
        let queryTokens = Set(LexicalEmbeddingProvider.tokens(LexicalEmbeddingProvider.normalised(query)))
        let documentTokens = Set(LexicalEmbeddingProvider.tokens(LexicalEmbeddingProvider.normalised(documentText)))
        guard !queryTokens.isEmpty, !documentTokens.isEmpty else { return 0 }
        let shared = queryTokens.intersection(documentTokens).count
        return Double(shared) / Double(queryTokens.count)
    }
}
