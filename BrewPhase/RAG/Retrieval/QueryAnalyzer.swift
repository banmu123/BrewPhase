import Foundation

/// `query_rules.json` —— 意图识别用的关键词与语法表。
///
/// 表里的中文**不是界面文案**：它们是匹配用的数据。放进 JSON 而不是写成 Swift
/// 字面量，就是为了不让本地化流水线把这些词收成待翻译的键——「一」「三」「天」
/// 这种单字被当成界面文案，只会给翻译表添一堆噪声。这和 `flavor_mapping.json`
/// 当初的做法是同一个理由。
struct QueryRules: Sendable {

    let intents: [QueryIntent: [String]]
    let bagReferences: [String]
    /// 每组是一件事的多种写法。命中任意一个，整组都会被当成过滤条件——
    /// 因为库里存的是**另一种语言**的写法的可能性是真实存在的。
    let methods: [[String]]
    let devices: [[String]]
    let processes: [[String]]

    /// 中文数字。「第三次」里的三。
    let numerals: [Character: Int]
    /// 计数单位。「三次」「3 cups」里的单位和杯。
    let countUnits: [String]
    /// 「最近」「last」这类相对时间的起头词。
    let relativeAnchors: [String]
    /// 时间单位 → 天数。按长度倒序，保证 `days` 不会被 `day` 抢先匹配掉。
    let relativeUnits: [(unit: String, days: Int)]

    static let empty = QueryRules(
        intents: [:], bagReferences: [], methods: [], devices: [], processes: [],
        numerals: [:], countUnits: [], relativeAnchors: [], relativeUnits: []
    )

    static let loaded: QueryRules = {
        guard let json = BundleResource.jsonObject(named: "query_rules") else {
            // 读不到不是致命的：没有关键词规则时，分析器仍会用向量检索兜住，
            // 只是少了对意图的精确判断。
            AppLog.rag.error("query_rules.json not found; the analyser runs without keyword rules")
            return .empty
        }
        return QueryRules(json: json)
    }()

    init(
        intents: [QueryIntent: [String]],
        bagReferences: [String],
        methods: [[String]],
        devices: [[String]],
        processes: [[String]],
        numerals: [Character: Int],
        countUnits: [String],
        relativeAnchors: [String],
        relativeUnits: [(unit: String, days: Int)]
    ) {
        self.intents = intents
        self.bagReferences = bagReferences
        self.methods = methods
        self.devices = devices
        self.processes = processes
        self.numerals = numerals
        self.countUnits = countUnits
        self.relativeAnchors = relativeAnchors
        self.relativeUnits = relativeUnits
    }

    init(json: [String: Any]) {
        var intents: [QueryIntent: [String]] = [:]
        for (rawKey, rawValue) in (json["intents"] as? [String: [String]] ?? [:]) {
            guard let intent = QueryIntent(rawValue: rawKey) else { continue }
            intents[intent] = rawValue.map(QueryRules.normalised)
        }
        self.intents = intents
        self.bagReferences = (json["bagReferences"] as? [String] ?? []).map(QueryRules.normalised)

        func groups(_ key: String) -> [[String]] {
            (json[key] as? [[String]] ?? []).map { $0.map(QueryRules.normalised) }
        }
        self.methods = groups("methods")
        self.devices = groups("devices")
        self.processes = groups("processes")

        let numerals = json["numerals"] as? [String: Int] ?? [:]
        self.numerals = Dictionary(uniqueKeysWithValues: numerals.compactMap { key, value in
            guard key.count == 1, let character = key.first else { return nil }
            return (character, value)
        })
        self.countUnits = (json["countUnits"] as? [String] ?? []).map(QueryRules.normalised)

        let relative = json["relative"] as? [String: Any] ?? [:]
        self.relativeAnchors = (relative["anchors"] as? [String] ?? []).map(QueryRules.normalised)
        self.relativeUnits = (relative["units"] as? [String: Int] ?? [:])
            .map { (unit: QueryRules.normalised($0.key), days: $0.value) }
            .sorted { $0.unit.count > $1.unit.count }
    }

    /// 表里的写法一律先归一化，这样匹配时只需要归一化问题文本。
    static func normalised(_ text: String) -> String {
        LexicalEmbeddingProvider.normalised(text)
    }
}

/// 问题分析器（协议 §3 的 `Question Analyzer`）。
///
/// 协议把它画成链路的第一格，因为**先决定怎么查、再去查**和「把所有东西都检索
/// 一遍」是两种质量完全不同的系统。这一层只做判断，不碰数据库。
///
/// 实现成协议是为了可替换：将来换成用模型做意图识别时，检索层一行都不用动。
protocol QueryAnalyzer: Sendable {
    func plan(
        for question: String,
        beans: [BeanHint],
        focusBeanID: UUID?,
        now: Date,
        calendar: Calendar
    ) -> QueryPlan

