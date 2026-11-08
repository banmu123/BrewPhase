import Foundation
import SwiftData
import CryptoKit

/// 从真实 SwiftData 构建同步批次：payload + 规范指纹 + 媒体清单。
///
/// 指纹字段序与桌面端 `snapshot-importer.ts` 的 `localFingerprint` 逐一对应
/// （SYNC_PROTOCOL.md §指纹）；**不含时间戳**——`createdAt` 只进 payload（桌面
/// 端保留原始创建时间），不进指纹。媒体路径（文件名）两端同名，进 payload
/// 与指纹（2026-11-07 起，之前缺失会让已上传文件与记录脱钩）。
struct SyncSnapshotBuilder {
    let context: ModelContext

    struct EntityBatch {
        var entityType: String
        var upserts: [SyncUpsert]
        var currentIDs: Set<String>
    }

    /// 媒体清单 + 显式错误报告（§4.3）：本地引用读不到不再静默跳过。
    struct MediaManifestResult {
        var entries: [MediaManifestEntry] = []
        var errors: [String] = []
    }

    // MARK: - 各实体

    func beanBatches() throws -> [EntityBatch] {
        let beans = try context.fetch(FetchDescriptor<Bean>())
        let upserts = beans.map { bean -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "name": .init(bean.name), "roaster": .init(bean.roaster),
                "origin": .init(bean.origin), "process": .init(bean.process),
                "roastLevel": .init(bean.roastLevelRaw),
                "roastDate": .init(epochMillis(bean.roastDate)),
                "purchaseDate": .init(epochMillis(bean.purchaseDate)),
                "openDate": .init(epochMillis(bean.openDate)),
                "weightG": .init(bean.weightG), "remainingG": .init(bean.remainingG),
                "price": .init(bean.price), "channel": .init(bean.channel),
                "imagePath": .init(bean.imagePath),
                "flavorTagsRaw": .init(bean.flavorTagsRaw), "notes": .init(bean.notes),
                "status": .init(bean.statusRaw),
                "stockCountedAt": .init(epochMillis(bean.stockCountedAt)),
                "isSample": .init(bean.isSample),
                "createdAt": .init(epochMillis(bean.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                bean.name, bean.roaster, bean.origin, bean.process, bean.roastLevelRaw,
                epochMillis(bean.roastDate), epochMillis(bean.purchaseDate), epochMillis(bean.openDate),
                bean.weightG, bean.remainingG, bean.price, bean.channel,
                bean.imagePath, bean.flavorTagsRaw, bean.notes, bean.statusRaw,
                epochMillis(bean.stockCountedAt), bean.isSample
            ]))
            return SyncUpsert(id: bean.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "bean", upserts: upserts, currentIDs: Set(beans.map { $0.id.uuidString }))]
    }

    func brewBatches() throws -> [EntityBatch] {
        let brews = try context.fetch(FetchDescriptor<Brew>())
        let upserts = brews.map { brew -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "beanId": .init(brew.bean?.id.uuidString ?? ""),
                "date": .init(epochMillis(brew.date) ?? 0),
                "method": .init(brew.method), "grinder": .init(brew.grinder),
                "grindSize": .init(brew.grindSize), "waterTemp": .init(brew.waterTemp),
                "coffeeG": .init(brew.coffeeG), "waterG": .init(brew.waterG),
                "timeSeconds": .init(brew.timeSeconds), "score": .init(brew.score),
                "acidity": .init(brew.acidity), "sweetness": .init(brew.sweetness),
                "bitterness": .init(brew.bitterness), "body": .init(brew.body),
                "aftertaste": .init(brew.aftertaste),
                "flavorTagsRaw": .init(brew.flavorTagsRaw), "notes": .init(brew.notes),
                "stockDeductedG": .init(brew.stockDeductedG),
                "createdAt": .init(epochMillis(brew.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                brew.bean?.id.uuidString, epochMillis(brew.date),
                brew.method, brew.grinder, brew.grindSize, brew.waterTemp,
                brew.coffeeG, brew.waterG, Double(brew.timeSeconds),
                Double(brew.score), Double(brew.acidity), Double(brew.sweetness),
                Double(brew.bitterness), Double(brew.body), Double(brew.aftertaste),
                brew.flavorTagsRaw, brew.notes, brew.stockDeductedG
            ]))
            return SyncUpsert(id: brew.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "brew", upserts: upserts, currentIDs: Set(brews.map { $0.id.uuidString }))]
    }

    func tastingBatches() throws -> [EntityBatch] {
        let tastings = try context.fetch(FetchDescriptor<Tasting>())
        let upserts = tastings.map { tasting -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "beanId": .init(tasting.bean?.id.uuidString ?? ""),
                "brewId": .init(tasting.brewID?.uuidString),
                "date": .init(epochMillis(tasting.date) ?? 0),
                "dayAfterRoast": .init(tasting.dayAfterRoast),
                "flavorTagsRaw": .init(tasting.flavorTagsRaw), "score": .init(tasting.score),
                "notes": .init(tasting.notes), "source": .init(tasting.sourceRaw),
                "createdAt": .init(epochMillis(tasting.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                tasting.bean?.id.uuidString, tasting.brewID?.uuidString, epochMillis(tasting.date),
                Double(tasting.dayAfterRoast), tasting.flavorTagsRaw, Double(tasting.score),
                tasting.notes, tasting.sourceRaw
            ]))
            return SyncUpsert(id: tasting.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "tasting", upserts: upserts, currentIDs: Set(tastings.map { $0.id.uuidString }))]
    }

    func phaseRuleBatches() throws -> [EntityBatch] {
        let rules = try context.fetch(FetchDescriptor<PhaseRule>())
        let upserts = rules.map { rule -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "roastLevel": .init(rule.roastLevelRaw),
                "restMinDays": .init(rule.restMinDays), "restMaxDays": .init(rule.restMaxDays),
                "peakStartDay": .init(rule.peakStartDay), "peakEndDay": .init(rule.peakEndDay),
                "declineStartDay": .init(rule.declineStartDay), "enabled": .init(rule.enabled)
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                rule.roastLevelRaw, Double(rule.restMinDays), Double(rule.restMaxDays),
                Double(rule.peakStartDay), Double(rule.peakEndDay),
                Double(rule.declineStartDay), rule.enabled
            ]))
            return SyncUpsert(id: rule.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "phaseRule", upserts: upserts, currentIDs: Set(rules.map { $0.id.uuidString }))]
    }

    func reminderBatches() throws -> [EntityBatch] {
        let reminders = try context.fetch(FetchDescriptor<PhaseReminder>())
        let upserts = reminders.map { reminder -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "beanId": .init(reminder.bean?.id.uuidString ?? ""),
                "kind": .init(reminder.kindRaw),
                "fireDate": .init(epochMillis(reminder.fireDate) ?? 0),
                "enabled": .init(reminder.enabled),
                "createdAt": .init(epochMillis(reminder.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                reminder.bean?.id.uuidString, reminder.kindRaw,
                epochMillis(reminder.fireDate), reminder.enabled
            ]))
            return SyncUpsert(id: reminder.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "phaseReminder", upserts: upserts, currentIDs: Set(reminders.map { $0.id.uuidString }))]
    }

    func recordBatches() throws -> [EntityBatch] {
        let records = try context.fetch(FetchDescriptor<Record>())
        let upserts = records.map { record -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "carrier": .init(record.carrierRaw), "title": .init(record.title),
                "note": .init(record.note), "urlString": .init(record.urlString),
                "canonicalURL": .init(record.canonicalURL),
                "provider": .init(record.providerRaw), "contentKind": .init(record.contentKindRaw),
                "platformContentID": .init(record.platformContentID),
                "linkPage": .init(record.linkPage),
                "sourceName": .init(record.sourceName), "authorName": .init(record.authorName),
                "summary": .init(record.summary),
                "thumbnailURLString": .init(record.thumbnailURLString),
                "metadataStatus": .init(record.metadataStatusRaw),
                "repositoryStars": .init(record.repositoryStars),
                "repositoryForks": .init(record.repositoryForks),
                "repositoryIssues": .init(record.repositoryIssues),
                "repositoryLanguage": .init(record.repositoryLanguage),
                "repositoryLicense": .init(record.repositoryLicense),
                "mediaPath": .init(record.mediaPath),
                "previewPath": .init(record.previewPath),
                "isSample": .init(record.isSample),
                "createdAt": .init(epochMillis(record.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                record.carrierRaw, record.title, record.note, record.urlString,
                record.canonicalURL, record.providerRaw, record.contentKindRaw,
                record.platformContentID, Double(record.linkPage),
                record.sourceName, record.authorName, record.summary,
                record.thumbnailURLString, record.metadataStatusRaw,
                Double(record.repositoryStars), Double(record.repositoryForks),
                Double(record.repositoryIssues), record.repositoryLanguage,
                record.repositoryLicense,
                record.mediaPath, record.previewPath,
                record.isSample
            ]))
            return SyncUpsert(id: record.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "record", upserts: upserts, currentIDs: Set(records.map { $0.id.uuidString }))]
    }

    func tagBatches() throws -> [EntityBatch] {
        let tags = try context.fetch(FetchDescriptor<RecordTag>())
        let upserts = tags.map { tag -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "name": .init(tag.name),
                "createdAt": .init(epochMillis(tag.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([tag.name]))
            return SyncUpsert(id: tag.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "recordTag", upserts: upserts, currentIDs: Set(tags.map { $0.id.uuidString }))]
    }

    /// Record ↔ Tag 多对多关系（§5）。id 是**确定性**的 `recordId:tagId`，
    /// 两端同一构造；不按名字匹配（同名标签、改名都不影响关系身份）。
    func recordTagLinkBatches() throws -> [EntityBatch] {
        let records = try context.fetch(FetchDescriptor<Record>())
        var upserts: [SyncUpsert] = []
        var ids = Set<String>()
        for record in records {
            for tag in record.tags ?? [] {
                let linkID = "\(record.id.uuidString):\(tag.id.uuidString)"
                guard ids.insert(linkID).inserted else { continue }
                let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                    record.id.uuidString, tag.id.uuidString
                ]))
                upserts.append(SyncUpsert(
                    id: linkID,
                    fingerprint: fp,
                    payload: [
                        "recordId": .init(record.id.uuidString),
                        "tagId": .init(tag.id.uuidString)
                    ]
                ))
            }
        }
        return [EntityBatch(entityType: "recordTagLink", upserts: upserts, currentIDs: ids)]
    }

    func canvasBatches() throws -> [EntityBatch] {
        let canvases = try context.fetch(FetchDescriptor<Canvas>())
        let upserts = canvases.map { canvas -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "name": .init(canvas.name), "note": .init(canvas.note),
                "isSample": .init(canvas.isSample),
                "createdAt": .init(epochMillis(canvas.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([canvas.name, canvas.note, canvas.isSample]))
            return SyncUpsert(id: canvas.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "canvas", upserts: upserts, currentIDs: Set(canvases.map { $0.id.uuidString }))]
    }

    func nodeBatches() throws -> [EntityBatch] {
        let nodes = try context.fetch(FetchDescriptor<CanvasNode>())
        let upserts = nodes.map { node -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "canvasId": .init(node.canvasID.uuidString),
                "recordId": .init(node.recordID.uuidString),
                "positionX": .init(node.positionX), "positionY": .init(node.positionY),
                "width": .init(node.width), "height": .init(node.height),
                "zIndex": .init(node.zIndex), "annotation": .init(node.annotation),
                "createdAt": .init(epochMillis(node.createdAt))
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                node.canvasID.uuidString, node.recordID.uuidString,
                node.positionX, node.positionY, node.width, node.height,
                Double(node.zIndex), node.annotation
            ]))
            return SyncUpsert(id: node.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "canvasNode", upserts: upserts, currentIDs: Set(nodes.map { $0.id.uuidString }))]
    }

    /// 全量批次，实体按依赖顺序（bean → brew → tasting → rule → reminder →
    /// tag → record → **tagLink** → canvas → node）；tagLink 依赖 record 与 tag，
    /// 必须在两者之后。
    func allBatches() throws -> [EntityBatch] {
        try beanBatches() + brewBatches() + tastingBatches() + phaseRuleBatches()
            + reminderBatches() + tagBatches() + recordBatches()
            + recordTagLinkBatches()
            + canvasBatches() + nodeBatches()
    }

    // MARK: - 媒体清单

    /// 收集全部被引用的媒体文件。视频本体走 MediaStore，图片/封面走 ImageStore；
    /// **直接按模型引用枚举**。引用了但本地读不到 → 显式进 `errors`（§4.3），
    /// 不静默跳过；大文件流式哈希，不整读进内存（§9）。
    func mediaManifest() -> MediaManifestResult {
        var result = MediaManifestResult()
        var seen = Set<String>()

        func add(name: String?, mediaType: String) {
            guard let name, !name.isEmpty else { return }
            guard seen.insert(name).inserted else { return }
            let url: URL
            if mediaType == "video" {
                url = MediaStore.shared.url(for: name)
            } else {
                url = ImageStore.shared.url(for: name, thumbnail: name.contains("_thumb"))
            }
            guard let digest = Self.fileSHA256(at: url) else {
                result.errors.append("\(mediaType) 文件无法读取：\(name)")
                return
            }
            result.entries.append(
                MediaManifestEntry(
                    name: name,
                    sha256: digest.sha256,
                    byteSize: digest.byteSize,
                    mediaType: mediaType,
                    mimeType: Self.mimeType(of: name)
                )
            )
        }

        guard let beans = try? context.fetch(FetchDescriptor<Bean>()) else {
            result.errors.append("豆子数据无法读取，媒体清单不完整")
            return result
        }
        for bean in beans { add(name: bean.imagePath, mediaType: "image") }

        guard let records = try? context.fetch(FetchDescriptor<Record>()) else {
            result.errors.append("记录数据无法读取，媒体清单不完整")
            return result
        }
        for record in records {
            if record.carrier == .video {
                add(name: record.mediaPath, mediaType: "video")
            } else {
                add(name: record.mediaPath, mediaType: "image")
            }
            add(name: record.previewPath, mediaType: "preview")
        }
        return result
    }

    /// 上传用读取句柄：调用方分块读 + 增量哈希，不把整个视频装进内存（§9）。
    func mediaHandle(for name: String) -> FileHandle? {
        let url = name.hasSuffix(".mov") || name.hasSuffix(".mp4") || name.hasSuffix(".m4v")
            ? MediaStore.shared.url(for: name)
            : ImageStore.shared.url(for: name, thumbnail: name.contains("_thumb"))
        return try? FileHandle(forReadingFrom: url)
    }

    /// 文件哈希缓存：键是路径，比对大小与修改时间。
    ///
    /// 记录增删后会触发自动同步，而每次同步都要重建媒体清单。若每次都把
    /// 整个视频从头读一遍，编辑一条记录就要等几十秒——文件没变就没有理由重算。
    private struct DigestStamp: Equatable {
        var size: Int64
        var modified: Date
    }

    private static var digestCache: [String: (stamp: DigestStamp, digest: (sha256: String, byteSize: Int))] = [:]

    /// 流式 SHA-256 + 字节数：内存占用恒为一块（256KB）。
    static func fileSHA256(at url: URL) -> (sha256: String, byteSize: Int)? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
        let stamp = DigestStamp(
            size: fileSize,
            modified: (attributes?[.modificationDate] as? Date) ?? .distantPast
        )
        if fileSize >= 0, let cached = digestCache[url.path], cached.stamp == stamp {
            return cached.digest
        }

        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        var size = 0
        while true {
            let chunk = (try? handle.read(upToCount: 256 * 1024)) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
            size += chunk.count
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        let result = (sha256: digest, byteSize: size)
        digestCache[url.path] = (stamp: DigestStamp(size: Int64(size), modified: stamp.modified), digest: result)
        return result
    }

    /// 按真实字节判 MIME（魔数），不信任扩展名。
    static func mimeType(of name: String) -> String {
        switch name.split(separator: ".").last?.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "mov": return "video/quicktime"
        case "mp4": return "video/mp4"
        case "m4v": return "video/x-m4v"
        default: return "application/octet-stream"
        }
    }
}
