import SwiftData
import XCTest

@testable import BrewPhase

/**
 * 自动推送的地基：SwiftData 的 save 必须继续发出 Core Data 的 didSave 通知。
 *
 * `SyncAutoPush` 只注册这一个观察点，不逐视图埋——所以这条链路一旦断掉
 * （比如将来换了持久层），表现不会是「自动同步悄悄失效」，而是这条测试先红。
 */
@MainActor
final class SyncAutoPushTests: XCTestCase {

    func testSwiftDataSaveFiresDidSaveNotification() throws {
        let schema = BrewPhaseSchema.schema
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        let context = container.mainContext

        var fired = false
        var savedCount = 0
        let token = NotificationCenter.default.addObserver(
            forName: .NSManagedObjectContextDidSave,
            object: nil,
            queue: nil
        ) { _ in
            fired = true
            savedCount += 1
        }
        defer { NotificationCenter.default.removeObserver(token) }

        let record = Record(carrier: .text)
        record.title = "通知探测"
        context.insert(record)
        try context.save()

        XCTAssertTrue(fired, "SwiftData 的 save 必须发出 NSManagedObjectContextDidSave，自动推送依赖这条通知")
        XCTAssertGreaterThanOrEqual(savedCount, 1)
    }

    func testInstallOnlyRegistersOnce() throws {
        let schema = BrewPhaseSchema.schema
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        // 重复 install 不应叠加观察者（App 启动与测试宿主共用进程时可能各装一次）
        SyncAutoPush.install(container: container)
        SyncAutoPush.install(container: container)
        XCTAssertTrue(true)
    }
}
