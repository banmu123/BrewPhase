import CryptoKit
import Foundation
import SwiftData

/// 生成、读取与校验完整备份。
///
/// 三条约束贯穿这个类型：
/// * **快照在调用方线程上一次取完**（`snapshot` 读的是模型对象），之后全是值类型，
///   编码与写盘可以离开主线程，用户中途改记录也不会把半个状态写进文件；
/// * **附件逐个读写**，内存峰值只跟最大的一张图有关，不跟图片总数有关；
/// * **校验先于一切**：`read` 解码后立刻 `validate`，恢复流程拿到的一定是已经
///   验过格式、版本、摘要、ID、关系与附件名的数据。
enum BackupManager {

    // MARK: - 快照

    /// 把 SwiftData 对象翻译成可编码的备份结构。必须在主线程/主上下文调用。
    @MainActor
    static func snapshot(beans: [Bean], rules: [PhaseRule]) -> BackupData {
        let beanRows = beans.map { bean in
            BackupBean(
                id: bean.id,
                name: bean.name,
                roaster: bean.roaster,
                origin: bean.origin,
                process: bean.process,
                roastLevelRaw: bean.roastLevelRaw,
                roastDate: bean.roastDate?.timeIntervalSince1970,
                purchaseDate: bean.purchaseDate?.timeIntervalSince1970,
                openDate: bean.openDate?.timeIntervalSince1970,
                weightG: bean.weightG,
                remainingG: bean.remainingG,
                price: bean.price,
                channel: bean.channel,
                imagePath: bean.imagePath,
                flavorTagsRaw: bean.flavorTagsRaw,
                notes: bean.notes,
                statusRaw: bean.statusRaw,
                createdAt: bean.createdAt.timeIntervalSince1970,
                updatedAt: bean.updatedAt.timeIntervalSince1970,
                isSample: bean.isSample
            )
        }

        var brewRows: [BackupBrew] = []
        var tastingRows: [BackupTasting] = []
        var reminderRows: [BackupReminder] = []

        // 冲煮/风味/提醒都从豆子出发收集：模型里它们是级联子对象，不存在脱离
        // 豆子的记录；这样也不会因为漏查一张表而丢数据。
        for bean in beans {
            for brew in (bean.brews ?? []).sorted(by: { $0.date < $1.date }) {
                brewRows.append(BackupBrew(
                    id: brew.id, beanID: bean.id,
                    date: brew.date.timeIntervalSince1970,
                    method: brew.method, grinder: brew.grinder, grindSize: brew.grindSize,
                    waterTemp: brew.waterTemp, coffeeG: brew.coffeeG, waterG: brew.waterG,
                    timeSeconds: brew.timeSeconds, score: brew.score,
                    acidity: brew.acidity, sweetness: brew.sweetness,
                    bitterness: brew.bitterness, body: brew.body, aftertaste: brew.aftertaste,
                    flavorTagsRaw: brew.flavorTagsRaw, notes: brew.notes,
                    createdAt: brew.createdAt.timeIntervalSince1970
                ))
            }
            for tasting in (bean.tastings ?? []).sorted(by: { $0.date < $1.date }) {
                tastingRows.append(BackupTasting(
                    id: tasting.id, beanID: bean.id,
                    date: tasting.date.timeIntervalSince1970,
                    dayAfterRoast: tasting.dayAfterRoast,
                    flavorTagsRaw: tasting.flavorTagsRaw,
                    score: tasting.score, notes: tasting.notes,
                    sourceRaw: tasting.sourceRaw, brewID: tasting.brewID,
                    createdAt: tasting.createdAt.timeIntervalSince1970
                ))
            }
            for reminder in (bean.reminders ?? []).sorted(by: { $0.fireDate < $1.fireDate }) {
                reminderRows.append(BackupReminder(
                    id: reminder.id, beanID: bean.id,
                    kindRaw: reminder.kindRaw,
                    fireDate: reminder.fireDate.timeIntervalSince1970,
                    enabled: reminder.enabled,
                    identifier: reminder.identifier,
                    createdAt: reminder.createdAt.timeIntervalSince1970
                ))
            }
        }

        let ruleRows = rules.map { rule in
            BackupPhaseRule(
                id: rule.id, roastLevelRaw: rule.roastLevelRaw,
                restMinDays: rule.restMinDays, restMaxDays: rule.restMaxDays,
                peakStartDay: rule.peakStartDay, peakEndDay: rule.peakEndDay,
                declineStartDay: rule.declineStartDay,
                enabled: rule.enabled,
                updatedAt: rule.updatedAt.timeIntervalSince1970
            )
        }

        return BackupData(beans: beanRows, brews: brewRows, tastings: tastingRows,
                          reminders: reminderRows, phaseRules: ruleRows)
    }

