import Foundation
import UIKit

/// 链接封面的统一取图协调器。
///
/// 列表卡片在滚动时会反复重建；没有这一层去重，同一条记录会被反复下载。
/// 规则：
///
/// * 本地已有缓存（`previewPath`）就什么都不做；
/// * 每条记录每次启动最多**自动**取一次——失败记在 `attempted` 里，本轮不再
///   重试，安静地退回占位图（详情页是唯一 `force` 重试的入口）；
/// * 成功后写回记录并落库，`@Query` 让列表卡、详情页同时长出图；
/// * 下载期间记录被删掉、或被编辑出别的图时，落盘的新文件要跟着清掉。
///
/// 取图只发生在「卡片可见」或「用户打开详情」时；没有封面地址的记录
/// （解析就没拿到 og:image）永远不发请求。
@MainActor
final class CoverFetcher {

    static let shared = CoverFetcher()

    enum Result {
        /// 本来就有缓存，什么都没做。
        case cached
        /// 下载成功并已写回记录。
        case fetched
        /// 下载失败（网络、超时、坏图）。
        case failed
        /// 没有封面地址，或本轮已经试过——不该再自动发起。
        case skipped
    }

    private var attempted: Set<UUID> = []
    private var inFlight: Set<UUID> = []

    /// 本轮是否已经试过这条记录（无论成败）。
    func hasAttempted(_ id: UUID) -> Bool { attempted.contains(id) }

    /// 是否正在取（可能是别的视图发起的）。
    func isInFlight(_ id: UUID) -> Bool { inFlight.contains(id) }

    @discardableResult
    func fetch(_ record: Record, force: Bool = false) async -> Result {
        guard record.carrier == .link, record.previewPath == nil,
              record.thumbnailURL != nil else {
            return .skipped
        }
        if !force {
            guard !attempted.contains(record.id) else { return .skipped }
        }
        attempted.insert(record.id)
        inFlight.insert(record.id)
        defer { inFlight.remove(record.id) }

        let referer = record.provider == .bilibili ? "https://www.bilibili.com/" : nil
        guard let remote = record.thumbnailURL,
              let image = await LinkPreviewService.downloadImage(remote, referer: referer),
              let saved = try? ImageStore.shared.save(image, maxDimension: 1200) else {
            return .failed
        }
        // 下载期间记录可能被删掉，或者用户已经编辑出别的图。
        guard record.previewPath == nil, record.modelContext != nil else {
            ImageStore.shared.delete(saved)
            return .failed
        }
        record.previewPath = saved
        do {
            try record.modelContext?.save()
        } catch {
            AppLog.store.error(
                "cover fetch failed: \(error.localizedDescription, privacy: .public)"
            )
            record.modelContext?.rollback()
            ImageStore.shared.delete(saved)
            return .failed
        }
        return .fetched
    }
}
