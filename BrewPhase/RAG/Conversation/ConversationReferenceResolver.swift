import Foundation

/// `conversation_rules.json` —— 多轮对话的匹配词表。
///
/// 与 `QueryRules` 同一个理由放在 JSON 里：这些是**匹配用的数据**，不是界面文案。
/// 写成 Swift 字面量会被本地化流水线收成待翻译的键（`Tools/Localization/keys.py`
/// 收集所有含中文的字符串字面量）。
///
/// 词表按用途分四组：指代词组（哪句话在指「刚才那个东西」）、承接词（这句话在延续
/// 上一轮）、参数名（在问哪个维度）、方向词（高/低/细/粗…）。
struct ConversationRules: Sendable {

    let references: [ReferenceKind: [String]]
    let followUps: [String]
    let parameters: [QueryParameter: [String]]
    let directions: [ParameterDirection: [String]]

    static let empty = ConversationRules(
        references: [:], followUps: [], parameters: [:], directions: [:]
    )

    static let loaded: ConversationRules = {
        guard let json = BundleResource.jsonObject(named: "conversation_rules") else {
            // 读不到不是致命的：没有词表时多轮继承退化成「只继承锁定状态」，
            // 指代不会被解析，也就不会有任何猜测。
            AppLog.rag.error("conversation_rules.json not found; reference resolution is off")
            return .empty
        }
        return ConversationRules(json: json)
    }()

    init(
        references: [ReferenceKind: [String]],
        followUps: [String],
        parameters: [QueryParameter: [String]],
        directions: [ParameterDirection: [String]]
    ) {
        self.references = references
        self.followUps = followUps
        self.parameters = parameters
        self.directions = directions
    }

    init(json: [String: Any]) {
        var references: [ReferenceKind: [String]] = [:]
        for (rawKey, rawValue) in (json["references"] as? [String: [String]] ?? [:]) {
            guard let kind = ReferenceKind(rawValue: rawKey) else { continue }
            references[kind] = rawValue.map(ConversationRules.normalised).filter { !$0.isEmpty }
        }
        self.references = references
        self.followUps = (json["followUps"] as? [String] ?? []).map(ConversationRules.normalised)

        var parameters: [QueryParameter: [String]] = [:]
        for (rawKey, rawValue) in (json["parameters"] as? [String: [String]] ?? [:]) {
            guard let parameter = QueryParameter(rawValue: rawKey) else { continue }
            parameters[parameter] = rawValue.map(ConversationRules.normalised).filter { !$0.isEmpty }
        }
        self.parameters = parameters

        var directions: [ParameterDirection: [String]] = [:]
        for (rawKey, rawValue) in (json["directions"] as? [String: [String]] ?? [:]) {
            guard let direction = ParameterDirection(rawValue: rawKey) else { continue }
            directions[direction] = rawValue.map(ConversationRules.normalised).filter { !$0.isEmpty }
        }
        self.directions = directions
    }

    /// 与检索侧共用一套归一化，免得出现「过滤命中、指代不命中」这种鬼故事。
    static func normalised(_ text: String) -> String {
        QueryRules.normalised(text)
    }
}

/// 一句指代在指哪一类东西（规格 §十）。
enum ReferenceKind: String, CaseIterable, Sendable {
    case bean
    case method
    case equipment
    case process
    case origin
    case variety
    case roast
    case brew
    case parameter
}

/// 指代解析不出来时的明确说明（规格 §十一/§三十五/§五十四）。
///
/// 它的存在就是**拒绝猜测**：不知道「它」是谁，就不要拿聊天记录里随便一个对象顶上，
/// 而是如实说这句话缺对象。
struct ReferenceAmbiguity: Equatable, Sendable {
    let kind: ReferenceKind
    /// 用户实际说的那个词（「它」「这个方法」…），用来把话说具体。
    let phrase: String
}

/// 指代与承接的解析结果（规格 §四十四）。
///
/// 每个字段都带 `Source`，这是刻意留的可解释性：调试时能回答「这个实体到底是从
/// 当前问题来的，还是从上一轮继承的」（规格 §十三）。
struct ResolvedReferences: Equatable, Sendable {

