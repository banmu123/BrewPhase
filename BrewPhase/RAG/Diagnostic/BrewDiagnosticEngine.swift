import Foundation

/// `diagnostic_rules.json` —— 诊断用的匹配词表与知识检索查询。
///
/// 和 `query_rules.json` / `conversation_rules.json` 同一个理由放在 JSON 里：
/// 这些是**匹配用的数据**，写成 Swift 字面量会被本地化流水线收成待翻译的键。
struct DiagnosticRules: Sendable {

    let dryness: [String]
    let hollow: [String]
    private let knowledgeQueries: [String: [String: String]]

    static let empty = DiagnosticRules(dryness: [], hollow: [], knowledgeQueries: [:])

    static let loaded: DiagnosticRules = {
        guard let json = BundleResource.jsonObject(named: "diagnostic_rules") else {
            // 读不到不是致命的：字面线索（干涩/水感）会失效，但时间与参数这两类
            // 数值证据完全不依赖它。
            AppLog.rag.error("diagnostic_rules.json not found; note keywords are off")
            return .empty
        }
        return DiagnosticRules(json: json)
    }()

    init(dryness: [String], hollow: [String], knowledgeQueries: [String: [String: String]]) {
        self.dryness = dryness
        self.hollow = hollow
        self.knowledgeQueries = knowledgeQueries
    }

    init(json: [String: Any]) {
        let keywords = json["notesKeywords"] as? [String: [String]] ?? [:]
        let dryness = (keywords["dryness"] ?? []).map(DiagnosticRules.normalised)
        let hollow = (keywords["hollow"] ?? []).map(DiagnosticRules.normalised)
        self.init(
            dryness: dryness,
            hollow: hollow,
            knowledgeQueries: json["knowledgeQueries"] as? [String: [String: String]] ?? [:]
        )
    }

    static func normalised(_ text: String) -> String {
        QueryRules.normalised(text)
    }

    /// 备注/标签里有没有干涩这类字面线索。
    func mentionsDryness(_ text: String) -> Bool {
        let normalised = DiagnosticRules.normalised(text)
        return dryness.contains { !$0.isEmpty && normalised.contains($0) }
    }

    /// 有没有「水感/寡淡」这类线索。
    func mentionsHollowness(_ text: String) -> Bool {
        let normalised = DiagnosticRules.normalised(text)
        return hollow.contains { !$0.isEmpty && normalised.contains($0) }
    }

    /// 取这个结论对应的知识检索查询串。
    func knowledgeQuery(for finding: DiagnosticFinding, languageCode: String) -> String? {
        guard let key = DiagnosticRules.queryKey(for: finding),
              let entry = knowledgeQueries[key]
        else { return nil }
        if let exact = entry[languageCode], !exact.isEmpty { return exact }
        let base = languageCode.split(separator: "-").first.map(String.init) ?? languageCode
        if let prefixed = entry.first(where: { $0.key.hasPrefix(base) })?.value, !prefixed.isEmpty {
            return prefixed
        }
        return entry["en"] ?? entry.values.first
    }

    /// 结论 → JSON 里的查询键。
    ///
    /// 不是直接拿 `rawValue`：JSON 的键是「症状」的名字，而枚举的 case 名带「suspected」。
    /// 把这张对照表写出来，是为了让词表文件保持人话（对着文件能看懂哪条对哪条）。
    static func queryKey(for finding: DiagnosticFinding) -> String? {
        switch finding {
        case .suspectedUnderExtraction: return "underExtraction"
        case .suspectedOverExtraction: return "overExtraction"
        case .highBitterness: return "overExtraction"
        case .fastFlow, .slowFlow: return "timeDeviation"
        case .parameterDeviation: return "parameterDeviation"
        case .lowSweetness: return "lowSweetness"
        case .thinBody: return "thinBody"
        }
    }
}

/// 冲煮诊断（规格 §九–§十三）。
///
/// 第一版的判据全部是**确定性的**：规则 + 个人历史 + 知识库，不用任何模型。
/// 「这杯是不是萃取不足」这种判断交给确定性逻辑，是因为它可解释、可测、可复现——
/// 用户下一杯改完还能验证同一个说法是不是兑现了。
///
/// 三条自律：
/// 1. 只输出**候选**加**置信度**，不说「一定」；
/// 2. 参考记录越少，置信度上限越低（`PersonalBaseline.confidenceCeiling`）；
/// 3. 证据不足时**不给建议**，只说明还缺什么——不给建议也是一个结论。
@MainActor
enum BrewDiagnosticEngine {

