import XCTest
@testable import BrewPhase

/// 插入动画的几何契约：默认从上方落下，Reduce Motion 下位移必须为 0。
///
/// 动画本身要真机看，但「有没有位移」是一个可以离屏断言的事实——这正是
/// Phase 3 把 Reduce Motion 分支写成 `.identity`（连淡入都没有）时漏掉的那条。
final class InsertionMotionTests: XCTestCase {

    func testDefaultMotionDropsFromAbove() {
        let motion = InsertionMotion.make(reduceMotion: false)
        XCTAssertEqual(motion, .drop)
        XCTAssertEqual(motion.offset, -150)
        XCTAssertFalse(motion.isOpacityOnly)
    }

    func testReduceMotionHasNoDisplacement() {
        let motion = InsertionMotion.make(reduceMotion: true)
        XCTAssertEqual(motion.offset, 0, "Reduce Motion 不允许任何位移")
        XCTAssertTrue(motion.isOpacityOnly, "没有位移不等于没有反馈：仍然要淡入")
    }

    /// 两个分支不能是同一个值：切换开关必须真的改变表现。
    func testTheTwoBranchesDiffer() {
        XCTAssertNotEqual(InsertionMotion.make(reduceMotion: true),
                          InsertionMotion.make(reduceMotion: false))
    }
}
