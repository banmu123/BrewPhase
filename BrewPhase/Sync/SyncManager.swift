import Foundation
import SwiftData
import CryptoKit

/// 同步编排：配对 → 清单 → 指纹差异 → 批量应用 → 媒体分块 → 基线更新。
///
/// 增量策略：**快照指纹差异**（Phase 2 任务书 §9）。iOS 没有统一 change log，
/// 不依赖 updatedAt——每次与本地保存的上次成功基线比对指纹：
/// 新增/修改 → upsert；基线有而当前没有 → tombstone 删除（带基线指纹）。
/// **基线按桌面端逐条结果提交**（§7.2）：applied/skipped 才推进，conflict/failed
/// 保留原基线等裁决或重试；整批 200 不代表全部成功。
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

    private static let chunkSize = 256 * 1024

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

            // 数据批次（顺序即依赖顺序；tagLink 依赖 record 与 tag，已在两者之后）
            var applied = 0, skipped = 0, conflicts = 0, failed = 0
            for (index, batch) in batches.enumerated() {
                phase = .sendingData(index + 1)
                let previousForEntity = previous[batch.entityType] ?? [:]
                let upserts = batch.upserts.filter { previousForEntity[$0.id] != $0.fingerprint }
                let deletedIDs = previousForEntity.keys.filter { !batch.currentIDs.contains($0) }.sorted()
                let deletes = deletedIDs.map { id in
                    SyncDelete(id: id, expectedFingerprint: previousForEntity[id])
                }
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
                commitBaseline(
                    entityType: batch.entityType,
                    upserts: upserts,
                    deletedIDs: deletedIDs,
                    outcome: outcome
                )
            }

            // 媒体：清单比对 → 只传缺失的 → 流式分块 + 增量哈希 + 整文件校验。
            // 本地引用读不到 → 显式计入 failed（§4.3），不静默跳过。
            let manifestResult = builder.mediaManifest()
            failed += manifestResult.errors.count
            let missing = manifestResult.entries.isEmpty
                ? []
                : try await client.mediaManifest(manifestResult.entries).missing
            for (index, entry) in missing.enumerated() {
                phase = .sendingMedia(index + 1, missing.count)
                if try await uploadMedia(entry, builder: builder, client: client) == false {
                    failed += 1
                }
            }

            lastSyncAt = Date()
            defaults.set(lastSyncAt, forKey: Self.lastSyncKey)
            phase = .done(applied: applied, skipped: skipped, conflicts: conflicts, failed: failed)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// 单个媒体文件的流式上传（§9）：FileHandle 分块读，增量 SHA-256 覆盖
    /// 整个文件（含断点续传时跳过的前缀），绝不把整个视频装进内存。
    /// 返回 false 表示这个文件失败（计 failed），不中断其余文件。
    private func uploadMedia(
        _ entry: MediaManifestEntry,
        builder: SyncSnapshotBuilder,
        client: SyncNetworkClient
    ) async throws -> Bool {
        guard let handle = builder.mediaHandle(for: entry.name) else { return false }
        defer { try? handle.close() }
        do {
            var hasher = SHA256()
            var fileSize = 0
            let resumed = try await client.resumedOffset(name: entry.name)
            // 断点续传：前缀只喂哈希不上传，保证 finalize 的整文件哈希完整。
            try handle.seek(toOffset: 0)
            while fileSize < resumed {
                guard let prefix = try handle.read(upToCount: Self.chunkSize), !prefix.isEmpty else { break }
                hasher.update(data: prefix)
                fileSize += prefix.count
            }
            var uploaded = fileSize
            while let chunk = try handle.read(upToCount: Self.chunkSize), !chunk.isEmpty {
                hasher.update(data: chunk)
                fileSize += chunk.count
                try await client.uploadChunk(name: entry.name, offset: uploaded, data: chunk)
                uploaded += chunk.count
            }
            let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            try await client.finalizeMedia(name: entry.name, sha256: digest, byteSize: fileSize)
            return true
        } catch {
            return false
        }
    }

    /// 逐条基线提交（§7.2）。桌面端 results 缺失（旧版本）时退回整批语义。
    private func commitBaseline(
        entityType: String,
        upserts: [SyncUpsert],
        deletedIDs: [String],
        outcome: ApplyOutcome
    ) {
        var entityBaseline = baseline[entityType] ?? [:]
        var hasChange = false

        if let results = outcome.results, !results.isEmpty {
            let byID = Dictionary(results.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            for upsert in upserts {
                guard let status = byID[upsert.id]?.status else { continue }
                if status == "applied" || status == "skipped" {
                    entityBaseline[upsert.id] = upsert.fingerprint
                    hasChange = true
                }
                // conflict / failed：基线不动，等裁决或重试。
            }
            for id in deletedIDs {
                guard let status = byID[id]?.status else { continue }
                if status == "applied" || status == "skipped" {
                    // applied = 删除生效；skipped = 桌面端本就没有（幂等收敛）。
                    entityBaseline.removeValue(forKey: id)
                    hasChange = true
                }
                // 删除冲突：保留 tombstone 基线，等待裁决后下轮重发。
            }
        } else if outcome.failedItems?.isEmpty != false {
            // 旧服务端（无逐条结果）：只有整批无失败才推进（原语义）。
            for upsert in upserts { entityBaseline[upsert.id] = upsert.fingerprint }
            for id in deletedIDs { entityBaseline.removeValue(forKey: id) }
            hasChange = true
        }

        guard hasChange else { return }
        var next = baseline
        next[entityType] = entityBaseline
        baseline = next
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
    /** 断点续传：问服务端这个文件已收到多少字节。文件名按查询参数编码。 */
    func resumedOffset(name: String) async throws -> Int {
        guard let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/api/sync/media/offset?name=\(encoded)") else { return 0 }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, _) = try await session.data(for: request)
        return (try? JSONDecoder().decode([String: Int].self, from: data))?["received"] ?? 0
    }
}