    enum Source: String, Sendable {
        /// 当前问题里明说的。
        case explicit
        /// 从上一轮对话状态继承的。
        case conversation
        /// 由锁定豆子的属性推出来的（Bean → Entity）。
        case beanContext
        /// 没有上下文可用。
        case generic
    }

    var beanID: UUID?
    var beanName: String?
    var beanSource: Source = .generic

    var method: MethodReference?
    var methodSource: Source = .generic
    var equipment: MethodReference?
    var equipmentSource: Source = .generic

    var parameter: QueryParameter?
    var parameterSource: Source = .generic
    var direction: ParameterDirection?

    var topic: ConversationTopic?
    var topicSource: Source = .generic

    /// 指代指向的具体实体（例如「这种处理法」→ `process.washed`）。
    /// 它只用来把检索用的查询扩写得更具体，**不**当作硬过滤条件。
    var referencedEntityIDs: [String] = []

    /// 这句话里的指代词，按出现顺序去重。
    var referencePhrases: [String] = []
    /// 是不是在承接上一轮（有指代、有承接词，或问「类似的」）。
    var isFollowUp = false
    /// 「刚才那杯」落到的那条冲煮记录。
    var brewID: UUID?
    /// 沿用自上一轮的东西，供界面/日志说明「这次用了什么」。
    var inheritedLabels: [String] = []
    var ambiguity: ReferenceAmbiguity?

    static let empty = ResolvedReferences()
}

extension ResolvedReferences {
    /// 只留下「这句话自己说的」，把继承来的部分清掉。
    ///
    /// 换豆子那一轮必须这么做（规格 §十九）：上一包豆子语境里的冲法、器具、参数、
    /// 话题和实体都不是这一包豆子的事实。清理要发生在**解析结果**上，而不是只发生
    /// 在状态上——`QueryPlan` 是下游（状态推进）的唯一输入，解析结果里留着旧的冲法，
    /// 状态推进就会把它原样写回去。
    func clearingInherited() -> ResolvedReferences {
        var cleared = self
        if methodSource == .conversation {
            cleared.method = nil
            cleared.methodSource = .generic
        }
        if equipmentSource == .conversation {
            cleared.equipment = nil
            cleared.equipmentSource = .generic
        }
        if parameterSource == .conversation {
            cleared.parameter = nil
            cleared.parameterSource = .generic
        }
        if topicSource == .conversation {
            cleared.topic = nil
            cleared.topicSource = .generic
        }
        cleared.referencedEntityIDs = []
        cleared.inheritedLabels = []
        return cleared
    }
}

/// 指代解析器（规格 §九/§四十四）。
///
/// 职责单一：**把「它」「这个方法」「低一点」这类话，对到当前会话状态里的具体对象上。**
/// 它不检索、不碰数据库、不产生任何新事实——所以它可以纯粹用值类型测。
///
/// 三条纪律：
/// 1. 只认词表里的说法，不做模糊联想；
/// 2. 没有落点就报 `ambiguity`，绝不从聊天历史里随便挑一个对象顶上（规格 §十一）；
/// 3. 显式永远压过继承（规格 §三十三/§三十四）。
struct ConversationReferenceResolver {

    let rules: ConversationRules
    let graph: EntityGraph

    init(rules: ConversationRules = .loaded, graph: EntityGraph = .loaded) {
        self.rules = rules
        self.graph = graph
    }

