import SwiftData
import XCTest
@testable import BrewPhase

/// Bean → Knowledge Linking 的验收测试（规格 §五十一 的八类 + §五十六 的五个场景）。
///
/// 断言口径沿用仓库既有约定：结构与 id 断言精确值，文案只断言包含关系。
/// 特别钉死两条红线：
/// * **不许自动生成**用户没写的字段（规格 §十二/§十七）；
/// * 没有证据时**不许**给个性化结论（规格 §四十九）。
@MainActor
final class KnowledgeLinkingTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private let today = Date()

    private var graph: EntityGraph { .loaded }

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
    private func makeBean(
        name: String = "Ethiopia Guji",
        origin: String = "埃塞俄比亚 · Guji",
        process: String = "水洗",
        roastLevel: RoastLevel = .light,
        flavorTags: [String] = ["Jasmine"],
        notes: String = ""
    ) -> Bean {
        let bean = Bean(
            name: name, roaster: "启程咖啡", origin: origin, process: process,
            roastLevel: roastLevel,
            roastDate: DateMath.add(days: -16, to: today),
            openDate: DateMath.add(days: -10, to: today),
            weightG: 200, remainingG: 86,
            flavorTags: flavorTags, notes: notes
        )
        context.insert(bean)
        return bean
    }

    @discardableResult
    private func makeBrew(
        _ bean: Bean, daysAgo: Int, score: Int,
        waterTemp: Double = 92, timeSeconds: Int = 150,
        method: String = "V60"
    ) -> Brew {
        let brew = Brew(
            date: DateMath.add(days: -daysAgo, to: today), method: method,
            grinder: "司令官 C40", grindSize: "22 格", waterTemp: waterTemp,
            coffeeG: 18, waterG: 300, timeSeconds: timeSeconds, score: score,
            acidity: score, sweetness: score, flavorTags: ["Mandarin"],
            notes: "备注", bean: bean
        )
        context.insert(brew)
        return brew
    }

    private func linking() -> KnowledgeLinkingService { KnowledgeLinkingService(graph: graph) }

    // MARK: - §51 Bean Normalization

    func testBeanNormalizationFoldsChineseEnglishAndCase() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        for text in ["Ethiopia", "埃塞俄比亚", "ETHIOPIA", "  ethiopia  ", "衣索比亚"] {
            let ids = graph.resolve(text).map(\.id)
            XCTAssertTrue(ids.contains("origin.ethiopia"), "\(text) 应该归一化到 origin.ethiopia，实际 \(ids)")
        }
    }

    // MARK: - §51 Process Normalization

    func testProcessNormalizationCoversBothLanguages() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        for text in ["Washed", "washed", "Fully Washed", "washed process", "水洗", "水洗处理", "湿法"] {
            let ids = graph.resolve(text, types: [.process]).map(\.id)
            XCTAssertEqual(ids, ["process.washed"], "\(text) 应该只归一化到 process.washed，实际 \(ids)")
        }
    }

    /// 短别名只在整串相等时才命中：别名「水」不该让「水洗」沾上水质主题。
    func testSingleCharacterAliasDoesNotMatchBySubstring() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        let ids = graph.resolve("水洗", types: [.process, .topic]).map(\.id)
        XCTAssertFalse(ids.contains("topic.water"), "「水洗」不该命中水质主题，实际 \(ids)")
    }

    // MARK: - §51 Exact Linking / §56 Scenario 1

    func testScenario1GujiBeanLinksToRegionAndItsCountry() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        let bean = makeBean()
        let beanContext = BeanContextResolver(graph: graph).context(for: bean, method: "V60")

        let ids = Set(beanContext.entityIDs)
        XCTAssertTrue(ids.contains("region.guji"), "应命中产区 Guji")
        XCTAssertTrue(ids.contains("origin.ethiopia"), "应命中国家 Ethiopia")
        XCTAssertTrue(ids.contains("process.washed"), "应命中处理法 washed")
        XCTAssertTrue(ids.contains("roast.light"), "应命中烘焙度 light")
        XCTAssertTrue(ids.contains("method.v60"), "应命中冲煮方式 v60")
        XCTAssertTrue(ids.contains("origin.africa"), "应由层级推出非洲（§15 层级 fallback）")

        // Scenario 1 的落点：这四类知识都要能被关联到。
        let knowledge = linking().context(for: bean, method: "V60", languageCode: "zh-Hans")
        XCTAssertFalse(knowledge.directKnowledge.isEmpty, "Scenario 1 应至少关联到一条直接知识")
        XCTAssertGreaterThan(knowledge.totalKnowledgeCount, 1)
    }

    // MARK: - §51 Partial Profile / §17 缺失字段策略

    func testPartialProfileNeverInventsRegionVarietyOrProcess() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        // 只填了「埃塞俄比亚」的豆子。
        let bean = makeBean(name: "", origin: "Ethiopia", process: "", roastLevel: .light, flavorTags: [], notes: "")
        let beanContext = BeanContextResolver(graph: graph).context(for: bean)

        let ids = Set(beanContext.entityIDs)
        XCTAssertTrue(ids.contains("origin.ethiopia"))

        // 绝不能凭空生出产区 / 品种 / 处理法。
        XCTAssertFalse(ids.contains(where: { $0.hasPrefix("region.") }), "不该生成任何产区：\(ids)")
        XCTAssertFalse(ids.contains(where: { $0.hasPrefix("variety.") }), "不该生成任何品种：\(ids)")
        XCTAssertFalse(ids.contains(where: { $0.hasPrefix("process.") }), "不该生成处理法：\(ids)")

        let missing = Set(beanContext.missingFields)
        XCTAssertTrue(missing.contains(.region))
        XCTAssertTrue(missing.contains(.variety))
        XCTAssertTrue(missing.contains(.process))
    }

    /// §56 Scenario 5：未知产区必须回退到通用知识，且**不能编造**。
    func testScenario5UnknownRegionFallsBackWithoutInventing() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        let bean = makeBean(name: "某个新产区", origin: "某个新产区", process: "", roastLevel: .light, flavorTags: [], notes: "")
        let linked = PersonalKnowledgeService().linked(bean: bean, languageCode: "zh-Hans")

        // 烘焙度是 App 里必有的一项（默认中烘），所以「直接链接」不会全空；
        // 但产地/产区/品种/处理法这四类**必须**一条都没有。
        let originLike = linked.knowledge.directLinks.filter {
            [.origin, .region, .variety, .varietyGroup, .process].contains($0.entity.type)
        }
        XCTAssertTrue(originLike.isEmpty, "未知产区不该产生产地/产区/品种/处理法链接：\(originLike.map(\.entity.id))")

        // 「直接知识」不会全空：烘焙度是 App 里必有的一项，而知识库里确实有一篇
        // 「烘焙度不是酸苦的唯一开关」带着 `roast.light`。所以这条用例真正守的东西
        // 是**归因**——直接知识只准由烘焙度引来，产地/产区/品种/处理法四类一条都不许有。
        // （数据里多一篇带 roast.light 的条目就会让「一条都不许有」这种写法失效，
        //   那不是这条用例想测的东西。）
        let roastNames = Set(
            KnowledgeSearchService(graph: graph).displayNames(for: ["roast.light"], languageCode: "zh-Hans")
        )
        for item in linked.knowledge.directKnowledge {
            XCTAssertTrue(Set(item.matchedEntities).isSubset(of: roastNames),
                          "直接知识只能来自烘焙度这条链接，实际命中的是：\(item.matchedEntities)")
        }
        XCTAssertFalse(linked.knowledge.allKnowledge.isEmpty, "应回退到通用知识")

        let insight = BeanKnowledgeInsight.beanKnowledge(linked, languageCode: "zh-Hans")
        // 卡片必须如实说自己关联了几条，而不是笼统地说「有专属资料」。
        XCTAssertEqual(insight.summary,
                       L("已关联 %@ 条与这包豆子直接相关的知识。",
                         String(linked.knowledge.directKnowledge.count)))
        // 置信度按既有规则来（有直接知识 → 中等）。这条期望值跟着数据走：
        // 若将来决定「烘焙度这种粗粒度 scope 不算直接相关」，要改的是
        // `PersonalKnowledgeService` 的规则，那时这条断言也应跟着改回 .low。
        XCTAssertEqual(insight.confidence, .medium)
    }

    // MARK: - §51 Equipment Specificity / §23

    func testEquipmentQueryNeverLeaksAnotherModelKnowledge() throws {
        let search = KnowledgeSearchService(graph: graph)

        // V1 的已知边界（架构审查决策 C1）：没有 Equipment 模型，设备级知识不存在。
        // 所以「车型号」查询返回空，而不是拿别的东西凑数。
        let byModel = search.searchByEquipment("Barista Express", languageCode: "zh-Hans")
        XCTAssertTrue(byModel.isEmpty, "V1 不提供设备级知识，应返回空而不是编一条：\(byModel.map(\.documentID))")

        // 而「V60」这类既是器具又是方式的串，退到方式级是诚实且有用的。
        let byMethodNamed = search.searchByEquipment("V60", languageCode: "zh-Hans")
        XCTAssertFalse(byMethodNamed.isEmpty, "V60 应退到方式级知识")
        XCTAssertTrue(byMethodNamed.allSatisfy { $0.matchedEntities.contains("V60 手冲") || $0.documentID == "kb.pourover.v60" })

        // 通识查询里不许出现型号级知识。
        let generic = search.searchByScope([.generic], languageCode: "zh-Hans")
        XCTAssertTrue(generic.allSatisfy { $0.scope != EntityScope.equipmentModel.rawValue })
    }

    // MARK: - §51 User Data Priority / §27 / §44

    func testPersonalEvidenceWinsOnPersonalQuestions() {
        let bean = makeBean()
        // 3 条高评分（达到阈值）+ 1 条低分，构成可用的个人区间。
        makeBrew(bean, daysAgo: 20, score: 5, waterTemp: 91, timeSeconds: 150)
        makeBrew(bean, daysAgo: 14, score: 5, waterTemp: 92, timeSeconds: 155)
        makeBrew(bean, daysAgo: 10, score: 5, waterTemp: 91.5, timeSeconds: 152)
        makeBrew(bean, daysAgo: 3, score: 3, waterTemp: 94, timeSeconds: 180)

        let service = PersonalKnowledgeService()
        let summary = service.summary(for: bean)

        XCTAssertTrue(summary.hasEnoughData, "3 条高评分应满足阈值")
        XCTAssertEqual(summary.highRatedCount, 3)
        XCTAssertTrue(PersonalKnowledgeService.personalSignalOutweighsKnowledge(summary))

        let linked = service.linked(bean: bean, method: "V60", languageCode: "zh-Hans")
        XCTAssertTrue(linked.personalComesFirst)

        // 冲煮页的建议必须来自**用户自己的区间**，不是通用知识。
        let insight = BeanKnowledgeInsight.brewRelevant(linked, method: "V60", languageCode: "zh-Hans")
        XCTAssertNotNil(insight.recommendation)
        XCTAssertTrue(
            insight.evidence.contains { $0.authority == .inference },
            "个人区间必须标成 inference，不能冒充事实"
        )
    }

    // MARK: - §51 Similarity

    func testAstringencyWordingVariantsResolveToTheSameEntity() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        for text in ["干涩", "尾段干", "余韵涩", "涩感明显", "发涩", "astringency"] {
            let ids = graph.resolve(text, types: [.sensory]).map(\.id)
            XCTAssertTrue(ids.contains("sensory.astringency"), "\(text) 应归到涩感，实际 \(ids)")
        }
    }

    // MARK: - §51 Insufficient Evidence / §49

    func testNoHistoryMeansNoPersonalRecommendation() {
        let bean = makeBean()
        let linked = PersonalKnowledgeService().linked(bean: bean, method: "V60", languageCode: "zh-Hans")

        XCTAssertFalse(linked.personal.hasEnoughData)
        XCTAssertFalse(linked.personalComesFirst)

        let insight = BeanKnowledgeInsight.brewRelevant(linked, method: "V60", languageCode: "zh-Hans")
        XCTAssertNil(insight.recommendation, "零记录时不许给个性化建议")
        XCTAssertEqual(insight.confidence, .low)
        XCTAssertTrue(
            insight.limitations.contains { $0.contains(String(IntelligenceConfig.minimumSamplesForComparison)) },
            "证据不足时必须说清缺多少条，且数字来自真实阈值"
        )
    }

    // MARK: - §56 Scenario 3

    func testScenario3DeviationDetectsCurrentOutsidePersonalRange() {
        let bean = makeBean()
        makeBrew(bean, daysAgo: 20, score: 5, waterTemp: 91, timeSeconds: 150)
        makeBrew(bean, daysAgo: 14, score: 5, waterTemp: 92, timeSeconds: 155)
        makeBrew(bean, daysAgo: 10, score: 5, waterTemp: 91.5, timeSeconds: 152)
        // 当前这一次明显更热、更久。
        makeBrew(bean, daysAgo: 1, score: 3, waterTemp: 94, timeSeconds: 185)

        let analysis = ParameterDeviationAnalyzer.analyze(
            current: bean.brewsNewestFirst.first,
            history: bean.brewsNewestFirst
        )

        XCTAssertEqual(analysis.verdict, .outsidePersonalRange)
        XCTAssertFalse(analysis.outsideFields.isEmpty)

        // 措辞红线：比较对象是用户自己的历史，永远不说「错」。
        let insight = InsightFormatter.deviation(analysis, bean: bean)
        let joined = ([insight.headline] + insight.reasons).joined()
        XCTAssertFalse(joined.contains("错"), "偏离措辞不许出现「错」")
    }

    // MARK: - §56 Scenario 4（相似记录 + 同一实体的措辞变体）

    func testScenario4SimilarWordingHitsTheSameSensoryEntity() throws {        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        let bean = makeBean()
        makeBrew(bean, daysAgo: 10, score: 3, waterTemp: 94, timeSeconds: 185)
        bean.brewsNewestFirst.first?.notes = "后段发干"
        try? context.save()

        // 用户这次写「尾段干涩」，两次描述必须落到同一个实体上，
        // 否则「相似记录」只能靠字面巧合。
        let first = graph.resolve("后段发干", types: [.sensory]).map(\.id)
        let second = graph.resolve("尾段干涩", types: [.sensory]).map(\.id)
        XCTAssertTrue(first.contains("sensory.astringency"))
        XCTAssertTrue(second.contains("sensory.astringency"))

        // 用户记录也带 entityIds，所以「同产区 / 同处理法的往次记录」能被实体过滤捞出来。
        // 记录进的是**索引**（`EmbeddingRecord`），不在 `KnowledgeBase` 里，所以这里
        // 直接检查 `DocumentBuilder` 产出的资料，而不是去问知识检索服务。
        let brew = try XCTUnwrap(bean.brewsNewestFirst.first)
        let document = DocumentBuilder.brewDocument(brew)
        XCTAssertEqual(document.sourceType, .brew)
        let entityIDs = document.metadata.entityIds ?? []
        XCTAssertTrue(entityIDs.contains("region.guji"), "冲煮记录应带 region.guji：\(entityIDs)")
        XCTAssertTrue(entityIDs.contains("process.washed"), "冲煮记录应带 process.washed：\(entityIDs)")
    }

    // MARK: - 结构

    func testLinksSeparateDirectMatchesFromHierarchyMatches() throws {
        try XCTSkipIf(graph.entities.isEmpty, "实体图谱资源未打包进测试宿主")

        let bean = makeBean()
        let knowledge = linking().context(for: bean, method: "V60", languageCode: "zh-Hans")

        XCTAssertFalse(knowledge.directLinks.isEmpty)
        XCTAssertFalse(knowledge.relatedLinks.isEmpty)

        // 直接链接里不许出现 hierarchy —— 那是「推出来的」，规格 §十二 不许它混进来。
        XCTAssertTrue(knowledge.directLinks.allSatisfy { $0.match != .hierarchy })
        XCTAssertTrue(knowledge.relatedLinks.allSatisfy { $0.match == .hierarchy || $0.match == .generalContext })
        // 置信度与命中方式一致，不是随手填的。
        for link in knowledge.directLinks {
            XCTAssertEqual(link.confidence, BeanKnowledgeLink.confidence(for: link.match))
        }
    }

    func testKnowledgeBaseCarriesEntityIDsAndScopes() {
        let documents = KnowledgeBase.payload.documents
        XCTAssertEqual(KnowledgeBase.payload.revision, 2)
        XCTAssertFalse(documents.isEmpty)

        // 每条知识都必须能说清它适用于什么范围（规格 §十三）。
        for document in documents {
            XCTAssertNotNil(document.scope, "\(document.id) 缺 scope")
            XCTAssertNotNil(document.authorityTier, "\(document.id) 缺权威等级")
            XCTAssertFalse(document.sourceIds.isEmpty, "\(document.id) 缺来源 id（规格 §四十一）")
        }

        // v60 那条必须挂着 v60 实体，否则 §二十 的实体过滤形同虚设。
        let v60 = documents.first { $0.id == "kb.pourover.v60" }
        XCTAssertEqual(v60?.entityIds, ["method.v60"])
        XCTAssertEqual(v60?.scope, EntityScope.brewMethod.rawValue)
    }

    /// 实体过滤对**知识**要真的生效——这是 v1 时代缺失、v2 才有的一环。
    func testEntityFilterMatchesKnowledgeNotJustUserRecords() {
        let search = KnowledgeSearchService(graph: graph)
        let evidence = search.searchByEntity("method.v60", languageCode: "zh-Hans")
        XCTAssertTrue(evidence.contains { $0.documentID == "kb.pourover.v60" })
        XCTAssertTrue(evidence.allSatisfy { !$0.matchedEntities.isEmpty })
    }
}
