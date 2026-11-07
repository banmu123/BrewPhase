import Foundation
import SwiftData
import CryptoKit

/// 从真实 SwiftData 构建同步批次：payload + 规范指纹 + 媒体清单。
///
/// 指纹字段序与桌面端 `snapshot-importer.ts` 的 `localFingerprint` 逐一对应
/// （SYNC_PROTOCOL.md §指纹）；**不含时间戳**。媒体以内容哈希为身份，
/// 路径不参与指纹（两端的存储名不同）。
struct SyncSnapshotBuilder {
    let context: ModelContext

    struct EntityBatch {
        var entityType: String
        var upserts: [SyncUpsert]
        var currentIDs: Set<String>
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
                "isSample": .init(bean.isSample)
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
                "stockDeductedG": .init(brew.stockDeductedG)
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
                "notes": .init(tasting.notes), "source": .init(tasting.sourceRaw)
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
                "enabled": .init(reminder.enabled)
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
                "isSample": .init(record.isSample)
            ]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([
                record.carrierRaw, record.title, record.note, record.urlString,
                record.canonicalURL, record.providerRaw, record.contentKindRaw,
                record.platformContentID, Double(record.linkPage),
                record.sourceName, record.authorName, record.summary,
                record.thumbnailURLString, record.metadataStatusRaw,
                Double(record.repositoryStars), Double(record.repositoryForks),
                Double(record.repositoryIssues), record.repositoryLanguage,
                record.repositoryLicense, record.isSample
            ]))
            return SyncUpsert(id: record.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "record", upserts: upserts, currentIDs: Set(records.map { $0.id.uuidString }))]
    }

    func tagBatches() throws -> [EntityBatch] {
        let tags = try context.fetch(FetchDescriptor<RecordTag>())
        let upserts = tags.map { tag -> SyncUpsert in
            let payload: [String: AnyCodableValue] = ["name": .init(tag.name)]
            let fp = SyncFingerprint.of(SyncFingerprint.canonical([tag.name]))
            return SyncUpsert(id: tag.id.uuidString, fingerprint: fp, payload: payload)
        }
        return [EntityBatch(entityType: "recordTag", upserts: upserts, currentIDs: Set(tags.map { $0.id.uuidString }))]
    }

    func canvasBatches() throws -> [EntityBatch] {
        let canvases = try context.fetch(FetchDescriptor<Canvas>())
        let upserts = canvases.map { canvas -> SyncUpsert in
            let payload: [String: AnyCodableValue] = [
                "name": .init(canvas.name), "note": .init(canvas.note),
                "isSample": .init(canvas.isSample)
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
                "zIndex": .init(node.zIndex), "annotation": .init(node.annotation)
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
    /// tag → record → canvas → node），桌面端事务里按同一顺序写。
    func allBatches() throws -> [EntityBatch] {
        try beanBatches() + brewBatches() + tastingBatches() + phaseRuleBatches()
            + reminderBatches() + tagBatches() + recordBatches()
            + canvasBatches() + nodeBatches()
    }

    // MARK: - 媒体清单

    /// 收集全部被引用的媒体文件。视频本体走 MediaStore，图片/封面走 ImageStore；
    /// 不假设 iOS 备份的附件清单——**直接按模型引用枚举**。
    func mediaManifest() throws -> [MediaManifestEntry] {
        var entries: [MediaManifestEntry] = []
        var seen = Set<String>()

        func add(name: String?, mediaType: String) {
            guard let name, !name.isEmpty, !seen.contains(name) else { return }
            seen.insert(name)
            let url: URL
            if mediaType == "video" {
                url = MediaStore.shared.url(for: name)
            } else {
                url = ImageStore.shared.url(for: name, thumbnail: name.contains("_thumb"))
            }
            guard let data = try? Data(contentsOf: url) else { return }
            entries.append(
                MediaManifestEntry(
                    name: name,
                    sha256: Self.sha256(data),
                    byteSize: data.count,
                    mediaType: mediaType,
                    mimeType: Self.mimeType(of: name)
                )
            )
        }

        let beans = try context.fetch(FetchDescriptor<Bean>())
        for bean in beans { add(name: bean.imagePath, mediaType: "image") }

        let records = try context.fetch(FetchDescriptor<Record>())
        for record in records {
            if record.carrier == .video {
                add(name: record.mediaPath, mediaType: "video")
            } else {
                add(name: record.mediaPath, mediaType: "image")
            }
            add(name: record.previewPath, mediaType: "preview")
        }
        return entries
    }

    func mediaData(for name: String) -> Data? {
        let url = name.hasSuffix(".mov") || name.hasSuffix(".mp4") || name.hasSuffix(".m4v")
            ? MediaStore.shared.url(for: name)
            : ImageStore.shared.url(for: name, thumbnail: name.contains("_thumb"))
        return try? Data(contentsOf: url)
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