    func resolve(
        question: String,
        conversation: ConversationContext,
        plan: QueryPlan,
        languageCode: String
    ) -> ResolvedReferences {
        var resolved = ResolvedReferences()
        let text = ConversationRules.normalised(question)
        guard !text.isEmpty else { return resolved }

        // 1 — 这句话有没有指代。
        let references = matchedReferences(in: text)
        resolved.referencePhrases = references.map(\.phrase)

        // 2 — 是不是在承接上一轮。三个充分条件，缺一不可地保守：
        //     有指代 / 有承接词 / 问的是「类似」。
        //
        //     没有这三者之一的问句一律当作新话题——宁可少继承，也不要把上一轮的
        //     豆子硬塞进一句通用问题（规格 §十一 的反面）。
        let hasFollowUpMarker = rules.followUps.contains { Self.contains(text, phrase: $0) }
        resolved.isFollowUp = !references.isEmpty
            || hasFollowUpMarker
            || plan.intents.contains(.similarity)

        // 3 — 指代指向的具体实体（例如「这种处理法」）。取当前豆子上下文里同族的节点。
        let contextEntities = conversation.allEntityIDs
        if let reference = references.first {
            resolved.referencedEntityIDs = referents(for: reference.kind, in: contextEntities)
        }

        // 4 — 豆子。显式（分析器已经匹配过名字或导航绑定）> 上一轮 > 上一轮证据。
        if let explicit = plan.focusBeanID {
            resolved.beanID = explicit
            resolved.beanName = plan.focusBeanName
            resolved.beanSource = .explicit
        } else if resolved.isFollowUp, let inherited = conversation.focusBeanID {
            resolved.beanID = inherited
            resolved.beanName = conversation.focusBeanName
            resolved.beanSource = .conversation
        } else if references.contains(where: { $0.kind == .brew }),
                  let fromEvidence = conversation.recentEvidence.compactMap(\.beanID).last {
            // 「刚才那杯」——杯子的主人就是那条记录所属的豆子（规格 §十二 里
            // 「上一轮证据」那一档）。
            resolved.beanID = fromEvidence
            resolved.beanName = conversation.focusBeanName
            resolved.beanSource = .conversation
        }

        // 5 — 冲煮方式与器具：显式 > 上一轮。
        if !plan.filter.methods.isEmpty {
            resolved.method = MethodReference(
                label: matchedWord(raw: question, normalised: text, candidates: plan.filter.methods)
                    ?? plan.filter.methods[0],
                spellings: plan.filter.methods
            )
            resolved.methodSource = .explicit
        } else if resolved.isFollowUp, let inherited = conversation.activeMethod {
            resolved.method = inherited
            resolved.methodSource = .conversation
        }

        if !plan.filter.devices.isEmpty {
            resolved.equipment = MethodReference(
                label: matchedWord(raw: question, normalised: text, candidates: plan.filter.devices)
                    ?? plan.filter.devices[0],
                spellings: plan.filter.devices
            )
            resolved.equipmentSource = .explicit
        } else if resolved.isFollowUp, let inherited = conversation.activeEquipment {
            resolved.equipment = inherited
            resolved.equipmentSource = .conversation
        }

        // 6 — 参数与方向。
        //
        // 「低一点呢」这种话里没有参数名，方向词本身也只对一部分参数是确定的
        // （细/粗必然是研磨，快/慢必然是时间）。剩下的必须由上一轮决定，决定不了
        // 就明确说缺对象——绝不默认成「水温」（规格 §三十八）。
        for (parameter, phrases) in rules.parameters.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            guard phrases.contains(where: { Self.contains(text, phrase: $0) }) else { continue }
            resolved.parameter = parameter
            resolved.parameterSource = .explicit
            break
        }
        var directionPhrase: String?
        for (direction, phrases) in rules.directions.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            guard let phrase = phrases.first(where: { Self.contains(text, phrase: $0) }) else { continue }
            resolved.direction = direction
            directionPhrase = phrase
            if resolved.parameter == nil, let implied = direction.impliedParameter {
                resolved.parameter = implied
                resolved.parameterSource = .conversation
            }
            break
        }
        if resolved.parameter == nil, resolved.direction != nil || resolved.isFollowUp {
            resolved.parameter = conversation.activeParameter ?? resolved.direction?.impliedParameter
            if resolved.parameter != nil { resolved.parameterSource = .conversation }
        }

        // 7 — 话题。参数最具体，其次是这句话里点到的知识实体，最后才是继承。
        if let parameter = resolved.parameter {
            resolved.topic = parameter.topic
            resolved.topicSource = resolved.parameterSource
        } else if let explicitTopic = topic(in: text) {
            resolved.topic = explicitTopic
            resolved.topicSource = .explicit
        } else if resolved.isFollowUp, let inherited = conversation.activeTopic {
            resolved.topic = inherited
            resolved.topicSource = .conversation
        }

        // 8 — 「刚才那杯」落到具体记录。
        if references.contains(where: { $0.kind == .brew }) {
            resolved.brewID = conversation.recentBrewID
        }

        // 9 — 指代没有落点：如实说，不猜。
        if let reference = references.first {
            resolved.ambiguity = ambiguity(for: reference, resolved: resolved, conversation: conversation)
        } else if let directionPhrase, resolved.parameter == nil {
            // 只有方向词、却没有能被调整的参数：同样是「缺对象」，同样不猜。
            resolved.ambiguity = ReferenceAmbiguity(kind: .parameter, phrase: directionPhrase)
        }

        // 10 — 沿用了什么，说给用户看。
        resolved.inheritedLabels = inheritedLabels(resolved, conversation: conversation, languageCode: languageCode)
        return resolved
    }

    // MARK: - 指代匹配

    private struct MatchedReference {
        let kind: ReferenceKind
        let phrase: String
    }

    /// 找出这句话里的指代。**最长匹配优先**——「这个处理法」必须盖住「这个」，
    /// 否则一句「这个处理法的区别」会被当成在指那包豆子。
    private func matchedReferences(in text: String) -> [MatchedReference] {
        var candidates: [(kind: ReferenceKind, phrase: String)] = []
        for (kind, phrases) in rules.references {
            for phrase in phrases where Self.contains(text, phrase: phrase) {
                candidates.append((kind, phrase))
            }
        }
        // 豆子的指代把既有 `query_rules.json` 的 bagReferences 一并算进来：
        // 那份表是分析器用来绑定导航豆子的，两处都算指代，才不会出现
        // 「分析器认出来了、解析器说没有」的分裂。并集是数据，不是猜。
        for phrase in QueryRules.loaded.bagReferences where Self.contains(text, phrase: phrase) {
            candidates.append((.bean, phrase))
        }

        // 去重后按「短语长度倒序 → 类型名」排序，保证同一句话的判定每次一样。
        var seen = Set<String>()
        return candidates
            .filter { seen.insert($0.phrase).inserted }
            .sorted {
                if $0.phrase.count != $1.phrase.count { return $0.phrase.count > $1.phrase.count }
                return $0.kind.rawValue < $1.kind.rawValue
            }
            .map(MatchedReference.init)
    }

    /// 指代在「当前豆子上下文 + 这句话自己」里能对上的实体。
    private func referents(for kind: ReferenceKind, in entityIDs: [String]) -> [String] {
        let prefixes: [String]
        switch kind {
        case .process: prefixes = ["process."]
        case .origin: prefixes = ["origin.", "region."]
        case .variety: prefixes = ["variety."]
        case .roast: prefixes = ["roast."]
        case .method: prefixes = ["method.", "family."]
        default: return []
        }
        return entityIDs.filter { id in prefixes.contains { id.hasPrefix($0) } }
    }

    /// 这句话自己点到的知识话题。
    private func topic(in text: String) -> ConversationTopic? {
        let ids = graph.resolve(text, limit: 8).map(\.id)
        // 先看直白的话题节点（alias 里就写着「水温」「处理法」这类词）。
        for id in ids where id.hasPrefix("topic.") {
            if let topic = ConversationTopic.forEntityID(id) { return topic }
        }
        for id in ids {
            if let topic = ConversationTopic.forEntityID(id) { return topic }
        }
        return nil
    }

    // MARK: - 歧义判定

    private func ambiguity(
        for reference: MatchedReference?,
        resolved: ResolvedReferences,
        conversation: ConversationContext
    ) -> ReferenceAmbiguity? {
        guard let reference else { return nil }

        let hasReferent: Bool
        switch reference.kind {
        case .bean: hasReferent = resolved.beanID != nil
        case .method: hasReferent = resolved.method != nil
        case .equipment: hasReferent = resolved.equipment != nil
        case .brew: hasReferent = resolved.brewID != nil
        case .parameter: hasReferent = resolved.parameter != nil
        case .process, .origin, .variety, .roast:
            hasReferent = !resolved.referencedEntityIDs.isEmpty
                || (reference.kind == .roast && conversation.directEntityIDs.contains { $0.hasPrefix("roast.") })
        }
        guard !hasReferent else { return nil }
        return ReferenceAmbiguity(kind: reference.kind, phrase: reference.phrase)
    }

    // MARK: - 沿用说明

    private func inheritedLabels(
        _ resolved: ResolvedReferences,
        conversation: ConversationContext,
        languageCode: String
    ) -> [String] {
        guard resolved.isFollowUp else { return [] }
        var labels: [String] = []
        if resolved.beanSource == .conversation, let name = resolved.beanName, !name.isEmpty {
            labels.append(name)
        }
        if resolved.methodSource == .conversation, let method = resolved.method {
            labels.append(method.label)
        }
        if resolved.equipmentSource == .conversation, let equipment = resolved.equipment {
            labels.append(equipment.label)
        }
        if resolved.parameterSource == .conversation, let parameter = resolved.parameter {
            labels.append(parameter.label)
        }
        if resolved.topicSource == .conversation, let topic = resolved.topic {
            labels.append(topic.label(languageCode: languageCode))
        }
        return labels
    }

    // MARK: - 文本匹配

    /// 词表里的写法是不是出现在这句话里。
    ///
    /// 中日韩短语用子串匹配（没有词边界这回事）；纯 ASCII 的词必须落在**词边界**上，
    /// 否则「it」会命中「with」、「bar」会命中「bartender」——这种误命中不会报错，
    /// 只会让指代解析在少数句子上悄悄跑偏。
    static func contains(_ text: String, phrase: String) -> Bool {
        guard !phrase.isEmpty else { return false }
        guard phrase.allSatisfy(\.isASCII) else { return text.contains(phrase) }

        var searchStart = text.startIndex
        while let range = text.range(of: phrase, range: searchStart..<text.endIndex) {
            let before = range.lowerBound == text.startIndex ? nil : text[text.index(before: range.lowerBound)]
            let after = range.upperBound == text.endIndex ? nil : text[range.upperBound]
            let leftOK = before.map { !$0.isLetter && !$0.isNumber } ?? true
            let rightOK = after.map { !$0.isLetter && !$0.isNumber } ?? true
            if leftOK && rightOK { return true }
            searchStart = range.upperBound
        }
        return false
    }

    /// 词表整组写法里，用户实际写的那个。
    ///
    /// 先用**原样文本**反查（忽略大小写），这样拿回来的是用户自己敲的写法——
    /// 词表在加载时已经归一化成小写，直接拿它当展示名会把「V60」写成「v60」。
    private func matchedWord(raw: String, normalised: String, candidates: [String]) -> String? {
        for candidate in candidates where !candidate.isEmpty {
            if let range = raw.range(of: candidate, options: .caseInsensitive) {
                return String(raw[range])
            }
        }
        return candidates.first { Self.contains(normalised, phrase: $0) }
    }
}