    static func diagnose(
        current: BrewObservation,
        beanHistory: [BrewObservation],
        allHistory: [BrewObservation],
        languageCode: String,
        rules: DiagnosticRules = .loaded,
        knowledgeService: KnowledgeSearchService = KnowledgeSearchService()
    ) -> BrewDiagnosis {

        let baseline = PersonalBaselineBuilder.baseline(
            method: current.method,
            beanHistory: beanHistory,
            allHistory: allHistory,
            requiredHighRated: IntelligenceConfig.diagnosticMinimumReferenceRecords
        )

        // 一条像样的参考记录都没有：不猜（规格 §十五/§二十六）。
        guard baseline.isUsable else {
            return .insufficient(baseline, notes: [baseline.shortfallMessage,
                                                  PersonalBaseline.keepRecordingAdvice])
        }

        let signals = Signals(current: current, baseline: baseline, rules: rules)
        var candidates: [DiagnosticCandidate] = []

        if let under = signals.underExtraction() { candidates.append(under) }
        if let over = signals.overExtraction() { candidates.append(over) }

        // 时间偏离只在「萃取不足/过萃」都没成立时才单独报——否则同一件事说两遍。
        if candidates.isEmpty {
            if let fast = signals.timeDeviation(direction: .fast) { candidates.append(fast) }
            if let slow = signals.timeDeviation(direction: .slow) { candidates.append(slow) }
        }

        // 有方向的结论之后，就不再单独报「甜感偏低」这类症状——它们已经是证据。
        if candidates.isEmpty {
            candidates.append(contentsOf: signals.standaloneSymptoms())
        }

        if let deviation = signals.parameterDeviation() { candidates.append(deviation) }

        candidates.sort { lhs, rhs in
            let left = Signals.rank(of: lhs.finding)
            let right = Signals.rank(of: rhs.finding)
            if left != right { return left < right }
            return lhs.confidence.rankValue > rhs.confidence.rankValue
        }

        var notes: [String] = [baseline.basisNote]
        if baseline.highRatedCount < IntelligenceConfig.minimumSamplesForComparison {
            notes.append(L("参考记录还只有 %@ 次，判定只是方向性的。",
                           String(baseline.highRatedCount)))
        }
        if current.filledAxes.isEmpty {
            notes.append(L("这杯没有填味觉细项，判断主要依据时间和参数。"))
        }

        guard let primary = candidates.first else {
            return .unremarkable(
                baseline,
                notes: notes + [L("这一杯在你自己的记录里没有明显异常。")]
            )
        }

        let suggestion = AdjustmentPlanner.suggestion(
            for: primary.finding,
            current: current,
            baseline: baseline,
            evidence: primary.evidence
        )
        let knowledge = knowledge(
            for: candidates.map(\.finding),
            method: current.method,
            languageCode: languageCode,
            rules: rules,
            service: knowledgeService
        )

        return BrewDiagnosis(
            candidates: candidates,
            baseline: baseline,
            suggestion: suggestion,
            notes: notes,
            knowledge: knowledge
        )
    }

    // MARK: - 知识依据（规格 §十九）

    /// 「这种表现通常可能意味着什么」——知识库回答的就是这一句。
    ///
    /// 它**不参与判断**：判断已经在规则里做完了，知识只负责把说法补上出处。
    static func knowledge(
        for findings: [DiagnosticFinding],
        method: String,
        languageCode: String,
        rules: DiagnosticRules = .loaded,
        service: KnowledgeSearchService = KnowledgeSearchService(),
        limit: Int = 2
    ) -> [KnowledgeEvidence] {
        var found: [KnowledgeEvidence] = []
        var seen = Set<String>()

        // 症状类最多一条。两篇同类条目不如「一篇对症 + 一篇顺势」：
        // 知识库目前没有通用萃取条目，症状查到的常常是别的冲法（比如意式那篇），
        // 此时配一篇这包豆这次用的冲法，用户才拿得到能上手的东西。
        if let query = findings.compactMap({ rules.knowledgeQuery(for: $0, languageCode: languageCode) }).first {
            for item in service.search(query, languageCode: languageCode, limit: 1) {
                guard seen.insert(item.documentID).inserted else { continue }
                found.append(item)
            }
        }

        if found.count < limit, !method.trimmed.isEmpty {
            let wanted = method.trimmed
            for item in service.searchByMethod(method, languageCode: languageCode, limit: limit) {
                guard found.count < limit, seen.insert(item.documentID).inserted else { continue }
                // 只补「标题里真的写着这种冲法」的那篇。
                //
                // 知识库里有些条目只是**提到**某种冲法（冷萃那篇提到 V60），把它们
                // 当作「这杯用的冲法」挂上来会误导——用户在 V60 的诊断卡上看到一篇
                // 冷萃，比少给一条知识更糟。
                guard item.title.localizedCaseInsensitiveContains(wanted) else { continue }
                found.append(item)
            }
        }
        return found
    }

