import SwiftData
import XCTest
@testable import BrewPhase

/// 端到端：从一句中文问题走到一段带引用的回答。
///
/// 这些测试跑的是真实链路——真正的规则表、真正的文档映射、真正的索引、真正的
/// 向量计算（端侧模型可用时就用它，不可用时退到词法）。回答由抽取式引擎给出，
/// 所以断言是确定的；换成 Ollama 或端侧模型时，这里断言的是「检索到了什么」，
/// 那部分不随引擎变化。
@MainActor
final class AskEngineTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private var engine: AskEngine!

    private let today = Date()
    private var guji: Bean!

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

    private func seed() throws {
        let bean = Bean(
            name: "Ethiopia Guji", roaster: "启程咖啡", origin: "埃塞俄比亚 · Guji", process: "水洗",
            roastLevel: .light,
            roastDate: DateMath.add(days: -16, to: today),
            openDate: DateMath.add(days: -10, to: today),
            weightG: 200, remainingG: 86,
            flavorTags: ["Jasmine", "Mandarin"], notes: "手冲首选，V60 闷蒸 30 秒"
        )
        context.insert(bean)
        guji = bean

        for (offset, temp, score, note) in [(13, 93.0, 4, "刚开袋，酸质冲一点"),
                                            (9, 92.0, 5, "花香出来了，很干净"),
                                            (4, 92.0, 5, "目前最平衡的一杯")] {
            let brew = Brew(
                date: DateMath.add(days: -offset, to: today), method: "V60",
                grinder: "司令官 C40", grindSize: "22 格", waterTemp: temp,
                coffeeG: 18, waterG: 300, timeSeconds: 150, score: score,
                flavorTags: ["Mandarin"], notes: note, bean: bean
            )
            context.insert(brew)
        }

        // 一个已经过了窗口、还剩很多的包，用来验证「有哪些豆子」里有它。
        context.insert(Bean(
            name: "Brazil Cerrado", roaster: "启程咖啡", origin: "巴西 · Cerrado", process: "半日晒",
            roastLevel: .mediumDark, roastDate: DateMath.add(days: -30, to: today),
            weightG: 250, remainingG: 210, flavorTags: ["Chocolate"], notes: "深一点，做奶咖不错"
        ))

        try context.save()
    }

    private func ask(_ question: String, focus: UUID? = nil) async throws -> AskAnswer {
        let beans = try context.fetch(FetchDescriptor<Bean>())
        let brews = try context.fetch(FetchDescriptor<Brew>())
        let tastings = try context.fetch(FetchDescriptor<Tasting>())
        let rules = try context.fetch(FetchDescriptor<PhaseRule>())

        return await engine.ask(
            question,
            focusBeanID: focus,
            beans: beans,
            brews: brews,
            tastings: tastings,
            book: PhaseRuleBook.make(stored: rules),
            settings: RAGSettings.standard,
            languageCode: "zh-Hans",
            now: today
        )
    }

    // MARK: - 精确事实

    func testWhenWasThisBagOpened() async throws {
        let answer = try await ask("这包豆什么时候开封的？", focus: guji.id)

        XCTAssertEqual(answer.engine, .onDeviceSummary)
        XCTAssertTrue(answer.context.hasFacts, "日期问题应该由结构化直查回答，而不是靠相似度")
        XCTAssertTrue(answer.plan.intents.contains(.timing))

        let expected = Fmt.short(guji.openDate!)
        XCTAssertTrue(answer.text.contains(expected), "回答里应该有开封日期 \(expected)：\n\(answer.text)")
    }

    func testHowDidIBrewTheLastThreeTimes() async throws {
        let answer = try await ask("我最近三次怎么冲这包豆的？", focus: guji.id)

        XCTAssertEqual(answer.plan.requestedCount, 3)
        let fact = try XCTUnwrap(answer.context.userBlocks.first { $0.isFact })
        XCTAssertTrue(fact.passage.content.contains("V60"), fact.passage.content)
        // 三次冲煮各自一行。
        let lines = fact.passage.content.split(separator: "\n").filter { $0.hasPrefix("·") }
        XCTAssertEqual(lines.count, 3, fact.passage.content)
    }

    func testWhatDidIRateThisBag() async throws {
        let answer = try await ask("我对这包豆评分多少？", focus: guji.id)

        XCTAssertTrue(answer.plan.intents.contains(.rating))
        XCTAssertTrue(answer.context.hasFacts)
        XCTAssertTrue(answer.text.contains("5"), answer.text)
    }

    func testWhichBagsDoIHave() async throws {
        let answer = try await ask("我今天还有哪些豆子？")

        XCTAssertTrue(answer.plan.intents.contains(.inventory))
        XCTAssertTrue(answer.text.contains("Ethiopia Guji"), answer.text)
        XCTAssertTrue(answer.text.contains("Brazil Cerrado"), answer.text)
    }

    // MARK: - 知识库与来源区分

    func testAKnowledgeQuestionIsAnsweredFromTheKnowledgeBase() async throws {
        let answer = try await ask("V60 一般用多少水温？")

        XCTAssertTrue(answer.plan.intents.contains(.knowledge))
        XCTAssertNil(answer.plan.focusBeanID, "没提到哪包豆，不该被绑到某包上")
        let diagnostics = """
        index=\(answer.report.total) embedded=\(answer.report.embedded) \
        intents=\(answer.plan.intents.map(\.rawValue).sorted()) \
        blocks=\(answer.citations.map { "\($0.passage.sourceType.rawValue)#\($0.citation)" }) \
        notes=\(answer.notes)
        """
        XCTAssertTrue(answer.context.hasKnowledge, "知识型提问必须能取到知识库 —— \(diagnostics)")
        XCTAssertTrue(answer.text.contains("知识库"), "回答里要说明这段说法来自知识库 —— \(answer.text)")
    }

    func testUserRecordsAndKnowledgeAreNeverPresentedAsTheSameThing() async throws {
        let answer = try await ask("我这包豆现在适合喝吗？", focus: guji.id)

        // 两种资料都在，但在上下文里被明确分成两组。
        XCTAssertTrue(answer.context.hasUserData)
        XCTAssertFalse(answer.context.userBlocks.isEmpty)
        let userCitations = Set(answer.context.userBlocks.map(\.citation))
        let knowledgeCitations = Set(answer.context.knowledgeBlocks.map(\.citation))
        XCTAssertTrue(userCitations.isDisjoint(with: knowledgeCitations))
    }

    // MARK: - 引用

    func testEveryAnswerNumbersItsEvidenceFromOneWithoutGaps() async throws {
        let answer = try await ask("我这包豆之前什么时候冲得最好？", focus: guji.id)
        let citations = answer.citations.map(\.citation)
        XCTAssertFalse(citations.isEmpty)
        XCTAssertEqual(citations, Array(1...citations.count), "编号必须连续，界面靠它把 [2] 指回具体那条")
    }

    func testTheCitationListCarriesEnoughToRecogniseEachEntry() async throws {
        let answer = try await ask("我最近三次怎么冲这包豆的？", focus: guji.id)
        for block in answer.citations {
            XCTAssertFalse(block.passage.title.isEmpty)
            XCTAssertFalse(block.passage.content.isEmpty)
        }
    }

    // MARK: - 增量索引

    // 这两条测的是**索引**，所以用的问题刻意不带指代词。「我这包豆怎么样？」
    // 在没有任何上下文时会走「这句话缺少明确对象」那条路（不再瞎查），索引自然
    // 也就不建了——那是多轮对话那一层有意改掉的行为，与增量索引无关。
    func testTheFirstQuestionBuildsTheIndexAndTheNextOneReusesIt() async throws {
        let first = try await ask("我的豆子怎么样？")
        XCTAssertGreaterThan(first.report.total, 0, "索引里应该既有用户资料也有知识库")
        XCTAssertGreaterThan(first.report.embedded, 0)

        let second = try await ask("我的豆子怎么样？")
        XCTAssertEqual(second.report.embedded, 0, "数据没变就不该重算任何向量")
        XCTAssertEqual(second.report.reused, second.report.total - 0 - second.report.removed)
    }

    func testChangingTheLanguageRebuildsTheIndexBecauseTheVectorSpaceMoved() async throws {
        _ = try await ask("我的豆子怎么样？")

        let beans = try context.fetch(FetchDescriptor<Bean>())
        let answer = await engine.ask(
            "how are my beans",
            focusBeanID: nil,
            beans: beans,
            brews: try context.fetch(FetchDescriptor<Brew>()),
            tastings: try context.fetch(FetchDescriptor<Tasting>()),
            book: nil,
            settings: RAGSettings.standard,
            languageCode: "en",
            now: today
        )
        XCTAssertGreaterThan(answer.report.embedded, 0,
                             "换了语言就是换了向量空间，索引必须重建而不是混着用")
    }

    // MARK: - 没有数据时

    func testInAnEmptyCellarItDoesNotInventCoffee() async throws {
        let schema = Schema([
            Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self, EmbeddingRecord.self,
        ])
        let empty = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        let emptyEngine = AskEngine(context: ModelContext(empty))
        let answer = await emptyEngine.ask(
            "我这包瑰夏什么时候开封的？",
            beans: [], brews: [], tastings: [], book: nil,
            settings: RAGSettings.standard, languageCode: "zh-Hans", now: today
        )

        XCTAssertFalse(answer.context.hasUserData, "空库里不该有任何用户资料")
        XCTAssertFalse(answer.text.contains("瑰夏"), "问题里的词不该被当成一条记录复述回来：\n\(answer.text)")
    }

    func testAnEmptyQuestionDoesNotRunTheWholeChain() async throws {
        let answer = try await ask("   ")

        XCTAssertTrue(answer.citations.isEmpty)
        XCTAssertEqual(answer.report.total, 0, "空问题不该触发索引同步")
        XCTAssertTrue(answer.text.contains("想问我什么"), answer.text)
    }

    // MARK: - 敏感行为

    /// V1（协议 §二）不用任何 LLM：就算偏好里存着 Ollama，回答也固定走本地
    /// 抽取式。V2 引入可选 LLM 层时，这条测试应改回「降级并说明原因」的行为。
    func testV1AlwaysAnswersWithTheLocalSummaryEvenIfOllamaIsPreferred() async throws {
        var settings = RAGSettings.standard
        settings.preferredEngine = .ollama
        // 指向一个几乎不可能有人监听的端口——V1 里它根本不该被碰。
        settings.ollamaBaseURL = "http://127.0.0.1:59999"
        settings.ollamaChatModel = "no-such-model"

        let answer = await engine.ask(
            "我的豆子怎么样？",
            beans: try context.fetch(FetchDescriptor<Bean>()),
            brews: try context.fetch(FetchDescriptor<Brew>()),
            tastings: try context.fetch(FetchDescriptor<Tasting>()),
            book: nil,
            settings: settings,
            languageCode: "zh-Hans",
            now: today
        )

        XCTAssertEqual(answer.engine, .onDeviceSummary)
        XCTAssertFalse(answer.usedFallback, "V1 没有降级这回事：抽取式就是唯一的引擎")
    }
}
