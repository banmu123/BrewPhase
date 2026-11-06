import XCTest
@testable import BrewPhase

/// Design System v1 的 Token 约束（docs/design/BrewPhase-Design-System-v1.md）。
///
/// 这些是纯值断言：它们钉住的不是某个界面，而是整套视觉语言的骨架——
/// 间距梯子必须单调、圆角必须分层、留白必须落在规范值上。谁改了 Token
/// 而没有更新规范文档，这里会先红。
final class StudioDesignTokensTests: XCTestCase {

    // MARK: - 空间梯子（4pt 基准）

    func testSpacingLadderIsMonotonicOnA4ptBase() {
        let ladder = [
            Metric.Space.xxs, Metric.Space.xs, Metric.Space.sm, Metric.Space.md,
            Metric.Space.lg, Metric.Space.xl, Metric.Space.xxl,
            Metric.Space.xxxl, Metric.Space.xxxxl,
        ]
        // 全部落在 4pt 基准上。
        for step in ladder {
            XCTAssertEqual(step.truncatingRemainder(dividingBy: 4), 0, "\(step) 不在 4pt 基准上")
        }
        // 严格递增，梯子才成其为梯子。
        for (before, after) in zip(ladder, ladder.dropFirst()) {
            XCTAssertLessThan(before, after)
        }
    }

    // MARK: - 页面节奏

    func testPageRhythmMatchesTheSpec() {
        XCTAssertEqual(Metric.gutter, 22, "页面左右留白 22pt（规范 §4）")
        XCTAssertEqual(Metric.sectionGap, 28, "一级区块间距 28pt（规范 §4）")
    }

    // MARK: - 首页 hero 的图片契约（v1.1 QA §1）

    func testDeckHeroReadsThe400pxThumbnail() {
        // BeanStack 最多保留四张可见卡，hero 用缩略图（长边 400px）把解码内存
        // 压到展示图的约 1/9；详情页仍读 1400px 展示图。这个常量是首页画质与
        // 性能的平衡点——改动它之前先重拍七张验收截图。
        XCTAssertEqual(ImageStore.thumbnailDimension, 400)
        XCTAssertEqual(ImageStore.maxDimension, 1400)
    }

    // MARK: - 圆角分层

    func testRadiusIsLayered() {
        XCTAssertLessThan(Metric.radiusSmall, Metric.radius)
        XCTAssertLessThan(Metric.radius, Metric.radiusLarge)
        XCTAssertEqual(Metric.radiusSmall, 10)
        XCTAssertEqual(Metric.radius, 16)
        XCTAssertEqual(Metric.radiusLarge, 20)
    }

    // MARK: - 层次约束

    func testElevationStaysQuiet() {
        // 阴影只允许两种，且都很淡：普通卡片无阴影，聚焦豆卡轻微抬升。
        // 用构造值钉住，防止有人顺手把阴影调浓。
        XCTAssertEqual(Palette.cardShadow, Palette.color(0x000000, 0.04))
        XCTAssertEqual(Palette.liftedShadow, Palette.color(0x000000, 0.08))
    }

    // MARK: - 色彩契约

    func testPhaseColoursKeepTheirSemanticSlots() {
        // 阶段色是语义，不允许被挪作装饰：四个阶段 + 优先级，各占一位。
        XCTAssertEqual(Palette.tint(.resting), Palette.resting)
        XCTAssertEqual(Palette.tint(.opening), Palette.opening)
        XCTAssertEqual(Palette.tint(.peak), Palette.peak)
        XCTAssertEqual(Palette.tint(.declining), Palette.declining)
    }
}
