import Foundation
import SwiftData

/// 同步编排：配对 → 清单 → 指纹差异 → 批量应用 → 媒体分块 → 基线更新。
///
/// 增量策略：**快照指纹差异**（Phase 2 任务书 §9）。iOS 没有统一 change log，
/// 不依赖 updatedAt——每次与本地保存的上次成功基线比对指纹：
/// 新增/修改 → upsert；基线有而当前没有 → tombstone 删除。
/// 只有桌面端确认成功后才更新基线；失败时基线不动，可安全重试。
@MainActor
final class SyncManager: ObservableObject {
    enum Phase: Equatable {
        case idle
        case preparing
        case sendingData(Int)
        case sendingMedia(Int, Int) // 已传文件数 / 总数
        case done(applied: Int, skipped: Int, conflicts: Int, failed: Int)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var lastSyncAt: Date?

    private let defaults: UserDefaults
    private static let baselineKey = "sync.baseline.v1"
    private static let lastSyncKey = "sync.lastSyncAt"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        lastSyncAt = defaults.object(forKey: Self.lastSyncKey) as? Date
    }

    // MARK: - 基线

    private var baseline: [String: [String: String]] {
        get { defaults.dictionary(forKey: Self.baselineKey) as? [String: [String: String]] ?? [:] }
        set { defaults.set(newValue, forKey: Self.baselineKey) }
    }

    func pairedDevice() -> (host: String, port: Int, deviceId: String, token: String)? {
        guard let host = SyncKeychain.string(forKey: "desktop.host"),
              let portText = SyncKeychain.string(forKey: "desktop.port"),
              let port = Int(portText),
              let token = SyncKeychain.string(forKey: "desktop.token") else { return nil }
        return (host, port, SyncKeychain.string(forKey: "desktop.deviceId") ?? "", token)
    }

    // MARK: - 配对

    /// 扫码后调用：验证配对码、保存凭据。
    func pair(with link: SyncPairingLink, deviceName: String) async throws -> PairResponse {
        guard link.expiresAt > Date() else {
            throw SyncError.pairingCodeExpired
        }
        let client = SyncNetworkClient(host: link.host, port: link.port, token: nil)
        let response = try await client.pair(pairingCode: link.pairingCode, deviceName: deviceName)
        SyncKeychain.set(response.token, forKey: "desktop.token")
        SyncKeychain.set(link.host, forKey: "desktop.host")
        SyncKeychain.set(String(link.port), forKey: "desktop.port")
        SyncKeychain.set(response.deviceId, forKey: "desktop.deviceId")
        SyncKeychain.set(link.deviceName, forKey: "desktop.deviceName")
        return response
    }

    func unpair() {
        for key in ["desktop.token", "desktop.host", "desktop.port", "desktop.deviceId", "desktop.deviceName"] {
            SyncKeychain.set(nil, forKey: key)
        }
        baseline = [:]
        defaults.removeObject(forKey: Self.lastSyncKey)
        lastSyncAt = nil
        phase = .idle
    }

    // MARK: - 同步

    func syncNow(context: ModelContext) async {
        do {
            guard let device = pairedDevice() else {
                phase = .failed("还没有配对的桌面端")
                return
            }
            phase = .preparing
            let client = SyncNetworkClient(host: device.host, port: device.port, token: device.token)
            _ = try await client.manifest()

            let builder = SyncSnapshotBuilder(context: context)
            let batches = try builder.allBatches()
            let previous = baseline

            // 数据批次（顺序即依赖顺序）
            var applied = 0, skipped = 0, conflicts = 0, failed = 0
            for (index, batch) in batches.enumerated() {
                phase = .sendingData(index + 1)
                let upserts = batch.upserts.filter { previous[batch.entityType]?[$0.id] != $0.fingerprint }
                let deletedIDs = previous[batch.entityType]?.keys.filter { !batch.currentIDs.contains($0) } ?? []
                let deletes = deletedIDs.map { SyncDelete(id: $0) }
                guard !upserts.isEmpty || !deletes.isEmpty else { continue }
                let outcome = try await client.apply(
                    SyncBatch(operations: [SyncOperation(
                        entityType: batch.entityType, upserts: upserts, deletes: deletes
                    )])
                )
                applied += outcome.appliedCount
                skipped += outcome.skippedCount
                conflicts += outcome.conflictCount
                failed += outcome.failedItems?.count ?? 0
                if outcome.failedItems?.isEmpty == false {
                    // 引用缺失等失败：保留基线，让下一次重试；本轮继续其余实体。
                    continue
                }
                var entityBaseline = previous[batch.entityType] ?? [:]
                for upsert in batch.upserts { entityBaseline[upsert.id] = upsert.fingerprint }
                for id in deletedIDs { entityBaseline.removeValue(forKey: id) }
                var next = baseline
                next[batch.entityType] = entityBaseline
                baseline = next
            }

            // 媒体：清单比对 → 只传缺失的 → 分块 + 整文件校验
            let manifest = try builder.mediaManifest()
            let check = try await client.mediaManifest(manifest)
            let missing = check.missing
            for (index, entry) in missing.enumerated() {
                phase = .sendingMedia(index + 1, missing.count)
                guard let data = builder.mediaData(for: entry.name) else {
                    failed += 1
                    continue
                }
                var offset = try await client.resumedOffset(name: entry.name)
                while offset < data.count {
                    let end = min(offset + 256 * 1024, data.count)
                    try await client.uploadChunk(name: entry.name, offset: offset, data: data.subdata(in: offset..<end))
                    offset = end
                }
                try await client.finalizeMedia(name: entry.name, sha256: entry.sha256, byteSize: entry.byteSize)
            }

            lastSyncAt = Date()
            defaults.set(lastSyncAt, forKey: Self.lastSyncKey)
            phase = .done(applied: applied, skipped: skipped, conflicts: conflicts, failed: failed)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

enum SyncError: LocalizedError {
    case pairingCodeExpired

    var errorDescription: String? {
        switch self {
        case .pairingCodeExpired: return "配对码已过期，请在桌面端重新生成"
        }
    }
}

extension SyncNetworkClient {
    /** 断点续传：问服务端这个文件已收到多少字节。 */
    func resumedOffset(name: String) async throws -> Int {
        guard let url = URL(string: "\(baseURL)/api/sync/media/offset?name=\(name)") else { return 0 }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, _) = try await session.data(for: request)
        return (try? JSONDecoder().decode([String: Int].self, from: data))?["received"] ?? 0
    }
}
