import SwiftData
import XCTest
@testable import BrewPhase

/// 「示例数据」测试模式（更多 → 数据 → 示例数据）的合同：
///
/// 打开开关 = 载入 7 包打 `isSample` 标记的演示豆；关闭 = **只删带标记的**，
/// 真实记录（不带标记）永远不动。这条分界线是整个功能的全部意义——
/// 任何一条测试放过了它，这个功能就是在造丢数据的机器。
@MainActor
final class SampleDataTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    override func setUpWithError() throws {
        LanguageManager.pinForTesting(.simplifiedChinese)
        // 用**真正的** `BrewPhaseSchema`，不是只挑 Bean 那几张：示例数据现在还会
        // 写记录、标签与画布节点，容器里没有这些实体的话，「示例画布上有节点」
        // 这条根本验证不了。
        container = try ModelContainer(
            for: BrewPhaseSchema.schema,
            configurations: [ModelConfiguration(isStoredInMemoryOnly: true)]
        )
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    @discardableResult
    private func makeRealBean(name: String = "My Real Bag", withBrew: Bool = false) -> Bean {
        let bean = Bean(
            name: name, roastLevel: .light,
            roastDate: DateMath.add(days: -10, to: Date()),
            weightG: 200, remainingG: 150
        )
        context.insert(bean)
        if withBrew {
            context.insert(Brew(date: Date(), method: "V60", coffeeG: 15, waterG: 240,
                                score: 4, bean: bean))
        }
        return bean
    }

    // MARK: - 安装

    func testInstallMarksEverySampleBeanAndSaves() throws {
        DemoData.install(context: context)

        let beans = try context.fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(beans.count, 7)
        XCTAssertTrue(beans.allSatisfy(\.isSample), "每一包示例豆都要带标记")
        XCTAssertTrue(DemoData.hasInstalled(context: context))
        // 落库才是真的装好（中途失败会 rollback）。
        XCTAssertGreaterThan(try context.fetchCount(FetchDescriptor<Brew>()), 0)
        XCTAssertGreaterThan(try context.fetchCount(FetchDescriptor<Tasting>()), 0)
    }

    func testInstallIsRepeatableWhenTheUserTogglesAgain() throws {
        DemoData.install(context: context)
        DemoData.removeInstalled(context: context)
        DemoData.install(context: context)   // 关了再开：完整一轮，不残留不翻倍

        let beans = try context.fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(beans.count, 7)
        XCTAssertTrue(beans.allSatisfy(\.isSample))
    }

    // MARK: - 示例画布（审核与试用的第三空间）

    /// 两块示例画布上都要真的有节点。
    ///
    /// Canvas 是三个空间里的第三个：空画布只能看到空态引导，把示例数据打开
    /// 也看不出这一版做了什么——这正好是审核员最先会点进去确认的地方。
    func testSampleCanvasesCarryNodesForEveryCarrier() throws {
        DemoData.install(context: context)

        let canvases = try context.fetch(FetchDescriptor<Canvas>())
        XCTAssertEqual(canvases.count, 2)

        var carriers = Set<RecordCarrier>()
        for canvas in canvases {
            let nodes = try CanvasNodeStore.nodes(in: canvas.id, context: context)
            XCTAssertFalse(nodes.isEmpty, "示例画布「\(canvas.name)」上一个节点都没有")
            for node in nodes {
                let record = try XCTUnwrap(
                    (try context.fetch(FetchDescriptor<Record>()))
                        .first { $0.id == node.recordID },
                    "节点指向了一条不存在的记录"
                )
                carriers.insert(record.carrier)
                XCTAssertTrue(record.isSample, "示例画布上不该出现真实记录")
            }
        }
        XCTAssertEqual(carriers, Set(RecordCarrier.allCases), "四种载体至少各有一条，画布才看得出层次")
    }