    // MARK: - 判据

    /// 一次诊断用到的全部信号计算。做成内部类型，是为了让「阈值怎么算」集中在一处。
    @MainActor
    private struct Signals {
        let current: BrewObservation
        let baseline: PersonalBaseline
        let rules: DiagnosticRules

        // MARK: 轴的高低（个人优先，绝对兜底）

        /// 某条轴是不是**比你自己好喝的那几杯更高**。没有个人基线时才用绝对阈值。
        func isHigh(_ axis: TasteAxis) -> Bool {
            let value = current.axis(axis)
            guard value > 0 else { return false }
            if let stats = baseline.axes.stats(of: axis), stats.count > 0 {
                return Double(value) > stats.maximum
            }
            return value >= IntelligenceConfig.diagnosticHighAxisThreshold
        }

        func isLow(_ axis: TasteAxis) -> Bool {
            let value = current.axis(axis)
            guard value > 0 else { return false }
            if let stats = baseline.axes.stats(of: axis), stats.count > 0 {
                return Double(value) < stats.minimum
            }
            return value <= IntelligenceConfig.diagnosticLowAxisThreshold
        }

        // MARK: 时间

        /// 相比个人区间快/慢了多少秒。正数表示当前更短。
        var timeDeltaFromRange: (seconds: Double, range: ClosedRange<Double>)? {
            guard current.timeSeconds > 0, let range = baseline.range(of: .time) else { return nil }
            let value = Double(current.timeSeconds)
            if value < range.lowerBound { return (range.lowerBound - value, range) }
            if value > range.upperBound { return (value - range.upperBound, range) }
            return (0, range)
        }

        var timeEvidence: String? {
            guard let delta = timeDeltaFromRange, delta.seconds > 0, let range = baseline.range(of: .time) else {
                return nil
            }
            let rangeText = L("%@–%@", BrewMath.formatTime(Int(range.lowerBound.rounded())),
                              BrewMath.formatTime(Int(range.upperBound.rounded())))
            return delta.seconds > 0 && Double(current.timeSeconds) < range.lowerBound
                ? L("本次 %@，你的较好记录在 %@（快 %@）",
                    current.recipe.timeText, rangeText,
                    BrewParameter.time.formattedDelta(delta.seconds))
                : L("本次 %@，你的较好记录在 %@（慢 %@）",
                    current.recipe.timeText, rangeText,
                    BrewParameter.time.formattedDelta(delta.seconds))
        }

        // MARK: 规则 1 / 2

        func underExtraction() -> DiagnosticCandidate? {
            guard let delta = timeDeltaFromRange,
                  let range = baseline.range(of: .time),
                  Double(current.timeSeconds) < range.lowerBound,
                  delta.seconds >= IntelligenceConfig.diagnosticTimeMarginSeconds
            else { return nil }

            let acidHigh = isHigh(.acidity)
            let sweetLow = isLow(.sweetness)
            guard acidHigh || sweetLow else { return nil }

            var evidence: [String] = []
            if let timeEvidence { evidence.append(timeEvidence) }
            if let acid = axisLine(.acidity, high: true) { evidence.append(acid) }
            if let sweet = axisLine(.sweetness, high: false) { evidence.append(sweet) }
            if isLow(.body) { evidence.append(bodyLine()) }

            let signalCount = 1 + (acidHigh ? 1 : 0) + (sweetLow ? 1 : 0)
            return DiagnosticCandidate(
                finding: .suspectedUnderExtraction,
                confidence: capped(signalCount >= 3 ? .high : (signalCount == 2 ? .medium : .low)),
                evidence: evidence
            )
        }

        func overExtraction() -> DiagnosticCandidate? {
            guard let delta = timeDeltaFromRange,
                  let range = baseline.range(of: .time),
                  Double(current.timeSeconds) > range.upperBound,
                  delta.seconds >= IntelligenceConfig.diagnosticTimeMarginSeconds
            else { return nil }

            let bitterHigh = isHigh(.bitterness)
            let dry = rules.mentionsDryness(current.text)
            guard bitterHigh || dry else { return nil }

            var evidence: [String] = []
            if let timeEvidence { evidence.append(timeEvidence) }
            if let bitter = axisLine(.bitterness, high: true) { evidence.append(bitter) }
            if dry { evidence.append(L("备注里出现了干涩这类感觉：%@", current.notes.trimmed)) }

            let signalCount = 1 + (bitterHigh ? 1 : 0) + (dry ? 1 : 0)
            return DiagnosticCandidate(
                finding: .suspectedOverExtraction,
                confidence: capped(signalCount >= 3 ? .high : (signalCount == 2 ? .medium : .low)),
                evidence: evidence
            )
        }

        // MARK: 规则 3

        enum TimeDirection { case fast, slow }

