import XCTest
@testable import BrewPhase

/// The deck's arithmetic — the part of 豆仓's swipe that is worth checking
/// without a screen.
///
/// The view only turns these numbers into transforms; if they are monotonic and
/// clamped, a swipe can only ever look like a card travelling and the next one
/// growing, never like a card flying off in the wrong direction.
final class BeanDeckTests: XCTestCase {

    private let width: CGFloat = 350

    // MARK: - Progress

    func testProgressAtRestIsTheCurrentIndex() {
        for index in 0..<5 {
            XCTAssertEqual(BeanDeck.progress(index: index, pan: 0, width: width), CGFloat(index))
        }
    }

    func testDraggingLeftAdvancesProgress() {
        let resting = BeanDeck.progress(index: 1, pan: 0, width: width)
        let dragged = BeanDeck.progress(index: 1, pan: -width / 2, width: width)
        XCTAssertGreaterThan(dragged, resting)
    }

    func testDraggingRightRewindsProgress() {
        let dragged = BeanDeck.progress(index: 2, pan: width / 2, width: width)
        XCTAssertLessThan(dragged, 2)
    }

    /// A zero width would divide by zero on the first frame, before layout.
    func testProgressSurvivesAnUnmeasuredWidth() {
        XCTAssertEqual(BeanDeck.progress(index: 0, pan: -100, width: 0), 0)
    }

    // MARK: - Depth

    func testFrontCardIsFullSizeAndUnmoved() {
        XCTAssertEqual(BeanDeck.scale(0), 1)
        XCTAssertEqual(BeanDeck.vertical(0), 0)
        XCTAssertEqual(BeanDeck.horizontal(0, width: width), 0)
        XCTAssertEqual(BeanDeck.opacity(0), 1)
    }

    func testCardsBehindShrinkAndLiftButStayCentred() {
        let one = BeanDeck.scale(1)
        let two = BeanDeck.scale(2)
        XCTAssertLessThan(one, 1)
        XCTAssertLessThan(two, one)
        XCTAssertEqual(BeanDeck.vertical(1), -Metric.stackPeek)
        XCTAssertEqual(BeanDeck.horizontal(1, width: width), 0)
        XCTAssertEqual(BeanDeck.opacity(1), 1)
    }

    /// Depth is clamped: the fourth card behind sits exactly where the third
    /// does, which is what keeps a long cellar from shrinking into nothing.
    func testDepthIsClamped() {
        XCTAssertEqual(BeanDeck.scale(3), BeanDeck.scale(2))
        XCTAssertEqual(BeanDeck.vertical(9), BeanDeck.vertical(2))
    }

    /// A swiped-away card is fully off the page and fully transparent by the
    /// time it reaches the next card's position.
    func testASwipedCardLeavesThePage() {
        XCTAssertEqual(BeanDeck.opacity(-1), 0)
        XCTAssertEqual(BeanDeck.opacity(-0.5), 0.425, accuracy: 0.0001)
        XCTAssertEqual(BeanDeck.horizontal(-1, width: width), -(width + 24))
    }

    func testOpacityNeverGoesNegative() {
        for depth in stride(from: -3.0, through: 0.0, by: 0.1) {
            XCTAssertGreaterThanOrEqual(BeanDeck.opacity(CGFloat(depth)), 0)
        }
    }

    // MARK: - Focus（v1.2 审查）

    private var ids: [UUID] { (0..<6).map { _ in UUID() } }

    /// 重排时 deck 跟着豆子走——焦点按身份保持，不按位置。
    func testFocusFollowsTheBeanThroughARerank() {
        let shelf = ids
        let focused = shelf[2]
        // 该豆从位置 2 移到位置 4（冲煮记录改变了排序）。
        var reranked = shelf
        reranked.remove(at: 2)
        reranked.insert(focused, at: 4)

        let resolved = BeanDeck.resolvedFocus(focusedID: focused, index: 2, ids: reranked)
        XCTAssertEqual(resolved.index, 4)
        XCTAssertEqual(resolved.focusedID, focused)
    }

