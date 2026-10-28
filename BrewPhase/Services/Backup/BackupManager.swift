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

    /// 收集白名单内的用户偏好。**每个白名单键都要有交代**：设过就是值，
    /// 没设过进 `unset`，恢复时据此移除目标设备上的同名键——否则「备份里没有」
    /// 会退化成「目标设备原有的值恰好留着」，同一个备份在另一台设备上恢复出
    /// 不同状态。
    static func preferences(from defaults: UserDefaults = .standard) -> BackupPreferences {
        var values: [String: BackupPreferenceValue] = [:]
        var unset: [String] = []

        func note(_ key: String, _ value: BackupPreferenceValue?) {
            if let value { values[key] = value } else { unset.append(key) }
        }

        for key in BackupPreferenceKeys.strings {
            note(key, defaults.string(forKey: key).map(BackupPreferenceValue.string))
        }
        for key in BackupPreferenceKeys.numbers {
            note(key, defaults.object(forKey: key) != nil
                 ? .number(defaults.double(forKey: key)) : nil)
        }
        for key in BackupPreferenceKeys.integers {
            note(key, defaults.object(forKey: key) != nil
                 ? .integer(defaults.integer(forKey: key)) : nil)
        }
        for key in BackupPreferenceKeys.flags {
            note(key, defaults.object(forKey: key) != nil
                 ? .flag(defaults.bool(forKey: key)) : nil)
        }
        return BackupPreferences(values: values, unset: unset)
    }

    // MARK: - 写

    /// 生成一个 `.brewphasebackup` 文件并返回它的临时位置。
    ///
    /// 逐块写入：manifest 与 data 先编码，附件按名字排序逐个编码、写盘、释放。
    /// 任何一步失败都会删掉半成品——不留下「看起来成功」的残缺备份。
    static func write(
        _ data: BackupData,
        preferences: BackupPreferences = .empty,
        appVersion: String,
        imagesDirectory: URL,
        now: Date = Date(),
        limits: BackupSizeLimits = .standard
    ) throws -> URL {
        // 空字符串在模型里等同「没有图片」（ImageStore 也是这样判断的），不算附件。
        let names = Set(data.beans.compactMap(\.imagePath)).filter { !$0.isEmpty }.sorted()
        guard names.count <= BackupFormat.maxAttachments else { throw BackupError.tooManyRecords }

        // 第一遍只算摘要与体积，不把图片留在内存里。
        var hashes: [String: String] = [:]
        var totalBytes = 0
        var largestBytes = 0
        for name in names {
            guard BackupFormat.isSafeAttachmentName(name) else {
                throw BackupError.invalidAttachmentName
            }
            let url = imagesDirectory.appendingPathComponent(name)
            guard let bytes = try? Data(contentsOf: url) else {
                throw BackupError.missingAttachment
            }
            totalBytes += bytes.count
            largestBytes = max(largestBytes, bytes.count)
            hashes[name] = sha256(bytes)
        }

        let dataBytes = try canonicalEncoding(data)
        // 预检：保证写出来的文件一定能被同一个读取端读回（Base64 会放大体积）。
        try BackupSizePolicy.validate(attachmentBytes: totalBytes,
                                      largestAttachmentBytes: largestBytes,
                                      dataBytes: dataBytes.count,
                                      limits: limits)

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
            dataDigest: try contentDigest(data: data, preferences: preferences),
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

            // 估计值只是挡在前面的一道闸；真实大小以磁盘为准。
            let written = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            try BackupSizePolicy.validateFinalFileSize(written, limits: limits)

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
    static func read(from url: URL, limits: BackupSizeLimits = .standard) throws -> BackupFile {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { throw BackupError.unreadableFile }
        guard size <= limits.maxFileBytes else { throw BackupError.fileTooLarge }
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
    /// 版本 → 规模 → 摘要 → 偏好 → ID → 关系 → 逐实体取值 → 附件。
    static func validate(_ file: BackupFile) throws {
        let manifest = file.manifest
        guard manifest.format == BackupFormat.identifier else { throw BackupError.malformed }
        guard manifest.schemaVersion >= 1 else { throw BackupError.malformed }
        guard manifest.schemaVersion >= BackupFormat.currentSchemaVersion else {
            // v1 的摘要不覆盖偏好，不能被当作完整的完整性校验。
            throw BackupError.legacyVersion(manifest.schemaVersion)
        }
        guard manifest.schemaVersion <= BackupFormat.currentSchemaVersion else {
            throw BackupError.unsupportedVersion(manifest.schemaVersion)
        }

        let data = file.data
        let preferences = file.preferences ?? .empty
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
        guard counts.attachments <= BackupFormat.maxAttachments else {
            throw BackupError.attachmentTooLarge
        }
        let largest = file.attachments.map(\.data.count).max() ?? 0

        // 摘要覆盖 data + preferences：改一个默认粉量也逃不过完整性检查。
        guard try contentDigest(data: data, preferences: preferences) == manifest.dataDigest else {
            throw BackupError.checksumMismatch
        }
        // 规模放在摘要之后也行，但体积问题给出更具体的错误更有用。
        try BackupSizePolicy.validate(attachmentBytes: counts.attachmentBytes,
                                      largestAttachmentBytes: largest,
                                      dataBytes: try canonicalEncoding(data).count)

        // 偏好：白名单、类型、范围、以及「每个键都要有交代」。
        let allowed = Set(BackupPreferenceKeys.all)
        let valueKeys = Set(preferences.values.keys)
        let unsetKeys = Set(preferences.unset)
        for key in valueKeys.union(unsetKeys) where !allowed.contains(key) {
            throw BackupError.invalidValue("preferences.\(key)")
        }
        guard valueKeys.isDisjoint(with: unsetKeys) else {
            throw BackupError.invalidValue("preferences.keys")
        }
        guard valueKeys.union(unsetKeys) == allowed else {
            throw BackupError.missingData
        }
        for (key, value) in preferences.values {
            try BackupPreferenceSchema.validate(value, for: key)
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

        try validateBeans(data.beans)
        try validateBrews(data.brews)
        try validateTastings(data.tastings)
        try validateReminders(data.reminders)
        try validateRules(data.phaseRules)

        // 图片引用必须能在附件里找到——缺图的备份不是完整备份。
        let imageNames = Set(data.beans.compactMap(\.imagePath))
        guard imageNames.allSatisfy({ $0.isEmpty || names.contains($0) }) else {
            throw BackupError.missingAttachment
        }
    }

    // MARK: - 逐实体取值

    /// 所有用于计算、排序、排程或展示的数值都按真实模型约束校验。
    /// 失败时抛出具体字段名，测试与日志能直接指出是哪一项。
    private static func validateBeans(_ beans: [BackupBean]) throws {
        for bean in beans {
            guard RoastLevel(rawValue: bean.roastLevelRaw) != nil else {
                throw BackupError.invalidValue("bean.roastLevelRaw")
            }
            guard BeanStatus(rawValue: bean.statusRaw) != nil else {
                throw BackupError.invalidValue("bean.statusRaw")
            }
            guard bean.weightG.isFinite, (0...100_000).contains(bean.weightG) else {
                throw BackupError.invalidValue("bean.weightG")
            }
            guard bean.remainingG.isFinite, (0...100_000).contains(bean.remainingG) else {
                throw BackupError.invalidValue("bean.remainingG")
            }
            guard bean.price.isFinite, (0...10_000_000).contains(bean.price) else {
                throw BackupError.invalidValue("bean.price")
            }
            for (label, date) in [("bean.roastDate", bean.roastDate),
                                  ("bean.purchaseDate", bean.purchaseDate),
                                  ("bean.openDate", bean.openDate)] {
                if let date, !date.isFinite { throw BackupError.invalidValue(label) }
            }
            guard bean.createdAt.isFinite, bean.updatedAt.isFinite else {
                throw BackupError.invalidValue("bean.timestamps")
            }
        }
    }

    private static func validateBrews(_ brews: [BackupBrew]) throws {
        for brew in brews {
            guard brew.date.isFinite, brew.createdAt.isFinite else {
                throw BackupError.invalidValue("brew.timestamps")
            }
            guard brew.waterTemp.isFinite, (0...100).contains(brew.waterTemp) else {
                throw BackupError.invalidValue("brew.waterTemp")
            }
            guard brew.coffeeG.isFinite, (0...500).contains(brew.coffeeG) else {
                throw BackupError.invalidValue("brew.coffeeG")
            }
            guard brew.waterG.isFinite, (0...5_000).contains(brew.waterG) else {
                throw BackupError.invalidValue("brew.waterG")
            }
            guard (0...7_200).contains(brew.timeSeconds) else {
                throw BackupError.invalidValue("brew.timeSeconds")
            }
            // StarRatingInput 只能取 0…5；越界值会让界面画出第六颗星或负数。
            for (label, score) in [("brew.score", brew.score),
                                   ("brew.acidity", brew.acidity),
                                   ("brew.sweetness", brew.sweetness),
                                   ("brew.bitterness", brew.bitterness),
                                   ("brew.body", brew.body),
                                   ("brew.aftertaste", brew.aftertaste)] {
                guard (0...5).contains(score) else { throw BackupError.invalidValue(label) }
            }
        }
    }

    private static func validateTastings(_ tastings: [BackupTasting]) throws {
        for tasting in tastings {
            guard TastingSource(rawValue: tasting.sourceRaw) != nil else {
                throw BackupError.invalidValue("tasting.sourceRaw")
            }
            guard tasting.date.isFinite, tasting.createdAt.isFinite else {
                throw BackupError.invalidValue("tasting.timestamps")
            }
            guard (0...36_500).contains(tasting.dayAfterRoast) else {
                throw BackupError.invalidValue("tasting.dayAfterRoast")
            }
            guard (0...5).contains(tasting.score) else {
                throw BackupError.invalidValue("tasting.score")
            }
        }
    }

    private static func validateReminders(_ reminders: [BackupReminder]) throws {
        for reminder in reminders {
            guard ReminderKind(rawValue: reminder.kindRaw) != nil else {
                throw BackupError.invalidValue("reminder.kindRaw")
            }
            guard reminder.fireDate.isFinite, reminder.createdAt.isFinite else {
                throw BackupError.invalidValue("reminder.timestamps")
            }
            // 标识由豆子 ID + 类型确定；对不上说明这条提醒会被挂到别的豆子名下。
            guard reminder.identifier == NotificationPlanner.identifier(
                beanID: reminder.beanID,
                kind: ReminderKind(rawValue: reminder.kindRaw) ?? .windowOpens
            ) else {
                throw BackupError.invalidValue("reminder.identifier")
            }
        }
    }

    private static func validateRules(_ rules: [BackupPhaseRule]) throws {
        for rule in rules {
            guard RoastLevel(rawValue: rule.roastLevelRaw) != nil else {
                throw BackupError.invalidValue("rule.roastLevelRaw")
            }
            guard rule.updatedAt.isFinite else {
                throw BackupError.invalidValue("rule.updatedAt")
            }
            for (label, days) in [("rule.restMinDays", rule.restMinDays),
                                  ("rule.restMaxDays", rule.restMaxDays),
                                  ("rule.peakStartDay", rule.peakStartDay),
                                  ("rule.peakEndDay", rule.peakEndDay),
                                  ("rule.declineStartDay", rule.declineStartDay)] {
                guard (0...3_650).contains(days) else { throw BackupError.invalidValue(label) }
            }
            // 与 PhaseRuleData 的语义一致：窗口必须存在，排气结束不早于开始，
            // 衰退不早于峰值开始。
            guard rule.restMinDays <= rule.restMaxDays else {
                throw BackupError.invalidValue("rule.restMaxDays")
            }
            guard rule.peakStartDay >= 1 else { throw BackupError.invalidValue("rule.peakStartDay") }
            guard rule.peakEndDay > rule.peakStartDay else {
                throw BackupError.invalidValue("rule.peakEndDay")
            }
            guard rule.declineStartDay >= rule.peakStartDay else {
                throw BackupError.invalidValue("rule.declineStartDay")
            }
        }
    }

    // MARK: - 摘要覆盖

    /// 摘要覆盖的全部可恢复内容：五类记录 + 偏好。
    /// 附件不在其中——它们各自有摘要，整体另有 `attachmentDigest`。
    private struct DigestCoverage: Codable {
        var data: BackupData
        var preferences: BackupPreferences
    }

    static func contentDigest(data: BackupData, preferences: BackupPreferences) throws -> String {
        sha256(try canonicalEncoding(DigestCoverage(data: data, preferences: preferences)))
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
        // 精确到秒 + 随机后缀：同一秒内连续生成两份也不会互相覆盖。
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        let suffix = UUID().uuidString.prefix(6).lowercased()
        let name = "brewphase-backup-\(formatter.string(from: date))-\(suffix).\(BackupFormat.fileExtension)"
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("BrewPhaseBackup", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(name)
    }
}