    // MARK: - 偏好

    /// 收集白名单内的用户偏好。只取实际存在的键：没设过的不写，
    /// 恢复时也就不会把别人的默认值硬塞进来。
    static func preferences(from defaults: UserDefaults = .standard) -> BackupPreferences {
        var values: [String: BackupPreferenceValue] = [:]

        for key in BackupPreferenceKeys.strings {
            if let value = defaults.string(forKey: key) { values[key] = .string(value) }
        }
        for key in BackupPreferenceKeys.numbers {
            if defaults.object(forKey: key) != nil {
                values[key] = .number(defaults.double(forKey: key))
            }
        }
        for key in BackupPreferenceKeys.integers {
            if defaults.object(forKey: key) != nil {
                values[key] = .integer(defaults.integer(forKey: key))
            }
        }
        for key in BackupPreferenceKeys.flags {
            if defaults.object(forKey: key) != nil {
                values[key] = .flag(defaults.bool(forKey: key))
            }
        }
        return BackupPreferences(values: values)
    }

    // MARK: - 写

    /// 生成一个 `.brewphasebackup` 文件并返回它的临时位置。
    ///
    /// 逐块写入：manifest 与 data 先编码，附件按名字排序逐个编码、写盘、释放。
    /// 任何一步失败都会删掉半成品——不留下「看起来成功」的残缺备份。
    static func write(
        _ data: BackupData,
        preferences: BackupPreferences = BackupPreferences(values: [:]),
        appVersion: String,
        imagesDirectory: URL,
        now: Date = Date()
    ) throws -> URL {
        // 空字符串在模型里等同「没有图片」（ImageStore 也是这样判断的），不算附件。
        let names = Set(data.beans.compactMap(\.imagePath)).filter { !$0.isEmpty }.sorted()
        guard names.count <= BackupFormat.maxAttachments else { throw BackupError.tooManyRecords }

        // 第一遍只算摘要与体积，不把图片留在内存里。
        var hashes: [String: String] = [:]
        var totalBytes = 0
        for name in names {
            guard BackupFormat.isSafeAttachmentName(name) else {
                throw BackupError.invalidAttachmentName
            }
            let url = imagesDirectory.appendingPathComponent(name)
            guard let bytes = try? Data(contentsOf: url) else {
                throw BackupError.missingAttachment
            }
            totalBytes += bytes.count
            guard totalBytes <= BackupFormat.maxAttachmentBytes else {
                throw BackupError.attachmentTooLarge
            }
            hashes[name] = sha256(bytes)
        }

        let dataBytes = try canonicalEncoding(data)
        let digestLines = names.compactMap { name in hashes[name].map { "\(name):\($0)" } }
            .sorted()
            .joined(separator: "\n")

        let manifest = BackupManifest(
            format: BackupFormat.identifier,
            schemaVersion: BackupFormat.currentSchemaVersion,
            appVersion: appVersion,
            createdAt: now.timeIntervalSince1970,
            summary: BackupSummary(
                beans: data.beans.count,
                brews: data.brews.count,
                tastings: data.tastings.count,
                reminders: data.reminders.count,
                phaseRules: data.phaseRules.count,
                attachments: names.count,
                attachmentBytes: totalBytes
            ),
            dataDigest: sha256(dataBytes),
            attachmentDigest: sha256(Data(digestLines.utf8))
        )

        let url = try destinationURL(for: now)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: url.path) else {
            throw BackupError.unreadableFile
        }