    /// 焦点豆离架（喝完/删除）时，替补上位的卡就是新的焦点——index 不动，
    /// focusedID 换人。旧行为保留了失效的 id，是后续跳回的根源。
    func testFocusReanchorsToTheReplacementWhenTheFocusedBeanLeaves() {
        let shelf = ids
        let focused = shelf[2]
        var withoutIt = shelf
        withoutIt.removeAll { $0 == focused }

        let resolved = BeanDeck.resolvedFocus(focusedID: focused, index: 2, ids: withoutIt)
        XCTAssertEqual(resolved.index, 2, "替补豆就位，deck 不该动")
        XCTAssertEqual(resolved.focusedID, withoutIt[2], "焦点必须落在屏幕上的这张卡")
        XCTAssertNotEqual(resolved.focusedID, focused)
    }

    /// 焦点豆离架后又被恢复：deck 继续跟着用户正在看的豆走，**不跳回**旧豆。
    /// 这是本次修复要钉死的核心场景。
    func testARestoredBeanDoesNotStealTheFocus() {
        let a = UUID(), b = UUID(), c = UUID(), d = UUID()
        // 用户在看 C（位置 2）；C 离架，替补 D 上位并获得焦点。
        let afterLeave = BeanDeck.resolvedFocus(focusedID: c, index: 2, ids: [a, b, d])
        XCTAssertEqual(afterLeave.focusedID, d)

        // C 恢复在喝，重新插到最前面。
        let afterRestore = BeanDeck.resolvedFocus(
            focusedID: afterLeave.focusedID, index: afterLeave.index, ids: [c, a, b, d])
        XCTAssertEqual(afterRestore.index, 3, "deck 滑动以保持 D 在眼前")
        XCTAssertEqual(afterRestore.focusedID, d, "而不是跳回刚恢复的 C")
    }

    /// 列表尾部一起离开时 index 越界：钳到末位，焦点同样落在屏幕上的卡。
    func testIndexIsClampedWhenTheFocusedBeanAndTailLeaveTogether() {
        let shelf = [UUID(), UUID(), UUID()]
        let resolved = BeanDeck.resolvedFocus(focusedID: shelf[2], index: 2, ids: [shelf[0]])
        XCTAssertEqual(resolved.index, 0)
        XCTAssertEqual(resolved.focusedID, shelf[0])
    }

    /// 货架空了：一切归零。BeanStack 在 Coffee 首页此时已整体卸载，但类型
    /// 必须自洽——空列表上没有「焦点」可言。
    func testFocusResolvesToNothingWhenTheShelfEmpties() {
        let resolved = BeanDeck.resolvedFocus(focusedID: UUID(), index: 3, ids: [])
        XCTAssertEqual(resolved.index, 0)
        XCTAssertNil(resolved.focusedID)
    }

    /// 首次出现（onAppear）走的就是重锚分支：focusedID 为 nil 且 index 越界
    /// （调试启动指定第 4 张卡、架上只有 1 包豆）时，钳回范围内并把焦点
    /// 落到唯一的卡上——否则 visiblePositions 会算出空窗口，页面没有卡片。
    func testFirstAppearanceClampsAnOutOfRangeIndex() {
        let only = UUID()
        let resolved = BeanDeck.resolvedFocus(focusedID: nil, index: 4, ids: [only])
        XCTAssertEqual(resolved.index, 0)
        XCTAssertEqual(resolved.focusedID, only)

        // 正常首启（index 0 合法）：值原样通过，不做多余的动作。
        let shelf = [UUID(), UUID(), UUID()]
        let plain = BeanDeck.resolvedFocus(focusedID: nil, index: 0, ids: shelf)
        XCTAssertEqual(plain.index, 0)
        XCTAssertEqual(plain.focusedID, shelf[0])
    }
}
