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
    /// 最近一次同步的具体失败原因（供界面显示与排障）。
    @Published private(set) var lastFailedReasons: [String] = []
    /// 最近一次同步的媒体统计（结果汇总展示；以真实清单/上传结果为准）。
    struct MediaStats: Equatable {
        var images: Int
        var videos: Int
        var failed: Int
    }
    @Published private(set) var lastMediaStats: MediaStats?

    static let protocolVersion = 1

    /// 全 App 共用一个实例：设置页与「记录增删后的自动推送」必须看到同一份
    /// `phase` / `lastSyncAt`，否则自动同步成功了设置页还显示旧时间。
    static let shared = SyncManager()

    private let defaults: UserDefaults
    private static let baselineKey = "sync.baseline.v1"
    private static let lastSyncKey = "sync.lastSyncAt"

    /// 同一时刻只跑一轮：自动推送与手动「立即同步」会撞车。
    private var isRunning = false
    /// 待执行的自动推送（窗口内合并，见 `scheduleAutoSync`）。
    private var autoPushTask: Task<Void, Never>?

    private static let chunkSize = 256 * 1024

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        lastSyncAt = defaults.object(forKey: Self.lastSyncKey) as? Date
    }

    // MARK: - 界面辅助

    /// 本地待同步数据量（首次同步确认区展示，如实统计不虚构）。
    struct LocalCounts: Equatable {
        var beans: Int
        var brews: Int
        var tastings: Int
        var records: Int
        var canvases: Int

        var summary: String {
            "\(L("豆子")) \(beans) · \(L("冲煮")) \(brews) · \(L("品鉴")) \(tastings) · \(L("收藏")) \(records) · \(L("画布")) \(canvases)"
        }
    }

    static func countLocalData(context: ModelContext) -> LocalCounts {
        func count<T: PersistentModel>(_ type: T.Type) -> Int {
            (try? context.fetchCount(FetchDescriptor<T>())) ?? 0
        }
        return LocalCounts(
            beans: count(Bean.self), brews: count(Brew.self), tastings: count(Tasting.self),
            records: count(Record.self), canvases: count(Canvas.self)
        )
    }

    /// 数据批次序号 → 可读阶段名（批次顺序 = allBatches 的实体依赖顺序）。
    static func stageLabel(for step: Int) -> String {
        switch step {
        case 1: return L("正在同步豆子")
        case 2: return L("正在同步冲煮")
        case 3: return L("正在同步品鉴")
        case 4, 5: return L("正在同步阶段规则与提醒")
        case 6, 7, 8: return L("正在同步收藏记录与标签")
        case 9, 10: return L("正在同步画布")
        default: return L("正在同步数据")
        }
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

    /// 扫码后调用：多地址探测 → 验证一次配对 → 校验协议版本 → 保存凭据。
    ///
    /// 配对码一次性：**只对验证可达的地址发一次 POST /api/pair**，绝不向
    /// 多个地址并发兑换；响应丢失时由用户重新生成二维码，不盲目重试。
    @discardableResult
    func pair(with link: SyncPairingLink, deviceName: String) async throws -> PairResponse {
        guard link.expiresAt > Date() else {
            throw SyncError.pairingCodeExpired
        }
        // 连通性探测：逐一 GET /api/status，验证 service 与 protocolVersion。
        var reachableHost: String?
        var tried: [String] = []
        for candidate in link.candidateHosts {
            tried.append(candidate)
            let probe = SyncNetworkClient(host: candidate, port: link.port, token: nil, timeout: 2.0)
            if let status = try? await probe.serviceStatus(),
               status.service == "brewphase-sync",
               status.protocolVersion == Self.protocolVersion {
                reachableHost = candidate
                break
            }
        }
        guard let host = reachableHost else {
            throw SyncError.desktopUnreachable(tried)
        }
        var confirmed = link
        confirmed.host = host
        let client = SyncNetworkClient(host: host, port: link.port, token: nil)
        let response = try await client.pair(pairingCode: confirmed.pairingCode, deviceName: deviceName)
        guard response.protocolVersion == Self.protocolVersion else {
            throw SyncError.protocolMismatch
        }
        // 凭据逐项落 Keychain；任一失败清理全部，绝不留「半配对」状态（§5）。
        let credentials: [(key: String, value: String)] = [
            ("desktop.token", response.token),
            ("desktop.host", host),
            ("desktop.port", String(link.port)),
            ("desktop.deviceId", response.deviceId),
            ("desktop.deviceName", confirmed.deviceName)
        ]
        var written: [String] = []
        for credential in credentials {
            guard SyncKeychain.set(credential.value, forKey: credential.key) else {
                for key in credentials.map(\.key) { SyncKeychain.set(nil, forKey: key) }
                throw SyncError.keychainWriteFailed
            }
            written.append(credential.key)
        }
        // 回读校验：写进去的必须读得回来（Keychain 可靠性验收口径）。
        for credential in credentials where SyncKeychain.string(forKey: credential.key) != credential.value {
            for key in written { SyncKeychain.set(nil, forKey: key) }
            throw SyncError.keychainWriteFailed
        }
        // 新配对 = 新基线：对面可能换了台 Mac、也可能被清空过。
        // 留着旧基线会让首次同步只发增量，缺的那部分永远补不回来。
        baseline = [:]
        defaults.removeObject(forKey: Self.lastSyncKey)
        lastSyncAt = nil
        phase = .idle
        return response
    }

    /// 解除配对的结果。`localOnly` = 桌面端没清成（连不上/服务未运行），
    /// 本地凭据仍然清掉了——用户要断开就必须能断开，不能因为对方离线而卡住。
    enum UnpairOutcome: Equatable {
        case wiped
        case localOnly(reason: String)
    }

    /// 解除配对。`wipeRemote` 为真时**先**让桌面端清空同步实体，再清本地凭据。
    ///
    /// 顺序不能反：token 一清就再也发不出这条请求了。
    @discardableResult
    func unpair(wipeRemote: Bool) async -> UnpairOutcome {
        var outcome = UnpairOutcome.wiped
        if wipeRemote, let device = pairedDevice() {
            do {
                try await SyncNetworkClient(
                    host: device.host,
                    port: device.port,
                    token: device.token,
                    timeout: 8
                ).wipeSyncedContent()
            } catch {
                outcome = .localOnly(reason: error.localizedDescription)
            }
        }
        clearLocalCredentials()
        return outcome
    }

    private func clearLocalCredentials() {
        for key in ["desktop.token", "desktop.host", "desktop.port", "desktop.deviceId", "desktop.deviceName"] {
            SyncKeychain.set(nil, forKey: key)
        }
        baseline = [:]
        defaults.removeObject(forKey: Self.lastSyncKey)
        lastSyncAt = nil
        phase = .idle
    }

    // MARK: - 自动推送

    /// 记录增删后调用：2 秒合并窗口，未配对直接返回，失败静默（只更新 phase）。
    ///
    /// 不做「改一个字段就发一轮」：一轮要构建全量快照与媒体清单，
    /// 2 秒足够把一次连续编辑合并。App 退到后台会被系统挂起，
    /// 没跑成的那一轮由下一次编辑或用户手动同步补上。
    func scheduleAutoSync(context: ModelContext) {
        guard pairedDevice() != nil else { return }
        autoPushTask?.cancel()
        autoPushTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            await self.syncNow(context: context)
        }
    }

    // MARK: - 同步

    func syncNow(context: ModelContext) async {
        // 自动推送与手动同步互斥：第二轮直接放弃，不做排队——
        // 快照是「当前状态」，排队跑一轮过期快照没有意义。
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }
        do {
            guard let device = pairedDevice() else {
                phase = .failed("还没有配对的桌面端")
                return
            }
            phase = .preparing
            lastMediaStats = nil
            lastFailedReasons = []
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
                for item in outcome.failedItems ?? [] {
                    lastFailedReasons.append("\(batch.entityType) #\(item.id.prefix(8)): \(item.reason)")
                }
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
            let imageCount = manifestResult.entries.filter { $0.mediaType != "video" }.count
            let videoCount = manifestResult.entries.filter { $0.mediaType == "video" }.count
            var mediaFailed = manifestResult.errors.count
            failed += manifestResult.errors.count
            let missing = manifestResult.entries.isEmpty
                ? []
                : try await client.mediaManifest(manifestResult.entries).missing
            for (index, entry) in missing.enumerated() {
                phase = .sendingMedia(index + 1, missing.count)
                if try await uploadMedia(entry, builder: builder, client: client) == false {
                    mediaFailed += 1
                    failed += 1
                }
            }
            lastMediaStats = MediaStats(images: imageCount, videos: videoCount, failed: mediaFailed)

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
    case desktopUnreachable([String])
    case protocolMismatch
    case keychainWriteFailed

    var errorDescription: String? {
        switch self {
        case .pairingCodeExpired: return "配对码已过期，请在桌面端重新生成"
        case .desktopUnreachable(let tried):
            return "无法连接桌面端（已尝试 \(tried.joined(separator: "、"))）。请确认 iPhone 与 Mac 在同一 Wi-Fi，桌面端同步已启用，且 Mac 防火墙允许 BrewPhase。"
        case .protocolMismatch: return "桌面端版本不兼容，请把两端都更新到最新版"
        case .keychainWriteFailed: return "配对凭据保存失败，请重试；若反复出现请检查系统设置"
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
