import Foundation

/// 从「上一轮状态 + 这一轮的计划与证据」算出下一轮状态（规格 §四十五）。
///
/// 三条纪律写在这里，而不是散在调用点：
///
/// 1. **优先级**：当前显式信息 > 指代解析结果 > 上一轮的 active 状态（规格 §四十五）。
/// 2. **换豆子就清豆子专属状态**（规格 §十九）：方式、器具、参数、证据全部作废，
///    只保留「在聊豆子」这个话题和这轮的新信息。理由不是洁癖：`V60` 是上一包豆子
///    语境里的 V60，把它带进另一包豆子的追问，会让用户看到一句他自己没说过的话。
/// 3. **绝不用回答文本反推状态**（规格 §四十六）：输入只有 `QueryPlan`、
///    指代解析结果与本轮的证据元数据。回答是抽取式拼出来的，它不能当事实源。
///
/// 整个类型没有状态、不碰数据库，所以每一条规则都能单独测。
enum ConversationStateUpdater {

    static func next(
        previous: ConversationContext,
        plan: QueryPlan,
        evidence: [EvidenceRef],
        beanContext: BeanContext?,
        languageCode: String
    ) -> ConversationContext {
        var next = previous
        next.turnIndex = previous.turnIndex + 1
        next.recentQuestion = plan.question
        next.recentQuestionTerms = plan.terms

        // 指代没解析出来的一轮只记「问过什么」，不动任何对象状态：
        // 一次失败的追问不该把上一轮辛苦建立起来的上下文清掉。
        if plan.clarification != nil {
            return next
        }

        let resolvedBeanID = plan.focusBeanID ?? (plan.resolution ?? .empty).beanID
        let subjectChanged = resolvedBeanID != nil && resolvedBeanID != previous.focusBeanID

        // 换豆子：继承来的部分在**解析结果**上就清掉（与 `ConversationQueryPlanner`
        // 同一套规则）。这一层的唯一输入是计划，解析结果里若还留着上一包豆子的冲法，
        // 下面几行就会把它原样写回状态——那样「换豆子会清理」就只是文档里的一句话。
        let resolution = subjectChanged
            ? (plan.resolution ?? .empty).clearingInherited()
            : (plan.resolution ?? .empty)

        if subjectChanged {
            next.directEntityIDs = []
            next.ancestorEntityIDs = []
            next.activeMethod = nil
            next.activeEquipment = nil
            next.activeParameter = nil
            next.lastDirection = nil
            next.recentEvidence = []
            next.activeTopic = .bean
        }

        // 豆子：这一轮定的 > 上一轮。豆名只为界面显示，不参与任何判断。
        if let resolvedBeanID {
            next.focusBeanID = resolvedBeanID
        }
        if let beanContext {
            next.focusBeanName = beanContext.beanName
            next.directEntityIDs = beanContext.directlyStatedEntityIDs
            next.ancestorEntityIDs = beanContext.inferredEntityIDs
        } else if let name = plan.focusBeanName, !name.isEmpty {
            next.focusBeanName = name
        }

        // 方式 / 器具 / 参数 / 话题：显式覆盖继承，继承压不住就保持原样。
        if let method = resolution.method {
            next.activeMethod = method
        }
        if let equipment = resolution.equipment {
            next.activeEquipment = equipment
        }
        if let parameter = resolution.parameter {
            next.activeParameter = parameter
        }
        if let direction = resolution.direction {
            next.lastDirection = direction
        }
        if let topic = resolution.topic {
            next.activeTopic = topic
        }
        if !plan.intents.isEmpty {
            next.activeIntent = primaryIntent(of: plan.intents)
        }

        // 轮次由**这里**盖戳：调用方给什么 turnIndex 都不影响结果，
        // 免得「谁负责数轮次」变成两处各数一次。
        let stamped = evidence.map {
            EvidenceRef(id: $0.id, sourceType: $0.sourceType, beanID: $0.beanID, turnIndex: next.turnIndex)
        }
        next.recentEvidence = window(
            previous: subjectChanged ? [] : previous.recentEvidence,
            evidence: stamped,
            turnIndex: next.turnIndex
        )
        return next
    }

    /// 证据窗口：只留最近若干轮，同一条只留最近一次出现。
    ///
    /// 为什么不无限增长（规格 §二十三）：一百轮之后这个值类型还会被逐轮复制、
    /// 被写进日志，而真正有用的只有「刚才引用了什么」这一点点信息。
    static func window(
        previous: [EvidenceRef],
        evidence: [EvidenceRef],
        turnIndex: Int
    ) -> [EvidenceRef] {
        let cutoff = turnIndex - IntelligenceConfig.conversationEvidenceTurns + 1
        var kept = (previous + evidence).filter { $0.turnIndex >= cutoff }

        // 同一条记录在窗口里只保留最近一次引用——`Array.last` 语义，顺序稳定。
        var seen = Set<String>()
        kept = kept.reversed().filter { seen.insert($0.id).inserted }.reversed()
        if kept.count > IntelligenceConfig.conversationEvidenceLimit {
            kept = Array(kept.suffix(IntelligenceConfig.conversationEvidenceLimit))
        }
        return kept
    }

    /// 多个意图同时命中时的「主意图」（规格 §二十一：`activeIntent` 只有一个）。
    ///
    /// 顺序按「这句话最想干什么」排，不是按字母：问库存/推荐最优先——它决定走向
    /// 规则引擎还是走向检索，是这一轮最结构性的一件事。
    static func primaryIntent(of intents: Set<QueryIntent>) -> QueryIntent? {
        primaryOrder.first { intents.contains($0) }
    }

    private static let primaryOrder: [QueryIntent] = [
        .inventory, .similarity, .preference, .rating, .recipe, .timing, .status, .knowledge,
    ]
}
