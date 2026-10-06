import SwiftData
import XCTest
@testable import BrewPhase

/// 1.0 首发验收（规格 §二～§七、§十三～§十四）：只钉住**发布前必须为真**的事实——
/// 库存不漂移、阶段边界稳定、幂等操作不出副作用、引擎吃到异常输入不产出鬼数字。
///
/// 这里故意不复述其它测试文件已有的覆盖（日期跨月/跨年、时间解析、图片序列、
/// 导出空库），只补清单上还空着的格子。
@MainActor
final class ReleaseAcceptanceTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    private let today = Date(timeIntervalSince1970: 1_780_000_000)

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
        remainingG: Double = 200,
        weightG: Double = 200,
        status: BeanStatus = .active,
        roastedDaysAgo: Int = 16
    ) -> Bean {
        let bean = Bean(
            name: name, roaster: "", origin: "", process: "",
            roastLevel: .light,
            roastDate: DateMath.add(days: -roastedDaysAgo, to: today),
            weightG: weightG, remainingG: remainingG
        )
        bean.status = status
        context.insert(bean)
        return bean
    }

    private func draft(dose: Double) -> BrewRecorder.Draft {
        BrewRecorder.Draft(
            recipe: BrewRecipe(method: "V60", grinder: "", grindSize: "",
                               waterTemp: 92, coffeeG: dose, waterG: 240, timeSeconds: 0),
            timeText: "2:30",
            date: today
        )
    }

    // MARK: - 库存漂移（P0：规格 §五）

    /// 反复编辑同一杯，库存只跟**当前值**走，不做累计扣减。
    /// （走的是 App 的真实编辑路径 `save(existing:)`；`apply(_:to:)` 是失败
    /// 回滚用的低层字段写入器，不管库存——这条注释防止以后再用错。）
    func testConsecutiveEditsNeverDriftTheStock() throws {
        let bean = makeBean()
        try context.save()

        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 185, accuracy: 0.001)

        // 15 → 18 → 12 → 20：每一步都是「按差值调」，不是「再扣一次」。
        try BrewRecorder.save(draft(dose: 18), bean: bean, existing: brew, in: context)
        try context.save()
        XCTAssertEqual(bean.remainingG, 182, accuracy: 0.001)

        try BrewRecorder.save(draft(dose: 12), bean: bean, existing: brew, in: context)
        try context.save()
        XCTAssertEqual(bean.remainingG, 188, accuracy: 0.001)

        try BrewRecorder.save(draft(dose: 20), bean: bean, existing: brew, in: context)
        try context.save()
        XCTAssertEqual(bean.remainingG, 180, accuracy: 0.001)

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 1, "反复保存不产生新记录")
    }

    /// 编辑过的记录再删除：还回去的是**这条记录当前**的粉量，库存不多不少。
    func testDeletingAnEditedBrewRestoresWhatItNowCosts() throws {
        let bean = makeBean()
        try context.save()

        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        try BrewRecorder.save(draft(dose: 18), bean: bean, existing: brew, in: context)
        try context.save()
        XCTAssertEqual(bean.remainingG, 182, accuracy: 0.001)

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 200, accuracy: 0.001, "还回的是编辑后的 18g")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 0)
    }

    /// 标记喝完之后再删除记录：状态与库存两条线互不干扰。
    func testDeletingABrewAfterTheBagWasMarkedFinishedReactivatesWithCorrectStock() throws {
        let bean = makeBean(remainingG: 20)
        try context.save()
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 5, accuracy: 0.001)

        bean.markFinished()
        try context.save()

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 20, accuracy: 0.001)
        XCTAssertEqual(bean.status, .active, "库存回血 > 0 时自动离开已喝完")
    }

    // MARK: - 喝完 / 恢复 的幂等（规格 §六）

    func testMarkFinishedAndRestoreAreIdempotent() throws {
        let bean = makeBean(remainingG: 86)
        try context.save()
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        let tasting = Tasting(date: today, dayAfterRoast: 16, flavorTags: [],
                              score: 4, notes: "好", source: .manual, bean: bean)
        context.insert(tasting)
        try context.save()

        let stockBefore = bean.remainingG
        let brewsBefore = try context.fetchCount(FetchDescriptor<Brew>())
        let tastingsBefore = try context.fetchCount(FetchDescriptor<Tasting>())

        bean.markFinished()
        bean.markFinished()          // 重复执行不产生副作用
        try context.save()
        XCTAssertEqual(bean.status, .finished)
        XCTAssertEqual(bean.remainingG, stockBefore, "喝完不动库存")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), brewsBefore, "喝完不删记录")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Tasting>()), tastingsBefore, "喝完不删风味")

        bean.restoreToActive()
        bean.restoreToActive()       // 重复恢复同样幂等
        try context.save()
        XCTAssertEqual(bean.status, .active)
        XCTAssertEqual(bean.remainingG, stockBefore, "恢复不凭空改库存")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), brewsBefore, "恢复不重新生成记录")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Tasting>()), tastingsBefore)
        _ = brew
    }

    // MARK: - 阶段边界（规格 §三）

    /// 边界日语义：`restEnd-1` 还在养豆、`restEnd` 起进入窗口、`peakStart` 起
    /// 黄金、`peakEnd` 起衰减。数字全部从规则推导，规则改了测试依然成立。
    func testPhaseBoundariesReadExactlyAtTheRuleEdges() {
        let rule = DefaultPhaseRules.data(for: .light)
        let bounds = PhaseEngine.boundaries(for: rule)

        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: bounds.restEnd - 1, rule: rule), .resting)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: bounds.restEnd, rule: rule), .opening)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: bounds.peakStart, rule: rule), .peak)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: bounds.peakEnd - 1, rule: rule), .peak)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: bounds.peakEnd, rule: rule), .declining)
    }

    /// 极端天数必须有稳定结果：很大的 day 是衰减，负数（未来烘焙日被夹到 0
    /// 之前的位置）归入养豆，绝不出现空 phase。
    func testExtremeDaysAreStable() {
        let rule = DefaultPhaseRules.data(for: .light)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: 365, rule: rule), .declining)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: 3_650, rule: rule), .declining)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: -3, rule: rule), .resting)
        XCTAssertEqual(PhaseEngine.phase(dayAfterRoast: 0, rule: rule), .resting)
    }

    /// 跨月与跨年各来一发：烘焙日 9/30 → 10/1 是 Day 1，12/31 → 1/1 是 Day 1
    /// （既有测试覆盖了天数计算，这里钉的是**读数入口**本身）。
    func testReadingAcrossMonthAndYearBoundaries() {
        var calendar = DateMath.calendar
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!

        let sep30 = calendar.date(from: DateComponents(year: 2026, month: 9, day: 30, hour: 15))!
        let oct1 = calendar.date(from: DateComponents(year: 2026, month: 10, day: 1, hour: 8))!
        let dec31 = calendar.date(from: DateComponents(year: 2025, month: 12, day: 31, hour: 23))!
        let jan1 = calendar.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 7))!

        let bag = BeanSnapshot(name: "边界豆", roastLevel: .light, roastDate: sep30,
                               weightG: 200, remainingG: 120)
        XCTAssertEqual(PhaseEngine.reading(for: bag, today: oct1, calendar: calendar).dayAfterRoast, 1)

        let yearBag = BeanSnapshot(name: "跨年豆", roastLevel: .light, roastDate: dec31,
                                   weightG: 200, remainingG: 120)
        XCTAssertEqual(PhaseEngine.reading(for: yearBag, today: jan1, calendar: calendar).dayAfterRoast, 1)
    }

    // MARK: - 推荐引擎的异常输入（规格 §十四）

    /// 全部喝完：不推荐任何东西——首页宁可空，也不把喝完的豆子端上来。
    func testAllFinishedCellarHasNoPick() {
        let finished = makeBean(name: "喝完了", status: .finished)
        let insight = InsightFactory.insight(
            for: finished, book: .make(stored: []), defaults: BrewDefaults.current(), today: today
        )
        XCTAssertNil(PriorityEngine.todaysPick(from: [insight.candidate]))
    }

    /// 单包在喝、没记录没评分：它就是今天的那包，而且理由说得出口。
    func testSingleUntouchedBagIsStillThePickWithAReadableReason() throws {
        let bean = makeBean(name: "唯一的豆")
        try context.save()
        let insight = InsightFactory.insight(
            for: bean, book: .make(stored: []), defaults: BrewDefaults.current(), today: today
        )
        let pick = PriorityEngine.todaysPick(from: [insight.candidate])
        XCTAssertEqual(pick?.bean.id, bean.id)
        XCTAssertFalse(pick?.verdict.headline.isEmpty ?? true, "必须说得出为什么")
    }

    /// 排名对同一组候选是稳定的：跑两遍顺序一致，且数量正确。
    func testRankingIsDeterministicUnderOddData() throws {
        _ = makeBean(name: "A", remainingG: 5)                            // 极低库存
        _ = makeBean(name: "B", remainingG: 0)                            // 零库存但没标喝完
        _ = makeBean(name: "C", remainingG: 200, roastedDaysAgo: 400)     // 很老
        try context.save()

        let defaults = BrewDefaults.current()
        let beans = try context.fetch(FetchDescriptor<Bean>())
        let first = InsightFactory.ranked(beans, book: .make(stored: []), defaults: defaults, today: today)
        let second = InsightFactory.ranked(beans, book: .make(stored: []), defaults: defaults, today: today)
        XCTAssertEqual(first.map(\.bean.id), second.map(\.bean.id), "同一组数据排名必须一致")
        XCTAssertEqual(first.count, 3)
    }

    // MARK: - 小样本估算（规格 §十三）

    /// 只有一杯：粉量取这一杯、节奏按保守的一天一杯——不假装精确，但也不空转。
    func testSingleSampleGivesAConservativeHonestEstimate() {
        let e = ConsumptionEstimator.estimate(
            remainingG: 90,
            samples: [BrewSample(date: DateMath.add(days: -3, to: today), coffeeG: 18)],
            today: today
        )
        XCTAssertFalse(e.usedDefaults)
        XCTAssertEqual(e.sampleCount, 1)
        XCTAssertEqual(e.averageDoseG, 18, accuracy: 0.001)
        XCTAssertEqual(e.brewsPerDay, 1, accuracy: 0.001, "样本不足两天跨度时按一天一杯")
        XCTAssertEqual(e.brewsRemaining, 5)      // 90 / 18
        XCTAssertEqual(e.daysRemaining, 5)
    }

    // MARK: - 时间解析补格（规格 §四）

    func testTimeParsingEdgeInputs() {
        XCTAssertEqual(BrewMath.parseTime("2:03"), 123)
        XCTAssertEqual(BrewMath.parseTime("138"), 138)
        XCTAssertEqual(BrewMath.parseTime("2.3"), 150)       // 分.秒 速记
        XCTAssertEqual(BrewMath.parseTime(" 2:05 "), 125)    // 带空白
        XCTAssertEqual(BrewMath.parseTime("２：３５"), 155)   // 全角冒号
        XCTAssertNil(BrewMath.parseTime(":30"))
        XCTAssertNil(BrewMath.parseTime("1:60"))
        XCTAssertNil(BrewMath.parseTime("-5"))
        XCTAssertNil(BrewMath.parseTime("abc"))
    }

    // MARK: - 数据量冒烟（规格 §二十二）

    /// 50 包豆 × 6 杯 × 3 条风味的量级：排名、逐包读数全部算得出、跑得完、
    /// 顺序稳定。不为性能做重构，只证明「几年之后还能用」。
    func testCellarOfFiftyBeansWithHundredsOfBrewsRanksStably() throws {
        for i in 0..<50 {
            let bean = makeBean(name: "豆 \(i)", remainingG: Double(30 + i),
                                roastedDaysAgo: 5 + (i * 3) % 200)
            for j in 0..<6 {
                context.insert(Brew(
                    date: DateMath.add(days: -j, to: today), method: "V60",
                    waterTemp: 92, coffeeG: 15, waterG: 240,
                    timeSeconds: 150, score: 3 + j % 3, bean: bean
                ))
            }
            for j in 0..<3 {
                context.insert(Tasting(
                    date: DateMath.add(days: -j, to: today), dayAfterRoast: 10 + j,
                    flavorTags: [], score: 4, notes: "", source: j == 0 ? .manual : .brew,
                    bean: bean
                ))
            }
        }
        try context.save()

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Bean>()), 50)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 300)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Tasting>()), 150)

        let start = Date()
        let defaults = BrewDefaults.current()
        let beans = try context.fetch(FetchDescriptor<Bean>())
        let ranked = InsightFactory.ranked(beans, book: .make(stored: []), defaults: defaults, today: today)
        XCTAssertEqual(ranked.count, 50)
        for insight in ranked {
            XCTAssertNotNil(insight.reading.phase, "每包都有阶段，无空档")
        }
        let again = InsightFactory.ranked(beans, book: .make(stored: []), defaults: defaults, today: today)
        XCTAssertEqual(ranked.map(\.bean.id), again.map(\.bean.id), "重复排名稳定")
        XCTAssertLessThan(Date().timeIntervalSince(start), 10, "量级冒烟要在秒级完成")
    }
}