/// 把「对话状态 + 指代解析」并轨进 `QueryPlan`（规格 §十三/§十四）。
///
/// 放在这一层而不是分析器里，是为了让分析器保持「只认这句话本身」的纯粹性：
/// 分析器不认识 Bean（那是 `@Model`，不能跨 actor），也不认识上一轮。并轨需要
/// 豆子的实体与原始字段，所以由持有数据库对象的 `AskEngine` 调用。
///
/// 优先级就是规格 §十二 那一条，只是落在具体字段上：
///
/// ```
/// 当前问题（显式）      → 分析器已经填好，这里不覆盖
/// 当前轮实体            → 分析器已经填好
/// focus bean（继承）    → 只在显式缺失时补
/// 上一轮 active 状态    → 只在上面都空时补
/// 通用知识              → 什么都不补
/// ```
enum ConversationQueryPlanner {

    static func apply(
        _ plan: QueryPlan,
        conversation: ConversationContext,
        beanContext: BeanContext?,
        graph: EntityGraph = .loaded,
        languageCode: String
    ) -> QueryPlan {
        var plan = plan
        let analyzedResolution = plan.resolution ?? .empty

        // 换豆子的一轮：继承来的豆子专属东西一律不带（规格 §十九）。
        // 判据是「这一轮锁定的豆子不是上一轮那包」。
        let subjectChanged = plan.focusBeanID != nil && plan.focusBeanID != conversation.focusBeanID
        let resolution = subjectChanged ? analyzedResolution.clearingInherited() : analyzedResolution
        if subjectChanged { plan.resolution = resolution }

        // 1 — 锁定对象。
        if plan.focusBeanID == nil, let inherited = resolution.beanID {
            // 推荐型问题（「今天我该先喝哪包」）问的是**所有**豆子，不能被继承来的
            // 那一包收窄——但它仍然留在对话状态里继续讨论（规格 §三十九）。
            if !plan.intents.contains(.inventory) {
                plan.focusBeanID = inherited
                plan.focusBeanName = resolution.beanName ?? plan.focusBeanName
                plan.filter.beanID = inherited
            }
        }

        // 2 — 冲煮方式与器具：过滤条件里没有时才用继承来的填。
        //     显式说了 Espresso 就不该还带着上一轮的 V60（规格 §三十四）；
        //     换了豆子也不该带着上一包豆子语境里的冲法。
        if !subjectChanged, plan.filter.methods.isEmpty, resolution.methodSource == .conversation,
           let method = resolution.method {
            plan.filter.methods = method.spellings
        }
        if !subjectChanged, plan.filter.devices.isEmpty, resolution.equipmentSource == .conversation,
           let equipment = resolution.equipment {
            plan.filter.devices = equipment.spellings
        }

        // 3 — 话题、参数与方向。
        plan.parameter = resolution.parameter
        plan.direction = resolution.direction
        if let topic = resolution.topic { plan.topic = topic }
        if subjectChanged, resolution.topicSource != .explicit { plan.topic = .bean }

        // 3.5 — 在**锁定了具体豆子**的前提下问某个参数，问的就是「我这包豆那次
        //       冲煮用的是多少」。按配方类问题走结构化直查，答出来的是真实数值；
        //       没锁定豆子的知识型问法（「V60 一般用多少水温」）不受影响。
        if plan.parameter != nil, plan.focusBeanID != nil, !plan.intents.contains(.recipe) {
            plan.intents.insert(.recipe)
        }

        // 4 — 「刚才那杯」落到那条冲煮记录上（规格 §十：不存在就报缺对象，不猜）。
        if let brewID = resolution.brewID {
            plan.filter.brewID = brewID
        }

        // 5 — 继承来的实体：给检索扩写与 warm 加权用。
        //
        // **刻意不写进 `filter.entityIDs`。** 知识库 19 篇文档里有 6 篇没有任何
        // entityIds（水质、新鲜度、意式基础、研磨总论、咖啡因），按实体硬筛会把
        // 今天答得出来的问题筛成「没找到」。实体在这一层的职责是**把查询说得更具体**，
        // 而不是把范围切得更小——后者交给 `beanID` 与既有过滤条件。
        plan.inheritedEntityIDs = inheritedEntities(
            plan: plan, conversation: conversation, resolution: resolution, beanContext: beanContext
        )

        // 6 — warm 证据：同一包豆子继续聊时，上一轮引用过的资料算「热候选」。
        //     它只影响排序，不影响取舍（规格 §四十七：不能默认上一轮证据就是这一轮的）。
        if plan.focusBeanID == conversation.focusBeanID {
            plan.warmEvidenceIDs = conversation.recentEvidenceIDs
        }

        // 7 — 检索用的查询文本（向量检索拿它算 embedding）。
        plan.retrievalQuery = expandedQuery(
            plan: plan, conversation: conversation, resolution: resolution,
            beanContext: beanContext, subjectChanged: subjectChanged,
            graph: graph, languageCode: languageCode
        )

        // 8 — 并轨之后再判一次「要不要走结构化直查」：判据和分析器里那一条完全一样，
        //     只是此时 focusBeanID 可能刚由继承补上。指代没落点的一轮不查（见
        //     `QueryPlan.clarification`）。
        if plan.clarification == nil {
            plan.wantsStructuredFacts = !plan.intents.isEmpty
                || plan.focusBeanID != nil
                || !plan.filter.methods.isEmpty
        }

        // 9 — 把「这一轮沿用了什么」写进给用户看的那句说明。
        //     它就在回答卡片的脚注里，是这套系统「可解释」的一部分。
        let extra = summaryLines(resolution)
        if !extra.isEmpty {
            plan.summary = ([plan.summary].compactMap { $0 } + extra).joined(separator: "\n")
        }
        return plan
    }