        do {
            try handle.write(contentsOf: Data(#"{"manifest":"#.utf8))
            try handle.write(contentsOf: try canonicalEncoding(manifest))
            try handle.write(contentsOf: Data(#","data":"#.utf8))
            try handle.write(contentsOf: dataBytes)
            try handle.write(contentsOf: Data(#","preferences":"#.utf8))
            try handle.write(contentsOf: try canonicalEncoding(preferences))
            try handle.write(contentsOf: Data(#","attachments":["#.utf8))

            for (index, name) in names.enumerated() {
                let fileURL = imagesDirectory.appendingPathComponent(name)
                let bytes = try Data(contentsOf: fileURL)
                // 第二遍读到的内容必须和第一遍一致，否则备份会「自证不实」。
                guard sha256(bytes) == hashes[name] else { throw BackupError.checksumMismatch }
                let attachment = BackupAttachment(name: name, sha256: hashes[name] ?? "", data: bytes)
                if index > 0 { try handle.write(contentsOf: Data(",".utf8)) }
                try handle.write(contentsOf: try canonicalEncoding(attachment))
            }

            try handle.write(contentsOf: Data("]}".utf8))
            try handle.close()
            AppLog.export.info("backup written: \(data.beans.count) bean(s), \(names.count) image(s)")
            return url
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    // MARK: - 读

    /// 读取并校验。返回的 `BackupFile` 一定已经通过 `validate`。
    static func read(from url: URL) throws -> BackupFile {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0, size <= BackupFormat.maxFileBytes else {
            throw size > BackupFormat.maxFileBytes ? BackupError.fileTooLarge : BackupError.unreadableFile
        }
        guard let bytes = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            throw BackupError.unreadableFile
        }

        let file: BackupFile
        do {
            file = try JSONDecoder().decode(BackupFile.self, from: bytes)
        } catch {
            throw BackupError.malformed
        }

        try validate(file)
        return file
    }

    // MARK: - 校验

    /// 恢复前必须走完的检查。顺序按「越便宜越先做」：
    /// 版本 → 规模 → 摘要 → ID → 关系 → 附件。
    static func validate(_ file: BackupFile) throws {
        let manifest = file.manifest
        guard manifest.format == BackupFormat.identifier else { throw BackupError.malformed }
        guard manifest.schemaVersion >= 1 else { throw BackupError.malformed }
        guard manifest.schemaVersion <= BackupFormat.currentSchemaVersion else {
            throw BackupError.unsupportedVersion(manifest.schemaVersion)
        }

        let data = file.data
        let counts = BackupSummary(
            beans: data.beans.count, brews: data.brews.count, tastings: data.tastings.count,
            reminders: data.reminders.count, phaseRules: data.phaseRules.count,
            attachments: file.attachments.count,
            attachmentBytes: file.attachments.reduce(0) { $0 + $1.data.count }
        )
        guard counts == manifest.summary else { throw BackupError.missingData }

        for count in [counts.beans, counts.brews, counts.tastings, counts.reminders, counts.phaseRules] {
            guard count <= BackupFormat.maxRecordsPerEntity else { throw BackupError.tooManyRecords }
        }
        guard counts.attachments <= BackupFormat.maxAttachments,
              counts.attachmentBytes <= BackupFormat.maxAttachmentBytes else {
            throw BackupError.attachmentTooLarge
        }

        // 摘要：数据部分与附件部分都要对得上，任何一处被改过都拒绝。
        guard sha256(try canonicalEncoding(data)) == manifest.dataDigest else {
            throw BackupError.checksumMismatch
        }

        var names = Set<String>()
        var lines: [String] = []
        for attachment in file.attachments {
            guard BackupFormat.isSafeAttachmentName(attachment.name),
                  names.insert(attachment.name).inserted else {
                throw BackupError.invalidAttachmentName
            }
            guard !attachment.data.isEmpty,
                  sha256(attachment.data) == attachment.sha256 else {
                throw BackupError.checksumMismatch
            }
            lines.append("\(attachment.name):\(attachment.sha256)")
        }
        guard sha256(Data(lines.sorted().joined(separator: "\n").utf8)) == manifest.attachmentDigest else {
            throw BackupError.checksumMismatch
        }

        // ID 唯一性：跨实体不要求唯一（不同类型各自一张表），实体内部必须唯一。
        func ensureUnique(_ ids: [UUID]) throws {
            guard Set(ids).count == ids.count else { throw BackupError.duplicateIdentifier }
        }
        try ensureUnique(data.beans.map(\.id))
        try ensureUnique(data.brews.map(\.id))
        try ensureUnique(data.tastings.map(\.id))
        try ensureUnique(data.reminders.map(\.id))
        try ensureUnique(data.phaseRules.map(\.id))

        // 关系：子记录必须挂在存在的豆子上；风味若来自冲煮，那条冲煮也要在，
        // 而且必须属于同一包豆子——跨包的引用只可能是坏数据。
        let beanIDs = Set(data.beans.map(\.id))
        let brewIDs = Set(data.brews.map(\.id))
        let brewOwner = Dictionary(uniqueKeysWithValues: data.brews.map { ($0.id, $0.beanID) })
        guard data.brews.allSatisfy({ beanIDs.contains($0.beanID) }),
              data.tastings.allSatisfy({ beanIDs.contains($0.beanID) }),
              data.reminders.allSatisfy({ beanIDs.contains($0.beanID) }) else {
            throw BackupError.brokenReference
        }
        guard data.tastings.allSatisfy({ tasting in
            guard let brewID = tasting.brewID else { return true }
            return brewIDs.contains(brewID) && brewOwner[brewID] == tasting.beanID
        }) else {
            throw BackupError.brokenReference
        }

        // 枚举与数值：宁可拒绝，也不把未知值静默落成默认值。
        guard data.beans.allSatisfy({ bean in
            RoastLevel(rawValue: bean.roastLevelRaw) != nil
                && BeanStatus(rawValue: bean.statusRaw) != nil
                && [bean.weightG, bean.remainingG, bean.price].allSatisfy(\.isFinite)
                && bean.weightG >= 0 && bean.remainingG >= 0 && bean.price >= 0
                && [bean.roastDate, bean.purchaseDate, bean.openDate].allSatisfy {
                    $0.map { $0.isFinite } ?? true
                }
        }) else { throw BackupError.missingData }

        guard data.tastings.allSatisfy({ TastingSource(rawValue: $0.sourceRaw) != nil }),
              data.reminders.allSatisfy({ ReminderKind(rawValue: $0.kindRaw) != nil }),
              data.phaseRules.allSatisfy({ RoastLevel(rawValue: $0.roastLevelRaw) != nil }) else {
            throw BackupError.missingData
        }

        // 图片引用必须能在附件里找到——缺图的备份不是完整备份。
        let imageNames = Set(data.beans.compactMap(\.imagePath))
        guard imageNames.allSatisfy({ $0.isEmpty || names.contains($0) }) else {
            throw BackupError.missingAttachment
        }

        // 偏好只允许白名单键；数值必须是有限数。未知键按坏数据处理，
        // 而不是「悄悄跳过」——真出现未知键，说明这份文件不属于当前版本。
        if let preferences = file.preferences {
            let allowed = Set(BackupPreferenceKeys.all)
            for (key, value) in preferences.values {
                guard allowed.contains(key) else { throw BackupError.missingData }
                if case .number(let number) = value, !number.isFinite {
                    throw BackupError.missingData
                }
            }
        }
    }

    // MARK: - 摘要与编码

    /// 固定键序、不转义斜杠，保证同一份数据永远编出同一串字节。
    static func canonicalEncoding<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func destinationURL(for date: Date) throws -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmm"
        let name = "brewphase-backup-\(formatter.string(from: date)).\(BackupFormat.fileExtension)"
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("BrewPhaseBackup", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(name)
    }
}
