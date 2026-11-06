import UIKit
import ImageIO

/// 一张图片的像素尺寸与展示宽高比。
///
/// 只装两个整数——卡片按列宽和这个比例预留高度（`高 = 列宽 ÷ 宽高比`），
/// 图片加载前后卡片就不必跳动。比例在宽或高不成立时返回 nil，由调用方
/// 退到中性占位比例。
struct ImageDimensions: Equatable, Sendable {
    let pixelWidth: Int
    let pixelHeight: Int

    /// 宽 ÷ 高。宽或高为 0 时返回 nil——一张不成立的图不该给出比例。
    var aspectRatio: CGFloat? {
        guard pixelWidth > 0, pixelHeight > 0 else { return nil }
        return CGFloat(pixelWidth) / CGFloat(pixelHeight)
    }
}

/// Owns every image file the app writes (§21).
///
/// Two sizes per photo — a display copy and a thumbnail — both downscaled before
/// they touch the disk, so a 12-megapixel bag shot never ends up in the sandbox
/// at full size. The store only ever records the *file name*; this type is the
/// only thing that knows where files live.
///
/// **Why `@unchecked Sendable`.** It is a shared singleton reached from SwiftUI
/// view bodies, so Swift 6 asks it to be `Sendable`. What has to be checked is
/// whether it owns mutable state, and it does not: every stored property below is
/// a `let`, so there is no unsynchronised mutation to race on. The two reference
/// members are both safe by contract —
///
/// * `fileManager`: `FileManager` is documented as safe to use from multiple
///   threads, and only the instance methods that are thread-safe are called;
/// * `cache`: `NSCache` is documented as thread-safe for concurrent access, and
///   the `UIImage`s put in it are immutable once created.
///
/// If a mutable stored property is ever added here, this conformance has to be
/// revisited — the annotation is a statement about *these* three properties.
final class ImageStore: @unchecked Sendable {

    static let shared = ImageStore()

    /// Longest edge of the stored display image.
    static let maxDimension: CGFloat = 1400
    /// Longest edge of the stored thumbnail.
    static let thumbnailDimension: CGFloat = 400
    static let jpegQuality: CGFloat = 0.8

    private let fileManager = FileManager.default
    private let directory: URL
    private let cache = NSCache<NSString, UIImage>()
    /// 尺寸元信息的内存缓存。ImageIO 只读文件头，但缓存让第二次询问连
    /// 文件都不碰；NSCache 自动响应内存压力，不需要手工清理策略。
    private let dimensionsCache = NSCache<NSString, DimensionsBox>()

    /// `NSCache` 只收类类型，包一层不可变盒子。
    private final class DimensionsBox: Sendable {
        let value: ImageDimensions
        init(_ value: ImageDimensions) { self.value = value }
    }

