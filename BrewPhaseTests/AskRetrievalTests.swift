import SwiftData
import XCTest
@testable import BrewPhase

/// 本地问答的检索层测试。
///
/// 断言的写法有两种，是有意区分的：
/// * 对**规则**（意图、条数、过滤条件、去重）断言精确值——那些是确定性行为，
///   变了一定是回归；
/// * 对**生成的文本**只断言包含关系——文案会改，句子不该被测试钉死。
@MainActor
final class AskRetrievalTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    private let today = Date()

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
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    // MARK: - 夹具

    @discardableResult
    private func makeGuji() -> Bean {
        let bean = Bean(
            name: "Ethiopia Guji", roaster: "启程咖啡", origin: "埃塞俄比亚 · Guji", process: "水洗",
            roastLevel: .light,
            roastDate: DateMath.add(days: -16, to: today),
            openDate: DateMath.add(days: -10, to: today),
            weightG: 200, remainingG: 86,
            flavorTags: ["Jasmine", "Mandarin"], notes: "手冲首选"
        )
        context.insert(bean)
        return bean
    }

    @discardableResult
    private func makeBrazil() -> Bean {
        let bean = Bean(
            name: "Brazil Cerrado", roaster: "启程咖啡", origin: "巴西 · Cerrado", process: "半日晒",
            roastLevel: .mediumDark,
            roastDate: DateMath.add(days: -30, to: today),
            weightG: 250, remainingG: 210,
            flavorTags: ["Chocolate"], notes: ""
        )
        context.insert(bean)
        return bean
    }

    @discardableResult
    private func makeBrew(_ bean: Bean, daysAgo: Int, score: Int, method: String = "V60") -> Brew {
        let brew = Brew(
            date: DateMath.add(days: -daysAgo, to: today), method: method,
            grinder: "司令官 C40", grindSize: "22 格", waterTemp: 92,
            coffeeG: 18, waterG: 300, timeSeconds: 150, score: score,
            acidity: score, sweetness: score, flavorTags: ["Mandarin"],
            notes: "备注", bean: bean
        )
        context.insert(brew)
        return brew
    }

    // MARK: - 文档映射

    func testABeanBecomesAReadableSentenceNotAFieldDump() {
        let bean = makeGuji()
        let document = DocumentBuilder.beanDocument(bean, now: today)

        XCTAssertEqual(document.sourceType, .bean)
        XCTAssertEqual(document.sourceId, bean.id.uuidString)
        // 读起来应该是话，而不是「key=value」。这几个词是句子的骨架。
        XCTAssertTrue(document.content.contains("埃塞俄比亚 · Guji"), document.content)
        XCTAssertTrue(document.content.contains("一包咖啡豆"), document.content)
        XCTAssertTrue(document.content.contains("水洗"), document.content)
        XCTAssertTrue(document.content.contains("浅烘"), document.content)
        // 天数来自 PhaseEngine，和详情页说的是同一件事。
        XCTAssertTrue(document.content.contains("16"), document.content)
        XCTAssertEqual(document.metadata.dayAfterRoast, 16)
        XCTAssertEqual(document.metadata.beanID, bean.id)
    }

    func testABagWithNoRoastDateSaysItCannotTellInsteadOfInventingDayZero() {
        let bean = Bean(name: "Panama Geisha", origin: "巴拿马 · Boquete", process: "水洗",
                        roastLevel: .light, roastDate: nil, weightG: 100, remainingG: 100)
        context.insert(bean)

        let document = DocumentBuilder.beanDocument(bean, now: today)
        XCTAssertNil(document.metadata.dayAfterRoast)
        XCTAssertTrue(document.content.contains("没有烘焙日期"), document.content)
        XCTAssertFalse(document.content.contains("第 0 天"))
    }

    func testAnEmptyTastingIsNotWorthIndexing() {
        let bean = makeGuji()
        context.insert(Tasting(date: today, dayAfterRoast: 16, bean: bean))
        let tastings = try! context.fetch(FetchDescriptor<Tasting>())

        XCTAssertTrue(DocumentBuilder.tastingDocuments(tastings: tastings, brews: []).isEmpty)
    }

    /// 这个项目里最容易踩的一个坑：`Brew.makeTasting()` 会把每次冲煮顺手写成一条
    /// 风味记录，所以一条冲煮在库里是两行。两条都建索引，检索会把同一件事当成
    /// 两条独立证据。
    func testABrewAndItsMirrorTastingAreIndexedOnlyOnce() {
        let bean = makeGuji()
        let brew = makeBrew(bean, daysAgo: 4, score: 5)
        let mirror = brew.makeTasting()
        mirror.bean = bean
        context.insert(mirror)

        let tastings = try! context.fetch(FetchDescriptor<Tasting>())
        XCTAssertEqual(tastings.count, 1, "夹具本身应该只有那条镜像记录")
        XCTAssertTrue(DocumentBuilder.tastingDocuments(tastings: tastings, brews: [brew]).isEmpty,
                      "完全由冲煮镜像出来的风味记录不该单独建索引")
    }

    func testAMirrorTastingTheUserEditedIsKeptBecauseItSaysSomethingNew() {
        let bean = makeGuji()
        let brew = makeBrew(bean, daysAgo: 4, score: 5)
        let mirror = brew.makeTasting()
        mirror.bean = bean
        mirror.notes = "隔了一天再喝，甜感明显出来了"
        context.insert(mirror)

        let tastings = try! context.fetch(FetchDescriptor<Tasting>())
        let documents = DocumentBuilder.tastingDocuments(tastings: tastings, brews: [brew])
        XCTAssertEqual(documents.count, 1, "用户改过的镜像记录带着冲煮里没有的信息，必须留下")
        XCTAssertTrue(documents[0].content.contains("甜感明显出来了"))
    }

    func testPreferenceIsNotInventedInAnEmptyCellar() {
        XCTAssertNil(DocumentBuilder.preferenceDocument(beans: [], brews: [], now: today))
    }

    /// 演示数据里的风味记录都是冲煮的附笔，所以一条都不该单独建索引。
    ///
    /// 这条测试守的是一个很容易被破坏的前提：只要有人再手工造一条标着
    /// `source: .brew` 却不带 `brewID` 的记录，去重就会失效——而失效的表现不是
    /// 报错，是回答里出现「你在两次冲煮里都提到了柑橘」，实际只冲过一次。
    func testInstalledDemoDataIndexesEachBrewOnlyOnce() throws {
        DemoData.install(context: context, today: today)

        let beans = try context.fetch(FetchDescriptor<Bean>())
        let brews = try context.fetch(FetchDescriptor<Brew>())
        let tastings = try context.fetch(FetchDescriptor<Tasting>())
        XCTAssertFalse(tastings.isEmpty, "演示数据本身应该造出风味记录，否则这条测试什么都没测")

        for tasting in tastings where tasting.source == .brew {
            let linked = try XCTUnwrap(tasting.brewID, "标着来自冲煮的风味记录必须指向那次冲煮")
            XCTAssertTrue(brews.contains { $0.id == linked }, "冲煮记录里找不到它指向的那一次")
        }

        let documents = DocumentBuilder.documents(
            beans: beans, brews: brews, tastings: tastings, book: nil, now: today
        )
        XCTAssertEqual(documents.filter { $0.sourceType == .brew }.count, brews.count)

        // 演示数据里三条 Guji 风味记录和它们的冲煮逐字相同，应当被去掉；巴西那条
        // 的备注与风味标签跟冲煮不一样，带着额外信息，必须留下。所以这里断言的
        // 是**性质**而不是条数：留下来的每一条，都得有它自己的东西。
        let tastingDocuments = documents.filter { $0.sourceType == .tasting }
        XCTAssertLessThan(tastingDocuments.count, tastings.count, "和冲煮逐字重复的风味记录没有被去掉")

        for document in tastingDocuments {
            guard let tasting = tastings.first(where: { $0.id.uuidString == document.sourceId }) else {
                return XCTFail("索引里的风味记录找不到对应的源对象：\(document.sourceId)")
            }
            let brew = tasting.brewID.flatMap { id in brews.first { $0.id == id } }
            let identicalToItsBrew = brew.map {
                $0.score == tasting.score
                    && $0.flavorTags == tasting.flavorTags
                    && $0.notes == tasting.notes
            } ?? false
            XCTAssertFalse(identicalToItsBrew, "留下来的风味记录必须带着冲煮里没有的信息")
        }
    }

    func testThePreferenceDocumentOnlyCountsHighScoresAsLikes() {
        let bean = makeGuji()
        makeBrew(bean, daysAgo: 3, score: 5)
        makeBrew(bean, daysAgo: 9, score: 2)

        let brews = try! context.fetch(FetchDescriptor<Brew>())
        let document = try? XCTUnwrap(DocumentBuilder.preferenceDocument(beans: [bean], brews: brews, now: today))
        XCTAssertTrue(document?.content.contains("柑橘") == true, document?.content ?? "")
        XCTAssertTrue(document?.content.contains("V60") == true)
    }

    func testTheContentHashMovesOnlyWhenTheContentMoves() {
        let bean = makeGuji()
        let first = DocumentBuilder.beanDocument(bean, now: today)

        bean.remainingG = 40
        let second = DocumentBuilder.beanDocument(bean, now: today)
        XCTAssertNotEqual(first.contentHash, second.contentHash, "剩余量写进了正文，指纹应该跟着变")

        let sameAgain = DocumentBuilder.beanDocument(bean, now: today)
        XCTAssertEqual(second.contentHash, sameAgain.contentHash, "同样的数据必须得到同样的指纹")
    }

    // MARK: - 意图识别

    private func plan(_ question: String, beans: [BeanHint] = [], focus: UUID? = nil) -> QueryPlan {
        // 用真实的规则表：如果它在 Bundle 里找不到，下面第一条断言会立刻说明问题，
        // 而不是让每条测试都退化成「什么都匹配不上」。
        let analyzer = RuleQueryAnalyzer(rules: .loaded)
        return analyzer.plan(for: question, beans: beans, focusBeanID: focus, now: today, calendar: DateMath.calendar)
    }

    func testTheShippedRuleTableLoads() {
        XCTAssertFalse(QueryRules.loaded.intents.isEmpty)
        XCTAssertFalse(QueryRules.loaded.countUnits.isEmpty)
        XCTAssertFalse(QueryRules.loaded.relativeUnits.isEmpty)
        XCTAssertFalse(QueryRules.loaded.relativeAnchors.isEmpty)
        // 中文数字单独断言一条：它是「最近三次」能不能被认出来的关键，
        // 而它坏掉的时候不会报错，只会让条数悄悄回退成默认值。
        XCTAssertEqual(QueryRules.loaded.numerals["三"], 3)
        XCTAssertEqual(QueryRules.loaded.numerals["两"], 2)
    }

    func testHowDidIBrewThisBagThreeTimes() {
        let bean = makeGuji()
        let result = plan("我最近三次怎么冲这包豆子的？", beans: [BeanHint(bean: bean)], focus: bean.id)

        XCTAssertTrue(result.intents.contains(.recipe))
        XCTAssertEqual(result.requestedCount, 3)
        XCTAssertEqual(result.focusBeanID, bean.id)
        XCTAssertEqual(result.filter.beanID, bean.id)
    }

    func testWhenWasThisBagOpened() {
        let bean = makeGuji()
        let result = plan("这包豆什么时候开封的？", beans: [BeanHint(bean: bean)], focus: bean.id)

        XCTAssertTrue(result.intents.contains(.timing))
        XCTAssertEqual(result.focusBeanID, bean.id)
    }

    func testHowDidIRateThisBag() {
        let bean = makeGuji()
        let result = plan("我对这包豆评分多少？", beans: [BeanHint(bean: bean)], focus: bean.id)
        XCTAssertTrue(result.intents.contains(.rating))
    }

    func testWhichBagsDoIHaveToday() {
        let result = plan("我今天还有哪些豆子？")
        XCTAssertTrue(result.intents.contains(.inventory))
        XCTAssertEqual(result.filter.sourceTypes, [.bean])
        XCTAssertFalse(result.wantsVectorSearch, "计数问题用不上相似度")
    }

    func testHaveIRunIntoSimilarDryingAstringency() {
        let result = plan("我之前有没有遇到过类似的干涩？")
        XCTAssertTrue(result.intents.contains(.similarity))
        XCTAssertTrue(result.wantsVectorSearch)
    }

    func testWhichBrewWasClosestToThisOne() {
        XCTAssertTrue(plan("哪次冲煮和这次情况最接近？").intents.contains(.similarity))
    }

    func testWhichBagsDoILikeWithSimilarFlavours() {
        let result = plan("我过去喜欢哪些类似风味的豆子？")
        XCTAssertTrue(result.intents.contains(.similarity))
        XCTAssertTrue(result.intents.contains(.preference), "「喜欢」应该被认成偏好问题")
    }

    func testWhenDidThisBagBrewBest() {
        let bean = makeGuji()
        let result = plan("我这包豆之前什么时候冲得最好？", beans: [BeanHint(bean: bean)], focus: bean.id)
        XCTAssertTrue(result.intents.contains(.rating))
        XCTAssertTrue(result.intents.contains(.timing))
        XCTAssertEqual(result.focusBeanID, bean.id)
    }

    /// 「最近三次」和「最近三天」都从「最近」起头，但一个问条数、一个问时间段。
    /// 把前者当成时间范围会把检索范围砍掉一大截。
    func testRecentTimesIsACountButRecentDaysIsADateRange() {
        XCTAssertEqual(plan("我最近三次怎么冲的？").requestedCount, 3)
        XCTAssertNil(plan("我最近三次怎么冲的？").filter.dateRange)

        let ranged = plan("我最近三天喝了什么？")
        XCTAssertNotNil(ranged.filter.dateRange)
        XCTAssertNil(ranged.requestedCount)

        XCTAssertEqual(plan("最近两杯的记录").requestedCount, 2)
        let week = plan("最近两周的记录")
        XCTAssertNotNil(week.filter.dateRange, "两周也是时间段")
    }

    func testAMethodInTheQuestionBecomesAFilterCarryingEverySpelling() {
        let result = plan("我的爱乐压怎么样？")
        XCTAssertTrue(result.filter.methods.contains("爱乐压"))
        XCTAssertTrue(result.filter.methods.contains("aeropress"),
                      "库里可能存的是另一种写法，过滤时要都试一遍")
    }

    func testTheMostSpecificBeanWins() {
        let guji = makeGuji()
        let brazil = makeBrazil()
        let beans = [BeanHint(bean: guji), BeanHint(bean: brazil)]

        XCTAssertEqual(plan("Guji 那包怎么样？", beans: beans).focusBeanID, guji.id)
        XCTAssertEqual(plan("Cerrado 那包怎么样？", beans: beans).focusBeanID, brazil.id)
    }

    func testABagReferenceBindsToTheFocusedBeanWithoutNamingIt() {
        let bean = makeGuji()
        let result = plan("这包豆现在适合喝吗？", beans: [BeanHint(bean: bean)], focus: bean.id)
        XCTAssertEqual(result.focusBeanID, bean.id)
    }

    /// 从豆子页面问一个纯知识问题，不该被强行绑到那包豆上。
    func testAPureKnowledgeQuestionDoesNotGetBoundToTheFocusedBean() {
        let bean = makeGuji()
        let result = plan("V60 一般用多少水温？", beans: [BeanHint(bean: bean)], focus: bean.id)
        XCTAssertNil(result.focusBeanID)
        XCTAssertTrue(result.intents.contains(.knowledge))
    }

    func testAQuestionWithNoRecognisableIntentStillSearches() {
        let result = plan("嗯……随便看看")
        XCTAssertTrue(result.intents.isEmpty)
        XCTAssertTrue(result.wantsVectorSearch, "认不出意图时向量检索是唯一的兜底")
        XCTAssertTrue(result.filter.isEmpty)
    }

    // MARK: - 元数据过滤

    func testTheFilterComparesFreeTextLoosely() {
        var filter = MetadataFilter()
        filter.origins = ["guji"]
        let passage = makePassage(metadata: DocumentMetadata(origin: "埃塞俄比亚 · Guji"))
        XCTAssertTrue(filter.matches(passage), "大小写和空格不该影响匹配")

        filter.origins = ["肯尼亚"]
        XCTAssertFalse(filter.matches(passage))
    }

    /// 0 分在 App 里是「没打分」，不是低分。
    func testAnUnscoredRecordDoesNotCountAsAZero() {
        var filter = MetadataFilter()
        filter.minimumScore = 4

        XCTAssertFalse(filter.matches(makePassage(metadata: DocumentMetadata(score: 0))),
                       "没打分的记录不该混进「4 分以上」里")
        XCTAssertTrue(filter.matches(makePassage(metadata: DocumentMetadata(score: 5))))
    }

    func testTheScoreRangeIsInclusiveAndTwoSided() {
        var filter = MetadataFilter()
        filter.minimumScore = 3
        filter.maximumScore = 4
        XCTAssertTrue(filter.matches(makePassage(metadata: DocumentMetadata(score: 3))))
        XCTAssertTrue(filter.matches(makePassage(metadata: DocumentMetadata(score: 4))))
        XCTAssertFalse(filter.matches(makePassage(metadata: DocumentMetadata(score: 5))))
    }

    private func makePassage(metadata: DocumentMetadata) -> StoredPassage {
        StoredPassage(recordKey: "test", sourceType: .brew, sourceId: "1",
                      title: "t", content: "c", metadata: metadata, updatedAt: today)
    }

    // MARK: - 向量索引

    func testTheIndexStoresSearchesAndFilters() throws {
        let guji = makeGuji()
        let brazil = makeBrazil()
        let index = SwiftDataVectorIndex(context: context)

        let gujiDocument = DocumentBuilder.beanDocument(guji, now: today)
        let brazilDocument = DocumentBuilder.beanDocument(brazil, now: today)
        try index.upsert([
            VectorIndexEntry(document: gujiDocument, vector: [1, 0, 0, 0],
                             modelIdentifier: "test.v1", languageCode: "zh-Hans"),
            VectorIndexEntry(document: brazilDocument, vector: [0, 1, 0, 0],
                             modelIdentifier: "test.v1", languageCode: "zh-Hans"),
        ])

        XCTAssertEqual(try index.count(), 2)
        XCTAssertEqual(Set(try index.summaries().map(\.key)),
                       [gujiDocument.id, brazilDocument.id])

        let all = try index.search(vector: [1, 0, 0, 0], filter: .none, limit: 10)
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all[0].passage.recordKey, gujiDocument.id, "同向的那条应该排第一")
        XCTAssertGreaterThan(all[0].similarity, all[1].similarity)

        var filter = MetadataFilter()
        filter.beanID = brazil.id
        let filtered = try index.search(vector: [1, 0, 0, 0], filter: filter, limit: 10)
        XCTAssertEqual(filtered.map(\.passage.recordKey), [brazilDocument.id])
    }

    func testUpsertingTheSameKeyReplacesRatherThanDuplicates() throws {
        let bean = makeGuji()
        let index = SwiftDataVectorIndex(context: context)
        let document = DocumentBuilder.beanDocument(bean, now: today)

        try index.upsert([VectorIndexEntry(document: document, vector: [1, 0],
                                           modelIdentifier: "test.v1", languageCode: "zh-Hans")])
        try index.upsert([VectorIndexEntry(document: document, vector: [0, 1],
                                           modelIdentifier: "test.v1", languageCode: "zh-Hans")])

        XCTAssertEqual(try index.count(), 1)
        let hits = try index.search(vector: [0, 1], filter: .none, limit: 5)
        let similarity = try XCTUnwrap(hits.first?.similarity)
        XCTAssertEqual(similarity, 1, accuracy: 1e-5, "应该是新向量在起作用")
    }

    func testAVectorFromAnotherSpaceIsSkippedRatherThanZeroPadded() throws {
        let bean = makeGuji()
        let index = SwiftDataVectorIndex(context: context)
        let document = DocumentBuilder.beanDocument(bean, now: today)
        try index.upsert([VectorIndexEntry(document: document, vector: [1, 0, 0, 0],
                                           modelIdentifier: "other.v1", languageCode: "en")])

        XCTAssertTrue(try index.search(vector: [1, 0], filter: .none, limit: 5).isEmpty,
                      "维度不同的向量没有可比的相似度，跳过它而不是补零")
    }

    func testRemovingAndClearing() throws {
        let bean = makeGuji()
        let index = SwiftDataVectorIndex(context: context)
        let document = DocumentBuilder.beanDocument(bean, now: today)
        try index.upsert([VectorIndexEntry(document: document, vector: [1, 0],
                                           modelIdentifier: "test.v1", languageCode: "zh-Hans")])

        try index.remove(keys: [document.id])
        XCTAssertEqual(try index.count(), 0)

        try index.upsert([VectorIndexEntry(document: document, vector: [1, 0],
                                           modelIdentifier: "test.v1", languageCode: "zh-Hans")])
        try index.removeAll()
        XCTAssertEqual(try index.count(), 0)
    }

    // MARK: - 上下文构建

    private func passage(
        id: String,
        sourceType: KnowledgeSourceType,
        title: String,
        content: String,
        origin: RetrievedPassage.Origin = .indexedDocument,
        relevance: Double
    ) -> RetrievedPassage {
        RetrievedPassage(
            id: id, origin: origin, sourceType: sourceType, title: title, content: content,
            metadata: DocumentMetadata(), relevance: relevance, similarity: nil, updatedAt: today
        )
    }

    func testTheContextKeepsUserRecordsAndKnowledgeApart() {
        let context = ContextBuilder.build(question: "q", passages: [
            passage(id: "b1", sourceType: .bean, title: "豆子", content: "用户的豆子", relevance: 0.9),
            passage(id: "k1", sourceType: .knowledge, title: "V60", content: "知识条目", relevance: 0.5),
        ])

        XCTAssertEqual(context.userBlocks.count, 1)
        XCTAssertEqual(context.knowledgeBlocks.count, 1)
        XCTAssertEqual(context.userBlocks[0].citation, 1)
        XCTAssertEqual(context.knowledgeBlocks[0].citation, 2, "编号在整份上下文里连续，不按组重新开始")
        XCTAssertTrue(context.rendered.contains("【用户自己的记录】"))
        XCTAssertTrue(context.rendered.contains("【BrewPhase 内置知识库】"))
        // 正文顺序：用户那段必须在前。
        let userIndex = context.rendered.range(of: "用户的豆子")!.lowerBound
        let knowledgeIndex = context.rendered.range(of: "知识条目")!.lowerBound
        XCTAssertLessThan(userIndex, knowledgeIndex)
    }

    func testAnEmptyGroupIsStillWrittenOutSoTheModelDoesNotFillTheGap() {
        let context = ContextBuilder.build(question: "q", passages: [
            passage(id: "k1", sourceType: .knowledge, title: "V60", content: "知识条目", relevance: 0.5),
        ])
        XCTAssertFalse(context.hasUserData)
        XCTAssertTrue(context.rendered.contains("（没有找到和这个问题相关的记录）"),
                      "不说「没找到」的话，模型很容易把知识库的通用说法当成用户的经历复述")
    }

    func testNearDuplicatesAreDroppedButFactsAreNot() {
        let context = ContextBuilder.build(question: "q", passages: [
            passage(id: "f1", sourceType: .brew, title: "评分", content: "平均 4 分",
                    origin: .structuredFact, relevance: 1.0),
            passage(id: "d1", sourceType: .brew, title: "第一次",
                    content: "用户用埃塞俄比亚 Guji 水洗豆做了一次 V60。粉量 18 克，水温 92 度。", relevance: 0.8),
            passage(id: "d2", sourceType: .brew, title: "第二次",
                    content: "用户用埃塞俄比亚 Guji 水洗豆做了一次 V60。粉量 18 克，水温 92 度。", relevance: 0.7),
        ])

        // 两条几乎一样的记录只留一条，但结构化事实不参与去重。
        XCTAssertEqual(context.userBlocks.count, 2)
        XCTAssertTrue(context.userBlocks.contains { $0.isFact })
    }

    func testTheBudgetIsRespectedAndTheOverflowIsCounted() {
        let passages = (0..<8).map { index in
            // 每条正文必须互不相同。完全一样的内容会在近似去重那一步就被摘掉，
            // 那样测的是去重而不是预算。
            passage(id: "d\(index)", sourceType: .bean, title: "第 \(index) 条",
                    content: String(repeating: "第 \(index) 条很长的正文。", count: 200),
                    relevance: 1.0 - Double(index) * 0.1)
        }

        let context = ContextBuilder.build(question: "q", passages: passages, budget: 800)
        XCTAssertLessThan(context.userBlocks.count, passages.count)
        XCTAssertEqual(context.droppedForBudget, passages.count - context.userBlocks.count)
        XCTAssertLessThan(context.usedCharacters, passages.reduce(0) { $0 + $1.content.count },
                          "预算没起作用，八条全进来了")
    }

    func testTheFirstPassageIsKeptEvenWhenItAloneBlowsTheBudget() {
        let context = ContextBuilder.build(question: "q", passages: [
            passage(id: "d1", sourceType: .bean, title: "唯一的", content: String(repeating: "字", count: 5000),
                    relevance: 1.0),
        ], budget: 100)

        XCTAssertEqual(context.userBlocks.count, 1, "一条都没有的上下文比超一点更糟")
    }

    // MARK: - 抽取式回答

    func testTheExtractiveEngineSaysSoWhenThereIsNothingToCite() async throws {
        let text = try await ExtractiveLLMProvider().generate(
            prompt: "p", context: BuiltContext(question: "？")
        )
        XCTAssertTrue(text.contains("没有找到"), text)
    }

    func testTheExtractiveEngineSaysWhenItOnlyHasKnowledge() async throws {
        let context = ContextBuilder.build(question: "q", passages: [
            passage(id: "k1", sourceType: .knowledge, title: "休息期",
                    content: "浅烘通常要 7–14 天。判断依据应该是味道而不是日历。", relevance: 0.9),
        ])
        let text = try await ExtractiveLLMProvider().generate(prompt: "p", context: context)
        XCTAssertTrue(text.contains("休息期"))
        XCTAssertTrue(text.contains("不代表你的实际情况"), "只说知识库时必须讲清楚那不是用户的经历")
    }

    func testTheExtractiveEnginePicksTheMostRelevantSentence() {
        let content = "第一句和问题无关。浅烘通常要 7–14 天养豆。第三句也是凑数的。"
        let picked = ExtractiveLLMProvider.bestSentences(in: content, terms: ["养豆"], count: 1)
        XCTAssertTrue(picked.contains("7–14 天"), picked)
    }
}
