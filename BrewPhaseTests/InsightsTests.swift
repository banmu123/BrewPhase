import SwiftData
import XCTest
@testable import BrewPhase

/// Local Intelligence V1 的验收测试（协议 §39 / §44 的五类场景）。
///
/// 断言口径和 `AskRetrievalTests` 一致：规则与数字断言精确值（确定性回归），
/// 文案只断言包含关系。特别的红线在这里钉死：
/// * 「证据不足」里的 N 必须等于 `IntelligenceConfig.minimumSamplesForComparison`
///   （协议 Case 5：N 必须是系统真实设置值，不要编造）；
/// * 偏离措辞永远不许出现「错」——比较对象是用户自己的历史，不是外部标准。
@MainActor
final class InsightsTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private var engine: RecommendationEngine!

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
        engine = RecommendationEngine(context: context)
    }

    override func tearDown() {
        engine = nil
        context = nil
        container = nil
    }

    // MARK: - 夹具

    @discardableResult
    private func makeGuji(remainingG: Double = 86, daysAgoRoast: Int = 16) -> Bean {
        let bean = Bean(
            name: "Ethiopia Guji", roaster: "启程咖啡", origin: "埃塞俄比亚 · Guji", process: "水洗",
            roastLevel: .light,
            roastDate: DateMath.add(days: -daysAgoRoast, to: today),
            openDate: DateMath.add(days: -10, to: today),
            weightG: 200, remainingG: remainingG,
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

    /// 全参数版夹具：偏离测试需要精确控制水温和时间。
    @discardableResult
    private func makeBrew(
        _ bean: Bean, daysAgo: Int, score: Int,
        waterTemp: Double = 92, timeSeconds: Int = 150,
        coffeeG: Double = 18, waterG: Double = 300,
        notes: String = "备注", method: String = "V60"
    ) -> Brew {
        let brew = Brew(
            date: DateMath.add(days: -daysAgo, to: today), method: method,
            grinder: "司令官 C40", grindSize: "22 格", waterTemp: waterTemp,
            coffeeG: coffeeG, waterG: waterG, timeSeconds: timeSeconds, score: score,
            acidity: score, sweetness: score, flavorTags: ["Mandarin"],
            notes: notes, bean: bean
        )
        context.insert(brew)
        return brew
    }

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: []) }

    // MARK: - Case 1：这包豆以前怎么冲最好（协议 §44 Case 1）

    func testCase1PersonalBestReturnsTheTopRatedBrewWithItsRecipe() {
        let bean = makeGuji()
        // 10 次历史：3 次 5 分、2 次 4 分、5 次低分。低分不参与「常用值」。
        makeBrew(bean, daysAgo: 14, score: 3)
        makeBrew(bean, daysAgo: 12, score: 2)
        makeBrew(bean, daysAgo: 11, score: 3)
        makeBrew(bean, daysAgo: 9, score: 5, waterTemp: 92, timeSeconds: 150)
        makeBrew(bean, daysAgo: 8, score: 4, waterTemp: 91, timeSeconds: 145)
        makeBrew(bean, daysAgo: 6, score: 5, waterTemp: 93, timeSeconds: 155)
        makeBrew(bean, daysAgo: 5, score: 1)
        makeBrew(bean, daysAgo: 4, score: 2)
        makeBrew(bean, daysAgo: 3, score: 4, waterTemp: 92, timeSeconds: 150)
        makeBrew(bean, daysAgo: 2, score: 3)

        let insight = engine.personalBest(for: bean)

        XCTAssertEqual(insight.kind, .personalBest)
        XCTAssertEqual(insight.confidence, .medium)
        XCTAssertEqual(insight.beanID, bean.id)
        XCTAssertTrue(insight.headline.contains(bean.displayName), "结果要指名是哪包豆")

        // 证据第一条就是最佳那次的配方：日期 + 参数 + 评分，全部可追溯。
        // 两条 5 分记录（92°C 与 93°C）同分取最近，最佳是 93°C 那次。
        let firstEvidence = insight.evidence.first?.text ?? ""
        XCTAssertTrue(firstEvidence.contains("93"), "同分取最近：最佳应是 93°C 那次")
        XCTAssertTrue(firstEvidence.contains("18"), "粉量要出现在证据里")
        XCTAssertTrue(firstEvidence.contains("300"), "水量要出现在证据里")
        XCTAssertTrue(firstEvidence.contains("5"), "最高评分要出现在证据里")

        // 高分区间统计来自 4 条高评分记录（92/91/93/92 → 92 到 93）。
        let temperatureEvidence = insight.evidence.map(\.text)
            .first { $0.contains(L("高评分记录的水温通常在")) }
        XCTAssertNotNil(temperatureEvidence)
        XCTAssertTrue(temperatureEvidence?.contains("93") ?? false, "区间上界来自真实高分记录")
        XCTAssertFalse(temperatureEvidence?.contains("94") ?? true, "低分记录的 94 不该混进常用区间")
    }

    // MARK: - Case 5：没有足够历史时不说结论（协议 §44 Case 5）

    func testCase5PersonalBestSaysInsufficientEvidenceWithTheRealThreshold() {
        let bean = makeGuji()
        makeBrew(bean, daysAgo: 3, score: 5) // 高评分只有 1 条，不足 N=3

        let insight = engine.personalBest(for: bean)

        XCTAssertEqual(insight.confidence, .insufficientEvidence)
        XCTAssertEqual(insight.kind, .personalBest)
        // N 必须和系统的真实设置一致，不许是编造的数。
        XCTAssertTrue(
            insight.reasons.contains(
                L("至少需要 %@ 条带评分的冲煮记录后才能进行比较。",
                  String(IntelligenceConfig.minimumSamplesForComparison))
            ),
            "理由里要写清真实阈值 N=\(IntelligenceConfig.minimumSamplesForComparison)"
        )
        // 现状证据：有几条带评分的记录要说清，而不是空着。
        XCTAssertTrue(
            (insight.evidence.first?.text ?? "").contains("1"),
            "证据里要报告现有的记录数"
        )
    }

    func testCase5WithNoHistoryAtAll() {
        let bean = makeGuji()

        let insight = engine.personalBest(for: bean)

        XCTAssertEqual(insight.confidence, .insufficientEvidence)
        XCTAssertTrue(insight.evidence.contains { $0.text.contains("0") }, "零记录也要说成证据")
    }

    // MARK: - Case 3：今天该喝哪包（协议 §44 Case 3）

    func testCase3TodayPickFollowsThePriorityRulesAndShowsRealNumbers() {
        // 两包都在可喝窗口内时，剩余量少、开封更久的 Guji 应该排在前面。
        let guji = makeGuji(remainingG: 30, daysAgoRoast: 16)
        let brazil = makeBrazil()

        let insight = engine.todayPick(
            beans: [brazil, guji],
            book: book,
            defaults: .standard,
            today: today
        )

        let pick = try! XCTUnwrap(insight, "库里有两包可喝的豆子时必须给出建议")
        XCTAssertEqual(pick.beanID, guji.id, "排序应与 PriorityEngine 一致：剩余少的先喝")
        XCTAssertEqual(pick.kind, .todayPick)

        // 证据全部来自真实数据：烘焙后天数、剩余量。
        let joined = pick.evidence.map(\.text).joined(separator: "；")
        XCTAssertTrue(joined.contains(L("剩余")), "剩余量要作为证据出现")
        XCTAssertTrue(joined.contains("16"), "烘焙后 16 天要出现在证据里")
    }

    func testCase3UrgencyWordingFollowsTheVerdictTier() {
        // 刚烘焙 3 天的浅烘还在养豆，不该被说成「优先」。
        let fresh = makeGuji(remainingG: 200, daysAgoRoast: 3)

        let insight = engine.todayPick(beans: [fresh], book: book, defaults: .standard, today: today)

        let pick = try! XCTUnwrap(insight)
        XCTAssertFalse(
            pick.headline.contains(L("建议优先喝")),
            "还在养豆期的豆子不该被催着喝：headline=\(pick.headline)"
        )
    }

    // MARK: - Case 4：这次冲煮和高评分的区别（协议 §44 Case 4）

    func testCase4DeviationReportsTheDifferenceAgainstPersonalBest() {
        let bean = makeGuji()
        // 高评分区间：92°C / 150s（3 条高分记录的常用值）。
        makeBrew(bean, daysAgo: 9, score: 5, waterTemp: 92, timeSeconds: 150)
        makeBrew(bean, daysAgo: 8, score: 4, waterTemp: 91, timeSeconds: 145)
        makeBrew(bean, daysAgo: 6, score: 5, waterTemp: 93, timeSeconds: 155)
        // 这次：94°C / 185s——两项都超出容差。
        makeBrew(bean, daysAgo: 1, score: 2, waterTemp: 94, timeSeconds: 185)

        let insight = engine.deviation(for: bean)

        XCTAssertEqual(insight.kind, .deviation)
        XCTAssertEqual(insight.confidence, .medium)
        XCTAssertTrue(insight.headline.contains(L("偏离了你高评分记录的常用范围")))

        let joined = insight.reasons.joined(separator: "；")
        XCTAssertTrue(joined.contains(L("水温")), "水温的偏离要点名")
        XCTAssertTrue(joined.contains(L("高了")), "方向要说清（高了而不是低了）")
        XCTAssertTrue(joined.contains(L("萃取时间")), "时间的偏离要点名")

        // 措辞红线（协议 §20）：和用户自己的历史比，永远不说「错了」。
        XCTAssertFalse(joined.contains(L("错")), "不许把偏离说成错误：\(joined)")

        // 证据行的「当前 vs 常用」都要是真实数字。
        let row = insight.evidence.map(\.text).first { $0.contains(L("水温")) }
        XCTAssertEqual(row, L("%@：当前 %@（常用 %@）", L("水温"), "94°C", "92°C"))
    }

    func testCase4WithinRangeProducesACalmHeadline() {
        let bean = makeGuji()
        makeBrew(bean, daysAgo: 9, score: 5, waterTemp: 92, timeSeconds: 150)
        makeBrew(bean, daysAgo: 8, score: 4, waterTemp: 91, timeSeconds: 145)
        makeBrew(bean, daysAgo: 6, score: 5, waterTemp: 93, timeSeconds: 155)
        makeBrew(bean, daysAgo: 1, score: 5, waterTemp: 92, timeSeconds: 150) // 和常用值一致

        let insight = engine.deviation(for: bean)

        XCTAssertEqual(insight.confidence, .high)
        XCTAssertTrue(insight.headline.contains(L("基本一致")))
        XCTAssertFalse(insight.headline.contains(L("偏离")))
    }

    func testCase4DeviationWithTooFewHighRatedBrewsIsInsufficient() {
        let bean = makeGuji()
        makeBrew(bean, daysAgo: 9, score: 5, waterTemp: 92) // 只有 1 条高分
        makeBrew(bean, daysAgo: 1, score: 2, waterTemp: 94)

        let insight = engine.deviation(for: bean)

        XCTAssertEqual(insight.confidence, .insufficientEvidence)
        XCTAssertTrue(insight.evidence.isEmpty)
        XCTAssertTrue(insight.reasons.contains { $0.contains(String(IntelligenceConfig.minimumSamplesForComparison)) })
    }

    // MARK: - Case 2：以前有没有遇到过类似干涩（协议 §44 Case 2）

    func testCase2SimilarHistoryFindsTheSameWordingAndRespectsTheBeanFilter() async {
        let guji = makeGuji()
        let brazil = makeBrazil()
        makeBrew(guji, daysAgo: 9, score: 3, notes: "尾段发干，其他都好")
        makeBrew(guji, daysAgo: 6, score: 4, notes: "余韵有点涩")
        makeBrew(brazil, daysAgo: 5, score: 2, notes: "尾段发干，苦味压不住")

        var settings = RAGSettings.standard
        settings.embeddingBackend = .lexical // 词法向量是确定性的，适合钉住行为

        // 锁定 Guji：巴西那包同样写着「尾段发干」，也不许混进来。
        let insight = await engine.similarHistory(
            matching: "尾段发干",
            focus: guji,
            beans: [guji, brazil],
            brews: Array(guji.brewsNewestFirst) + Array(brazil.brewsNewestFirst),
            tastings: [],
            book: book,
            settings: settings,
            languageCode: "zh-Hans",
            now: today
        )

        XCTAssertEqual(insight.kind, .similarHistory)
        let names = insight.evidence.map(\.text).joined(separator: "；")
        XCTAssertTrue(names.contains("Ethiopia Guji"), "命中记录要能追溯到豆子")
        XCTAssertFalse(names.contains("Brazil Cerrado"), "锁定某包豆后不许混入别的豆子")
    }

    func testCase2SimilarHistoryWithNoIndexAtAllSaysSo() async {
        let bean = makeGuji()

        let insight = await engine.similarHistory(
            matching: "干涩",
            focus: bean,
            beans: [bean],
            brews: [],
            tastings: [],
            book: book,
            settings: .standard,
            languageCode: "zh-Hans",
            now: today
        )

        XCTAssertEqual(insight.confidence, .insufficientEvidence)
        XCTAssertTrue(insight.evidence.isEmpty)
    }

    // MARK: - 能力状态（协议 §36）

    func testCapabilityReportsWhatIsActuallyAvailable() async {
        let capability = await engine.capability(settings: .standard, languageCode: "zh-Hans")

        XCTAssertTrue(capability.structuredQueryAvailable, "结构化查询是纯本地代码，恒可用")
        XCTAssertTrue(capability.recommendationAvailable, "推荐是纯本地代码，恒可用")
        XCTAssertTrue(capability.knowledgeBaseAvailable, "随包知识库必须能加载")
        // 语义检索的可用性取决于 provider，但 backend 名字必须如实报告。
        XCTAssertEqual(capability.semanticBackend, .onDevice)
        XCTAssertFalse(capability.semanticModelIdentifier.isEmpty)
    }

    // MARK: - 性能（协议 §45 要求报告）

    /// 演示数据规模（6 包豆 + 全部记录 + 16 条知识库）的首次同步与一次语义检索。
    /// 门限故意放得很宽（协议 §40：不过度优化，只要不卡）；打印实际数字供报告用。
    func testDemoScaleSyncAndSearchStayInteractive() async throws {
        let bean = makeGuji()
        for offset in 0..<12 {
            makeBrew(bean, daysAgo: 14 - offset, score: [5, 4, 3, 2][offset % 4],
                     waterTemp: 92 + Double(offset % 3), timeSeconds: 145 + offset * 3,
                     notes: offset % 3 == 0 ? "尾段发干" : "很顺滑，柑橘明显")
        }
        let brazil = makeBrazil()
        makeBrew(brazil, daysAgo: 4, score: 2, notes: "尾段发干")

        let beans = try context.fetch(FetchDescriptor<Bean>())
        let brews = try context.fetch(FetchDescriptor<Brew>())
        let tastings = try context.fetch(FetchDescriptor<Tasting>())

        var settings = RAGSettings.standard
        settings.embeddingBackend = .lexical // 词法向量稳定且快，门限才有意义

        let syncStart = Date()
        let report = await engine.similarHistory(
            matching: "尾段发干", focus: nil,
            beans: beans, brews: brews, tastings: tastings,
            book: book, settings: settings, languageCode: "zh-Hans", now: today
        )
        let elapsed = Date().timeIntervalSince(syncStart)
        print("⏱ similarHistory (sync + embed + search + format): \(Int(elapsed * 1000)) ms, headline=\(report.headline)")

        XCTAssertFalse(report.evidence.isEmpty, "两条「尾段发干」必须能找到")
        XCTAssertLessThan(elapsed, 2.0, "演示规模的一次问答不许卡")
    }

    // MARK: - 今天喝什么、手冲还是意式

    func testMethodSuggestionPrefersTheHistoryWhenItIsClear() {
        // Guji 手冲 4 次平均 4.5，意式 2 次平均 2——历史明确，该是手冲。
        let bean = makeGuji()
        makeBrew(bean, daysAgo: 9, score: 5, method: "V60")
        makeBrew(bean, daysAgo: 8, score: 4, method: "V60")
        makeBrew(bean, daysAgo: 6, score: 5, method: "手冲")
        makeBrew(bean, daysAgo: 4, score: 4, method: "V60")
        makeBrew(bean, daysAgo: 3, score: 2, method: "意式浓缩")
        makeBrew(bean, daysAgo: 2, score: 2, method: "espresso")

        let insight = engine.methodSuggestion(for: bean, allBrews: try! context.fetch(FetchDescriptor<Brew>()))

        XCTAssertEqual(insight.kind, .methodSuggestion)
        XCTAssertEqual(insight.confidence, .medium)
        XCTAssertTrue(insight.headline.contains(MethodFamily.filter.label),
                      "历史平均分差 ≥0.5 时偏好不能推翻记录：\(insight.headline)")

        let joined = insight.reasons.joined(separator: "；") + insight.evidence.map(\.text).joined(separator: "；")
        XCTAssertTrue(joined.contains("4.5"), "手冲的平均分要出现")
        XCTAssertTrue(joined.contains(MethodFamily.espresso.label), "被比下去的家族也要摆出来")
    }

    func testMethodSuggestionBreaksATieByTheFixedFamilyOrder() {
        // 手冲平均 4.0、意式平均 4.0：平票，按「手冲 → 意式 → 冷萃」的固定顺序手冲赢。
        let bean = makeGuji()
        makeBrew(bean, daysAgo: 9, score: 4, method: "V60")
        makeBrew(bean, daysAgo: 7, score: 4, method: "手冲")
        makeBrew(bean, daysAgo: 5, score: 4, method: "V60")
        makeBrew(bean, daysAgo: 3, score: 4, method: "意式浓缩")
        makeBrew(bean, daysAgo: 2, score: 4, method: "意式浓缩")

        let insight = engine.methodSuggestion(for: bean, allBrews: [])

        XCTAssertTrue(insight.headline.contains(MethodFamily.filter.label),
                      "平票按固定家族顺序取先者：\(insight.headline)")
        XCTAssertTrue(insight.evidence.contains { $0.text.contains(MethodFamily.espresso.label) },
                      "被比下去的家族要摆进证据里")
    }

    func testMethodSuggestionWithNoHistoryAtAllSaysSo() {
        let bean = makeGuji()

        let insight = engine.methodSuggestion(for: bean, allBrews: [])

        XCTAssertEqual(insight.confidence, .insufficientEvidence)
        XCTAssertTrue(insight.reasons.contains {
            $0.contains(String(IntelligenceConfig.minimumSamplesForComparison - 1))
        }, "阈值必须来自 IntelligenceConfig 的真实值")
    }

    func testMethodRulesRecogniseFreeTextVariants() {
        XCTAssertEqual(MethodRules.family(of: "V60"), .filter)
        XCTAssertEqual(MethodRules.family(of: "手冲"), .filter)
        XCTAssertEqual(MethodRules.family(of: "意式浓缩"), .espresso)
        XCTAssertEqual(MethodRules.family(of: "卡布奇诺"), .espresso)
        XCTAssertEqual(MethodRules.family(of: "冷萃"), .cold)
        XCTAssertEqual(MethodRules.family(of: "冰手冲"), .cold, "「冰」优先：用户想说的是冰的那杯")
        XCTAssertNil(MethodRules.family(of: "完全不认识的做法"))
    }


    func testFormatterNeverInventsNumbers() {
        // 剩余量变了，证据必须跟着变——模板里不许藏死数字。
        let bean = makeGuji(remainingG: 137, daysAgoRoast: 9)
        let pick = try! XCTUnwrap(
            InsightFactory.todaysPick([bean], book: book, defaults: .standard, today: today)
        )
        let insight = InsightFormatter.todayPick(pick, bean: bean, today: today)

        let joined = insight.evidence.map(\.text).joined(separator: "；")
        XCTAssertTrue(joined.contains("137"), "剩余量必须来自真实数据")
        XCTAssertTrue(joined.contains("9"), "烘焙后天数必须来自真实数据")
        XCTAssertFalse(joined.contains("86"), "旧数值不许残留")
    }
}
