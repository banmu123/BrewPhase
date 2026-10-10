import SwiftData
import XCTest
@testable import BrewPhase

/// 饮品选择 → 配方 → 分步引导 → 记录 这条新链路的测试。
///
/// 覆盖四层：配方目录与默认值、步骤生成（目标值必须由配方算出）、计时器
/// 的日期算术、以及模型扩展之后既有链路不被破坏（校验不误伤奶咖、库存只扣
/// 粉、导出兼容旧备份）。
@MainActor
final class BrewGuideTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private var bean: Bean!

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
        bean = Bean(
            name: "Ethiopia Guji", roaster: "启程咖啡", origin: "埃塞俄比亚", process: "水洗",
            roastLevel: .light, roastDate: Date(), openDate: nil,
            weightG: 200, remainingG: 200, flavorTags: [], notes: ""
        )
        context.insert(bean)
        try context.save()
    }

    override func tearDown() {
        context = nil
        container = nil
        bean = nil
    }

    // MARK: - 饮品目录

    func testAllSixDrinksExistWithDistinctNames() {
        XCTAssertEqual(DrinkType.allCases.count, 6)
        XCTAssertEqual(Set(DrinkType.allCases.map(\.name)).count, 6)
    }

    func testEveryDrinkHasACompleteDefaultPlan() {
        for drink in DrinkType.allCases {
            let plan = DrinkRecipePlan.default(for: drink)
            XCTAssertGreaterThan(plan.coffeeG, 0, "\(drink) 的粉量不能是零")
            XCTAssertGreaterThan(plan.totalSeconds, 0, "\(drink) 的用时不能是零")
            XCTAssertEqual(plan.drink, drink)
            // 需要什么就有什么，不需要的必须是零——字段语义不许含糊。
            XCTAssertEqual(plan.espressoYieldG > 0, drink.usesEspressoYield, "\(drink) 浓缩液")
            XCTAssertEqual(plan.milkG > 0, drink.usesMilk, "\(drink) 牛奶")
            XCTAssertEqual(plan.addedWaterG > 0, drink.usesAddedWater, "\(drink) 加水")
            if drink == .pourOver || drink == .coldBrew {
                XCTAssertGreaterThan(plan.waterG, 0, "\(drink) 需要冲煮用水")
            } else {
                XCTAssertEqual(plan.waterG, 0, "\(drink) 不该有手冲意义上的注水量")
            }
        }
    }

    func testSwitchingFromPourOverToLatteNeverCarriesThePourWater() {
        let pourOver = DrinkRecipePlan.default(for: .pourOver)
        XCTAssertEqual(pourOver.waterG, 240)

        let latte = DrinkRecipePlan.forDrink(.latte, keepingDoseFrom: pourOver)
        XCTAssertEqual(latte.waterG, 0, "手冲的注水量不许变成拿铁的配方")
        XCTAssertGreaterThan(latte.milkG, 0)
        XCTAssertEqual(latte.espressoYieldG, 36)
        // 粉量是唯一被明允许跨饮品保留的数字（豆子已经磨了）。
        XCTAssertEqual(latte.coffeeG, pourOver.coffeeG)
    }

    /// 配方的家族要和 `brew_method_rules.json` 的分类说同一套话——
    /// 历史、统计、诊断都靠它归队。
    func testDrinkFamiliesMatchTheMethodRulesAliases() {
        for drink in DrinkType.allCases {
            XCTAssertEqual(MethodRules.family(of: drink.defaultMethod), drink.family,
                           "\(drink.defaultMethod) 应归类为 \(drink.family)")
        }
    }

    // MARK: - 步骤生成

    func testPourOverStepsComputeTargetsFromTheRecipe() {
        var plan = DrinkRecipePlan.default(for: .pourOver)
        let steps = BrewStepBuilder.steps(for: plan)

        let bloom = steps.first { $0.id == "pourOver.bloom" }
        XCTAssertEqual(bloom?.targetG, 45)               // 3 × 15g
        XCTAssertEqual(bloom?.targetSeconds, 30)
        XCTAssertEqual(bloom?.usesTimer, true)

        let secondPour = steps.first { $0.id == "pourOver.secondPour" }
        XCTAssertEqual(secondPour?.targetG, 240)          // 总注水 = 配方水量

        // 改了配方，步骤目标跟着变——目标不许写死。
        plan.waterG = 300
        plan.coffeeG = 18
        let edited = BrewStepBuilder.steps(for: plan)
        XCTAssertEqual(edited.first { $0.id == "pourOver.bloom" }?.targetG, 54)
        XCTAssertEqual(edited.first { $0.id == "pourOver.secondPour" }?.targetG, 300)
    }

    func testEspressoStepsTargetTheYieldWithATimer() {
        let steps = BrewStepBuilder.steps(for: .default(for: .espresso))
        let extract = steps.first { $0.id == "espresso.extract" }
        XCTAssertEqual(extract?.targetG, 36)
        XCTAssertEqual(extract?.usesTimer, true)
        XCTAssertNil(steps.first { $0.id == "espresso.dose" }?.targetTemp)
        // 意式没有注水步骤。
        XCTAssertFalse(steps.contains { $0.title.contains("注水") })
    }

    func testLatteAndCappuccinoShareTheEspressoBaseButDifferOnMilk() {
        let latte = BrewStepBuilder.steps(for: .default(for: .latte))
        let cappuccino = BrewStepBuilder.steps(for: .default(for: .cappuccino))

        XCTAssertEqual(latte.first { $0.id == "latte.extract" }?.targetG, 36)
        XCTAssertEqual(latte.first { $0.id == "latte.milk" }?.targetG, 170)
        XCTAssertEqual(cappuccino.first { $0.id == "cappuccino.milk" }?.targetG, 120)

        // 卡布的奶泡更厚：目标温度更低（更多空气），说明文字里点名奶泡。
        let latteSteam = latte.first { $0.id == "latte.steam" }
        let cappFoam = cappuccino.first { $0.id == "cappuccino.foam" }
        XCTAssertGreaterThan(latteSteam?.targetTemp ?? 0, cappFoam?.targetTemp ?? 0)
        XCTAssertNotEqual(latteSteam?.id, cappFoam?.id)
    }

    func testAmericanoKeepsYieldAndAddedWaterSeparate() {
        let steps = BrewStepBuilder.steps(for: .default(for: .americano))
        XCTAssertEqual(steps.first { $0.id == "americano.extract" }?.targetG, 36)
        XCTAssertEqual(steps.first { $0.id == "americano.water" }?.targetG, 120)
    }

    func testColdBrewSteepsForHoursWithoutATimer() {
        let steps = BrewStepBuilder.steps(for: .default(for: .coldBrew))
        let steep = steps.first { $0.id == "coldBrew.steep" }
        XCTAssertEqual(steep?.targetSeconds, 12 * 3600)
        XCTAssertEqual(steep?.usesTimer, false, "冷萃不能套手冲的短时计时流程")
        // 全程没有需要秒表快进的步骤。
        XCTAssertFalse(steps.contains { $0.usesTimer })
    }

    // MARK: - 计时器

    private func session(_ drink: DrinkType = .pourOver) -> BrewGuideSession {
        BrewGuideSession(steps: BrewStepBuilder.steps(for: .default(for: drink)))
    }

    func testClockAccumulatesAcrossPauseAndResume() {
        var clock = BrewClock()
        let t0 = Date(timeIntervalSince1970: 1_000)

        clock.start(t0)
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(30)), 30, accuracy: 0.001)
        clock.pause(t0.addingTimeInterval(30))
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(100)), 30, accuracy: 0.001,
                       "暂停之后时间不能再走")

        clock.start(t0.addingTimeInterval(200))
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(210)), 40, accuracy: 0.001,
                       "继续要从暂停的地方接着走")
    }

    func testStartingTwiceDoesNotResetTheClock() {
        var clock = BrewClock()
        let t0 = Date(timeIntervalSince1970: 2_000)
        clock.start(t0)
        clock.start(t0.addingTimeInterval(5))
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(10)), 10, accuracy: 0.001,
                       "重复点开始不许把起点拨回去")
    }

    func testPausingTwiceIsHarmless() {
        var clock = BrewClock()
        let t0 = Date(timeIntervalSince1970: 3_000)
        clock.start(t0)
        clock.pause(t0.addingTimeInterval(10))
        clock.pause(t0.addingTimeInterval(20))
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(30)), 10, accuracy: 0.001)
    }

    func testCompleteStepAdvancesAndFinishesOnTheLastStep() {
        let guide = session(.espresso)   // 5 步
        let t0 = Date(timeIntervalSince1970: 4_000)
        guide.toggleTimer(now: t0)

        for _ in 0..<4 { guide.completeStep(now: t0) }
        XCTAssertEqual(guide.stepIndex, 4)
        XCTAssertFalse(guide.isFinished)

        guide.completeStep(now: t0.addingTimeInterval(5))
        XCTAssertTrue(guide.isFinished)
        XCTAssertEqual(guide.stepIndex, 4, "最后一步完成之后不该再前进")
        XCTAssertFalse(guide.isRunning, "完成后表要停")
        // 全程计时没有被换步清掉。
        XCTAssertEqual(guide.totalClock.elapsed(now: t0.addingTimeInterval(5)), 5, accuracy: 0.001)
    }

    func testStepClockResetsOnAdvanceWhileTotalClockKeepsRunning() {
        let guide = session(.pourOver)
        let t0 = Date(timeIntervalSince1970: 5_000)
        guide.toggleTimer(now: t0)

        guide.completeStep(now: t0.addingTimeInterval(12))
        XCTAssertEqual(guide.stepClock.elapsed(now: t0.addingTimeInterval(15)), 3, accuracy: 0.001,
                       "换步后本步的表从零开始")
        XCTAssertEqual(guide.totalClock.elapsed(now: t0.addingTimeInterval(15)), 15, accuracy: 0.001,
                       "全程的表跨步累计")
    }

    func testGoingBackReopensThePreviousStep() {
        let guide = session(.espresso)
        let t0 = Date(timeIntervalSince1970: 6_000)
        guide.completeStep(now: t0)
        guide.completeStep(now: t0)
        XCTAssertEqual(guide.stepIndex, 2)

        guide.goBack(now: t0)
        XCTAssertEqual(guide.stepIndex, 1)
        XCTAssertFalse(guide.isRunning, "回退不打断暂停状态")

        // 从第 1 步走完全程（还差 4 步）进入完成态，再退回最后一步。
        for _ in 0..<4 { guide.completeStep(now: t0) }
        XCTAssertTrue(guide.isFinished)
        guide.goBack(now: t0)
        XCTAssertFalse(guide.isFinished)
        XCTAssertEqual(guide.stepIndex, 4)
    }

    // MARK: - 校验（不误伤）

    func testEspressoIsNotNaggedAboutPourOverWater() {
        var recipe = BrewRecipe(method: "意式浓缩")
        recipe.coffeeG = 18
        recipe.espressoYieldG = 36
        recipe.timeSeconds = 30

        let validation = BrewMath.validate(recipe)
        XCTAssertTrue(validation.canSave)
        XCTAssertFalse(validation.hints.contains("水量还没填，粉水比会留空"),
                       "奶咖/意式没有手冲注水量，不该被提醒")
        XCTAssertFalse(validation.hints.contains("水温还没填"))
        XCTAssertTrue(validation.isEmpty)
    }

    func testLatteWithoutYieldGetsAYieldHintNotAWaterHint() {
        var recipe = BrewRecipe(method: "拿铁")
        recipe.coffeeG = 18
        let validation = BrewMath.validate(recipe)
        XCTAssertTrue(validation.hints.contains("浓缩液重量还没填"))
        XCTAssertFalse(validation.hints.contains("水量还没填，粉水比会留空"))
    }

    func testColdBrewGetsASteepHintInsteadOfBrewTime() {
        var recipe = BrewRecipe(method: "冷萃")
        recipe.coffeeG = 20
        recipe.waterG = 200
        let validation = BrewMath.validate(recipe)
        XCTAssertTrue(validation.hints.contains("浸泡时长还没填"))
        XCTAssertFalse(validation.hints.contains("冲煮时间还没填"))
        XCTAssertFalse(validation.hints.contains("水温还没填"), "冷萃用冷水，不提醒水温")
    }

    func testFilterRecipesKeepTheOriginalHints() {
        var recipe = BrewRecipe(method: "V60")
        recipe.coffeeG = 15
        let validation = BrewMath.validate(recipe)
        XCTAssertTrue(validation.hints.contains("水量还没填，粉水比会留空"))
        XCTAssertTrue(validation.hints.contains("水温还没填"))
        XCTAssertTrue(validation.hints.contains("冲煮时间还没填"))
    }

    /// 奶咖的浓缩液/牛奶绝不能变成粉水比——那是诊断基线的输入，
    /// 一个假 1:2 会把整条比较链带歪。
    func testMilkDrinkRatioStaysEmptyInsteadOfInventingOne() {
        let latte = DrinkRecipePlan.default(for: .latte).asRecipe()
        XCTAssertEqual(latte.ratioValue, 0)
        XCTAssertEqual(latte.ratioText, "—")
    }

    // MARK: - 保存与库存

    func testSavingALatteStoresMilkFieldsAndDeductsOnlyTheDose() throws {
        let recipe = BrewRecipe(
            method: "拿铁", grinder: "", grindSize: "",
            waterTemp: 93, coffeeG: 18, waterG: 0, timeSeconds: 30,
            espressoYieldG: 36, milkG: 160, addedWaterG: 0
        )
        let draft = BrewRecorder.Draft(recipe: recipe, timeText: "0:30")

        let brew = try BrewRecorder.save(draft, bean: bean, in: context)

        XCTAssertEqual(brew.espressoYieldG, 36)
        XCTAssertEqual(brew.milkG, 160)
        XCTAssertEqual(brew.addedWaterG, 0)
        XCTAssertEqual(brew.waterG, 0)
        // 库存只按粉量扣：牛奶和浓缩液不是咖啡豆。
        XCTAssertEqual(bean.remainingG, 182, accuracy: 0.001)
        // 一条记录、一条镜像风味（没有评分时不上时间线）。
        XCTAssertEqual(bean.brewsCount, 1)
        XCTAssertEqual((bean.tastings ?? []).count, 0)

        // 编辑回来：改粉量按差值扣，新字段照常更新。
        var edited = draft
        edited.recipe.coffeeG = 20
        edited.recipe.milkG = 180
        _ = try BrewRecorder.save(edited, bean: bean, existing: brew, in: context)
        XCTAssertEqual(brew.milkG, 180)
        XCTAssertEqual(bean.remainingG, 180, accuracy: 0.001)
        XCTAssertEqual(bean.brewsCount, 1, "编辑不该多出一条记录")
    }

    func testDeletingALatteReturnsOnlyTheDose() throws {
        let recipe = BrewRecipe(
            method: "拿铁", grinder: "", grindSize: "",
            waterTemp: 93, coffeeG: 18, waterG: 0, timeSeconds: 30,
            espressoYieldG: 36, milkG: 160, addedWaterG: 0
        )
        let brew = try BrewRecorder.save(
            BrewRecorder.Draft(recipe: recipe, timeText: "0:30"), bean: bean, in: context
        )
        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 200, accuracy: 0.001, "删除把粉还回来，牛奶本来就不该扣")
    }

    // MARK: - 引导种子

    func testGuidedSeedPrefillsTargetsAndMeasuredTime() {
        var plan = DrinkRecipePlan.default(for: .latte)
        plan.totalSeconds = 30

        let measured = GuidedBrewSeed(plan: plan, measuredSeconds: 75)
        XCTAssertEqual(measured.recipe.espressoYieldG, 36)
        XCTAssertEqual(measured.recipe.milkG, 170)
        XCTAssertEqual(measured.timeText, "1:15", "引导里开过表，就预填实测时长")
        XCTAssertTrue(measured.isMeasured)

        let unmeasured = GuidedBrewSeed(plan: plan, measuredSeconds: 0)
        XCTAssertEqual(unmeasured.timeText, "0:30", "没开表给建议值，不冒充实测")
        XCTAssertFalse(unmeasured.isMeasured)
    }

    // MARK: - 下一杯对比（浓缩液/牛奶/加水）

    private func makeBrew(
        method: String,
        daysAgo: Int,
        coffeeG: Double,
        waterG: Double,
        timeSeconds: Int,
        espressoYieldG: Double = 0,
        milkG: Double = 0,
        addedWaterG: Double = 0,
        score: Int = 0
    ) -> Brew {
        Brew(
            date: DateMath.add(days: -daysAgo, to: Date()),
            method: method, grinder: "", grindSize: "",
            waterTemp: 93, coffeeG: coffeeG, waterG: waterG, timeSeconds: timeSeconds,
            score: score,
            espressoYieldG: espressoYieldG, milkG: milkG, addedWaterG: addedWaterG
        )
    }

    func testFollowUpShowsYieldAndMilkChangesBetweenTwoLattes() {
        let previous = makeBrew(method: "拿铁", daysAgo: 3, coffeeG: 18, waterG: 0,
                                timeSeconds: 30, espressoYieldG: 36, milkG: 170)
        let current = makeBrew(method: "拿铁", daysAgo: 1, coffeeG: 18, waterG: 0,
                               timeSeconds: 28, espressoYieldG: 40, milkG: 150)

        let followUp = SuggestionFollowUp.between(previous: previous, suggestion: nil, current: current)

        XCTAssertTrue(followUp.hasChanges)
        let text = followUp.changesText ?? ""
        XCTAssertTrue(text.contains("浓缩液 36g → 40g"), "实际是：\(text)")
        XCTAssertTrue(text.contains("牛奶 170g → 150g"), "实际是：\(text)")
    }

    func testFollowUpDoesNotInventChangesFromUnfilledMilkFields() {
        // 上一杯手冲（奶字段全空），这一杯拿铁：没填过的字段不许被读成
        // 「0 → 170」——没填是没填，不是变化。
        let previous = makeBrew(method: "V60", daysAgo: 3, coffeeG: 15, waterG: 240, timeSeconds: 150)
        let current = makeBrew(method: "拿铁", daysAgo: 1, coffeeG: 18, waterG: 0,
                               timeSeconds: 30, espressoYieldG: 36, milkG: 170)

        let followUp = SuggestionFollowUp.between(previous: previous, suggestion: nil, current: current)

        let text = followUp.changesText ?? ""
        XCTAssertFalse(text.contains("牛奶"), "实际是：\(text)")
        XCTAssertFalse(text.contains("浓缩液"), "实际是：\(text)")
    }

    func testFollowUpStaysQuietWhenMilkFieldsAreIdentical() {
        let previous = makeBrew(method: "拿铁", daysAgo: 3, coffeeG: 18, waterG: 0,
                                timeSeconds: 30, espressoYieldG: 36, milkG: 160)
        let current = makeBrew(method: "拿铁", daysAgo: 1, coffeeG: 18, waterG: 0,
                               timeSeconds: 30, espressoYieldG: 36, milkG: 160)

        let followUp = SuggestionFollowUp.between(previous: previous, suggestion: nil, current: current)
        XCTAssertFalse(followUp.hasChanges)
        XCTAssertNil(followUp.changesText)
    }

    // MARK: - 计时与中断

    func testClockKeepsTrueTimeAcrossABackgroundGap() {
        // App 退后台再回来，显示的用时必须等于真实流逝——Date 算术不依赖
        // 每秒跳表，后台这几分钟不会被丢掉。
        var clock = BrewClock()
        let t0 = Date(timeIntervalSince1970: 10_000)
        clock.start(t0)
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(300)), 300, accuracy: 0.001)
        // 回到前台顺手暂停：累计停在 300，不会继续飘。
        clock.pause(t0.addingTimeInterval(300))
        XCTAssertEqual(clock.elapsed(now: t0.addingTimeInterval(600)), 300, accuracy: 0.001)
    }

    func testMeasuredSeedNeverPretendsToBeTheTarget() {
        // 拿铁建议萃取 30 秒。用户实际只走了 6 秒的表，就必须预填 6 秒——
        // 目标耗时不能冒充实测耗时。
        let plan = DrinkRecipePlan.default(for: .latte)
        XCTAssertEqual(plan.totalSeconds, 30)
        let seed = GuidedBrewSeed(plan: plan, measuredSeconds: 6)
        XCTAssertEqual(seed.timeText, "0:06")
        XCTAssertFalse(seed.isMeasured == false)
    }


    // MARK: - 导出

    func testLatteExportRoundTripKeepsTheMilkFields() throws {
        let recipe = BrewRecipe(
            method: "拿铁", grinder: "", grindSize: "",
            waterTemp: 93, coffeeG: 18, waterG: 0, timeSeconds: 30,
            espressoYieldG: 36, milkG: 160, addedWaterG: 0
        )
        _ = try BrewRecorder.save(
            BrewRecorder.Draft(recipe: recipe, timeText: "0:30", score: 4), bean: bean, in: context
        )

        let bundle = ExportManager.build(beans: [bean], rules: [])
        let data = try ExportManager.jsonData(bundle)
        let decoded = try ExportManager.decode(data)

        let dto = try XCTUnwrap(decoded.brews.first)
        XCTAssertEqual(dto.espressoYieldG, 36)
        XCTAssertEqual(dto.milkG, 160)

        // CSV 的新列也跟着走。
        let brewTable = try XCTUnwrap(ExportManager.csvTables(decoded).first { $0.name == "brews" })
        XCTAssertTrue(brewTable.header.contains("espressoYieldG"))
        XCTAssertTrue(brewTable.header.contains("milkG"))
        XCTAssertTrue(brewTable.rows[0].contains("160"))
    }

    func testOldBackupWithoutMilkFieldsStillDecodes() throws {
        // 先造一份新版备份，再把三个新字段从 JSON 里抠掉——等价于旧版本写的备份。
        let recipe = BrewRecipe(
            method: "拿铁", grinder: "", grindSize: "",
            waterTemp: 93, coffeeG: 18, waterG: 0, timeSeconds: 30,
            espressoYieldG: 36, milkG: 160, addedWaterG: 0
        )
        _ = try BrewRecorder.save(
            BrewRecorder.Draft(recipe: recipe, timeText: "0:30"), bean: bean, in: context
        )
        var bundle = ExportManager.build(beans: [bean], rules: [])
        var data = try ExportManager.jsonData(bundle)

        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        var working = json
        var brews = try XCTUnwrap(working["brews"] as? [[String: Any]])
        for index in brews.indices {
            brews[index].removeValue(forKey: "espressoYieldG")
            brews[index].removeValue(forKey: "milkG")
            brews[index].removeValue(forKey: "addedWaterG")
        }
        working["brews"] = brews
        data = try JSONSerialization.data(withJSONObject: working)

        let decoded = try ExportManager.decode(data)
        let dto = try XCTUnwrap(decoded.brews.first)
        XCTAssertNil(dto.espressoYieldG, "旧备份缺字段要读得进来")
        XCTAssertNil(dto.milkG)
        XCTAssertNil(dto.addedWaterG)
        XCTAssertEqual(dto.coffeeG, 18)

        bundle = decoded
        XCTAssertEqual(bundle.brews.count, 1)
    }
}
