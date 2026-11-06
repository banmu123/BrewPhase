import XCTest
@testable import BrewPhase

/// `InsertionSequence` 的契约：一次只落一条、按入队顺序、清理不串味。
///
/// 这里钉住的是 Phase 3.1 修掉的那类竞争：旧实现用两个互不知情的固定
/// 延时（插入间隔 520ms、状态清理 760ms），三条连着存时前一条的清理会
/// 打到后一条身上。序列把时序收敛成「完成回调推进一格」，测试就按这个
/// 推进方式验证。
final class InsertionSequenceTests: XCTestCase {

    private func makeRecord(_ title: String) -> Record {
        Record(carrier: .text, title: title)
    }

    func testTakeNextPreservesEnqueueOrder() {
        var sequence = InsertionSequence()
        let first = makeRecord("第一条")
        let second = makeRecord("第二条")
        let third = makeRecord("第三条")
        sequence.enqueue([first, second, third])

        XCTAssertEqual(sequence.takeNext()?.id, first.id)
        sequence.finishActive()
        XCTAssertEqual(sequence.takeNext()?.id, second.id)
        sequence.finishActive()
        XCTAssertEqual(sequence.takeNext()?.id, third.id)
        sequence.finishActive()
        XCTAssertNil(sequence.takeNext())
        XCTAssertTrue(sequence.isIdle)
    }

    /// 下落位被占时不能交出下一条——这是「两个状态不许争同一条记录」的根。
    func testTakeNextIsRefusedWhileBusy() {
        var sequence = InsertionSequence()
        let first = makeRecord("正在落")
        let second = makeRecord("排队中")
        sequence.enqueue([first, second])

        XCTAssertEqual(sequence.takeNext()?.id, first.id)
        XCTAssertTrue(sequence.isBusy)
        XCTAssertNil(sequence.takeNext(), "前一条没落完，下一条不能开始")
        XCTAssertEqual(sequence.activeID, first.id, "下落位不能被覆盖")
    }

    /// 前一条的完成回调只让出下落位，不能顺手动到后面排队的记录。
    func testFinishingTheActiveRecordLeavesTheQueueIntact() {
        var sequence = InsertionSequence()
        let first = makeRecord("第一条")
        let second = makeRecord("第二条")
        sequence.enqueue([first, second])
        _ = sequence.takeNext()

        sequence.finishActive()
        XCTAssertNil(sequence.activeID)
        XCTAssertEqual(sequence.pending.map(\.id), [second.id], "排队的那条原样还在")
        XCTAssertEqual(sequence.takeNext()?.id, second.id, "紧接着就能开始下一条")
    }

    /// 保存回调重入、同一条被传两次：排队与下落位都不重复。
    func testDuplicateIDsAreEnqueuedOnce() {
        var sequence = InsertionSequence()
        let record = makeRecord("会重复")
        sequence.enqueue([record])
        sequence.enqueue([record])
        XCTAssertEqual(sequence.pending.count, 1)

        _ = sequence.takeNext()
        sequence.enqueue([record])
        XCTAssertTrue(sequence.pending.isEmpty, "正在落的记录不会再排一份")
        XCTAssertEqual(sequence.activeID, record.id)
    }

    /// 取消只清动画状态：记录已经落库，序列不拥有删除权。
    func testCancelClearsAnimationStateOnly() {
        var sequence = InsertionSequence()
        let active = makeRecord("正在落")
        let queued = makeRecord("排队")
        sequence.enqueue([active, queued])
        _ = sequence.takeNext()

        sequence.cancel()
        XCTAssertNil(sequence.activeID)
        XCTAssertTrue(sequence.pending.isEmpty)
        XCTAssertTrue(sequence.isIdle)
        XCTAssertNil(sequence.takeNext(), "取消之后不能再自动开播")
        // 记录本身没有被序列改动（数据库里仍在）。
        XCTAssertEqual(active.title, "正在落")
    }

    /// 空序列取不到东西，也不会把状态弄脏。
    func testEmptySequenceIsIdle() {
        var sequence = InsertionSequence()
        XCTAssertTrue(sequence.isIdle)
        XCTAssertFalse(sequence.isBusy)
        XCTAssertNil(sequence.takeNext())
        sequence.finishActive() // 空转时的误调用必须是安全操作
        XCTAssertTrue(sequence.isIdle)
    }
}
