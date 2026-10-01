import SwiftData
import XCTest
@testable import BrewPhase

/// 多轮对话（Conversational Intelligence V1）的测试。
///
/// 分两段，是有意的：
///
/// * **规则单测**——指代解析、优先级、状态清理、检索扩写。这些是确定性行为，
///   断言精确值：它们变了一定是回归。
/// * **端到端**——从一句中文问题走完整条链路（真规则表、真索引、真抽取式回答），
///   覆盖规格 §49–§59 的 11 个场景。断言的是「继承对不对、切换对不对、不猜对不对」，
///   而不是回答措辞。
@MainActor
final class ConversationTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private var engine: AskEngine!

    private let today = Date()
    private var guji: Bean!
    private var huila: Bean!

    override func setUpWithError() throws {
        LanguageManager.pinForTesting(.simplifiedChinese)
        let schema = Schema([
            Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self, EmbeddingRecord.self,
        ])
        container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        context = ModelContext(container)
        engine = AskEngine(context: context)
        try seed()
    }

    override func tearDown() {
        engine = nil
        context = nil
        container = nil
    }

    // MARK: - 夹具

    private func seed() throws {
        let guji = Bean(
            name: "Ethiopia Guji", roaster: "启程咖啡", origin: "埃塞俄比亚 · Guji", process: "水洗",
            roastLevel: .light,
            roastDate: DateMath.add(days: -16, to: today),
            openDate: DateMath.add(days: -10, to: today),
            weightG: 200, remainingG: 86,
            flavorTags: ["Jasmine", "Mandarin"], notes: "手冲首选"
        )
        context.insert(guji)
        self.guji = guji

        for (offset, temp, score) in [(13, 93.0, 4), (9, 92.0, 5), (4, 92.0, 5)] {
            context.insert(Brew(
                date: DateMath.add(days: -offset, to: today), method: "V60",
                grinder: "司令官 C40", grindSize: "22 格", waterTemp: temp,
                coffeeG: 18, waterG: 300, timeSeconds: 150, score: score,
                flavorTags: ["Mandarin"], notes: "花香", bean: guji
            ))
        }

        let huila = Bean(
            name: "Colombia Huila", roaster: "启程咖啡", origin: "哥伦比亚 · Huila", process: "水洗",
            roastLevel: .medium,
            roastDate: DateMath.add(days: -9, to: today),
            weightG: 250, remainingG: 200, flavorTags: ["Caramel"], notes: ""
        )
        context.insert(huila)
        self.huila = huila

        try context.save()
    }

    private func hints() throws -> [BeanHint] {
        try context.fetch(FetchDescriptor<Bean>()).map(BeanHint.init(bean:))
    }

    /// 只跑到「计划」为止：用真实规则表 + 真实实体图，不碰数据库索引。
    private func plan(
        _ question: String,
        conversation: ConversationContext = .empty,
        focus: UUID? = nil
    ) throws -> QueryPlan {
        RuleQueryAnalyzer(rules: .loaded).plan(
            for: question,
            beans: try hints(),
            focusBeanID: focus,
            conversation: conversation,
            now: today,
            calendar: DateMath.calendar
        )
    }

    private func ask(
        _ question: String,
        conversation: inout ConversationContext,
        focus: UUID? = nil
    ) async throws -> AskAnswer {
        let answer = await engine.ask(
            question,
            focusBeanID: focus,
            conversation: conversation,
            beans: try context.fetch(FetchDescriptor<Bean>()),
            brews: try context.fetch(FetchDescriptor<Brew>()),
            tastings: try context.fetch(FetchDescriptor<Tasting>()),
            book: PhaseRuleBook.make(stored: try context.fetch(FetchDescriptor<PhaseRule>())),
            settings: RAGSettings.standard,
            languageCode: "zh-Hans",
            now: today
        )
        conversation = answer.conversationUpdate
        return answer
    }

    // MARK: - 指代解析（规则单测）

    func testABagReferenceResolvesToTheLockedBagInsteadOfAskingAgain() throws {
        var conversation = ConversationContext.empty
        conversation.focusBeanID = guji.id
        conversation.focusBeanName = guji.displayName

        let resolution = ConversationReferenceResolver().resolve(
            question: "这包豆现在怎么样？",
            conversation: conversation,
            plan: try plan("这包豆现在怎么样？"),
            languageCode: "zh-Hans"
        )

        XCTAssertEqual(resolution.beanID, guji.id)
        XCTAssertEqual(resolution.beanSource, .conversation)
        XCTAssertNil(resolution.ambiguity, "有锁定对象就不该再问一遍")
    }

    /// 规格 §54：没有可解析的指代对象时必须明确提示，**不猜**。
    func testAReferenceWithNoReferentIsFlaggedRatherThanGuessed() throws {
        let resolution = ConversationReferenceResolver().resolve(
            question: "它怎么样？",
            conversation: .empty,
            plan: try plan("它怎么样？"),
            languageCode: "zh-Hans"
        )

        XCTAssertNil(resolution.beanID)
        let ambiguity = try XCTUnwrap(resolution.ambiguity)
        XCTAssertEqual(ambiguity.kind, .bean)
        XCTAssertEqual(ambiguity.phrase, "它")
    }

    /// 「那…呢」这种承接词足以说明这句话在延续上一轮，但它本身**不要求**有指代对象。
    func testAFollowUpMarkerInheritsTheThread() throws {
        var conversation = ConversationContext.empty
        conversation.focusBeanID = guji.id
        conversation.focusBeanName = guji.displayName

        let resolution = ConversationReferenceResolver().resolve(
            question: "那用 V60 呢？",
            conversation: conversation,
            plan: try plan("那用 V60 呢？"),
            languageCode: "zh-Hans"
        )

        XCTAssertTrue(resolution.isFollowUp)
        XCTAssertEqual(resolution.beanID, guji.id)
        XCTAssertEqual(resolution.method?.label.lowercased(), "v60", "方式应当是用户说的那个写法")
        XCTAssertEqual(resolution.methodSource, .explicit)
        XCTAssertNil(resolution.ambiguity)
    }

    /// 规格 §58：显式说了新方式就必须覆盖上一轮的。
    func testAnExplicitMethodOverridesTheInheritedOne() throws {
        var conversation = ConversationContext.empty
        conversation.activeMethod = MethodReference(label: "V60", spellings: ["V60", "v60"])

        let question = "改用 Espresso。"
        let analyzed = try plan(question, conversation: conversation)
        let resolution = ConversationReferenceResolver().resolve(
            question: question, conversation: conversation, plan: analyzed, languageCode: "zh-Hans"
        )

        XCTAssertEqual(resolution.methodSource, .explicit)
        XCTAssertEqual(resolution.method?.label.lowercased(), "espresso")
        XCTAssertFalse(resolution.method?.spellings.contains("V60") ?? true,
                       "显式覆盖时不能把上一轮那组写法也带上")
    }

    /// 规格 §51：方向词必须结合上一轮的参数解析；解析不出来就报缺对象。
    func testAParameterDirectionNeedsThePreviousParameter() throws {
        var conversation = ConversationContext.empty
        conversation.activeParameter = .temperature
        let question = "低一点呢？"

        let resolution = ConversationReferenceResolver().resolve(
            question: question, conversation: conversation,
            plan: try plan(question), languageCode: "zh-Hans"
        )

        XCTAssertEqual(resolution.parameter, .temperature)
        XCTAssertEqual(resolution.direction, .lower)
        XCTAssertNil(resolution.ambiguity)

        let orphan = ConversationReferenceResolver().resolve(
            question: question, conversation: .empty,
            plan: try plan(question), languageCode: "zh-Hans"
        )
        XCTAssertEqual(orphan.ambiguity?.kind, .parameter, "没有上一轮参数就不该默认成水温")
    }

    /// 方向词只表示方向，**不产生新数值**（规格 §38）。
    func testADirectionDoesNotInventAValue() throws {
        var conversation = ConversationContext.empty
        conversation.activeParameter = .temperature
        let resolution = ConversationReferenceResolver().resolve(
            question: "低一点呢？", conversation: conversation,
            plan: try plan("低一点呢？"), languageCode: "zh-Hans"
        )

        XCTAssertEqual(resolution.direction, .lower)
        XCTAssertEqual(resolution.parameter, .temperature)
        // 解析结果里根本没有「数值」这个字段——这就是不编数字在类型上的保证。
        XCTAssertFalse(String(describing: resolution).contains("89"))
        XCTAssertFalse(String(describing: resolution).contains("91"))
    }

    /// 规格 §53：「这种处理法」落在上一轮那包豆子的处理法实体上。
    func testATypedReferencePicksTheEntityFromTheBeanContext() throws {
        var conversation = ConversationContext.empty
        conversation.focusBeanID = guji.id
        conversation.directEntityIDs = ["origin.ethiopia", "region.guji", "process.washed", "roast.light"]

        let question = "这种处理法呢？"
        let resolution = ConversationReferenceResolver().resolve(
            question: question, conversation: conversation,
            plan: try plan(question, conversation: conversation), languageCode: "zh-Hans"
        )

        XCTAssertEqual(resolution.referencedEntityIDs, ["process.washed"])
        XCTAssertEqual(resolution.topic, .processing)
        XCTAssertNil(resolution.ambiguity)
    }

    // MARK: - 状态推进（规则单测）

    func testTheStateUpdaterClearsBeanScopedStateOnASwitch() throws {
        var previous = ConversationContext.empty
        previous.turnIndex = 2
        previous.focusBeanID = guji.id
        previous.focusBeanName = guji.displayName
        previous.directEntityIDs = ["process.washed", "roast.light"]
        previous.ancestorEntityIDs = ["origin.ethiopia"]
        previous.activeMethod = MethodReference(label: "V60", spellings: ["V60", "v60"])
        previous.activeParameter = .temperature
        previous.recentEvidence = [
            EvidenceRef(id: "brew:\(UUID().uuidString)", sourceType: .brew, beanID: guji.id, turnIndex: 2)
        ]

        // 「那 Colombia Huila 呢？」——新豆子是显式匹配出来的。
        let plan = try plan("那 Colombia Huila 呢？", conversation: previous)
        XCTAssertEqual(plan.focusBeanID, huila.id)

        let next = ConversationStateUpdater.next(
            previous: previous, plan: plan, evidence: [],
            beanContext: nil, languageCode: "zh-Hans"
        )

        XCTAssertEqual(next.focusBeanID, huila.id)
        XCTAssertNil(next.activeMethod, "上一包豆子语境里的冲法不该跟过来")
        XCTAssertNil(next.activeParameter)
        XCTAssertTrue(next.directEntityIDs.isEmpty)
        XCTAssertTrue(next.ancestorEntityIDs.isEmpty)
        XCTAssertTrue(next.recentEvidence.isEmpty, "上一包豆子的证据必须清掉")
        XCTAssertEqual(next.activeTopic, .bean, "话题保留「在聊豆子」这一层")
        XCTAssertEqual(next.turnIndex, 3)
        XCTAssertEqual(next.conversationID, previous.conversationID, "换豆子不等于换会话")
    }

    /// 一次没问清的追问不该把上一轮建立起来的上下文冲掉（规格 §四十五 的反面）。
    func testAClarificationTurnDoesNotWipeTheState() throws {
        var previous = ConversationContext.empty
        previous.turnIndex = 1
        previous.focusBeanID = guji.id
        previous.activeMethod = MethodReference(label: "V60", spellings: ["V60", "v60"])
        previous.activeTopic = .brewing

        let plan = try plan("它怎么样？", conversation: .empty)
        XCTAssertNotNil(plan.clarification)

        let next = ConversationStateUpdater.next(
            previous: previous, plan: plan, evidence: [],
            beanContext: nil, languageCode: "zh-Hans"
        )

        XCTAssertEqual(next.turnIndex, 2)
        XCTAssertEqual(next.focusBeanID, guji.id)
        XCTAssertEqual(next.activeMethod?.label, "V60")
        XCTAssertEqual(next.activeTopic, .brewing)
    }

    func testTheEvidenceWindowKeepsOnlyTheRecentTurns() throws {
        let old = (1...3).map {
            EvidenceRef(id: "brew:t\($0)", sourceType: .brew, beanID: guji.id, turnIndex: $0)
        }
        let fresh = EvidenceRef(id: "brew:t4", sourceType: .brew, beanID: guji.id, turnIndex: 4)

        let kept = ConversationStateUpdater.window(previous: old, evidence: [fresh], turnIndex: 4)
        XCTAssertFalse(kept.contains { $0.id == "brew:t1" }, "超过窗口轮数的证据应当过期")
        XCTAssertTrue(kept.contains { $0.id == "brew:t3" })
        XCTAssertTrue(kept.contains { $0.id == "brew:t4" })

        // 同一条只留最近一次引用。
        let duplicated = ConversationStateUpdater.window(
            previous: [EvidenceRef(id: "brew:same", sourceType: .brew, beanID: nil, turnIndex: 3)],
            evidence: [EvidenceRef(id: "brew:same", sourceType: .brew, beanID: nil, turnIndex: 4)],
            turnIndex: 4
        )
        XCTAssertEqual(duplicated.count, 1)
        XCTAssertEqual(duplicated.first?.turnIndex, 4)
    }

    func testThePrimaryIntentPrefersTheStructuralQuestion() {
        XCTAssertEqual(ConversationStateUpdater.primaryIntent(of: [.inventory, .recipe]), .inventory)
        XCTAssertEqual(ConversationStateUpdater.primaryIntent(of: [.knowledge, .recipe]), .recipe)
        XCTAssertEqual(ConversationStateUpdater.primaryIntent(of: [.similarity, .preference]), .similarity)
        XCTAssertNil(ConversationStateUpdater.primaryIntent(of: []))
    }

    // MARK: - 上下文并轨（规则单测）

    /// 省略句才扩写检索 query：一句独立的新问题不该被上一轮的豆子污染。
    func testTheRetrievalQueryOnlyExpandsForFollowUps() throws {
        var conversation = ConversationContext.empty
        conversation.focusBeanID = guji.id
        conversation.focusBeanName = guji.displayName
        conversation.activeMethod = MethodReference(label: "V60", spellings: ["V60", "v60"])
        let beanContext = BeanContextResolver().context(for: guji, today: today)

        let followUp = "那水温呢？"
        let planned = ConversationQueryPlanner.apply(
            try plan(followUp, conversation: conversation),
            conversation: conversation, beanContext: beanContext, languageCode: "zh-Hans"
        )
        XCTAssertTrue(planned.retrievalQuery.contains("V60"), planned.retrievalQuery)
        XCTAssertTrue(planned.retrievalQuery.contains("Guji") || planned.retrievalQuery.contains("水洗"),
                      planned.retrievalQuery)
        XCTAssertTrue(planned.retrievalQuery.hasPrefix(followUp), "问题本身必须留在最前面")

        let standalone = "V60 一般用多少水温？"
        let untouched = ConversationQueryPlanner.apply(
            try plan(standalone), conversation: .empty, beanContext: nil, languageCode: "zh-Hans"
        )
        XCTAssertEqual(untouched.retrievalQuery, standalone)
        XCTAssertEqual(untouched.effectiveRetrievalQuery, standalone)
    }

    /// 继承来的实体**不是硬过滤条件**（不然水质/新鲜度那几篇没有 entityIds 的知识会被筛掉）。
    func testInheritedEntitiesNeverBecomeHardFilters() throws {
        var conversation = ConversationContext.empty
        conversation.focusBeanID = guji.id
        let beanContext = BeanContextResolver().context(for: guji, today: today)

        let planned = ConversationQueryPlanner.apply(
            try plan("那水温呢？", conversation: conversation),
            conversation: conversation, beanContext: beanContext, languageCode: "zh-Hans"
        )

        XCTAssertFalse(planned.inheritedEntityIDs.isEmpty, "实体该继承，供扩写用")
        XCTAssertTrue(planned.filter.entityIDs.isEmpty, "但不能变成过滤条件")
        XCTAssertEqual(planned.filter.beanID, guji.id, "收窄范围靠豆子 id")
    }

    /// 规格 §39/§59：推荐型问题不能被继承来的豆子收窄，但豆子留在对话状态里。
    func testARecommendationQuestionIsNotNarrowedByTheInheritedBag() throws {
        var conversation = ConversationContext.empty
        conversation.focusBeanID = guji.id
        conversation.focusBeanName = guji.displayName

        let planned = ConversationQueryPlanner.apply(
            try plan("那今天先喝它吗？", conversation: conversation),
            conversation: conversation, beanContext: nil, languageCode: "zh-Hans"
        )

        XCTAssertTrue(planned.intents.contains(.inventory))
        XCTAssertNil(planned.focusBeanID, "问「哪包」时不该锁定某一包")
        XCTAssertNil(planned.filter.beanID)
        XCTAssertFalse(planned.wantsVectorSearch, "推荐是规则问题，不该走语义检索")
        XCTAssertEqual(planned.resolution?.beanID, guji.id, "但状态里还留着正在聊的那包")
    }

    // MARK: - 端到端：规格 §49–§59

    /// Case 1（§49）：Bean 继承。
    func testCase1ABeanIsInheritedIntoTheNextTurn() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("这包 Ethiopia Guji 水洗豆怎么样？", conversation: &conversation)
        XCTAssertEqual(conversation.focusBeanID, guji.id)
        XCTAssertTrue(conversation.directEntityIDs.contains("region.guji"))
        XCTAssertTrue(conversation.directEntityIDs.contains("process.washed"))
        XCTAssertTrue(conversation.allEntityIDs.contains("origin.ethiopia"))
        // Ethiopia 在这一轮是**明说**的（`origin` 字段里就写着「埃塞俄比亚 · Guji」），
        // 真正靠层级推出来的是它上面那两层。
        XCTAssertTrue(conversation.ancestorEntityIDs.contains("origin.africa"),
                      "祖先应当是推出来的：\(conversation.allEntityIDs)")

        let second = try await ask("那用 V60 呢？", conversation: &conversation)

        XCTAssertEqual(second.plan.focusBeanID, guji.id, "第二轮必须还锁着那包豆")
        XCTAssertEqual(second.plan.filter.beanID, guji.id)
        XCTAssertTrue(second.plan.filter.methods.contains("v60"))
        XCTAssertTrue(second.plan.inheritedEntityIDs.contains("process.washed"))
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "v60")
        XCTAssertEqual(conversation.focusBeanID, guji.id)
    }

    /// Case 2（§50）：方法继承——「那水温呢」问的是 V60 的水温，不是通用水温。
    func testCase2AMethodIsInheritedAndScopesTheWaterQuestion() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("这包豆适合 V60 吗？", conversation: &conversation, focus: guji.id)
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "v60")

        let second = try await ask("那水温呢？", conversation: &conversation)

        XCTAssertTrue(second.plan.filter.methods.contains("v60"), "V60 要跟过来")
        XCTAssertEqual(second.plan.topic, .water)
        XCTAssertEqual(second.plan.parameter, .temperature)
        XCTAssertTrue(second.plan.retrievalQuery.contains("V60"),
                      "检索 query 要带上 V60，否则问的是通用水温：\(second.plan.retrievalQuery)")
        XCTAssertEqual(second.plan.focusBeanID, guji.id)
        XCTAssertEqual(second.plan.resolution?.methodSource, .conversation)
        XCTAssertEqual(second.plan.resolution?.parameterSource, .explicit)
    }

    /// Case 3（§51）：连续参数——「低一点呢」要接上一轮的水温。
    func testCase3ADirectionAttachesToThePreviousParameter() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("Guji 用 92°C 怎么样？", conversation: &conversation)
        XCTAssertEqual(conversation.focusBeanID, guji.id)
        XCTAssertEqual(conversation.activeParameter, .temperature)

        let second = try await ask("低一点呢？", conversation: &conversation)

        XCTAssertEqual(second.plan.parameter, .temperature)
        XCTAssertEqual(second.plan.direction, .lower)
        XCTAssertEqual(second.plan.focusBeanID, guji.id, "参数追问仍然锁着那包豆")
        XCTAssertNil(second.plan.clarification, "方向接得上就不该报缺对象")
        // 方向不产生新数值：回答里出现的温度只能来自用户自己的记录。
        XCTAssertTrue(second.text.contains("92") || second.text.contains("93") || second.text.contains("没有找到"),
                      second.text)
    }

    /// Case 4（§52）：换豆子要清掉上一包的专属状态。
    func testCase4SwitchingBeansClearsTheOldBagState() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("看看 Guji。", conversation: &conversation)
        XCTAssertEqual(conversation.focusBeanID, guji.id)
        XCTAssertFalse(conversation.allEntityIDs.isEmpty)

        let second = try await ask("那 Colombia Huila 呢？", conversation: &conversation)

        XCTAssertEqual(second.plan.focusBeanID, huila.id)
        XCTAssertEqual(second.plan.filter.beanID, huila.id)
        XCTAssertEqual(conversation.focusBeanID, huila.id)
        XCTAssertTrue(conversation.directEntityIDs.allSatisfy { !$0.contains("guji") },
                      "上一包豆子的实体不该留下：\(conversation.allEntityIDs)")
        XCTAssertTrue(conversation.recentEvidence.allSatisfy { $0.beanID != guji.id },
                      "上一包豆子的证据不该留下：\(conversation.recentEvidence.map(\.id))")
        XCTAssertNil(conversation.activeMethod)
    }

    /// Case 5（§53）：指代上一轮的处理法。
    func testCase5AProcessingReferenceResolvesToTheInheritedEntity() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("这包 Ethiopia Guji 水洗豆怎么样？", conversation: &conversation)
        XCTAssertTrue(conversation.directEntityIDs.contains("process.washed"))

        let second = try await ask("这种处理法呢？", conversation: &conversation)

        XCTAssertEqual(second.plan.resolution?.referencedEntityIDs, ["process.washed"])
        XCTAssertEqual(second.plan.topic, .processing)
        XCTAssertEqual(second.plan.focusBeanID, guji.id)
    }

    /// Case 6（§54）：没有可解析的指代对象时明确提示，且不检索。
    func testCase6AnUnresolvableReferenceAsksInsteadOfSearching() async throws {
        var conversation = ConversationContext.empty

        let first = try await ask("V60 怎么冲？", conversation: &conversation)
        XCTAssertNil(first.plan.focusBeanID, "这句话没有点任何一包豆子")
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "v60")

        let second = try await ask("它怎么样？", conversation: &conversation)

        XCTAssertNotNil(second.plan.clarification)
        XCTAssertEqual(second.plan.clarification?.kind, .bean)
        XCTAssertTrue(second.context.isEmpty, "没对象就不该检索，检索结果只会是噪声")
        XCTAssertTrue(second.text.contains("不猜"), second.text)
        XCTAssertEqual(conversation.focusBeanID, nil, "一次没问清的话不该凭空给会话塞一包豆子")
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "v60", "上一轮的方式要保住")
    }

    /// Case 7（§55）：知识库范围——继承上下文不等于可以编内容。
    func testCase7AnInheritedBagDoesNotLicenseInventingContent() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("Guji 是什么？", conversation: &conversation)
        let second = try await ask("那它适合什么处理法？", conversation: &conversation)

        XCTAssertEqual(second.plan.focusBeanID, guji.id, "「它」应当落在那包豆上")
        XCTAssertTrue(second.context.hasKnowledge || second.text.contains("没有找到"),
                      "要么给出知识库里的真实条目，要么如实说没找到：\(second.text)")

        // 回答里出现的处理法必须能在引用到的资料里找到出处。
        let cited = second.citations.map(\.passage.content).joined(separator: "\n")
        for process in ["日晒", "蜜处理", "厌氧", "湿刨"] {
            if second.text.contains(process) {
                XCTAssertTrue(cited.contains(process) || second.question.contains(process),
                              "回答里出现了没有出处的「\(process)」：\n\(second.text)")
            }
        }
    }

    /// Case 8（§56）：个人历史要继承 focusBean。
    func testCase8PersonalHistoryInheritsTheBag() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("我这包豆过去冲得怎么样？", conversation: &conversation, focus: guji.id)
        let second = try await ask("有没有类似的？", conversation: &conversation)

        XCTAssertTrue(second.plan.intents.contains(.similarity))
        XCTAssertEqual(second.plan.focusBeanID, guji.id, "找相似也要锁在同一包豆上，否则会捞到别人的记录")
        XCTAssertTrue(second.plan.filter.beanID == guji.id)
        XCTAssertTrue(second.plan.resolution?.isFollowUp == true)
    }

    /// Case 9（§57）：推荐要切到结构化规则，不再是语义检索。
    func testCase9RecommendationSwitchesToTheRuleEngine() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("这包豆用 V60 怎么样？", conversation: &conversation, focus: guji.id)
        XCTAssertEqual(conversation.focusBeanID, guji.id)

        let second = try await ask("今天我应该先喝哪包？", conversation: &conversation)

        XCTAssertTrue(second.plan.intents.contains(.inventory))
        XCTAssertNil(second.plan.focusBeanID, "推荐问的是所有豆子")
        XCTAssertTrue(second.context.hasFacts, "推荐由结构化直查（规则）给出，不是语义检索")
        XCTAssertTrue(second.text.contains("Guji") || second.text.contains("Huila"), second.text)
        XCTAssertEqual(conversation.focusBeanID, guji.id, "问完推荐，正在聊的那包豆还在")
        XCTAssertEqual(conversation.activeIntent, .inventory)
    }

    /// Case 10（§58）：显式新信息覆盖旧上下文。
    func testCase10AnExplicitMethodWinsOverTheInheritedOne() async throws {
        var conversation = ConversationContext.empty

        _ = try await ask("Guji 用 V60。", conversation: &conversation)
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "v60")

        let second = try await ask("改用 Espresso。", conversation: &conversation)

        XCTAssertTrue(second.plan.filter.methods.contains("espresso"))
        XCTAssertFalse(second.plan.filter.methods.contains("V60"), "V60 不该被带进来")
        XCTAssertEqual(second.plan.resolution?.methodSource, .explicit)
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "espresso")
        XCTAssertEqual(conversation.focusBeanID, guji.id, "换的是冲法，不是豆子")
    }

    /// Case 11（§59）：六轮连问，逐轮检查继承与切换。
    func testCase11ASixTurnConversationKeepsTheThread() async throws {
        var conversation = ConversationContext.empty
        let sessionID = conversation.conversationID

        // 1 — 认豆。
        _ = try await ask("这包 Ethiopia Guji 水洗浅烘豆怎么样？", conversation: &conversation)
        XCTAssertEqual(conversation.focusBeanID, guji.id)
        XCTAssertTrue(conversation.directEntityIDs.contains("process.washed"))
        // 烘焙度是从枚举**推**出来的（豆子上没有「烘焙度」这个自由文本字段），
        // 所以它落在 inferred 那一档。
        XCTAssertTrue(conversation.allEntityIDs.contains("roast.light"))
        XCTAssertTrue(conversation.ancestorEntityIDs.contains("roast.light"))

        // 2 — 方式。
        _ = try await ask("V60 呢？", conversation: &conversation)
        XCTAssertEqual(conversation.activeMethod?.label.lowercased(), "v60")
        XCTAssertEqual(conversation.focusBeanID, guji.id)

        // 3 — 参数。
        let third = try await ask("水温呢？", conversation: &conversation)
        XCTAssertEqual(third.plan.parameter, .temperature)
        XCTAssertEqual(third.plan.topic, .water)
        XCTAssertEqual(conversation.activeParameter, .temperature)

        // 4 — 方向。
        let fourth = try await ask("低一点呢？", conversation: &conversation)
        XCTAssertEqual(fourth.plan.direction, .lower)
        XCTAssertEqual(fourth.plan.focusBeanID, guji.id)
        XCTAssertEqual(fourth.plan.filter.methods.contains("v60"), true, "方法一直跟着")

        // 5 — 历史。
        let fifth = try await ask("我以前有没有遇到过类似的？", conversation: &conversation)
        XCTAssertTrue(fifth.plan.intents.contains(.similarity))
        XCTAssertEqual(fifth.plan.focusBeanID, guji.id)
        XCTAssertEqual(conversation.activeIntent, .similarity)

        // 6 — 推荐：意图切换，豆子仍在。
        let sixth = try await ask("那今天先喝它吗？", conversation: &conversation)
        XCTAssertTrue(sixth.plan.intents.contains(.inventory))
        XCTAssertEqual(conversation.activeIntent, .inventory)
        XCTAssertEqual(conversation.focusBeanID, guji.id)
        XCTAssertEqual(conversation.turnIndex, 6)
        XCTAssertEqual(conversation.conversationID, sessionID, "六轮都在同一个会话里")
        XCTAssertTrue(conversation.recentEvidence.count <= IntelligenceConfig.conversationEvidenceLimit)
        XCTAssertEqual(conversation.discussionLabel(languageCode: "zh-Hans")?.contains("Ethiopia Guji"), true,
                       "六轮之后界面那一行还该说在聊哪包豆：\(conversation.discussionLabel(languageCode: "zh-Hans") ?? "-")")
    }

    // MARK: - 兼容性

    /// 规格 §64：单轮入口（含 `Tools/run.sh --ask`）继续工作，第一轮就是空会话。
    func testASingleTurnCallStillWorksWithoutAnyContext() async throws {
        let answer = await engine.ask(
            "我今天还有哪些豆子？",
            beans: try context.fetch(FetchDescriptor<Bean>()),
            brews: try context.fetch(FetchDescriptor<Brew>()),
            tastings: try context.fetch(FetchDescriptor<Tasting>()),
            book: nil,
            settings: RAGSettings.standard,
            languageCode: "zh-Hans",
            now: today
        )

        XCTAssertTrue(answer.context.hasFacts)
        XCTAssertEqual(answer.conversationUpdate.turnIndex, 1)
        XCTAssertEqual(answer.conversationUpdate.activeIntent, .inventory)
    }

    /// 视图那一行「正在讨论」的数据来源。
    func testTheDiscussionLabelSaysWhatIsBeingTalkedAbout() {
        var conversation = ConversationContext.empty
        XCTAssertNil(conversation.discussionLabel(languageCode: "zh-Hans"), "空会话不该显示这一行")

        conversation.focusBeanName = "Ethiopia Guji"
        conversation.activeMethod = MethodReference(label: "V60", spellings: ["V60", "v60"])
        XCTAssertEqual(conversation.discussionLabel(languageCode: "zh-Hans"), "Ethiopia Guji · V60")

        conversation.activeParameter = .temperature
        XCTAssertEqual(conversation.discussionLabel(languageCode: "zh-Hans"), "Ethiopia Guji · V60 · 水温",
                       "参数比话题具体，两者都有时只说参数")
    }
}
