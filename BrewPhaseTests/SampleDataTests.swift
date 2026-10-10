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