    /// 并轨这一轮额外产生的说明行。
    private static func summaryLines(_ resolution: ResolvedReferences) -> [String] {
        var lines: [String] = []
        if !resolution.inheritedLabels.isEmpty {
            lines.append(L("沿用上一轮：%@", resolution.inheritedLabels.joined(separator: L(" · "))))
        }
        if let parameter = resolution.parameter {
            if let direction = resolution.direction {
                lines.append(L("这一轮在问：%@（%@）", parameter.label, direction.label))
            } else {
                lines.append(L("这一轮在问：%@", parameter.label))
            }
        }
        return lines
    }

    // MARK: - 实体集与检索扩写

    private static func inheritedEntities(
        plan: QueryPlan,
        conversation: ConversationContext,
        resolution: ResolvedReferences,
        beanContext: BeanContext?
    ) -> [String] {
        var ids: [String] = []
        if let beanContext, beanContext.beanID == plan.focusBeanID {
            ids.append(contentsOf: beanContext.directlyStatedEntityIDs)
            ids.append(contentsOf: beanContext.inferredEntityIDs)
        } else {
            ids.append(contentsOf: conversation.directEntityIDs)
            ids.append(contentsOf: conversation.ancestorEntityIDs)
        }
        // 指代指向的具体节点（「这种处理法」→ `process.washed`）也算继承来的：
        // 它是上一轮/豆子上下文里的东西，不是这句话新说的。
        ids.append(contentsOf: resolution.referencedEntityIDs)

        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }

