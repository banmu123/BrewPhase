import XCTest
@testable import BrewPhase

/// `RecordCardHeightEstimator` 的契约：比例数学必须精确，文本近似必须
/// 单调、有界。估算不必像素级正确，但「横图比竖图矮」「长文比短文高」
/// 这类关系错了，列分配就会系统性偏斜。
final class RecordCardHeightEstimatorTests: XCTestCase {

    private let width: CGFloat = 200

    // MARK: - 图片比例

    /// 竖图 100×200（宽高比 0.5）：列宽 200 → 图高 400。
    func testPortraitImageHeightFollowsTheRatio() {
        let record = Record(carrier: .image, note: "看")
        let dims = ImageDimensions(pixelWidth: 100, pixelHeight: 200)
        let estimate = RecordCardHeightEstimator.estimate(for: record,
                                                          columnWidth: width, image: dims)
        // 图 400 + 呼吸 8 + 备注 1 行(17+2) + meta 17。用户没填标题，
        // displayTitle 的备注回退不参与窄卡排版（避免同一句话出现两遍）。
        XCTAssertEqual(estimate, 444, accuracy: 0.5)
    }

    /// 拿不到尺寸：4:3 占位。
    func testMissingDimensionsFallBackToThePlaceholderRatio() {
        let record = Record(carrier: .image)
        let estimate = RecordCardHeightEstimator.estimate(for: record,
                                                          columnWidth: width, image: nil)
        // 图 150（200 ÷ 4/3）+ 呼吸 8 + meta 17
        XCTAssertEqual(estimate, 175, accuracy: 0.5)
    }