    /// 记录数必须**超过一页**，否则「滚动到底取下一页」在示例数据上永远走不到。
    ///
    /// 直接跟 `RecordsDataSource.pageSize` 比，不写死 20：以后改页大小，这条会
    /// 跟着一起守住，而不是变成一条永远成立的假断言。
    func testSampleRecordsFillMoreThanOnePage() throws {
        DemoData.install(context: context)
        let records = try context.fetchCount(FetchDescriptor<Record>())
        XCTAssertGreaterThan(records, RecordsDataSource.pageSize)
    }

    /// 关掉开关时，示例画布上的节点要连画布一起清掉。
    func testRemovalTakesSampleCanvasNodesAway() throws {
        DemoData.install(context: context)
        XCTAssertGreaterThan(try context.fetchCount(FetchDescriptor<CanvasNode>()), 0)

        XCTAssertTrue(DemoData.removeInstalled(context: context))

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CanvasNode>()), 0, "示例节点要随示例画布一起走")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Canvas>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Record>()), 0)
    }

    /// 真实画布上摆了示例记录：删示例数据只能摘掉节点，画布本身要留着。
    func testRemovalKeepsARealCanvasThatHoldsSampleRecords() throws {
        let canvas = Canvas(name: "我的真实画布")
        context.insert(canvas)
        try context.save()

        DemoData.install(context: context)
        let sample = try XCTUnwrap(
            try context.fetch(FetchDescriptor<Record>(predicate: #Predicate { $0.isSample })).first
        )
        try CanvasNodeStore.add([sample], to: canvas,
                                visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                context: context)
        XCTAssertEqual(try CanvasNodeStore.nodes(in: canvas.id, context: context).count, 1)

        XCTAssertTrue(DemoData.removeInstalled(context: context))

        XCTAssertEqual(try CanvasNodeStore.nodes(in: canvas.id, context: context).count, 0, "指向示例记录的节点要摘掉")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Canvas>()), 1, "真实画布不能被带走")
    }

    // MARK: - 移除（P0：真实数据不得受伤）

    func testRemoveDeletesOnlySampleBeansAndTheirHistory() throws {
        let real = makeRealBean(name: "真实豆", withBrew: true)
        try context.save()

        DemoData.install(context: context)
        XCTAssertTrue(DemoData.hasInstalled(context: context))

        XCTAssertTrue(DemoData.removeInstalled(context: context))

        let remainingBeans = try context.fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(remainingBeans.map(\.name), ["真实豆"], "只删示例豆")
        XCTAssertFalse(remainingBeans[0].isSample)

        // 真实豆的冲煮记录完好；示例的冲煮与风味随级联清空。
        let brews = try context.fetch(FetchDescriptor<Brew>())
        XCTAssertEqual(brews.count, 1)
        XCTAssertEqual(brews.first?.bean?.id, real.id)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Tasting>()), 0)

        XCTAssertFalse(DemoData.hasInstalled(context: context))
    }

    func testRemoveIsSafeOnAnEmptyOrAlreadyCleanStore() throws {
        XCTAssertFalse(DemoData.removeInstalled(context: context), "空库删除是空操作")

        _ = makeRealBean()
        try context.save()
        XCTAssertFalse(DemoData.removeInstalled(context: context), "没有示例数据时不删任何东西")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Bean>()), 1)
    }

    /// 标记是唯一的删除依据：用户手滑把示例豆改了名，它依然是示例豆；
    /// 反过来，真实豆永远不会因为长得像示例就被带走。
    func testRemovalFollowsTheMarkNotTheName() throws {
        DemoData.install(context: context)
        try context.save()

        // 把一包示例豆改名成任何东西——标记仍在，照样会被移除。
        let guji = try XCTUnwrap(try context.fetch(FetchDescriptor<Bean>()).first { $0.name == "Ethiopia Guji" })
        guji.name = "我自己的豆"
        try context.save()

        // 再放一包真实豆，名字故意取成演示豆的名字。
        let real = makeRealBean(name: "Ethiopia Guji")
        try context.save()

        XCTAssertTrue(DemoData.removeInstalled(context: context))

        let remaining = try context.fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(remaining.map(\.id), [real.id], "按标记删，不按名字删")
    }
}
