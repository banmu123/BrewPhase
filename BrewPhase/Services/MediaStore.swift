import AVFoundation
import UIKit

/// 视频文件的落盘位置。
///
/// 与 `ImageStore` 分工明确：图片（含视频封面）走 `ImageStore`，因为要生成缩略图；
/// 视频本体走这里，只搬文件、只存文件名——**绝不把视频字节塞进数据库字段**。
/// 一段 30 秒的 4K 视频是几百 MB，放进 SwiftData 的 Data 属性等于把整个库拖垮。
///
/// 目录在 Application Support 下，和图片目录平级，备份与「清理无用文件」都能
/// 按同一套「引用集合」的思路处理。
final class MediaStore: @unchecked Sendable {

    static let shared = MediaStore()

    private let fileManager = FileManager.default
    private let directory: URL

    private init() {
        let base = fileManager
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? fileManager.temporaryDirectory
        directory = base.appendingPathComponent("BrewPhase/Media", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func url(for name: String) -> URL {
        directory.appendingPathComponent(name)
    }

    func exists(_ name: String?) -> Bool {
        guard let name, !name.isEmpty else { return false }
        return fileManager.fileExists(atPath: url(for: name).path)
    }

    // MARK: - 写入

    /// 把一个临时文件搬进媒体目录，返回要存在记录上的文件名。
    ///
    /// 用 `copyItem` 而不是读进 `Data`：视频可能上千兆，读进内存在真机上会直接
    /// 被系统杀掉。扩展名保留，播放器要靠它选解码器。
    func save(videoAt source: URL) throws -> String {
        let ext = source.pathExtension.isEmpty ? "mov" : source.pathExtension.lowercased()
        let name = "\(UUID().uuidString).\(ext)"
        try fileManager.copyItem(at: source, to: url(for: name))
        AppLog.images.debug("stored video \(name, privacy: .public)")
        return name
    }

    func delete(_ name: String?) {
        guard let name, !name.isEmpty else { return }
        let target = url(for: name)
        guard fileManager.fileExists(atPath: target.path) else { return }
        do {
            try fileManager.removeItem(at: target)
        } catch {
            AppLog.images.error(
                "failed to remove video \(name, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    // MARK: - 封面

    /// 从视频里取一帧当封面。失败就返回 nil——卡片会退回到一个播放占位块，
    /// 而不是让整条记录打不开。
    func poster(for name: String, at seconds: Double = 0.4) async -> UIImage? {
        await Self.poster(forVideoAt: url(for: name), at: seconds)
    }

    /// 同上，但针对任意文件位置：编辑器里选完视频还没落盘时也要能出封面。
    static func poster(forVideoAt url: URL, at seconds: Double = 0.4) async -> UIImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1200, height: 1200)

        let time = CMTime(seconds: seconds, preferredTimescale: 600)
        do {
            let result = try await generator.image(at: time)
            return UIImage(cgImage: result.image)
        } catch {
            AppLog.images.debug("video poster failed for \(url.lastPathComponent, privacy: .public)")
            return nil
        }
    }

    /// 视频时长，用来在编辑器里给一句「0:42」的确认。
    func duration(for name: String) async -> Double? {
        let asset = AVURLAsset(url: url(for: name))
        guard let duration = try? await asset.load(.duration) else { return nil }
        let seconds = CMTimeGetSeconds(duration)
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }
}
