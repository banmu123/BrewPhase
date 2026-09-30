import UIKit

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

    // MARK: - Writing

    /// Downscales, writes both sizes, and returns the name to store on the bean.
    @discardableResult
    func save(_ image: UIImage) throws -> String {
        let name = "\(UUID().uuidString).jpg"

        guard let display = Self.downscaled(image, maxDimension: Self.maxDimension),
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

        cache.setObject(display, forKey: name as NSString)
        AppLog.images.debug("stored image \(name, privacy: .public)")

        // A new image means the old one, if any, is the caller's business — see
        // `replace(_:previous:)`.
        return name
    }

    /// Saves a new image and removes the one it replaces, so editing a bean does
    /// not leak the previous file.
    @discardableResult
    func replace(_ image: UIImage, previous: String?) throws -> String {
        let name = try save(image)
        if let previous, previous != name { delete(previous) }
        return name
    }

    // MARK: - Reading

    func image(named name: String?, thumbnail: Bool = true) -> UIImage? {
        guard let name, !name.isEmpty else { return nil }

        let key = "\(name)|\(thumbnail)" as NSString
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

    // MARK: - Deleting

    /// Removes both sizes. Called when a bean is deleted, so image lifetime is
    /// tied to bean lifetime (§21).
    func delete(_ name: String?) {
        guard let name, !name.isEmpty else { return }
        try? fileManager.removeItem(at: url(for: name))
        try? fileManager.removeItem(at: url(for: name, thumbnail: true))
        cache.removeObject(forKey: name as NSString)
        cache.removeObject(forKey: "\(name)|true" as NSString)
        cache.removeObject(forKey: "\(name)|false" as NSString)
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
            try? fileManager.removeItem(at: url)
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
