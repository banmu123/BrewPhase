import SwiftData
import XCTest
@testable import BrewPhase

/// 数据一致性与可靠性（Phase 1）。
///
/// 每条测试对应一条**会发生**的错账路径，不是对实现细节的复述：
/// * 袋里不够时记一杯，删掉之后库存会不会凭空变多；
/// * 手动盘点之后，删一条旧记录会不会把用户称出来的数字改掉；
/// * 同一笔记在时间线和详情页上写的是不是同一天；
/// * 整批删示例数据、关掉提醒开关之后，系统里还有没有会响的旧通知；
/// * 备份走一圈回来，库存账本还在不在。
@MainActor
final class DataConsistencyTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    /// 固定时间戳：只用于日期算术，不用于提醒排程（那边要用真实的 now）。
    private let today = Date(timeIntervalSince1970: 1_780_000_000)

    override func setUpWithError() throws {
        LanguageManager.pinForTesting(.simplifiedChinese)
        container = try ModelContainer(
            for: BrewPhaseSchema.schema,
            configurations: [ModelConfiguration(schema: BrewPhaseSchema.schema, isStoredInMemoryOnly: true)]
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
        weightG: Double = 200,
        remainingG: Double? = nil,
        roastDaysAgo: Int? = 16
    ) -> Bean {
        let bean = Bean(
            name: name, roaster: "启程咖啡", origin: "", process: "",
            roastLevel: .light,
            roastDate: roastDaysAgo.map { DateMath.add(days: -$0, to: today) },
            weightG: weightG, remainingG: remainingG ?? weightG
        )
        context.insert(bean)
        return bean
    }

    private func draft(
        dose: Double,
        date: Date? = nil,
        score: Int = 0,
        notes: String = ""
    ) -> BrewRecorder.Draft {
        BrewRecorder.Draft(
            recipe: BrewRecipe(method: "V60", grinder: "C40", grindSize: "22 格",
                               waterTemp: 92, coffeeG: dose, waterG: 240, timeSeconds: 0),
            timeText: "2:30",
            date: date ?? today,
            score: score,
            notes: notes
        )
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "bp-consistency-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    // MARK: - 库存：实扣量

    /// 袋里只有 5g 时记一杯 18g：只扣得掉 5g，删掉也只退 5g。
    ///
    /// 旧实现按粉量退 18g，一次「记错 → 删掉」就让这包豆凭空多出 13g。
    func testAShortBagDeductsOnlyWhatItHadAndDeleteReturnsExactlyThat() throws {
        let bean = makeBean(weightG: 200, remainingG: 5)

        let brew = try BrewRecorder.save(draft(dose: 18), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(brew.stockDeductedG), 5, accuracy: 0.001, "记下来的是实扣量，不是粉量")

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 5, accuracy: 0.001, "原路返回：进出必须相等")
    }

    /// 同一杯在「袋里不够」的状态下反复改粉量，库存不能自己长出来。
    func testEditingTheDoseOnAShortBagNeverInventsStock() throws {
        let bean = makeBean(weightG: 200, remainingG: 5)
        let brew = try BrewRecorder.save(draft(dose: 18), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.001)

        // 18 → 12：仍然不够，实际扣的仍是 5g。
        _ = try BrewRecorder.save(draft(dose: 12), bean: bean, existing: brew, in: context)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(brew.stockDeductedG), 5, accuracy: 0.001)

        // 12 → 3：这次够得着，退 2g。
        _ = try BrewRecorder.save(draft(dose: 3), bean: bean, existing: brew, in: context)
        XCTAssertEqual(bean.remainingG, 2, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(brew.stockDeductedG), 3, accuracy: 0.001)

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 5, accuracy: 0.001)
    }

    /// 创建 → 编辑 → 删除走一圈，库存回到起点。这是账本最基本的自洽。
    func testCreateEditDeleteRoundTripReturnsToTheStartingStock() throws {
        let bean = makeBean(weightG: 200, remainingG: 12)

        let brew = try BrewRecorder.save(draft(dose: 18), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.001)
        _ = try BrewRecorder.save(draft(dose: 25), bean: bean, existing: brew, in: context)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.001)
        _ = try BrewRecorder.save(draft(dose: 9), bean: bean, existing: brew, in: context)
        XCTAssertEqual(bean.remainingG, 3, accuracy: 0.001)

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 12, accuracy: 0.001, "一圈之后必须回到 12g")
    }

    /// 旧记录（没有实扣量）按粉量退——与升级前一致，不会更差。
    func testALegacyBrewWithoutARecordedDeductionFallsBackToItsDose() throws {
        let bean = makeBean(weightG: 200, remainingG: 200)
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 185, accuracy: 0.001)

        // 模拟升级前的行：这个字段当时还不存在。
        brew.stockDeductedG = nil
        try context.save()

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 200, accuracy: 0.001)
    }

    /// 旧记录同样能编辑：差额要按**改之前的粉量**算。
    ///
    /// 这里曾经踩过顺序坑：先 `apply`（把 `coffeeG` 改成新值）再读兜底值，
    /// 差额永远是 0，改粉量不动库存。
    func testEditingALegacyBrewAdjustsStockByItsOriginalDose() throws {
        let bean = makeBean(weightG: 200, remainingG: 200)
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 185, accuracy: 0.001)

        brew.stockDeductedG = nil
        try context.save()

        _ = try BrewRecorder.save(draft(dose: 18), bean: bean, existing: brew, in: context)
        XCTAssertEqual(bean.remainingG, 182, accuracy: 0.001, "15 → 18 只该再扣 3g")
        XCTAssertEqual(try XCTUnwrap(brew.stockDeductedG), 18, accuracy: 0.001)
    }

    // MARK: - 库存：人工盘点

    /// 手动盘点之后，删掉一条**盘点之前**的冲煮不该改库存。
    ///
    /// 盘点是一次重新计数：那个数字已经把这条冲煮算进去了。再退一次粉，
    /// 得到的是用户从没称过的重量。
    func testDeletingABrewRecordedBeforeAManualCountLeavesStockAlone() throws {
        let bean = makeBean(weightG: 200, remainingG: 200)
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 185, accuracy: 0.001)

        // 用户把袋子放上秤：现在只剩 100g。
        bean.setRemaining(100)
        try context.save()
        XCTAssertTrue(brew.isSettledForStock(in: bean))

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 100, accuracy: 0.001, "盘点值就是事实，删旧记录不能改它")
        XCTAssertEqual(bean.status, .active)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 0, "记录本身照常删除")
    }

    /// 盘点**之后**记的冲煮照常扣减、照常退还。
    func testABrewRecordedAfterAManualCountStillDeductsAndReturns() throws {
        let bean = makeBean(weightG: 200, remainingG: 200)
        bean.setRemaining(100)
        try context.save()

        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 85, accuracy: 0.001)
        XCTAssertFalse(brew.isSettledForStock(in: bean))

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 100, accuracy: 0.001)
    }

    /// 盘点之后编辑一条旧记录：字段照改，库存不动。
    func testEditingASettledBrewChangesTheRecordButNotTheStock() throws {
        let bean = makeBean(weightG: 200, remainingG: 200)
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        bean.setRemaining(100)
        try context.save()

        _ = try BrewRecorder.save(draft(dose: 20), bean: bean, existing: brew, in: context)
        XCTAssertEqual(brew.coffeeG, 20, accuracy: 0.001)
        XCTAssertEqual(bean.remainingG, 100, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(brew.stockDeductedG), 0, accuracy: 0.001, "已结算的记录不再持有可退还的量")

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 100, accuracy: 0.001)
    }

    /// 已经标记喝完的袋子，删一条已结算的记录不该被「回血」叫醒。
    func testDeletingASettledBrewDoesNotReactivateAFinishedBag() throws {
        let bean = makeBean(weightG: 200, remainingG: 20)
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        XCTAssertEqual(bean.remainingG, 5, accuracy: 0.001)

        bean.setRemaining(0)
        bean.markFinished()
        try context.save()

        try BrewRecorder.delete(brew, in: context)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.001)
        XCTAssertEqual(bean.status, .finished)
    }

    // MARK: - 烘焙天数

    /// 天数由（烘焙日期，记录日期）现算：改了烘焙日期，时间线跟着改。
    func testTastingDayFollowsTheBeanAfterTheRoastDateIsCorrected() throws {
        let bean = makeBean()
        let tasting = Tasting(date: DateMath.add(days: -2, to: today),
                              dayAfterRoast: 0,        // 创建时算错/没算
                              score: 4, bean: bean)
        context.insert(tasting)
        try context.save()

        XCTAssertEqual(tasting.resolvedDayAfterRoast, 14, "16 天前烘焙、2 天前记录")

        bean.roastDate = DateMath.add(days: -5, to: today)
        try context.save()
        XCTAssertEqual(tasting.resolvedDayAfterRoast, 3, "烘焙日期改了，同一笔记录的天数要跟着改")
    }

    /// 没有烘焙日期就没有天数——不是 Day 0。
    func testTastingWithoutARoastDateHasNoDayAtAll() throws {
        let bean = makeBean(roastDaysAgo: nil)
        let tasting = Tasting(date: today, dayAfterRoast: 0, score: 3, bean: bean)
        context.insert(tasting)
        try context.save()

        XCTAssertNil(tasting.resolvedDayAfterRoast)
        XCTAssertEqual(tasting.dayText, "—")
    }

    /// 冲煮与它镜像出来的风味记录，天数必须一样。
    func testBrewAndItsMirrorTastingAgreeOnTheDay() throws {
        let bean = makeBean()
        let brew = try BrewRecorder.save(
            draft(dose: 15, date: DateMath.add(days: -4, to: today), score: 5),
            bean: bean, in: context
        )
        let mirror = try XCTUnwrap((bean.tastings ?? []).first { $0.brewID == brew.id })

        XCTAssertEqual(brew.dayAfterRoast, 12)
        XCTAssertEqual(mirror.resolvedDayAfterRoast, brew.dayAfterRoast)
    }

    // MARK: - 通知生命周期

    /// 整批删除示例数据之后，系统队列里不能再留着它们的提醒。
    func testRemovingSampleDataClearsEveryPendingReminderForIt() async throws {
        let scheduler = FakeScheduler()
        let manager = NotificationManager(scheduler: scheduler)
        let book = PhaseRuleBook.make(stored: [])
        // `sync` 读的是缓存的授权状态；不先刷新一次，它会按「未授权」一条都不排。
        await manager.refreshStatus()

        DemoData.install(context: context)
        let samples = DemoData.sampleBeans(context: context)
        XCTAssertFalse(samples.isEmpty)

        for bean in samples {
            let estimate = InsightFactory.insight(for: bean, book: book).estimate
            await manager.sync(bean: bean, rule: book.rule(for: bean.roastLevel),
                               estimate: estimate, context: context, preferences: .allEnabled)
        }
        let scheduled = await scheduler.pendingCount()
        XCTAssertGreaterThan(scheduled, 0, "示例豆应当排上了提醒，否则这条测试没在验证清理")

        // `MoreView.performSampleAction(.remove)` 的顺序：先记标识符，再删库，再清系统。
        let identifiers = DemoData.sampleBeans(context: context)
            .flatMap { NotificationPlanner.allIdentifiers(beanID: $0.id) }
        XCTAssertTrue(DemoData.removeInstalled(context: context))
        manager.unschedule(identifiers: identifiers)

        for identifier in identifiers {
            XCTAssertFalse(scheduler.pending.contains(identifier), "\(identifier) 还留在系统队列里")
        }
    }

    /// 删示例数据只清示例豆的通知，真实豆的提醒要原样留着。
    func testRemovingSampleDataLeavesRealBeanRemindersAlone() async throws {
        let scheduler = FakeScheduler()
        let manager = NotificationManager(scheduler: scheduler)
        let book = PhaseRuleBook.make(stored: [])
        await manager.refreshStatus()

        let real = Bean(name: "我自己的豆", roastLevel: .light,
                        roastDate: DateMath.add(days: -2, to: Date()),
                        weightG: 200, remainingG: 200)
        context.insert(real)
        DemoData.install(context: context)
        try context.save()

        for bean in [real] + DemoData.sampleBeans(context: context) {
            let estimate = InsightFactory.insight(for: bean, book: book).estimate
            await manager.sync(bean: bean, rule: book.rule(for: bean.roastLevel),
                               estimate: estimate, context: context, preferences: .allEnabled)
        }

        let realIDs = NotificationPlanner.allIdentifiers(beanID: real.id)
        let sampleIDs = DemoData.sampleBeans(context: context)
            .flatMap { NotificationPlanner.allIdentifiers(beanID: $0.id) }
        // 只针对**真的排上了**的那几条做前后对比：一条都没排上的种类谈不上「被带走」。
        let realScheduled = realIDs.filter { scheduler.pending.contains($0) }
        let sampleScheduled = sampleIDs.filter { scheduler.pending.contains($0) }
        XCTAssertFalse(realScheduled.isEmpty)
        XCTAssertFalse(sampleScheduled.isEmpty)

        XCTAssertTrue(DemoData.removeInstalled(context: context))
        manager.unschedule(identifiers: sampleIDs)

        XCTAssertTrue(realScheduled.allSatisfy { scheduler.pending.contains($0) }, "真实豆的提醒不能被带走")
        XCTAssertTrue(sampleScheduled.allSatisfy { !scheduler.pending.contains($0) })
    }

    /// 关掉一类提醒后，已经排在系统里的那几条必须撤掉。
    func testTurningAReminderKindOffClearsItsPendingRequests() async throws {
        let scheduler = FakeScheduler()
        let manager = NotificationManager(scheduler: scheduler)
        let book = PhaseRuleBook.make(stored: [])
        await manager.refreshStatus()

        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -2, to: Date()),
                        weightG: 200, remainingG: 200)
        context.insert(bean)
        try context.save()

        let estimate = InsightFactory.insight(for: bean, book: book).estimate
        await manager.sync(bean: bean, rule: book.rule(for: bean.roastLevel),
                           estimate: estimate, context: context, preferences: .allEnabled)

        let opens = NotificationPlanner.identifier(beanID: bean.id, kind: .windowOpens)
        XCTAssertTrue(scheduler.pending.contains(opens), "先确认这条提醒真的排上了")

        var preferences = ReminderPreferences.allEnabled
        preferences.set(.windowOpens, enabled: false)
        await manager.refreshAll(beans: [bean], book: book, context: context, preferences: preferences)

        XCTAssertFalse(scheduler.pending.contains(opens), "关掉之后系统里不能还留着它")
    }

    // MARK: - 备份与恢复

    /// 备份 → 恢复之后，库存账本（实扣量）与盘点时刻都要还在。
    func testBackupRoundTripKeepsTheStockLedgerAndTheCount() throws {
        let bean = makeBean(weightG: 200, remainingG: 200)
        let brew = try BrewRecorder.save(draft(dose: 15), bean: bean, in: context)
        bean.setRemaining(100)
        try context.save()

        let images = try makeTemporaryDirectory()
        let suiteName = "brewphase.tests.consistency"
        let suite = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        suite.removePersistentDomain(forName: suiteName)
        defer { suite.removePersistentDomain(forName: suiteName) }

        let data = BackupManager.snapshot(
            beans: try context.fetch(FetchDescriptor<Bean>()),
            rules: try context.fetch(FetchDescriptor<PhaseRule>()),
            records: [], canvases: [], tags: []
        )
        XCTAssertEqual(try XCTUnwrap(data.brews.first?.stockDeductedG), 15, accuracy: 0.001)
        XCTAssertNotNil(data.beans.first?.stockCountedAt)

        let url = try BackupManager.write(data,
                                          preferences: BackupManager.preferences(from: suite),
                                          appVersion: "1.1",
                                          imagesDirectory: images,
                                          now: today)
        let file = try BackupManager.read(from: url)

        let restoredContainer = try ModelContainer(
            for: BrewPhaseSchema.schema,
            configurations: [ModelConfiguration(schema: BrewPhaseSchema.schema, isStoredInMemoryOnly: true)]
        )
        _ = try BackupRestorer.restore(file, into: restoredContainer,
                                       imagesDirectory: images, defaults: suite)

        let restoreContext = ModelContext(restoredContainer)
        let restoredBean = try XCTUnwrap(try restoreContext.fetch(FetchDescriptor<Bean>()).first)
        let restoredBrew = try XCTUnwrap(try restoreContext.fetch(FetchDescriptor<Brew>()).first)

        XCTAssertEqual(restoredBean.remainingG, 100, accuracy: 0.001)
        XCTAssertNotNil(restoredBean.stockCountedAt, "盘点时刻丢了，恢复后删旧记录就会改库存")
        XCTAssertEqual(try XCTUnwrap(restoredBrew.stockDeductedG), 15, accuracy: 0.001)

        // 恢复出来的账本要能照常算账：这条记录已被盘点结算，删它不动库存。
        try BrewRecorder.delete(restoredBrew, in: restoreContext)
        XCTAssertEqual(restoredBean.remainingG, 100, accuracy: 0.001)
    }

    // MARK: - 数据库打不开时的出口

    func testStoreArchiveCopiesTheStoreAndItsSidecars() throws {
        let source = try makeTemporaryDirectory()
        try Data("main".utf8).write(to: source.appending(path: "default.store"))
        try Data("wal".utf8).write(to: source.appending(path: "default.store-wal"))
        try Data("shm".utf8).write(to: source.appending(path: "default.store-shm"))

        let destination = try makeTemporaryDirectory()
        let folder = try StoreRecovery.archive(in: source, to: destination, now: today)

        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
        XCTAssertEqual(names, ["default.store", "default.store-shm", "default.store-wal"])
        XCTAssertEqual(try Data(contentsOf: folder.appending(path: "default.store")),
                       Data("main".utf8))
        // 导出是复制，不是搬家：原件必须还在。
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.appending(path: "default.store").path))
    }

    func testStoreArchiveWithoutAStoreThrows() throws {
        let source = try makeTemporaryDirectory()
        let destination = try makeTemporaryDirectory()

        XCTAssertThrowsError(try StoreRecovery.archive(in: source, to: destination, now: today)) { error in
            XCTAssertEqual(error as? StoreRecovery.Failure, .noStore)
        }
    }

    /// 同一秒内导出两次不能覆盖前一份：目标目录已存在就失败，原件与旧副本都不动。
    func testStoreArchiveRefusesToOverwriteAnExistingExport() throws {
        let source = try makeTemporaryDirectory()
        try Data("main".utf8).write(to: source.appending(path: "default.store"))
        let destination = try makeTemporaryDirectory()

        let first = try StoreRecovery.archive(in: source, to: destination, now: today)
        XCTAssertThrowsError(try StoreRecovery.archive(in: source, to: destination, now: today)) { error in
            XCTAssertEqual(error as? StoreRecovery.Failure, .copyFailed)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.appending(path: "default.store").path))
    }

    // MARK: - Schema

    /// App 与测试共用同一份实体清单；容器认得的实体数量必须与清单一致。
    ///
    /// 这里钉住数量是刻意的：新增实体必须是一次**有意识**的改动，而不是某个
    /// 模型文件被顺手挪进清单。记录与画布加进来时，这个数字从 6 变成 8。
    func testTheSharedSchemaHoldsEveryPersistedEntity() throws {
        XCTAssertEqual(BrewPhaseSchema.schema.entities.count, BrewPhaseSchema.modelTypes.count)
        XCTAssertEqual(BrewPhaseSchema.modelTypes.count, 9)
    }

    /// 落盘再打开：新增的两个可选字段要原样回来。
    ///
    /// 这是「旧库 + 新列」在本机唯一能做的真实检验——SwiftData 的轻量迁移会把
    /// 新列补成 NULL，测试里把字段置 nil 存进去，等价于旧行的形状。
    func testTheStockLedgerSurvivesACloseAndReopen() throws {
        let directory = try makeTemporaryDirectory()
        let url = directory.appending(path: "consistency.store")

        do {
            let container = try ModelContainer(
                for: BrewPhaseSchema.schema,
                configurations: [ModelConfiguration(schema: BrewPhaseSchema.schema, url: url)]
            )
            let context = ModelContext(container)
            let bean = Bean(name: "Guji", roastLevel: .light,
                            roastDate: DateMath.add(days: -16, to: today),
                            weightG: 200, remainingG: 0)
            bean.stockCountedAt = today
            context.insert(bean)
            let brew = Brew(date: today, method: "V60", coffeeG: 18, bean: bean)
            brew.stockDeductedG = 5
            context.insert(brew)
            let legacy = Brew(date: today, method: "V60", coffeeG: 15, bean: bean)
            legacy.stockDeductedG = nil
            context.insert(legacy)
            try context.save()
        }

        let reopened = try ModelContainer(
            for: BrewPhaseSchema.schema,
            configurations: [ModelConfiguration(schema: BrewPhaseSchema.schema, url: url)]
        )
        let context = ModelContext(reopened)
        let bean = try XCTUnwrap(try context.fetch(FetchDescriptor<Bean>()).first)
        let brews = try context.fetch(FetchDescriptor<Brew>()).sorted { $0.coffeeG < $1.coffeeG }

        XCTAssertNotNil(bean.stockCountedAt)
        XCTAssertEqual(brews.count, 2)
        XCTAssertNil(brews.first?.stockDeductedG, "旧行读回来仍然是 nil（迁移补的是 NULL）")
        XCTAssertEqual(try XCTUnwrap(brews.last?.stockDeductedG), 5, accuracy: 0.001)
        XCTAssertEqual(brews.last?.appliedStockDeductedG, 5)
        XCTAssertEqual(brews.first?.appliedStockDeductedG, 15, "nil 走粉量兜底")
    }
}
