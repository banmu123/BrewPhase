import SwiftData
import XCTest
@testable import BrewPhase

/// 30 秒快记 → 个人基线 → 诊断 → 下一杯建议 → 再记录 这条闭环的测试
/// （规格 §二十八 的第 1、2、10 项）。
///
/// 前面 `BrewDiagnosticTests` 测的是规则本身（纯值类型）；这里测的是**接线**：
/// 预填取的是哪一次、保存会不会把库存和时间线一起带上、诊断能不能进「问一问」。
@MainActor
final class BrewLoopTests: XCTestCase {

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
        guji = makeBean()
        try context.save()
    }

    override func tearDown() {
        engine = nil
        context = nil
        container = nil
    }

    // MARK: - 夹具

    @discardableResult
    private func makeBean(name: String = "Ethiopia Guji", remainingG: Double = 200) -> Bean {
        let bean = Bean(
            name: name, roaster: "启程咖啡", origin: "埃塞俄比亚 · Guji", process: "水洗",
            roastLevel: .light,
            roastDate: DateMath.add(days: -16, to: today),
            openDate: DateMath.add(days: -10, to: today),
            weightG: 200, remainingG: remainingG,
            flavorTags: ["Jasmine"], notes: ""
        )
        context.insert(bean)
        return bean
    }

    @discardableResult
    private func makeBrew(
        _ bean: Bean,
        daysAgo: Int,
        method: String = "V60",
        temp: Double = 92,
        dose: Double = 15,
        water: Double = 240,
        time: Int = 150,
        score: Int = 0,
        acidity: Int = 0,
        sweetness: Int = 0,
        bitterness: Int = 0,
        body: Int = 0,
        notes: String = ""
    ) -> Brew {
        let brew = Brew(
            date: DateMath.add(days: -daysAgo, to: today), method: method,
            grinder: "司令官 C40", grindSize: "22 格", waterTemp: temp,
            coffeeG: dose, waterG: water, timeSeconds: time, score: score,
            acidity: acidity, sweetness: sweetness, bitterness: bitterness, body: body,
            flavorTags: [], notes: notes, bean: bean
        )
        context.insert(brew)
        return brew
    }

    private func draft(
        time: String = "2:30",
        temp: Double = 92,
        dose: Double = 15,
        water: Double = 240,
        score: Int = 0,
        flavorTags: [String] = [],
        notes: String = ""
    ) -> BrewRecorder.Draft {
        BrewRecorder.Draft(
            recipe: BrewRecipe(method: "V60", grinder: "司令官 C40", grindSize: "22 格",
                               waterTemp: temp, coffeeG: dose, waterG: water, timeSeconds: 0),
            timeText: time,
            date: today,
            score: score,
            flavorTags: flavorTags,
            notes: notes
        )
    }

    // MARK: - 预填（规格 §28 第 1 项）

    func testTheFormPrefillsFromTheLastBrewOfThisBag() throws {
        makeBrew(guji, daysAgo: 5, temp: 91, time: 155, score: 5)
        let latest = makeBrew(guji, daysAgo: 2, temp: 92, dose: 18, water: 300, time: 140, score: 3)

        let prefill = BrewPrefillBuilder.prefill(
            beanBrews: guji.brewsNewestFirst, allBrews: guji.brewsNewestFirst, defaults: .standard
        )

        XCTAssertEqual(prefill.source, .lastBrewOfSameBean)
        XCTAssertEqual(prefill.basis?.id, latest.id)
        XCTAssertEqual(prefill.recipe.coffeeG, 18)
        XCTAssertEqual(prefill.recipe.waterG, 300)
        XCTAssertEqual(prefill.recipe.waterTemp, 92)
        XCTAssertEqual(prefill.timeText, "2:20")
        XCTAssertEqual(prefill.basis?.sameBean, true)
    }

    func testTheSameMethodWinsOverSimplyTheNewest() throws {
        let espresso = makeBrew(guji, daysAgo: 1, method: "意式浓缩", temp: 93, dose: 18, water: 36, time: 28)
        let v60 = makeBrew(guji, daysAgo: 4, method: "V60", temp: 91, dose: 15, water: 240, time: 152)
        _ = espresso

        let prefill = BrewPrefillBuilder.prefill(
            beanBrews: guji.brewsNewestFirst, allBrews: guji.brewsNewestFirst,
            method: "V60", defaults: .standard
        )

        XCTAssertEqual(prefill.basis?.id, v60.id, "换了器具之后就找那一件器具的上一次")
        XCTAssertEqual(prefill.recipe.waterTemp, 91)
        XCTAssertEqual(prefill.recipe.method, "V60", "用户刚选的冲法不能被预填改掉")
    }

    func testANewBagBorrowsTheHabitAndThenFallsBackToDefaults() throws {
        let colombia = makeBean(name: "Colombia Huila")
        makeBrew(guji, daysAgo: 2, temp: 91, dose: 15, water: 240, time: 152)

        let borrowed = BrewPrefillBuilder.prefill(
            beanBrews: colombia.brewsNewestFirst, allBrews: guji.brewsNewestFirst, defaults: .standard
        )
        XCTAssertEqual(borrowed.source, .lastBrewAnyBean)
        XCTAssertEqual(borrowed.recipe.waterTemp, 91, "换豆时沿用习惯的那套参数")
        XCTAssertEqual(borrowed.basis?.sameBean, false)

        let cold = BrewPrefillBuilder.prefill(
            beanBrews: [], allBrews: [], defaults: .standard
        )
        XCTAssertEqual(cold.source, .userDefaults)
        XCTAssertTrue(cold.isBareDefault)
        XCTAssertNil(cold.basis)
        XCTAssertEqual(cold.recipe.coffeeG, BrewDefaults.standard.doseG)
        XCTAssertEqual(cold.recipe.method, BrewDefaults.standard.method)
    }

    /// 规格 §七：改了哪一项，存之前就该看得见。
    func testTheDeltaNamesWhatChangedSinceTheLastCup() {
        let previous = BrewRecipe(method: "V60", grinder: "司令官 C40", grindSize: "22 格",
                                  waterTemp: 92, coffeeG: 15, waterG: 240, timeSeconds: 152)
        var current = previous
        current.waterTemp = 91
        current.timeSeconds = 160

        let delta = BrewDelta.between(previous: previous, current: current)

        XCTAssertEqual(delta.changes.count, 2)
        let temperature = delta.changes.first { $0.field == .parameter(.temperature) }
        XCTAssertEqual(temperature?.phrase, "降温 1°C")
        let time = delta.changes.first { $0.field == .parameter(.time) }
        XCTAssertEqual(time?.phrase, "延长 8 秒")
        XCTAssertEqual(delta.singleNumericChange, nil, "改了两项就不算「只改一个」")

        // 只填了其中一边的字段不参与比较：那不是用户改的，是他第一次填。
        var halfFilled = BrewRecipe.empty
        halfFilled.method = "V60"
        XCTAssertTrue(BrewDelta.between(previous: .empty, current: halfFilled).changes.isEmpty)
    }

    // MARK: - 保存（规格 §28 第 2 项）

    func testSavingDeductsStockAndLeavesATimelineMark() throws {
        let brew = try BrewRecorder.save(
            draft(time: "2:30", score: 4, flavorTags: ["Honey"], notes: "甜感明显"),
            bean: guji, in: context
        )

        XCTAssertEqual(brew.timeSeconds, 150)
        XCTAssertEqual(brew.score, 4)
        XCTAssertEqual(guji.remainingG, 185, accuracy: 0.001)
        let mirror = (guji.tastings ?? []).first { $0.brewID == brew.id }
        XCTAssertNotNil(mirror, "记一次冲煮应当顺手在风味时间线上留一条")
        XCTAssertEqual(mirror?.source, .brew)
        XCTAssertEqual(mirror?.notes, "甜感明显")
    }

    func testEditingAdjustsStockByTheDifferenceOnly() throws {
        let brew = try BrewRecorder.save(draft(dose: 15), bean: guji, in: context)
        XCTAssertEqual(guji.remainingG, 185, accuracy: 0.001)

        // 改一个打错的粉量：只补差，不该再扣一次。
        _ = try BrewRecorder.save(draft(dose: 18), bean: guji, existing: brew, in: context)
        XCTAssertEqual(guji.remainingG, 182, accuracy: 0.001)
        XCTAssertEqual(brew.coffeeG, 18)

        // 去掉和冲煮逐字重复的镜像记录：冲煮不再有话可说时它也该消失。
        _ = try BrewRecorder.save(
            BrewRecorder.Draft(existing: brew), bean: guji, existing: brew, in: context
        )
        XCTAssertTrue((guji.tastings ?? []).allSatisfy { $0.brewID != brew.id })
    }

    func testSavingWithoutADoseIsRefusedWithAReadableMessage() {
        XCTAssertThrowsError(try BrewRecorder.save(draft(dose: 0), bean: guji, in: context)) { error in
            guard case BrewRecorder.Failure.invalid(let message) = error else {
                return XCTFail("应当是校验失败：\(error)")
            }
            XCTAssertTrue(message.contains("粉量"), message)
        }
    }

    func testDeletingABrewPutsTheCoffeeBack() throws {
        let brew = try BrewRecorder.save(draft(dose: 15), bean: guji, in: context)
        XCTAssertEqual(guji.remainingG, 185, accuracy: 0.001)

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(guji.remainingG, 200, accuracy: 0.001)
        XCTAssertEqual(try context.fetch(FetchDescriptor<Brew>()).count, 0)
    }

    /// 保存失败时靠 `BrewRecorder.apply` 把上一版逐字段写回去（`rollback()`
    /// 撤不回既有对象的属性改动，见 `PersistenceTests`）。这个往返必须无损，
    /// 否则失败清理会留下第三种状态——既不是新值也不是旧值。
    func testReapplyingTheOriginalDraftRestoresEveryField() throws {
        let brew = try BrewRecorder.save(
            draft(time: "2:28", temp: 92, dose: 18, water: 300, score: 5,
                  flavorTags: ["Honey"], notes: "甜感明显"),
            bean: guji, in: context
        )
        let original = BrewRecorder.Draft(existing: brew)

        // 走一遍「用户改了一堆字段」再写回。
        BrewRecorder.apply(
            BrewRecorder.Draft(
                recipe: BrewRecipe(method: "意式浓缩", grinder: "X", grindSize: "3",
                                   waterTemp: 85, coffeeG: 20, waterG: 40, timeSeconds: 0),
                timeText: "0:30", date: today, score: 1, notes: "改坏的"
            ),
            to: brew
        )
        BrewRecorder.apply(original, to: brew)

        XCTAssertEqual(brew.method, "V60")
        XCTAssertEqual(brew.grinder, "司令官 C40")
        XCTAssertEqual(brew.grindSize, "22 格")
        XCTAssertEqual(brew.waterTemp, 92, accuracy: 0.001)
        XCTAssertEqual(brew.coffeeG, 18, accuracy: 0.001)
        XCTAssertEqual(brew.waterG, 300, accuracy: 0.001)
        XCTAssertEqual(brew.timeSeconds, 148)
        XCTAssertEqual(brew.score, 5)
        XCTAssertEqual(brew.flavorTags, ["Honey"])
        XCTAssertEqual(brew.notes, "甜感明显")
    }

    // MARK: - 上一杯建议 → 这一杯（观察性对比，规格：不下因果）

    func testSuggestionFollowUpReportsOnlyWhatChanged() throws {
        let previous = makeBrew(guji, daysAgo: 2, time: 128, score: 3)   // 2:08
        let current = makeBrew(guji, daysAgo: 0, time: 151, score: 4)    // 2:31

        let followUp = SuggestionFollowUp.between(previous: previous, suggestion: nil, current: current)

        XCTAssertEqual(followUp.changesText, "时间 2:08 → 2:31")
        XCTAssertEqual(followUp.scoreDelta, 1)
        XCTAssertEqual(followUp.scoreText, L("这次评分比上一杯高。"))
        XCTAssertNil(followUp.directionText, "没有建议就没有方向结论")
    }

    func testSuggestionFollowUpSeesTheAdjustmentDirection() throws {
        let previous = Brew(date: Date(), method: "V60", waterTemp: 92,
                            coffeeG: 18, waterG: 300, timeSeconds: 150, bean: guji)
        context.insert(previous)
        let current = Brew(date: Date(), method: "V60", waterTemp: 94,
                           coffeeG: 18, waterG: 300, timeSeconds: 150, bean: guji)
        context.insert(current)

        let suggestion = AdjustmentSuggestion(
            parameter: .temperature, direction: .higher,
            reason: "", expectedEffect: "", keep: [], observe: [], referenceRange: nil
        )
        let followUp = SuggestionFollowUp.between(previous: previous, suggestion: suggestion, current: current)

        XCTAssertEqual(followUp.followedDirection, true)
        XCTAssertEqual(followUp.directionText, L("调整方向与上次建议一致。"))
        XCTAssertEqual(followUp.changes.first?.label, L("水温"))
        XCTAssertEqual(followUp.changes.first?.from, "92°C")
        XCTAssertEqual(followUp.changes.first?.to, "94°C")
    }

    // MARK: - 诊断进「问一问」（规格 §28 第 10 项）

    private func seedTheStaleCup() throws {
        makeBrew(guji, daysAgo: 12, temp: 91, time: 152, score: 5)
        makeBrew(guji, daysAgo: 8, temp: 92, time: 148, score: 4)
        makeBrew(guji, daysAgo: 4, temp: 91, time: 155, score: 5)
        // 今天这一杯：时间明显短，酸高、甜低、口感薄。
        makeBrew(guji, daysAgo: 0, temp: 92, time: 128, score: 3,
                 acidity: 5, sweetness: 2, bitterness: 2, body: 2)
        try context.save()
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

    func testAskingWhyThisCupWentWrongBringsTheDiagnosisAndTheNextStep() async throws {
        try seedTheStaleCup()
        var conversation = ConversationContext.empty

        let answer = try await ask("为什么这杯不好喝？", conversation: &conversation, focus: guji.id)

        XCTAssertTrue(answer.plan.intents.contains(.diagnosis))
        XCTAssertEqual(answer.plan.focusBeanID, guji.id, "诊断是关于某一杯的，必须锁定对象")

        let fact = answer.context.userBlocks.first { $0.passage.id.hasPrefix("fact:diagnosis:") }
        let content = try XCTUnwrap(fact?.passage.content)
        XCTAssertTrue(content.contains("可能萃取不足"), content)
        XCTAssertTrue(content.contains("2:08"), content)
        XCTAssertTrue(content.contains("下一杯建议"), content)
        XCTAssertTrue(content.contains("细一档"), content)

        // 回答里要能看见建议与「保持不变」的那部分；依据是结构化事实而不是模型措辞。
        XCTAssertTrue(answer.text.contains("下一杯建议") || answer.text.contains("细一档"), answer.text)

        // 状态里记下的是**结构化的建议**，不是回答原文。
        XCTAssertEqual(conversation.activeSuggestion?.parameter, .grind)
        XCTAssertEqual(conversation.activeSuggestion?.direction, .finer)
        XCTAssertEqual(conversation.activeSuggestion?.headline, "研磨度：细一档")
        XCTAssertEqual(conversation.focusBeanID, guji.id)
    }

    func testTheNextTurnStillKnowsWhatWasSuggested() async throws {
        try seedTheStaleCup()
        var conversation = ConversationContext.empty

        _ = try await ask("为什么这杯不好喝？", conversation: &conversation, focus: guji.id)
        let next = try await ask("那水温呢？", conversation: &conversation)

        XCTAssertTrue(next.plan.summary?.contains("上一轮的建议：研磨度：细一档") == true,
                      next.plan.summary ?? "-")
        XCTAssertEqual(next.plan.focusBeanID, guji.id)
        XCTAssertEqual(next.plan.parameter, .temperature)
        XCTAssertEqual(conversation.activeSuggestion?.parameter, .grind, "建议该留在状态里继续讨论")
        XCTAssertEqual(conversation.activeParameter, .temperature, "这一轮问的参数也要记下来")
    }

    func testSwitchingBagsDropsTheOldSuggestion() async throws {
        try seedTheStaleCup()
        let colombia = makeBean(name: "Colombia Huila")
        try context.save()
        var conversation = ConversationContext.empty

        _ = try await ask("为什么这杯不好喝？", conversation: &conversation, focus: guji.id)
        XCTAssertNotNil(conversation.activeSuggestion)

        _ = try await ask("那 Colombia Huila 呢？", conversation: &conversation)

        XCTAssertEqual(conversation.focusBeanID, colombia.id)
        XCTAssertNil(conversation.activeSuggestion, "上一包豆子的建议不该跟到新豆上")
    }

    func testWithOneCupOnlyTheAnswerSaysWhatIsMissing() async throws {
        makeBrew(guji, daysAgo: 0, temp: 92, time: 128, score: 3, acidity: 5, sweetness: 2)
        try context.save()
        var conversation = ConversationContext.empty

        let answer = try await ask("为什么这杯不好喝？", conversation: &conversation, focus: guji.id)

        XCTAssertTrue(answer.plan.intents.contains(.diagnosis))
        let fact = answer.context.userBlocks.first { $0.passage.id.hasPrefix("fact:diagnosis:") }
        let content = try XCTUnwrap(fact?.passage.content)
        XCTAssertTrue(content.contains("还差"), content)
        XCTAssertTrue(content.contains("继续记几杯"), content)
        XCTAssertFalse(content.contains("细一档"), "没有参考记录时不许给出一个具体建议")
        XCTAssertNil(answer.plan.suggestion)
    }
}
