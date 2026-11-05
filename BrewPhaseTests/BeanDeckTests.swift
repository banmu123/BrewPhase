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
}
