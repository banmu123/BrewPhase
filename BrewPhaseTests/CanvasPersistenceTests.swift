import SwiftData
import XCTest
@testable import BrewPhase

/// 画布节点的**磁盘持久化**契约。
///
/// 其它画布测试都跑在 `isStoredInMemoryOnly` 上：它们能证明逻辑对，但证明不了
/// 「退出画布、重进、甚至杀掉 App 之后节点还在」。这里用真实的临时数据库文件，
/// 写完就释放整个 `ModelContainer`，再用同一个 URL 重新打开——只有这样才能
/// 发现「只在内存里成立」的持久化问题。
@MainActor
final class CanvasPersistenceTests: XCTestCase {

    private var storeDirectory: URL!

    override func setUpWithError() throws {
        storeDirectory = FileManager.default.temporaryDirectory
            .appending(path: "BrewPhaseCanvasTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let storeDirectory, FileManager.default.fileExists(atPath: storeDirectory.path) {
            try? FileManager.default.removeItem(at: storeDirectory)
        }
        storeDirectory = nil
    }

    private var storeURL: URL {
        storeDirectory.appending(path: "store.sqlite")
    }

    /// 每次调用都开一个**新的**容器：测试里「重开数据库」就是再调一次它。
    private func openContainer() throws -> ModelContainer {
        let schema = BrewPhaseSchema.schema
        return try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, url: storeURL)]
        )
    }

    // MARK: - A. 节点跨数据库重开仍然存在

    /// 在一块画布上放两条记录，保存后**释放整个容器**，再用同一个文件打开：
    /// 节点数量、引用、坐标、尺寸、层级都必须原样回来。
    func testNodesSurviveReopeningTheStore() throws {
        var canvasID = UUID()
        var recordIDs: [UUID] = []
        var nodeIDs: [UUID] = []

        try autoreleasepool {
            let container = try openContainer()
            let context = ModelContext(container)
            let canvas = Canvas(name: "AI 应用开发学习")
            canvasID = canvas.id
            context.insert(canvas)

            let first = Record(carrier: .text, title: "Agent 架构笔记", note: "工具调用与记忆")
            let second = Record(carrier: .link, title: "FastAPI 文档",
                                urlString: "https://fastapi.tiangolo.com")
            context.insert(first)
            context.insert(second)
            recordIDs = [first.id, second.id]
            try context.save()

            let created = try CanvasNodeStore.add([first, second], to: canvas,
                                                 visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                                 context: context)
            XCTAssertEqual(created.count, 2)
            nodeIDs = created.map(\.id)
            // `add` 内部已经 save；这里再确认一次调用方拿到的就是已落库的对象。
            XCTAssertEqual(try context.fetchCount(FetchDescriptor<CanvasNode>()), 2)
        }

        let container = try openContainer()
        let context = ModelContext(container)

        let canvases = try context.fetch(FetchDescriptor<Canvas>())
        XCTAssertEqual(canvases.count, 1)
        XCTAssertEqual(canvases.first?.id, canvasID)

        let nodes = try context.fetch(FetchDescriptor<CanvasNode>())
        XCTAssertEqual(nodes.count, 2, "重新打开数据库后节点必须还在")
        XCTAssertEqual(Set(nodes.map(\.id)), Set(nodeIDs))
        XCTAssertEqual(Set(nodes.map(\.recordID)), Set(recordIDs))
        XCTAssertTrue(nodes.allSatisfy { $0.canvasID == canvasID },
                      "节点的 canvasID 必须指回原来那块画布")
        for node in nodes {
            XCTAssertGreaterThan(node.width, 0)
            XCTAssertGreaterThan(node.height, 0)
        }
    }

    /// 与画布页的 `@Query` 同一条谓词：重开之后按 canvasID 过滤，仍然取得到节点。
    /// 这条把「能读全部节点」和「能读到这块画布的节点」分开验证——后者才是界面用的。
    func testQueryFilteredByCanvasIDStillFindsNodesAfterReopen() throws {
        var canvasID = UUID()
        var otherCanvasID = UUID()

        try autoreleasepool {
            let container = try openContainer()
            let context = ModelContext(container)
            let canvas = Canvas(name: "目标画布")
            canvasID = canvas.id
            let other = Canvas(name: "另一块画布")
            otherCanvasID = other.id
            context.insert(canvas)
            context.insert(other)

            let record = Record(carrier: .text, title: "只进目标画布", note: "正文")
            context.insert(record)
            try context.save()

            try CanvasNodeStore.add([record], to: canvas,
                                    visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                    context: context)
            try CanvasNodeStore.add([record], to: other,
                                    visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                    context: context)
        }

        let container = try openContainer()
        let context = ModelContext(container)
        let id = canvasID
        let descriptor = FetchDescriptor<CanvasNode>(predicate: #Predicate { $0.canvasID == id })
        let nodes = try context.fetch(descriptor)
        XCTAssertEqual(nodes.count, 1, "按 canvasID 过滤只该取到这块画布的节点")
        XCTAssertNotEqual(otherCanvasID, canvasID)

        // 界面的 recordsByID 用的是这条谓词：一批 ID 一次取回。
        let ids = nodes.map(\.recordID)
        let recordDescriptor = FetchDescriptor<Record>(predicate: #Predicate { ids.contains($0.id) })
        let records = try context.fetch(recordDescriptor)
        XCTAssertEqual(records.count, 1, "按节点引用的 ID 批量取记录必须成功")
    }

    // MARK: - B. 位置跨数据库重开仍然存在

    func testNodePositionSurvivesReopeningTheStore() throws {
        var canvasID = UUID()
        var nodeID = UUID()
        let movedTo = CGPoint(x: 613.5, y: -128.25)

        try autoreleasepool {
            let container = try openContainer()
            let context = ModelContext(container)
            let canvas = Canvas(name: "拖动")
            canvasID = canvas.id
            context.insert(canvas)
            let record = Record(carrier: .image, title: "截图", note: "")
            context.insert(record)
            try context.save()

            let node = try XCTUnwrap(
                try CanvasNodeStore.add([record], to: canvas,
                                        visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                        context: context).first)
            nodeID = node.id
            CanvasNodeStore.move(node, to: movedTo, context: context)
        }

        let container = try openContainer()
        let context = ModelContext(container)
        let id = nodeID
        let nodes = try context.fetch(
            FetchDescriptor<CanvasNode>(predicate: #Predicate { $0.id == id })
        )
        let node = try XCTUnwrap(nodes.first)
        XCTAssertEqual(node.canvasID, canvasID)
        XCTAssertEqual(node.positionX, Double(movedTo.x), accuracy: 0.001)
        XCTAssertEqual(node.positionY, Double(movedTo.y), accuracy: 0.001)

        // 画布时间也被移动更新过：列表排序与缩略图刷新都靠它。
        let canvas = try XCTUnwrap(try context.fetch(FetchDescriptor<Canvas>()).first)
        XCTAssertGreaterThan(canvas.updatedAt, canvas.createdAt)
    }

    // MARK: - C / D. 读取失败与真正的孤儿

    /// 读取记录失败时：**一个节点都不能删**。这是「退出画布后节点全没了」最可能的
    /// 成因——把一次失败的查询当成「记录都不存在」。
    func testReconcileKeepsEveryNodeWhenTheRecordFetchFails() throws {
        let container = try openContainer()
        let context = ModelContext(container)
        let canvas = Canvas(name: "读取失败")
        context.insert(canvas)
        let record = Record(carrier: .text, title: "还在", note: "")
        context.insert(record)
        try context.save()
        let node = try XCTUnwrap(
            try CanvasNodeStore.add([record], to: canvas,
                                    visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                    context: context).first)

        let outcome = CanvasNodeReconciler.reconcile(nodes: [node], context: context) { _, _ in
            throw CocoaError(.fileReadCorruptFile)
        }

        XCTAssertTrue(outcome.didFail, "读取失败必须被识别出来")
        XCTAssertTrue(outcome.recordsByID.isEmpty)
        XCTAssertEqual(outcome.purgedNodeIDs, [], "读取失败时不允许清理任何节点")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CanvasNode>()), 1,
                       "节点必须留在数据库里")
    }

    /// 一批 ID 里混着若干条已经不存在的记录：查询本身必须成功，
    /// 只清理确认取不到的那几条——不能因为「有 ID 查不到」就整批失败。
    func testReconcileToleratesABatchWithSeveralMissingRecords() throws {
        let container = try openContainer()
        let context = ModelContext(container)
        let canvas = Canvas(name: "混合批次")
        context.insert(canvas)
        let alive = Record(carrier: .text, title: "还在", note: "")
        context.insert(alive)
        try context.save()

        let kept = try XCTUnwrap(
            try CanvasNodeStore.add([alive], to: canvas,
                                    visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                    context: context).first)
        var orphans: [CanvasNode] = []
        for index in 0..<3 {
            let orphan = CanvasNode(canvasID: canvas.id, recordID: UUID(),
                                    positionX: Double(index) * 300, positionY: 900,
                                    width: 220, height: 170)
            context.insert(orphan)
            orphans.append(orphan)
        }
        try context.save()

        let outcome = CanvasNodeReconciler.reconcile(nodes: [kept] + orphans, context: context)

        XCTAssertFalse(outcome.didFail, "有 ID 查不到不等于查询失败")
        XCTAssertEqual(Set(outcome.purgedNodeIDs), Set(orphans.map(\.id)))
        XCTAssertEqual(outcome.recordsByID.count, 1)
        XCTAssertEqual(try context.fetch(FetchDescriptor<CanvasNode>()).map(\.id), [kept.id])
    }

    /// 真正不存在的记录：只清理确认失效的那一条，其他节点与画布时间正常。
    func testReconcilePurgesOnlyTheConfirmedOrphan() throws {
        let container = try openContainer()
        let context = ModelContext(container)
        let canvas = Canvas(name: "孤儿")
        context.insert(canvas)
        let alive = Record(carrier: .text, title: "在的", note: "")
        context.insert(alive)
        try context.save()

        let nodes = try CanvasNodeStore.add([alive], to: canvas,
                                            visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
                                            context: context)
        let kept = try XCTUnwrap(nodes.first)
        // 手工造一条指向已不存在记录的节点：模拟外部删除留下的残骸。
        let orphan = CanvasNode(canvasID: canvas.id, recordID: UUID(),
                                positionX: 400, positionY: 400, width: 220, height: 170)
        context.insert(orphan)
        try context.save()

        let outcome = CanvasNodeReconciler.reconcile(nodes: [kept, orphan], context: context)

        XCTAssertFalse(outcome.didFail)
        XCTAssertEqual(outcome.purgedNodeIDs, [orphan.id])
        let remaining = try context.fetch(FetchDescriptor<CanvasNode>())
        XCTAssertEqual(remaining.map(\.id), [kept.id], "正常节点不能被牵连")
        XCTAssertEqual(outcome.recordsByID[alive.id]?.id, alive.id)
    }
}