    /// 极端比例也不再钳制：估算必须与卡片渲染同一条公式（列宽 ÷ 宽高比）。
    /// 旧实现把 1:20 的竖长图算成 520pt（实际 4000pt），列分配会系统性地
    /// 选错边。横到极致仍受 64pt 的「最小存在感」托底——那是估算自身的
    /// 下限，不改变卡片渲染。
    func testExtremeRatiosFollowTheSameFormulaAsTheCard() {
        let record = Record(carrier: .image)
        let wide = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: width,
            image: ImageDimensions(pixelWidth: 2000, pixelHeight: 100))
        let tall = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: width,
            image: ImageDimensions(pixelWidth: 100, pixelHeight: 2000))
        // 200 ÷ 20 = 10，加 8 + 17 = 35 → 触到 64pt 托底。
        XCTAssertEqual(wide, 64, accuracy: 0.5)
        // 200 ÷ 0.05 = 4000，加 8 + 17 = 4025。
        XCTAssertEqual(tall, 4000 + 8 + 17, accuracy: 0.5)
    }

    /// 旧的 72pt 图片下限已经移除：3:1 的横幅按 66.7pt 计，而不是被抬到 72。
    func testWideImageIsNoLongerFlooredAt72() {
        let record = Record(carrier: .image)
        let estimate = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: width,
            image: ImageDimensions(pixelWidth: 300, pixelHeight: 100))
        XCTAssertEqual(estimate, 200.0 / 3 + 8 + 17, accuracy: 0.5)
    }

    /// 同一条记录，列宽变宽 → 图片等比变高。
    func testImageHeightScalesWithColumnWidth() {
        let record = Record(carrier: .image)
        let dims = ImageDimensions(pixelWidth: 100, pixelHeight: 100) // 1:1
        let narrow = RecordCardHeightEstimator.estimate(for: record, columnWidth: 160, image: dims)
        let wide = RecordCardHeightEstimator.estimate(for: record, columnWidth: 220, image: dims)
        let expectedDiff: CGFloat = 60
        XCTAssertEqual(wide - narrow, expectedDiff, accuracy: 0.5, "1:1 图高差 = 列宽差")
    }

    /// 视频封面拿不到尺寸时按 9:16 竖版习惯（高 = 宽 × 9/16）。
    func testVideoPosterFallbackRatio() {
        let record = Record(carrier: .video, title: "一只猫", sourceName: "本机")
        let estimate = RecordCardHeightEstimator.estimate(for: record,
                                                          columnWidth: width, image: nil)
        // 封面 112.5 + 呼吸 8 + 标题 21 + 4 + 来源 15 + 2 + meta 17
        XCTAssertEqual(estimate, 179.5, accuracy: 0.5)
    }

    /// 16:9 与 9:16 的独立比例测试：估算必须与卡片渲染用同一个语义
    /// （宽 ÷ 高），横竖差值 = 200 × 16/9 − 200 × 9/16。
    func testVideoPosterRatioHandlesLandscapeAndPortrait() {
        let record = Record(carrier: .video, title: "视频", sourceName: "本机")
        let landscape = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: 200,
            image: ImageDimensions(pixelWidth: 1600, pixelHeight: 900))
        let portrait = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: 200,
            image: ImageDimensions(pixelWidth: 900, pixelHeight: 1600))
        let expectedDelta: CGFloat = 200 * 16 / 9 - 200 * 9 / 16
        XCTAssertEqual(portrait - landscape, expectedDelta, accuracy: 0.6)
    }

    /// YouTube 兜底必须与卡片一致：没有本地封面尺寸时按 16:9 横版
    /// （宽÷高），封面高 112.5pt——旧实现算成 355pt 的竖图。
    func testYouTubeFallbackMatchesTheCardRenderingRatio() {
        let record = Record(carrier: .link, title: "Me at the zoo",
                            urlString: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        record.adopt(LinkResolver.match(URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")!))
        let estimate = RecordCardHeightEstimator.estimate(for: record,
                                                          columnWidth: 200, image: nil)
        // 封面 112.5 + 标题 21+6 + credit 15+2 + meta 17 + 4
        XCTAssertEqual(estimate, 177.5, accuracy: 0.6)
    }

    /// 竖版 9:16 封面（手机拍的视频）：封面高约为横版的 3.16 倍。
    func testPortraitVideoPosterIsTall() {
        let record = Record(carrier: .video, title: "竖版视频")
        let estimate = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: 200,
            image: ImageDimensions(pixelWidth: 900, pixelHeight: 1600))
        let posterHeight: CGFloat = 200 * 16 / 9
        XCTAssertGreaterThan(estimate, posterHeight, "竖版海报本身就要占 355pt 以上")
    }

    /// 封面同样不钳制：1:3 的竖长封面，估算就是列宽 × 3。
    func testTallPosterIsNotClamped() {
        let record = Record(carrier: .video, title: "竖长封面", sourceName: "本机")
        let estimate = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: 200,
            image: ImageDimensions(pixelWidth: 100, pixelHeight: 300))
        // 封面 600 + 呼吸 8 + 标题 21+4 + 来源 15+2 + meta 17
        XCTAssertEqual(estimate, 667, accuracy: 0.6)
    }

    // MARK: - 文本

    func testLongerNoteMeansTallerTextCard() {
        let short = Record(carrier: .text, note: "一句话。")
        let long = Record(carrier: .text, note: String(repeating: "这句话很长，", count: 40))
        let shortEstimate = RecordCardHeightEstimator.estimate(for: short, columnWidth: width, image: nil)
        let longEstimate = RecordCardHeightEstimator.estimate(for: long, columnWidth: width, image: nil)
        XCTAssertGreaterThan(longEstimate, shortEstimate)
    }

    /// 长文按行数上限封顶：八行正文 + 标题，不会无限生长。
    func testVeryLongTextIsCapped() {
        let record = Record(carrier: .text,
                            title: String(repeating: "题", count: 60),
                            note: String(repeating: "字", count: 4000))
        let estimate = RecordCardHeightEstimator.estimate(for: record, columnWidth: width, image: nil)
        // 标题 2×26 + 6，正文 8×21，底 28，meta 17，尾 8 —— 上界之内。
        let cap: CGFloat = CGFloat(2) * 26 + 6 + CGFloat(8) * 21 + 28 + 17 + 8
        XCTAssertLessThanOrEqual(estimate, cap + 0.5)
    }

    /// 空标题不占行：图片卡带标题比不带标题高。
    func testMissingTitleDoesNotReserveSpace() {
        let withTitle = Record(carrier: .image, title: "有标题", note: "")
        let withoutTitle = Record(carrier: .image, note: "")
        let withEstimate = RecordCardHeightEstimator.estimate(for: withTitle, columnWidth: width, image: nil)
        let withoutEstimate = RecordCardHeightEstimator.estimate(for: withoutTitle, columnWidth: width, image: nil)
        let titleBlock: CGFloat = 21 + 4
        XCTAssertEqual(withEstimate - withoutEstimate, titleBlock, accuracy: 0.5)
    }

    // MARK: - 四种载体

    func testAllCarriersProducePositiveReasonableEstimates() {
        let link = Record(carrier: .link, title: "BrewPhase",
                          urlString: "https://github.com/banmu123/BrewPhase")
        let image = Record(carrier: .image, note: "一张图")
        let video = Record(carrier: .video, title: "一段视频")
        let text = Record(carrier: .text, note: "一句话")
        for record in [link, image, video, text] {
            let estimate = RecordCardHeightEstimator.estimate(for: record,
                                                              columnWidth: width, image: nil)
            XCTAssertGreaterThanOrEqual(estimate, 64, "\(record.carrier) 不得低于下限")
            XCTAssertLessThan(estimate, 1500, "\(record.carrier) 不该顶到上限")
        }
    }

    /// 载体一致、内容一致 → 估算确定。
    func testEstimatesAreDeterministic() {
        let record = Record(carrier: .text, title: "稳定", note: "同样的输入")
        let first = RecordCardHeightEstimator.estimate(for: record, columnWidth: width, image: nil)
        let second = RecordCardHeightEstimator.estimate(for: record, columnWidth: width, image: nil)
        XCTAssertEqual(first, second)
    }
}