    /// 检索用的查询文本。
    ///
    /// 为什么需要它：向量检索原本拿**裸问题**去算 embedding，而「那水温呢」这种
    /// 省略句在向量空间里没有主体——它和「我的冲煮记录」这段话的相似度天然偏低。
    /// 把继承来的上下文（哪包豆、什么处理法、什么烘焙度、哪种冲法、哪个参数）
    /// 拼在问题前面，检索才是「带着语境在问」，而不是「只拿半句话在问」。
    ///
    /// 只有**承接式**的一轮才扩写：一句独立的新问题不该被上一轮的豆子污染
    /// （规格 §七十三 的边界）。
    private static func expandedQuery(
        plan: QueryPlan,
        conversation: ConversationContext,
        resolution: ResolvedReferences,
        beanContext: BeanContext?,
        subjectChanged: Bool,
        graph: EntityGraph,
        languageCode: String
    ) -> String {
        guard resolution.isFollowUp else { return plan.question }

        var parts: [String] = []
        if let beanContext, beanContext.beanID == plan.focusBeanID {
            parts.append(beanContext.beanName)
            if !beanContext.rawOrigin.isEmpty { parts.append(beanContext.rawOrigin) }
            if !beanContext.rawProcess.isEmpty { parts.append(beanContext.rawProcess) }
            parts.append(beanContext.roastLevelLabel)
        } else if let name = conversation.focusBeanName, !name.isEmpty {
            parts.append(name)
        } else if let name = plan.focusBeanName, !name.isEmpty {
            parts.append(name)
        }

        // 换了豆子：上一包豆子的冲法、参数、话题都作废，只补新豆子的属性。
        if !subjectChanged {
            if let method = resolution.method {
                parts.append(method.label)
            } else if let inherited = conversation.activeMethod {
                parts.append(inherited.label)
            }

            if let parameter = resolution.parameter {
                parts.append(parameter.label)
            } else if let topic = resolution.topic {
                parts.append(topic.label(languageCode: languageCode))
            }

            for id in resolution.referencedEntityIDs {
                guard let entity = graph.entity(withID: id) else { continue }
                parts.append(entity.displayName(for: languageCode))
            }
        }

        // 去重（豆名可能已经出现在问题里，实体名也可能互相包含），再按上限截断。
        var seen = Set<String>()
        let additions = parts
            .map(\.trimmed)
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
            .prefix(IntelligenceConfig.conversationContextTermLimit)
        guard !additions.isEmpty else { return plan.question }
        return ([plan.question] + additions).joined(separator: " ")
    }
}