    /// 带对话上下文的版本（规格 §十三）。
    ///
    /// 加在协议上而不是替换旧方法，是为了让既有实现与测试里的替身一行不改就能编译：
    /// 下面 extension 里的默认实现直接忽略上下文。真正会用到上下文的只有
    /// `RuleQueryAnalyzer`。
    func plan(
        for question: String,
        beans: [BeanHint],
        focusBeanID: UUID?,
        conversation: ConversationContext,
        now: Date,
        calendar: Calendar
    ) -> QueryPlan
}

extension QueryAnalyzer {
    func plan(for question: String, beans: [BeanHint] = [], focusBeanID: UUID? = nil) -> QueryPlan {
        plan(for: question, beans: beans, focusBeanID: focusBeanID, now: Date(), calendar: DateMath.calendar)
    }

    /// 默认实现：忽略对话上下文，行为与单轮完全一致。
    func plan(
        for question: String,
        beans: [BeanHint],
        focusBeanID: UUID?,
        conversation: ConversationContext,
        now: Date,
        calendar: Calendar
    ) -> QueryPlan {
        plan(for: question, beans: beans, focusBeanID: focusBeanID, now: now, calendar: calendar)
    }
}

/// 规则式分析器。
///
/// 为什么第一版用规则而不是模型：判断「这句话在问评分还是问配方」是**确定性**的
/// 问题，关键词表能把协议里列的每一类问题都覆盖到，而且它可测、可解释、零延迟、
/// 不需要任何模型。用模型做这一层，失败时的表现是「检索范围莫名其妙」，很难查。
struct RuleQueryAnalyzer: QueryAnalyzer {

    let rules: QueryRules
    /// 指代解析器（规格 §十三）。纯值类型，不碰数据库。
    let resolver: ConversationReferenceResolver

    init(rules: QueryRules = .loaded, resolver: ConversationReferenceResolver = ConversationReferenceResolver()) {
        self.rules = rules
        self.resolver = resolver
    }

    /// 单轮入口：等于「空会话」的对话入口。
    func plan(
        for question: String,
        beans: [BeanHint],
        focusBeanID: UUID?,
        now: Date,
        calendar: Calendar
    ) -> QueryPlan {
        plan(
            for: question, beans: beans, focusBeanID: focusBeanID,
            conversation: .empty, now: now, calendar: calendar
        )
    }

    func plan(
        for question: String,
        beans: [BeanHint],
        focusBeanID: UUID?,
        conversation: ConversationContext,
        now: Date,
        calendar: Calendar
    ) -> QueryPlan {
        let raw = question.trimmed
        var plan = QueryPlan(question: raw)
        let text = QueryRules.normalised(raw)
        guard !text.isEmpty else { return plan }

        // 1 — 意图。多个意图可以同时命中，它们共同决定检索范围。
        var terms: [String] = []
        for (intent, keywords) in rules.intents.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            for keyword in keywords where !keyword.isEmpty && text.contains(keyword) {
                plan.intents.insert(intent)
                terms.append(keyword)
            }
        }

        // 2 — 用户明确问了几条。
        plan.requestedCount = requestedCount(in: text)

        // 3 — 时间范围。
        plan.filter.dateRange = recentRange(in: text, now: now)

        // 4 — 哪包豆子。这是最值钱的一步：锁定对象之后，其它豆子的记录就不会
        //     因为「读起来很像」而挤进来。
        if let matched = matchBean(in: text, beans: beans) {
            plan.focusBeanID = matched.id
            plan.focusBeanName = matched.name
            terms.append(contentsOf: matched.matchTokens.filter { text.contains(QueryRules.normalised($0)) })
        } else if let focusBeanID,
                  let bean = beans.first(where: { $0.id == focusBeanID }),
                  bindsToFocusedBag(text: text, intents: plan.intents) {
            // 从某包豆子的页面里问「这包豆…」，不必再念一遍名字。
            plan.focusBeanID = bean.id
            plan.focusBeanName = bean.name
        }

        // 5 — 冲煮方式、器具、处理法。整组塞进去当「或」条件。
        plan.filter.methods = matchedGroups(text, in: rules.methods)
        plan.filter.devices = matchedGroups(text, in: rules.devices)
        plan.filter.processes = matchedGroups(text, in: rules.processes)

        // 6 — 产地。只在没锁定单包时才用得上：锁定了单包，`beanID` 已经比产区更准。
        if plan.focusBeanID == nil {
            plan.filter.origins = matchedOrigins(text, beans: beans)
            terms.append(contentsOf: plan.filter.origins.map { QueryRules.normalised($0) })
        }

