import Foundation

/// 知识实体图（规格 §十八）：节点 + 别名索引 + 父子层级。
///
/// 为什么是「图」而不是一张平表：规格 §十五 要求层级 fallback——
/// `Guji → Ethiopia → East Africa → Coffee Origin`，越往下优先级越低。只写
/// 「Guji」时，Ethiopia 不是被匹配到的，而是**推**出来的，两者必须能区分，
/// 所以命中方式（`MatchType`）与层级一起构成了这张图的输出。
///
/// 数据来自 `Resources/knowledge_entities.json`（随包，离线）。图是**不可变**的：
/// 加载一次，之后全是纯查询，没有锁也没有缓存失效问题。
struct EntityGraph: Sendable {

    let entities: [KnowledgeEntity]

    /// 索引。`canonical` 与 `alias` 分开，是为了让「写的就是规范名」和
    /// 「写的是一个别名」在结果里可区分（规格 §十五 的前两档）。
    private let byID: [String: KnowledgeEntity]
    private let canonicalIndex: [String: [String]]
    private let aliasIndex: [String: [String]]
    /// 子 → 父的反向索引，用于祖先查询。
    private let childIndex: [String: [String]]

    static let empty = EntityGraph(entities: [])

    /// 懒加载一次。读不到不是致命错误：链接层降级为「无实体可用」，
    /// 界面回退到通用知识，而不是崩掉。
    static let loaded: EntityGraph = {
        guard let json = BundleResource.jsonObject(named: "knowledge_entities") else {
            AppLog.rag.error("knowledge_entities.json not found in the bundle")
            return .empty
        }
        let graph = EntityGraph(json: json)
        guard !graph.entities.isEmpty else {
            AppLog.rag.error("knowledge_entities.json is not in the expected shape")
            return .empty
        }
        AppLog.rag.info("entity graph loaded: \(graph.entities.count) entities")
        return graph
    }()

    init(entities: [KnowledgeEntity]) {
        self.entities = entities
        self.byID = Dictionary(entities.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        var canonical: [String: [String]] = [:]
        var alias: [String: [String]] = [:]
        var children: [String: [String]] = [:]

        for entity in entities {
            let key = EntityGraph.normalised(entity.canonicalName)
            if !key.isEmpty {
                canonical[key, default: []].append(entity.id)
            }
            for name in entity.aliases {
                let aliasKey = EntityGraph.normalised(name)
                guard !aliasKey.isEmpty else { continue }
                alias[aliasKey, default: []].append(entity.id)
            }
            if let parent = entity.parentId {
                children[parent, default: []].append(entity.id)
            }
        }

        self.canonicalIndex = canonical
        self.aliasIndex = alias
        self.childIndex = children.mapValues { $0.sorted() }
    }

    init(json: [String: Any]?) {
        let raw = (json?["entities"] as? [[String: Any]]) ?? []
        self.init(entities: raw.compactMap(KnowledgeEntity.init(json:)))
    }

    // MARK: - 查询

    func entity(withID id: String) -> KnowledgeEntity? { byID[id] }

    func entities(ofType type: EntityType) -> [KnowledgeEntity] {
        entities.filter { $0.type == type }
    }

    /// 文本 → 实体（规格 §九）。
    ///
    /// 结果**确定性排序**：先按命中方式优先级，再按适用范围具体度，再按命中写法
    /// 长度，最后按 id。字典遍历顺序在 Swift 里是不定的，不显式排序就会让
    /// 「同一包豆两次给出不同关联」——那种不确定性没法写测试。
    func resolve(_ text: String, types: Set<EntityType>? = nil, limit: Int = 8) -> [EntityResolution] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = EntityGraph.normalised(text)
        guard !key.isEmpty else { return [] }

        var found: [String: (KnowledgeEntity, MatchType, String)] = [:]

        func record(_ id: String, match: MatchType, alias: String) {
            guard let entity = byID[id] else { return }
            if let types, !types.contains(entity.type) { return }
            // 同一实体只保留**最优**的一次命中，不让别名把精确匹配盖掉。
            if let existing = found[id], existing.1.priority <= match.priority { return }
            found[id] = (entity, match, alias)
        }

        // 1) 规范名
        for id in canonicalIndex[key] ?? [] {
            let canonical = byID[id]?.canonicalName ?? ""
            let match: MatchType = (canonical == trimmed) ? .exact : .normalized
            record(id, match: match, alias: canonical)
        }

        // 2) 别名（整串）
        for id in aliasIndex[key] ?? [] { record(id, match: .alias, alias: key) }

        // 3) 包含匹配。**短别名（归一后不足 2 个字符）只允许整串相等**——
        //    否则别名「水」会让「水洗」命中水质主题，这是实测踩到的坑。
        for (aliasKey, ids) in aliasIndex where aliasKey.count >= 2 && aliasKey != key {
            guard key.contains(aliasKey) else { continue }
            for id in ids { record(id, match: .alias, alias: aliasKey) }
        }
        for (canonicalKey, ids) in canonicalIndex where canonicalKey.count >= 2 && canonicalKey != key {
            guard key.contains(canonicalKey) else { continue }
            for id in ids { record(id, match: .normalized, alias: canonicalKey) }
        }

        return found.values
            .sorted { lhs, rhs in
                if lhs.1.priority != rhs.1.priority { return lhs.1.priority < rhs.1.priority }
                if lhs.0.scope.rank != rhs.0.scope.rank { return lhs.0.scope.rank > rhs.0.scope.rank }
                if lhs.2.count != rhs.2.count { return lhs.2.count > rhs.2.count }
                return lhs.0.id < rhs.0.id
            }
            .prefix(limit)
            .map { EntityResolution(entity: $0.0, match: $0.1, matchedAlias: $0.2) }
    }

    /// 祖先，由近及远（不含自己）。
    func ancestors(of id: String, maxDepth: Int = 4) -> [KnowledgeEntity] {
        var result: [KnowledgeEntity] = []
        var current = byID[id]?.parentId
        var depth = 0
        var visited: Set<String> = [id]
        while let next = current, depth < maxDepth, !visited.contains(next) {
            guard let entity = byID[next] else { break }
            result.append(entity)
            visited.insert(next)
            current = entity.parentId
            depth += 1
        }
        return result
    }

    /// 后代（不含自己）。
    func descendants(of id: String) -> [KnowledgeEntity] {
        (childIndex[id] ?? []).compactMap { byID[$0] }
    }

    /// 从根到自己的路径（含自己）。
    func path(of id: String) -> [KnowledgeEntity] {
        guard let entity = byID[id] else { return [] }
        return ancestors(of: id).reversed() + [entity]
    }

    /// 归一化：全角转半角 + 转小写 + 去分隔符与空白。
    ///
    /// 复用 `LexicalEmbeddingProvider.normalised` 而不是另写一份——`MetadataFilter`
    /// 已经是这么做的，检索与链接两边用同一套归一，才不会出现「过滤命中、链接不命中」。
    /// 分隔符集合与 `Tools/knowledge/build_kb.py` 的 `_SEPARATORS` 一一对应。
    static func normalised(_ text: String) -> String {
        LexicalEmbeddingProvider.normalised(text).filter { !separators.contains($0) }
    }

    private static let separators: Set<Character> = [
        " ", "\t", "\n", "\u{00A0}",
        "-", "_", "·", "•", "・", "/", "\\", "|",
        ",", "，", "、", ";", "；", "+",
        "(", ")", "（", "）", "[", "]", "【", "】",
    ]
}