    private init() {
        let base = fileManager
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? fileManager.temporaryDirectory
        directory = base.appendingPathComponent("BrewPhase/Images", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        cache.countLimit = 60
    }

    // MARK: - Paths

    var directoryURL: URL { directory }

    /// Where the given stored name lives on disk.
    func url(for name: String, thumbnail: Bool = false) -> URL {
        directory.appendingPathComponent(Self.fileName(for: name, thumbnail: thumbnail))
    }

    /// `A1B2.jpg` → `A1B2_thumb.jpg`
    static func fileName(for name: String, thumbnail: Bool) -> String {
        guard thumbnail else { return name }
        let stem = (name as NSString).deletingPathExtension
        return "\(stem)_thumb.jpg"
    }

    // MARK: - Cache keys

    /// 唯一构造缓存 Key 的地方。展示图与缩略图各占一个键位、互不借用。
    ///
    /// v1.2 审查修复：`save` 曾把展示图缓存在裸文件名下，而读取路径全部走
    /// `name|…`——那份缓存永远命不中，只是白占 NSCache 的名额，保存后的
    /// 第一次读取仍然要进磁盘。现在读写共用这一个函数，拼法不会再分叉。
    private static func cacheKey(_ name: String, thumbnail: Bool) -> NSString {
        "\(name)|\(thumbnail)" as NSString
    }

    // MARK: - Writing

    /// Downscales, writes both sizes, and returns the name to store on the bean.
    ///
    /// `maxDimension` 用来区分「用户拍的照片」和「网页预览图」：后者本来就只有
    /// 几百像素宽，再存一张 1400 的长边副本只是白占空间。
    @discardableResult
    func save(_ image: UIImage, maxDimension: CGFloat = ImageStore.maxDimension) throws -> String {
        let name = "\(UUID().uuidString).jpg"

        guard let display = Self.downscaled(image, maxDimension: maxDimension),
              let displayData = display.jpegData(compressionQuality: Self.jpegQuality) else {
            throw ImageStoreError.encodingFailed
        }
        try displayData.write(to: url(for: name), options: .atomic)

        // The thumbnail is best-effort: if it fails the app still works, it just
        // falls back to the display image.
        if let thumb = Self.downscaled(image, maxDimension: Self.thumbnailDimension),
           let thumbData = thumb.jpegData(compressionQuality: Self.jpegQuality) {
            try? thumbData.write(to: url(for: name, thumbnail: true), options: .atomic)
        }

        cache.setObject(display, forKey: Self.cacheKey(name, thumbnail: false))
        // 尺寸顺手预热：刚落盘的图，第一次询问尺寸不该再碰磁盘。
        if let displayDimensions = Self.dimensions(of: display) {
            dimensionsCache.setObject(DimensionsBox(displayDimensions),
                                      forKey: Self.fileName(for: name, thumbnail: false) as NSString)
        }
        if let thumb = Self.downscaled(image, maxDimension: Self.thumbnailDimension),
           let thumbDimensions = Self.dimensions(of: thumb) {
            dimensionsCache.setObject(DimensionsBox(thumbDimensions),
                                      forKey: Self.fileName(for: name, thumbnail: true) as NSString)
        }
        AppLog.images.debug("stored image \(name, privacy: .public)")

        // A new image means the old one, if any, is the caller's business — see
        // `replace(_:previous:)`.
        return name
    }

    // MARK: - Reading

    func image(named name: String?, thumbnail: Bool = true) -> UIImage? {
        guard let name, !name.isEmpty else { return nil }

        let key = Self.cacheKey(name, thumbnail: thumbnail)
        if let cached = cache.object(forKey: key) { return cached }

        // A missing thumbnail is not an error — migrate to the full image.
        if let image = UIImage(contentsOfFile: url(for: name, thumbnail: thumbnail).path) {
            cache.setObject(image, forKey: key)
            return image
        }
        if thumbnail, let full = UIImage(contentsOfFile: url(for: name).path) {
            cache.setObject(full, forKey: key)
            return full
        }
        // The record points at a file that is not there. A broken reference must
        // never take the app down, or block the bean from opening.
        AppLog.images.debug("missing image file for \(name, privacy: .public)")
        return nil
    }

    // MARK: - 尺寸元信息

    /// 读取一张已存图片的像素尺寸（按展示方向校正过）。
    ///
    /// ImageIO 只读文件头，不解码整张位图；结果进内存缓存，第二次询问
    /// 不再碰磁盘。缩略图与展示图是两个文件，`thumbnail` 决定读哪一个。
    /// 文件不存在或读不出属性时返回 nil——调用方用中性占位比例，卡片照常
    /// 出现。保存时两个尺寸已经写进缓存（`save` 顺手预热），正常路径
    /// 第一次询问也不落盘。
    func imageDimensions(named name: String?, thumbnail: Bool = false) -> ImageDimensions? {
        guard let name, !name.isEmpty else { return nil }
        let key = Self.fileName(for: name, thumbnail: thumbnail) as NSString
        if let box = dimensionsCache.object(forKey: key) { return box.value }

        guard let source = CGImageSourceCreateWithURL(url(for: name, thumbnail: thumbnail) as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else {
            return nil
        }

        // 展示方向校正：orientation 5–8（横竖互换的四种）像素宽高要交换。
        // 保存流程会把方向烤进位图，但外部下载的封面不总走那条路，这里统一兜住。
        let orientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
        let swapped = (5...8).contains(orientation)
        let dimensions = swapped
            ? ImageDimensions(pixelWidth: height, pixelHeight: width)
            : ImageDimensions(pixelWidth: width, pixelHeight: height)

        dimensionsCache.setObject(DimensionsBox(dimensions), forKey: key)
        return dimensions
    }

    // MARK: - Deleting

    /// Removes both sizes. Called when a bean is deleted, so image lifetime is
    /// tied to bean lifetime (§21).
    ///
    /// 删除失败只记日志、不抛出：最坏的结果是一个没人引用的文件留在磁盘上，
    /// 而「清理无用的图片」会把它们收走。但失败不能像以前那样悄悄溜走——
    /// 排查「为什么空间没释放」时，日志是唯一的线索。
    func delete(_ name: String?) {
        guard let name, !name.isEmpty else { return }
        remove(url(for: name))
        remove(url(for: name, thumbnail: true))
        cache.removeObject(forKey: Self.cacheKey(name, thumbnail: false))
        cache.removeObject(forKey: Self.cacheKey(name, thumbnail: true))
        dimensionsCache.removeObject(forKey: Self.fileName(for: name, thumbnail: false) as NSString)
        dimensionsCache.removeObject(forKey: Self.fileName(for: name, thumbnail: true) as NSString)
    }

    private func remove(_ url: URL) {
        // 文件本来就不在（比如没有缩略图）不是错误。
        guard fileManager.fileExists(atPath: url.path) else { return }
        do {
            try fileManager.removeItem(at: url)
        } catch {
            AppLog.images.error(
                "failed to remove \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    // MARK: - Housekeeping

    /// Files on disk that no bean refers to any more.
    func orphanedFiles(referenced: Set<String>) -> [URL] {
        let known = Set(referenced.flatMap { name in
            [Self.fileName(for: name, thumbnail: false), Self.fileName(for: name, thumbnail: true)]
        })
        let contents = (try? fileManager.contentsOfDirectory(at: directory,
                                                            includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return contents.filter { !known.contains($0.lastPathComponent) }
    }

    /// Deletes orphans and reports how many went.
    @discardableResult
    func clearOrphans(referenced: Set<String>) -> Int {
        let orphans = orphanedFiles(referenced: referenced)
        for url in orphans {
            remove(url)
        }
        if !orphans.isEmpty {
            AppLog.images.info("cleared \(orphans.count) orphaned image files")
        }
        return orphans.count
    }

    func totalBytes() -> Int64 {
        let contents = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.fileSizeKey]
        )) ?? []
        return contents.reduce(into: Int64(0)) { total, url in
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            total += Int64(size)
        }
    }

    func fileCount() -> Int {
        ((try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []).count
    }

    // MARK: - Backup support

    /// 备份恢复时用的缩略图重建：拿已落盘的展示图，生成与 `save` 同规格的缩略图。
    /// 缩略图是**派生数据**，所以备份里不存它——恢复时在这里重建，失败也不致命
    /// （`image(named:)` 会自动回退到展示图）。
    static func thumbnailData(forDisplayImageAt url: URL) -> Data? {
        guard let image = UIImage(contentsOfFile: url.path),
              let thumb = downscaled(image, maxDimension: thumbnailDimension) else {
            return nil
        }
        return thumb.jpegData(compressionQuality: jpegQuality)
    }

    /// 恢复后调用：文件名可能被重新写入，缓存里的旧图不能再被读到。
    func clearCache() {
        cache.removeAllObjects()
        dimensionsCache.removeAllObjects()
    }

    /// 位图的像素尺寸。`size` 是点，乘上 `scale` 才是像素——
    /// 保存管线里 `format.scale = 1`，两者一致，但这里不做这个假设。
    private static func dimensions(of image: UIImage) -> ImageDimensions? {
        let width = Int((image.size.width * image.scale).rounded())
        let height = Int((image.size.height * image.scale).rounded())
        guard width > 0, height > 0 else { return nil }
        return ImageDimensions(pixelWidth: width, pixelHeight: height)
    }

    // MARK: - Scaling

    /// Aspect-fit downscale. Returns the original untouched when it is already
    /// small enough, so re-saving a thumbnail does not resample it twice.
    static func downscaled(_ image: UIImage, maxDimension: CGFloat) -> UIImage? {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxDimension, longest > 0 else { return image }

        let scale = maxDimension / longest
        let target = CGSize(width: (image.size.width * scale).rounded(),
                            height: (image.size.height * scale).rounded())

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        // Drawing (rather than resizing the CGImage) also bakes in the EXIF
        // orientation, so a photo taken sideways is stored upright.
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

enum ImageStoreError: LocalizedError {
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .encodingFailed: return L("这张图片没能保存下来，可以换一张试试")
        }
    }
}
