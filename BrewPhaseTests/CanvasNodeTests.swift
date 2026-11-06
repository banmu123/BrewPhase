import SwiftData
import XCTest
@testable import BrewPhase

/// `CanvasNode` 与 `CanvasNodeStore` 的契约：引用关系、去重、级联清理。
///
/// 节点不复制记录内容，只存 `canvasID` / `recordID`——所以「删记录要清节点」
/// 与「删画布要清节点」不是数据库自动完成的，必须由存储层保证。这几条测试
/// 就是在钉这件事。
@MainActor
final class CanvasNodeTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private var canvas: Canvas!

    override func setUpWithError() throws {
        container = try ModelContainer(for: BrewPhaseSchema.schema,
                                       configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        context = ModelContext(container)
        canvas = Canvas(name: "AI 应用开发学习")
        context.insert(canvas)
        try context.save()
    }

    override func tearDown() {
        context = nil
        container = nil
        canvas = nil
    }

    private func makeRecord(_ title: String, carrier: RecordCarrier = .text) -> Record {
        let record = Record(carrier: carrier, title: title, note: title)
        context.insert(record)
        return record
    }

    private var visible: CGRect {
        CGRect(x: 0, y: 0, width: 390, height: 700)
    }

    // MARK: - 添加

    func testAddPlacesNodesInsideTheVisibleAreaWithoutOverlapping() throws {
        let first = makeRecord("第一条")
        let second = makeRecord("第二条", carrier: .link)
        try context.save()

        let nodes = try CanvasNodeStore.add([first, second], to: canvas,
                                            visibleWorldRect: visible, context: context)
        XCTAssertEqual(nodes.count, 2)
        for node in nodes {
            XCTAssertTrue(visible.contains(node.frame), "新节点必须落在当前可见区里")
        }
        XCTAssertFalse(nodes[0].frame.intersects(nodes[1].frame), "两条新节点不能互相盖住")
        XCTAssertEqual(CanvasNodeStore.nodes(in: canvas.id, context: context).count, 2)
    }

    /// 同一画布不允许重复添加同一条记录；重复调用是安全空操作。
    func testDuplicateRecordIsNotAddedTwiceToTheSameCanvas() throws {
        let record = makeRecord("只该出现一次")
        try context.save()

        _ = try CanvasNodeStore.add([record], to: canvas, visibleWorldRect: visible, context: context)
        let again = try CanvasNodeStore.add([record, record], to: canvas,
                                            visibleWorldRect: visible, context: context)

        XCTAssertTrue(again.isEmpty, "重复添加必须被应用层挡住")
        XCTAssertEqual(CanvasNodeStore.nodes(in: canvas.id, context: context).count, 1)
    }

    /// 同一条记录可以被多块画布引用——画布是摆放，不是归属。
    func testTheSameRecordCanLiveOnTwoCanvases() throws {
        let record = makeRecord("跨画布")
        let other = Canvas(name: "另一块画布")
        context.insert(other)
        try context.save()

        _ = try CanvasNodeStore.add([record], to: canvas, visibleWorldRect: visible, context: context)
        _ = try CanvasNodeStore.add([record], to: other, visibleWorldRect: visible, context: context)

        XCTAssertEqual(CanvasNodeStore.nodes(in: canvas.id, context: context).count, 1)
        XCTAssertEqual(CanvasNodeStore.nodes(in: other.id, context: context).count, 1)
    }

    // MARK: - 移动

    func testMovePersistsTheWorldPosition() throws {
        let record = makeRecord("拖动")
        try context.save()
        let node = try XCTUnwrap(
            try CanvasNodeStore.add([record], to: canvas,
                                    visibleWorldRect: visible, context: context).first)

        CanvasNodeStore.move(node, to: CGPoint(x: 321.5, y: -45.25), context: context)

        let fetched = try context.fetch(FetchDescriptor<CanvasNode>())
        let stored = try XCTUnwrap(fetched.first)
        XCTAssertEqual(stored.positionX, 321.5, accuracy: 0.001, "世界坐标原样落库")
        XCTAssertEqual(stored.positionY, -45.25, accuracy: 0.001)
    }

    // MARK: - 移除与级联

    /// 从画布移除节点：记录必须还在。
    func testRemovingANodeKeepsTheSourceRecord() throws {
        let record = makeRecord("记录还在")
        try context.save()
        let node = try XCTUnwrap(
            try CanvasNodeStore.add([record], to: canvas,
                                    visibleWorldRect: visible, context: context).first)

        CanvasNodeStore.remove(node, context: context)

        XCTAssertTrue(CanvasNodeStore.nodes(in: canvas.id, context: context).isEmpty)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Record>()), 1,
                       "移除节点不能删记录")
    }

    /// 删除源记录：引用它的节点一起清掉，别的画布上的其他节点不受影响。
    func testDeletingARecordRemovesOnlyItsNodes() throws {
        let victim = makeRecord("要删的")
        let survivor = makeRecord("要留的")
        try context.save()
        _ = try CanvasNodeStore.add([victim, survivor], to: canvas,
                                    visibleWorldRect: visible, context: context)

        CanvasNodeStore.deleteNodes(referencing: victim.id, context: context)
        context.delete(victim)
        try context.save()

        let remaining = CanvasNodeStore.nodes(in: canvas.id, context: context)
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining.first?.recordID, survivor.id)
    }

    /// 删除画布：节点一起清掉，记录原样保留。
    func testDeletingACanvasRemovesItsNodesAndKeepsRecords() throws {
        let record = makeRecord("记录")
        try context.save()
        _ = try CanvasNodeStore.add([record], to: canvas,
                                    visibleWorldRect: visible, context: context)

        CanvasNodeStore.deleteNodes(in: canvas.id, context: context)
        context.delete(canvas)
        try context.save()

        XCTAssertTrue(try context.fetch(FetchDescriptor<CanvasNode>()).isEmpty)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Record>()), 1)
    }

    /// 示例数据清理：只清示例画布/示例记录相关的节点，真实节点不动。
    func testDeletingSampleNodesLeavesRealNodesAlone() throws {
        let sampleRecord = makeRecord("示例")
        sampleRecord.isSample = true
        let realRecord = makeRecord("真实")
        let sampleCanvas = Canvas(name: "示例画布", isSample: true)
        context.insert(sampleCanvas)
        try context.save()

        _ = try CanvasNodeStore.add([sampleRecord], to: canvas,
                                    visibleWorldRect: visible, context: context)
        _ = try CanvasNodeStore.add([realRecord], to: canvas,
                                    visibleWorldRect: visible, context: context)
        _ = try CanvasNodeStore.add([realRecord], to: sampleCanvas,
                                    visibleWorldRect: visible, context: context)

        CanvasNodeStore.deleteSampleNodes(records: [sampleRecord], canvases: [sampleCanvas],
                                          context: context)
        try context.save()

        let remaining = try context.fetch(FetchDescriptor<CanvasNode>())
        XCTAssertEqual(remaining.count, 1, "只留下真实记录在真实画布上的节点")
        XCTAssertEqual(remaining.first?.recordID, realRecord.id)
        XCTAssertEqual(remaining.first?.canvasID, canvas.id)
    }

    // MARK: - 模型

    func testFrameNeverCollapsesBelowATappableSize() {
        let node = CanvasNode(canvasID: UUID(), recordID: UUID(),
                              width: 10, height: 10)
        XCTAssertGreaterThanOrEqual(node.frame.width, 48)
        XCTAssertGreaterThanOrEqual(node.frame.height, 48)
    }
}
