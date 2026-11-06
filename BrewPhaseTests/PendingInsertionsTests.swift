import XCTest
@testable import BrewPhase

/// `PendingInsertions` 的契约：保存回调只入队、按序出队、按 id 去重。
///
/// 动画时序（外层 sheet 关闭后才插入）是视图层的编排；这里钉住的是
/// 编排所依赖的队列语义——丢了记录用户会少一条，重了会出现两张卡。
final class PendingInsertionsTests: XCTestCase {

    private func makeRecord(_ title: String) -> Record {
        Record(carrier: .text, title: title)
    }

    func testEnqueueThenDrainReturnsTheRecord() {
        var queue = PendingInsertions()
        let record = makeRecord("一条记录")
        queue.enqueue(record)
        XCTAssertFalse(queue.isEmpty)

        let drained = queue.drain()
        XCTAssertEqual(drained.map(\.id), [record.id])
        XCTAssertTrue(queue.isEmpty, "drain 之后队列必须清空")
    }

    func testDrainPreservesEnqueueOrder() {
        var queue = PendingInsertions()
        let first = makeRecord("第一条")
        let second = makeRecord("第二条")
        queue.enqueue(first)
        queue.enqueue(second)

        XCTAssertEqual(queue.drain().map(\.id), [first.id, second.id])
    }

    func testDuplicateEnqueueIsIgnoredByID() {
        var queue = PendingInsertions()
        let record = makeRecord("会重复入队的记录")
        queue.enqueue(record)
        queue.enqueue(record)

        XCTAssertEqual(queue.drain().count, 1, "同一条记录的回调重入不得插两次")
    }

    func testDrainingTwiceYieldsNothingTheSecondTime() {
        var queue = PendingInsertions()
        queue.enqueue(makeRecord("一次性"))
        _ = queue.drain()
        XCTAssertTrue(queue.drain().isEmpty, "第二次 drain 必须是空的——不重复播动画")
    }

    func testEmptyQueueDrainsToNothing() {
        var queue = PendingInsertions()
        XCTAssertTrue(queue.isEmpty)
        XCTAssertTrue(queue.drain().isEmpty)
    }
}