        // 7 — 检索范围。
        if plan.focusBeanID != nil {
            plan.filter.beanID = plan.focusBeanID
        } else if plan.intents == [.knowledge] {
            // 纯知识问题：用户数据进来只会挤掉答案。
            plan.filter.sourceTypes = [.knowledge]
        } else if plan.intents == [.inventory] {
            plan.filter.sourceTypes = [.bean]
        }

        // 8 — 走哪几条路。
        //
        // 两个都要走才叫混合检索：结构化给精确事实，向量给「相似」这种没有精确
        // 匹配的说法。唯一的例外是「我有几包豆」——那是一个计数问题，相似度对它
        // 没有任何帮助。
        plan.wantsStructuredFacts = !plan.intents.isEmpty || plan.focusBeanID != nil || !plan.filter.methods.isEmpty
        plan.wantsVectorSearch = plan.intents != [.inventory]

        // 9 — 对话上下文（规格 §十三）：解析这句话里的指代与承接。
        //
        // 这里只做**语义**：它指谁、在问哪个参数、算不算承接上一轮。真正的并轨
        // （补上继承来的 focus bean、冲法、实体与检索 query）由
        // `ConversationQueryPlanner` 在拿到 `Bean` 之后完成——分析器只认识值类型的
        // `BeanHint`，而实体解析需要那包豆子本身。分开的另一个好处是：
        // 这一步完全可以用几个字符串测，不需要数据库。
        plan.resolution = resolver.resolve(
            question: raw,
            conversation: conversation,
            plan: plan,
            // 用非隔离的语言码读取（`LanguageManager.shared.current` 是主 actor 的，
            // 分析器本身不是）——和 `L()` 读的是同一个锁保护的全局值。
            languageCode: currentLocaleCode()
        )

