import ImageIO
import XCTest
import UniformTypeIdentifiers
@testable import BrewPhase

/// `ImageStore.imageDimensions` 的契约：像素尺寸、方向校正、缓存行为。
///
/// Masonry 卡片要用「列宽 ÷ 宽高比」预留高度，尺寸必须与最终展示一致——
/// 一张横图被读成竖图，卡片就会先按竖图留白、加载后再跳。
final class ImageStoreDimensionsTests: XCTestCase {

    // MARK: - 造图

    private func makeImage(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
            .image { ctx in
                UIColor.systemBrown.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
            }
    }

    /// 写一张带任意 EXIF orientation 的 JPEG 到 ImageStore 目录。
    /// 像素数据是 width × height；orientation 6 表示「展示时顺时针转 90°」。
    private func storeJPEG(width: Int, height: Int,
                           orientation: Int? = nil) throws -> String {
        let name = "\(UUID().uuidString).jpg"
        let url = ImageStore.shared.url(for: name)
        let image = try XCTUnwrap(makeImage(width: width, height: height).cgImage)
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        var properties: [CFString: Any] = [:]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return name
    }

    // MARK: - 基础读取

    func testLandscapePortraitAndSquareDimensions() throws {
        for (width, height) in [(300, 200), (200, 300), (240, 240)] {
            let name = try storeJPEG(width: width, height: height)
            defer { ImageStore.shared.delete(name) }
            let dimensions = try XCTUnwrap(
                ImageStore.shared.imageDimensions(named: name, thumbnail: false))
            XCTAssertEqual(dimensions.pixelWidth, width, "\(width)×\(height)")
            XCTAssertEqual(dimensions.pixelHeight, height, "\(width)×\(height)")
            XCTAssertEqual(dimensions.aspectRatio, CGFloat(width) / CGFloat(height))
        }
    }

    func testMissingFileReturnsNil() {
        XCTAssertNil(ImageStore.shared.imageDimensions(named: "definitely-not-here.jpg"))
        XCTAssertNil(ImageStore.shared.imageDimensions(named: nil))
        XCTAssertNil(ImageStore.shared.imageDimensions(named: ""))
    }

    /// EXIF orientation 6（顺时针转 90° 展示）：像素 300×200，竖起来看是 200×300。
    /// 卡片按「展示方向」留白，所以必须读出校正后的尺寸。
    func testEXIFOrientationIsCorrected() throws {
        let name = try storeJPEG(width: 300, height: 200, orientation: 6)
        defer { ImageStore.shared.delete(name) }
        let dimensions = try XCTUnwrap(ImageStore.shared.imageDimensions(named: name))
        XCTAssertEqual(dimensions.pixelWidth, 200, "展示宽度是像素高度")
        XCTAssertEqual(dimensions.pixelHeight, 300, "展示高度是像素宽度")
    }

    /// 正向的 orientation 1 不交换。
    func testUprightOrientationIsUntouched() throws {
        let name = try storeJPEG(width: 300, height: 200, orientation: 1)
        defer { ImageStore.shared.delete(name) }
        let dimensions = try XCTUnwrap(ImageStore.shared.imageDimensions(named: name))
        XCTAssertEqual(dimensions.pixelWidth, 300)
        XCTAssertEqual(dimensions.pixelHeight, 200)
    }

    // MARK: - 缓存行为

    /// 第一次读取把尺寸放进内存缓存：删掉磁盘文件后再问，仍然答得出来。
    /// （Masonry 滚动时反复询问同一张卡，不能每次都读文件头。）
    func testDimensionsAreCachedInMemory() throws {
        let name = try storeJPEG(width: 320, height: 200)
        defer { ImageStore.shared.delete(name) }

        let first = try XCTUnwrap(ImageStore.shared.imageDimensions(named: name))
        try FileManager.default.removeItem(at: ImageStore.shared.url(for: name))

        let second = try XCTUnwrap(ImageStore.shared.imageDimensions(named: name))
        XCTAssertEqual(first, second, "第二次读取走缓存，与文件是否还在无关")
    }

    /// 删除图片时两种尺寸的缓存一并清掉：之后读不到，也不该读到旧值。
    func testDeleteClearsDimensionCache() throws {
        let name = try storeJPEG(width: 300, height: 200)
        XCTAssertNotNil(ImageStore.shared.imageDimensions(named: name))
        ImageStore.shared.delete(name)
        XCTAssertNil(ImageStore.shared.imageDimensions(named: name))
    }

    /// 恢复后的 `clearCache()` 同样清空尺寸缓存。
    func testClearCacheAlsoClearsDimensions() throws {
        let name = try storeJPEG(width: 300, height: 200)
        XCTAssertNotNil(ImageStore.shared.imageDimensions(named: name))
        ImageStore.shared.clearCache()
        try FileManager.default.removeItem(at: ImageStore.shared.url(for: name))
        XCTAssertNil(ImageStore.shared.imageDimensions(named: name),
                     "缓存清空后，文件也没了，必须如实返回 nil")
    }

    /// 保存即预热：`save` 出来的图，第一次询问尺寸不落盘。
    func testSaveWarmsTheDimensionCache() throws {
        let name = try ImageStore.shared.save(makeImage(width: 640, height: 400))
        defer { ImageStore.shared.delete(name) }
        try FileManager.default.removeItem(at: ImageStore.shared.url(for: name))

        let dimensions = try XCTUnwrap(ImageStore.shared.imageDimensions(named: name))
        XCTAssertEqual(dimensions.pixelWidth, 640)
        XCTAssertEqual(dimensions.pixelHeight, 400)
    }
}
