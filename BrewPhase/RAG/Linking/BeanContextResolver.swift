import Foundation

/// Bean → BeanContext（规格 §七）。
///
/// 三条硬规则，全部来自规格：
/// 1. **只翻译，不推断。** 用户写「埃塞俄比亚 · Guji」，就得到 Ethiopia 与 Guji；
///    只写「Guji」，得到 Guji 与**由层级推出的** Ethiopia（规格 §五十一 明确要求
///    「Guji 能够关联 Guji + Ethiopia」）。但绝不会从 Ethiopia 反向生出 Guji / Washed /
///    Heirloom——那是编数据（规格 §十二 / §十七）。
/// 2. **缺失就是缺失。** 没识别到的字段记进 `missingFields`，不用默认值填。
/// 3. **确定性。** 同一包豆子在同一语言下重复解析，结果必须逐项相同（否则
///    `contentHash` 会抖，索引会没完没了地重建）。
struct BeanContextResolver {

    let graph: EntityGraph

    init(graph: EntityGraph = .loaded) {
        self.graph = graph
    }

    /// 解析一包豆子。
    ///
    /// - Parameters:
    ///   - method: 当前要冲的方式（冲煮页会传）。为空时退到最近一次冲煮记录的方式。
    func context(
        for bean: Bean,
        method: String? = nil,
        today: Date = Date()
    ) -> BeanContext {

        var found: [String: EntityResolution] = [:]

        func record(_ resolutions: [EntityResolution]) {
            for resolution in resolutions {
                if let existing = found[resolution.id], existing.match.priority <= resolution.match.priority {
                    continue
                }
                found[resolution.id] = resolution
            }
        }

        // 1) 产地：`Bean.origin` 是「国家 · 产区」合一的自由文本，一次解析出两者。
        let originText = bean.origin.nonEmpty
        if let originText {
            record(graph.resolve(originText, types: [.origin, .region], limit: 8))
        }

        // 2) 品种：App 没有 `variety` 字段（架构审查决策 D1），所以从豆名与备注里
        //    尽力识别。识别不到就是没有——这一条不会凭空给出一支品种。
        let varietyText = [bean.name, bean.notes].compactMap { $0.nonEmpty }.joined(separator: " ")
        if !varietyText.trimmed.isEmpty {
            record(graph.resolve(varietyText, types: [.variety, .varietyGroup], limit: 6))
        }

        // 3) 处理法。
        if let process = bean.process.nonEmpty {
            record(graph.resolve(process, types: [.process], limit: 4))
        }

        // 4) 烘焙度：枚举是稳定值，直接映射到实体，不走文本匹配（不会有歧义）。
        if let roast = roastEntity(for: bean.roastLevel) {
            found[roast.id] = EntityResolution(
                entity: roast,
                match: .inferred,
                matchedAlias: bean.roastLevel.label
            )
        }

        // 5) 风味标签：`FlavorLibrary` 存的是英文规范 id，正好是实体别名的一种写法。
        for tag in bean.flavorTags {
            record(graph.resolve(tag, types: [.sensory], limit: 2))
        }

        // 6) 冲煮方式：优先用调用方给的当前方式，否则用最近一次冲煮。
        let methodText = method?.nonEmpty ?? bean.latestBrew?.method.nonEmpty
        if let methodText {
            record(graph.resolve(methodText, types: [.brewMethod, .brewFamily], limit: 4))
        }

        // 7) 层级展开：把已命中节点的祖先补进来，标 `.hierarchy`（规格 §十五/§十八）。
        //    只向上走，绝不向下——向下就是「从国家推出产区」的编造。
        for resolution in found.values {
            for ancestor in graph.ancestors(of: resolution.id) {
                if let existing = found[ancestor.id], existing.match.priority <= MatchType.hierarchy.priority {
                    continue
                }
                found[ancestor.id] = EntityResolution(
                    entity: ancestor,
                    match: .hierarchy,
                    matchedAlias: ancestor.canonicalName
                )
            }
        }

        let ordered = found.values.sorted { lhs, rhs in
            if lhs.match.priority != rhs.match.priority { return lhs.match.priority < rhs.match.priority }
            if lhs.entity.scope.rank != rhs.entity.scope.rank { return lhs.entity.scope.rank > rhs.entity.scope.rank }
            if lhs.matchedAlias.count != rhs.matchedAlias.count { return lhs.matchedAlias.count > rhs.matchedAlias.count }
            return lhs.id < rhs.id
        }

        return BeanContext(
            beanID: bean.id,
            beanName: bean.displayName,
            rawOrigin: bean.origin,
            rawProcess: bean.process,
            rawRoaster: bean.roaster,
            roastLevelRaw: bean.roastLevel.rawValue,
            roastLevelLabel: bean.roastLevel.label,
            flavorTags: bean.flavorTags,
            methodText: methodText,
            daysSinceRoast: bean.dayAfterRoast(on: today),
            daysSinceOpen: openDays(bean: bean, today: today),
            resolutions: ordered
        )
    }

    // MARK: - 私有

    /// 烘焙度枚举 → 实体。`espressoBlend` 在 ML 编码层刻意留空
    /// （`FlavorRoastLevel.modelValue` 返回 nil），但知识层面它是一支可链接的实体。
    private func roastEntity(for level: RoastLevel) -> KnowledgeEntity? {
        let id: String
        switch level {
        case .light: id = "roast.light"
        case .medium: id = "roast.medium"
        case .mediumDark: id = "roast.medium_dark"
        case .dark: id = "roast.dark"
        case .espressoBlend: id = "roast.espresso_blend"
        }
        return graph.entity(withID: id)
    }

    /// 开封后天数。没有开封日期就没有——**不**用烘焙日期顶上（那是另一件事）。
    private func openDays(bean: Bean, today: Date) -> Int? {
        guard let open = bean.openDate else { return nil }
        return max(0, DateMath.daysBetween(open, today))
    }
}