        plan.terms = Array(Set(terms)).sorted()
        plan.summary = summary(for: plan)
        return plan
    }

    // MARK: - 条数

    /// 「最近三次」「最后两杯」里的那个数。
    ///
    /// 做法是反过来找：先找到计数单位，再看它前面紧挨着的是不是一个数。这比
    /// 「找数字再看后面是什么」稳，因为中文里数字可以只是一个汉字，而数字出现
    /// 的位置远多于计数单位（日期、克数、水温里全是数字）。
    private func requestedCount(in text: String) -> Int? {
        let characters = Array(text)
        for unit in rules.countUnits where !unit.isEmpty {
            var searchStart = text.startIndex
            while let range = text.range(of: unit, range: searchStart..<text.endIndex) {
                let index = text.distance(from: text.startIndex, to: range.lowerBound)
                if let value = numberEnding(at: index, in: characters) { return value }
                searchStart = range.upperBound
            }
        }
        return nil
    }

    /// 从 `index` 往前读一个数（阿拉伯数字或中文数字），允许中间有空白。
    private func numberEnding(at index: Int, in characters: [Character]) -> Int? {
        var cursor = index - 1
        while cursor >= 0, characters[cursor].isWhitespace { cursor -= 1 }

        var digits: [Character] = []
        while cursor >= 0, characters[cursor].isASCIIDigit, digits.count < 3 {
            digits.insert(characters[cursor], at: 0)
            cursor -= 1
        }
        if !digits.isEmpty, let value = Int(String(digits)), value > 0 { return value }
        if cursor >= 0, let value = rules.numerals[characters[cursor]] { return value }
        return nil
    }

    // MARK: - 相对时间

    /// 「最近三天」这类相对时间。
    ///
    /// 只认**明确带时间单位**的说法。这一点很重要：「最近三次」也是「最近」开头，
    /// 但它问的是条数不是时间段，当成时间范围会把检索范围砍掉一大截。中英文走
    /// 同一套结构，只是单位词和时间倍率不同。
    private func recentRange(in text: String, now: Date) -> ClosedRange<Date>? {
        let characters = Array(text)

        for anchor in rules.relativeAnchors where !anchor.isEmpty {
            guard let range = text.range(of: anchor) else { continue }
            var cursor = text.distance(from: text.startIndex, to: range.upperBound)
            while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }

            var digits: [Character] = []
            while cursor < characters.count, characters[cursor].isASCIIDigit, digits.count < 3 {
                digits.append(characters[cursor])
                cursor += 1
            }
            var count = Int(String(digits))
            if count == nil, cursor < characters.count, let value = rules.numerals[characters[cursor]] {
                count = value
                cursor += 1
            }
            guard let count, count > 0 else { continue }

            while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
            let remainder = String(characters[cursor...])
            // `relativeUnits` 已按长度倒序，所以 "days" 会先于 "day" 被试到。
            guard let unit = rules.relativeUnits.first(where: { remainder.hasPrefix($0.unit) }) else { continue }

            let days = count * unit.days
            let start = DateMath.add(days: -(days - 1), to: now)
            return start <= now ? start...now : nil
        }
        return nil
    }

    // MARK: - 实体

    /// 问题里点到的是哪包豆子。取**最具体**的那个匹配。
    private func matchBean(in text: String, beans: [BeanHint]) -> BeanHint? {
        var best: (bean: BeanHint, score: Int)?
        for bean in beans {
            var score = 0
            let name = QueryRules.normalised(bean.name)
            // 整个名字命中，权重按长度给——「Ethiopia Guji」比「Guji」更确定。
            if name.count >= 2, text.contains(name) { score = max(score, name.count * 3) }
            for token in bean.matchTokens {
                let candidate = QueryRules.normalised(token)
                guard candidate.count >= 2, text.contains(candidate) else { continue }
                score = max(score, candidate.count)
            }
            guard score > 0 else { continue }
            if best == nil || score > best!.score { best = (bean, score) }
        }
        return best?.bean
    }

    /// 命中了哪些组。返回的是**整组写法**，不是命中的那一个词。
    private func matchedGroups(_ text: String, in groups: [[String]]) -> [String] {
        var found: [String] = []
        for group in groups where group.contains(where: { !$0.isEmpty && text.contains($0) }) {
            found.append(contentsOf: group)
        }
        return found
    }

    private func matchedOrigins(_ text: String, beans: [BeanHint]) -> [String] {
        var found: Set<String> = []
        for bean in beans {
            for token in bean.originTokens where text.contains(QueryRules.normalised(token)) {
                found.insert(token)
            }
        }
        return found.sorted()
    }

    private func refersToABag(_ text: String) -> Bool {
        rules.bagReferences.contains { !$0.isEmpty && text.contains($0) }
    }

    /// 从某包豆子的页面提问时，要不要把问题绑到那包豆上。
    ///
    /// 判据是「问题在说这包豆」，而不是「问题里有配方或日期词」。后者会把
    /// 「V60 一般用多少水温」这种通用问题也绑上去——而从豆子页面顺手问一个通用
    /// 问题是完全正常的，绑错了会拿一包无关的豆子去查常识。
    private func bindsToFocusedBag(text: String, intents: Set<QueryIntent>) -> Bool {
        if refersToABag(text) { return true }
        // 知识型的问法优先解释成通用问题。
        guard !intents.contains(.knowledge) else { return false }
        return intents.contains(where: \.isAboutThisBag)
    }

    /// 给用户看的一句「这次按什么在查」。
    private func summary(for plan: QueryPlan) -> String? {
        var parts: [String] = []
        if let name = plan.focusBeanName { parts.append(name) }
        if let count = plan.requestedCount { parts.append(L("最近 %@ 条", String(count))) }
        if let range = plan.filter.dateRange {
            let days = DateMath.daysBetween(range.lowerBound, range.upperBound) + 1
            parts.append(L("最近 %@ 天", String(days)))
        }
        if let method = plan.filter.methods.first { parts.append(method) }
        if !plan.filter.processes.isEmpty { parts.append(plan.filter.processes[0]) }
        if !plan.filter.origins.isEmpty { parts.append(plan.filter.origins.joined(separator: L("、"))) }
        let labels = QueryIntent.allCases
            .filter { plan.intents.contains($0) }
            .map(\.label)
        if !labels.isEmpty { parts.append(labels.joined(separator: L("、"))) }
        guard !parts.isEmpty else { return nil }
        return L("检索范围：%@", parts.joined(separator: L(" · ")))
    }
}

extension QueryIntent {
    /// 这一类问题默认指的是「当前这包豆子」——从豆子页面提问时不带名字也应该锁定它。
    var isAboutThisBag: Bool {
        switch self {
        case .recipe, .timing, .rating, .status: return true
        case .inventory, .preference, .similarity, .knowledge: return false
        }
    }
}

private extension Character {
    /// 只认阿拉伯数字。
    ///
    /// **不能只用 `isNumber`**：汉字数字（一二三…）的 Unicode 类别是 Nl（字母数字），
    /// `isNumber` 对它们返回 true。拿它当判据，「最近三次」里的「三」会被当成一个
    /// 数字字符吞掉，而 `Int("三")` 是 nil——于是条数认不出来，还悄悄回退成「没提」。
    /// 这个 bug 不会报错也不会崩，只会让检索范围变成默认值，靠测试才抓得住。
    var isASCIIDigit: Bool { isASCII && isNumber }
}