        func timeDeviation(direction: TimeDirection) -> DiagnosticCandidate? {
            guard let delta = timeDeltaFromRange,
                  let range = baseline.range(of: .time),
                  delta.seconds >= IntelligenceConfig.diagnosticTimeMarginSeconds,
                  let timeEvidence
            else { return nil }

            let value = Double(current.timeSeconds)
            switch direction {
            case .fast where value >= range.lowerBound: return nil
            case .slow where value <= range.upperBound: return nil
            default: break
            }

            return DiagnosticCandidate(
                finding: direction == .fast ? .fastFlow : .slowFlow,
                confidence: capped(.medium),
                evidence: [timeEvidence]
            )
        }

        // MARK: 规则 4

        /// 参数偏离个人区间。**不含时间**——时间已经由上面几条覆盖，说两遍是噪声。
        func parameterDeviation() -> DiagnosticCandidate? {
            var lines: [String] = []
            for parameter in [BrewParameter.temperature, .ratio, .dose] {
                guard let value = current.value(of: parameter),
                      let range = baseline.range(of: parameter),
                      let stats = baseline.stats(of: parameter)
                else { continue }
                let outsideLow = value < range.lowerBound - parameter.tolerance
                let outsideHigh = value > range.upperBound + parameter.tolerance
                guard outsideLow || outsideHigh else { continue }
                lines.append(L("%@ 本次 %@，你的较好记录在 %@–%@",
                               parameter.label,
                               parameter.formatted(value),
                               parameter.formatted(range.lowerBound),
                               parameter.formatted(range.upperBound)))
            }
            guard !lines.isEmpty else { return nil }
            return DiagnosticCandidate(
                finding: .parameterDeviation,
                confidence: capped(lines.count >= 2 ? .high : .medium),
                evidence: lines
            )
        }

        // MARK: 症状类（只在没有方向性结论时单独出现）

        func standaloneSymptoms() -> [DiagnosticCandidate] {
            var found: [DiagnosticCandidate] = []
            if isLow(.sweetness), let line = axisLine(.sweetness, high: false) {
                found.append(DiagnosticCandidate(finding: .lowSweetness,
                                                 confidence: capped(.medium), evidence: [line]))
            }
            if isHigh(.bitterness), let line = axisLine(.bitterness, high: true) {
                found.append(DiagnosticCandidate(finding: .highBitterness,
                                                 confidence: capped(.medium), evidence: [line]))
            }
            if isLow(.body) || rules.mentionsHollowness(current.text) {
                found.append(DiagnosticCandidate(finding: .thinBody,
                                                 confidence: capped(.low), evidence: [bodyLine()]))
            }
            return found
        }

        // MARK: 证据行

        func axisLine(_ axis: TasteAxis, high: Bool) -> String? {
            let value = current.axis(axis)
            guard value > 0 else { return nil }
            guard let stats = baseline.axes.stats(of: axis), stats.count > 0 else {
                return L("这杯的 %@ 是 %@/5", axis.label, String(value))
            }
            if high {
                return L("这杯的 %@ 是 %@/5，你较好记录里最高 %@",
                         axis.label, String(value), Fmt.number(stats.maximum))
            }
            return L("这杯的 %@ 是 %@/5，你较好记录里最低 %@",
                     axis.label, String(value), Fmt.number(stats.minimum))
        }

        func bodyLine() -> String {
            let value = current.axis(.body)
            if rules.mentionsHollowness(current.text) {
                return L("备注里出现了水感/寡淡这类感觉：%@", current.notes.trimmed)
            }
            return value > 0 ? L("这杯的醇厚是 %@/5", String(value)) : L("这杯没有填醇厚")
        }

        // MARK: 置信度

        /// 置信度**先被样本量封顶**，再看信号数量（规格 §十五）。
        func capped(_ confidence: Insight.Confidence) -> Insight.Confidence {
            let ceiling = baseline.confidenceCeiling
            return confidence.rankValue > ceiling.rankValue ? ceiling : confidence
        }

        /// 候选的展示顺序：先方向性结论，再时间，再症状，最后参数偏离。
        static func rank(of finding: DiagnosticFinding) -> Int {
            switch finding {
            case .suspectedUnderExtraction: return 0
            case .suspectedOverExtraction: return 1
            case .fastFlow: return 2
            case .slowFlow: return 3
            case .lowSweetness: return 4
            case .highBitterness: return 5
            case .thinBody: return 6
            case .parameterDeviation: return 7
            }
        }
    }
}

extension Insight.Confidence {
    /// 排序用的权重（越大越强）。
    var rankValue: Int {
        switch self {
        case .high: return 3
        case .medium: return 2
        case .low: return 1
        case .insufficientEvidence: return 0
        }
    }
}
