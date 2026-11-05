import Foundation
import SwiftData

/// 用备份替换当前数据。
///
/// 只实现「替换」一种模式：合并需要逐字段冲突策略，而当前模型没有版本号/时间戳
/// 之外的仲裁依据，做一个「看起来能合并」的版本只会制造重复记录。与其埋这个雷，
/// 不如明确只支持完整替换。
///
/// 安全次序（失败时旧数据必须原样可读）：
/// 1. 再次校验（`read` 已校验过，这里防的是调用方绕过）；
/// 2. 图片先落盘到临时目录，校验后**新增**文件搬进图片目录（同名同内容跳过，
///    同名不同内容直接拒绝）——不覆盖任何现有文件的内容；
/// 3. 在**新的** `ModelContext` 里删除旧记录、写入新记录，最后只 `save()` 一次；
/// 4. `save()` 失败 → `rollback()` + 删除本次新增的图片文件，旧数据保持不变；
/// 5. 成功后才清理不再被引用的旧图片。
///
/// 第 2 步与第 4 步之间不是跨存储的事务（文件系统 + SQLite 各自提交），这一点
/// 无法在 SwiftData 里伪装成原子操作；这里用「先写新文件、数据库单次提交、
/// 失败回删新文件」把窗口压到最小，并保证旧数据在任何失败路径下都不被删除。
enum BackupRestorer {

    struct Outcome: Equatable {
        var beans: Int
        var brews: Int
        var tastings: Int
        var reminders: Int
        var phaseRules: Int
        /// v2 备份没有记录段，恢复出来就是 0。
        var records: Int
        var canvases: Int
        var imagesRestored: Int
    }

    static func restore(
        _ file: BackupFile,
        into container: ModelContainer,
        imagesDirectory: URL,
        defaults: UserDefaults = .standard,
        save: (ModelContext) throws -> Void = { try $0.save() }
    ) throws -> Outcome {
        try BackupManager.validate(file)

        let fileManager = FileManager.default
        let staging = fileManager.temporaryDirectory
            .appendingPathComponent("BrewPhaseRestore-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: staging) }

        // 1) 附件先落到暂存区；一个字节都不碰现有图片。
        for attachment in file.attachments {
            try attachment.data.write(to: staging.appendingPathComponent(attachment.name),
                                      options: .atomic)
        }

        // 2) 搬进图片目录。同名文件只在内容完全一致时跳过；内容不一致就停止。
        var created: [String] = []
        do {
            for attachment in file.attachments {
                let target = imagesDirectory.appendingPathComponent(attachment.name)
                if fileManager.fileExists(atPath: target.path) {
                    let existing = try Data(contentsOf: target)
                    guard BackupManager.sha256(existing) == attachment.sha256 else {
                        throw BackupError.imageConflict
                    }
                    continue
                }
                try fileManager.moveItem(at: staging.appendingPathComponent(attachment.name),
                                         to: target)
                created.append(attachment.name)
                try? ImageStore.thumbnailData(forDisplayImageAt: target)?
                    .write(to: imagesDirectory.appendingPathComponent(
                        ImageStore.fileName(for: attachment.name, thumbnail: true)), options: .atomic)
            }

            let outcome = try replaceDatabase(file, in: container, save: save)

            // 偏好放在数据提交之后：数据是主，设置是辅；设置写失败也不该
            // 让一次已经成功的恢复变成「失败」。
            applyPreferences(file.preferences, to: defaults)

            // 3) 成功之后才清孤儿：此刻旧记录已经不在了，旧图片才真的没用了。
            //    记录的两类图片（预览图、图片记录的正文图）也在同一个目录里，
            //    引用集合必须一起算进来，否则恢复会把它们当垃圾删掉。
            let recordImages = (file.data.records ?? []).flatMap { record -> [String?] in
                [record.previewPath, (record.mediaPath?.hasSuffix(".jpg") ?? false) ? record.mediaPath : nil]
            }
            let referenced = Set(file.data.beans.compactMap(\.imagePath) + recordImages.compactMap { $0 })
            removeOrphans(in: imagesDirectory, keeping: referenced)
            ImageStore.shared.clearCache()

            AppLog.export.info(
                "restore finished: \(outcome.beans) bean(s), \(outcome.brews) brew(s), \(created.count) new image(s)"
            )
            return Outcome(
                beans: outcome.beans, brews: outcome.brews, tastings: outcome.tastings,
                reminders: outcome.reminders, phaseRules: outcome.phaseRules,
                records: outcome.records, canvases: outcome.canvases,
                imagesRestored: created.count
            )
        } catch {
            // 失败：撤掉本次搬进来的新文件（已存在的同名文件从未被覆盖）。
            for name in created {
                try? fileManager.removeItem(at: imagesDirectory.appendingPathComponent(name))
                try? fileManager.removeItem(at: imagesDirectory.appendingPathComponent(
                    ImageStore.fileName(for: name, thumbnail: true)))
            }
            if error is BackupError { throw error }
            AppLog.export.error("restore failed: \(String(describing: error), privacy: .public)")
            throw BackupError.restoreFailed
        }
    }

    // MARK: - 数据库

    @discardableResult
    private static func replaceDatabase(
        _ file: BackupFile,
        in container: ModelContainer,
        save: (ModelContext) throws -> Void
    ) throws -> Outcome {
        let context = ModelContext(container)
        context.autosaveEnabled = false

        do {
            for bean in try context.fetch(FetchDescriptor<Bean>()) { context.delete(bean) }
            for brew in try context.fetch(FetchDescriptor<Brew>()) { context.delete(brew) }
            for tasting in try context.fetch(FetchDescriptor<Tasting>()) { context.delete(tasting) }
            for reminder in try context.fetch(FetchDescriptor<PhaseReminder>()) { context.delete(reminder) }
            for rule in try context.fetch(FetchDescriptor<PhaseRule>()) { context.delete(rule) }

            var beans: [UUID: Bean] = [:]
            for row in file.data.beans {
                let bean = Bean()
                bean.id = row.id
                bean.name = row.name
                bean.roaster = row.roaster
                bean.origin = row.origin
                bean.process = row.process
                bean.roastLevelRaw = row.roastLevelRaw
                bean.roastDate = row.roastDate.map(Date.init(timeIntervalSince1970:))
                bean.purchaseDate = row.purchaseDate.map(Date.init(timeIntervalSince1970:))
                bean.openDate = row.openDate.map(Date.init(timeIntervalSince1970:))
                bean.weightG = row.weightG
                bean.remainingG = row.remainingG
                bean.price = row.price
                bean.channel = row.channel
                bean.imagePath = row.imagePath
                bean.flavorTagsRaw = row.flavorTagsRaw
                bean.notes = row.notes
                bean.statusRaw = row.statusRaw
                bean.createdAt = Date(timeIntervalSince1970: row.createdAt)
                bean.updatedAt = Date(timeIntervalSince1970: row.updatedAt)
                bean.isSample = row.isSample
                bean.stockCountedAt = row.stockCountedAt.map(Date.init(timeIntervalSince1970:))
                context.insert(bean)
                beans[row.id] = bean
            }

            for row in file.data.brews {
                let brew = Brew()
                brew.id = row.id
                brew.date = Date(timeIntervalSince1970: row.date)
                brew.method = row.method
                brew.grinder = row.grinder
                brew.grindSize = row.grindSize
                brew.waterTemp = row.waterTemp
                brew.coffeeG = row.coffeeG
                brew.waterG = row.waterG
                brew.timeSeconds = row.timeSeconds
                brew.score = row.score
                brew.acidity = row.acidity
                brew.sweetness = row.sweetness
                brew.bitterness = row.bitterness
                brew.body = row.body
                brew.aftertaste = row.aftertaste
                brew.flavorTagsRaw = row.flavorTagsRaw
                brew.notes = row.notes
                brew.createdAt = Date(timeIntervalSince1970: row.createdAt)
                brew.stockDeductedG = row.stockDeductedG
                brew.bean = beans[row.beanID]
                context.insert(brew)
            }

            for row in file.data.tastings {
                let tasting = Tasting()
                tasting.id = row.id
                tasting.date = Date(timeIntervalSince1970: row.date)
                tasting.dayAfterRoast = row.dayAfterRoast
                tasting.flavorTagsRaw = row.flavorTagsRaw
                tasting.score = row.score
                tasting.notes = row.notes
                tasting.sourceRaw = row.sourceRaw
                tasting.brewID = row.brewID
                tasting.createdAt = Date(timeIntervalSince1970: row.createdAt)
                tasting.bean = beans[row.beanID]
                context.insert(tasting)
            }

            for row in file.data.reminders {
                let reminder = PhaseReminder(kind: .windowOpens,
                                             fireDate: Date(timeIntervalSince1970: row.fireDate),
                                             identifier: row.identifier)
                reminder.id = row.id
                reminder.kindRaw = row.kindRaw
                reminder.enabled = row.enabled
                reminder.createdAt = Date(timeIntervalSince1970: row.createdAt)
                reminder.bean = beans[row.beanID]
                context.insert(reminder)
            }

            for row in file.data.phaseRules {
                let rule = PhaseRule(data: PhaseRuleData(
                    roastLevel: RoastLevel(rawValue: row.roastLevelRaw) ?? .medium,
                    restMinDays: row.restMinDays, restMaxDays: row.restMaxDays,
                    peakStartDay: row.peakStartDay, peakEndDay: row.peakEndDay,
                    declineStartDay: row.declineStartDay, enabled: row.enabled
                ))
                rule.id = row.id
                rule.updatedAt = Date(timeIntervalSince1970: row.updatedAt)
                context.insert(rule)
            }

            // 记录与画布：只有文件里**确实有这一段**才替换。
            // v2 备份没有这两段（nil），它说的是「这份备份不知道有记录」，
            // 不是「记录为空」——把设备上的记录当成空的删掉是不可接受的。
            // 记录与标签一起替换：先清记录、再清标签，顺序反过来会先断开关系，
            // 虽然是空操作，但没有必要。
            if let records = file.data.records {
                for row in try context.fetch(FetchDescriptor<Record>()) { context.delete(row) }
                for row in try context.fetch(FetchDescriptor<RecordTag>()) { context.delete(row) }

                var tagsByID: [UUID: RecordTag] = [:]
                for row in file.data.tags ?? [] {
                    let tag = RecordTag(name: row.name,
                                        createdAt: Date(timeIntervalSince1970: row.createdAt))
                    tag.id = row.id
                    context.insert(tag)
                    tagsByID[row.id] = tag
                }

                for row in records {
                    let record = Record(
                        carrier: RecordCarrier(rawValue: row.carrierRaw) ?? .text,
                        title: row.title,
                        note: row.note,
                        urlString: row.urlString,
                        sourceName: row.sourceName,
                        previewPath: row.previewPath,
                        mediaPath: row.mediaPath,
                        createdAt: Date(timeIntervalSince1970: row.createdAt),
                        isSample: row.isSample
                    )
                    record.id = row.id
                    record.updatedAt = Date(timeIntervalSince1970: row.updatedAt)
                    record.canonicalURL = row.canonicalURL ?? ""
                    record.providerRaw = row.providerRaw ?? ""
                    record.contentKindRaw = row.contentKindRaw ?? ""
                    record.platformContentID = row.platformContentID ?? ""
                    record.linkPage = row.linkPage ?? 1
                    record.authorName = row.authorName ?? ""
                    record.summary = row.summary ?? ""
                    record.thumbnailURLString = row.thumbnailURLString ?? ""
                    record.metadataStatusRaw = row.metadataStatusRaw
                        ?? LinkMetadataStatus.idle.rawValue
                    record.repositoryStars = row.repositoryStars ?? 0
                    record.repositoryForks = row.repositoryForks ?? 0
                    record.repositoryIssues = row.repositoryIssues ?? 0
                    record.repositoryLanguage = row.repositoryLanguage ?? ""
                    record.repositoryLicense = row.repositoryLicense ?? ""
                    // 找不到的标签（比如旧文件里被手工删掉了）直接跳过，
                    // 一条记录不应该因为一个坏标签整条不见。
                    record.tags = row.tagIDs.compactMap { tagsByID[$0] }
                    context.insert(record)
                }
            }

            if let canvases = file.data.canvases {
                for row in try context.fetch(FetchDescriptor<Canvas>()) { context.delete(row) }
                for row in canvases {
                    let canvas = Canvas(
                        name: row.name,
                        note: row.note,
                        createdAt: Date(timeIntervalSince1970: row.createdAt),
                        isSample: row.isSample
                    )
                    canvas.id = row.id
                    canvas.updatedAt = Date(timeIntervalSince1970: row.updatedAt)
                    context.insert(canvas)
                }
            }

            // 一次提交：删除与写入在同一个事务里，要么全成，要么全不成。
            try save(context)

            return Outcome(
                beans: file.data.beans.count, brews: file.data.brews.count,
                tastings: file.data.tastings.count, reminders: file.data.reminders.count,
                phaseRules: file.data.phaseRules.count,
                records: file.data.records?.count ?? 0,
                canvases: file.data.canvases?.count ?? 0,
                imagesRestored: 0
            )
        } catch {
            context.rollback()
            throw error
        }
    }

    // MARK: - 偏好

    /// 只写白名单键，值按各自类型写回；备份时没有设置过的键要移除，
    /// 这样「恢复成备份时的状态」在另一台设备上也成立。
    /// `@AppStorage` 会据此即时刷新界面。
    private static func applyPreferences(_ preferences: BackupPreferences?, to defaults: UserDefaults) {
        guard let preferences else { return }
        for key in preferences.unset {
            defaults.removeObject(forKey: key)
        }
        for (key, value) in preferences.values {
            switch value {
            case .string(let string): defaults.set(string, forKey: key)
            case .number(let number): defaults.set(number, forKey: key)
            case .integer(let integer): defaults.set(integer, forKey: key)
            case .flag(let flag): defaults.set(flag, forKey: key)
            }
        }
    }

    // MARK: - 孤儿清理

    /// 只动图片目录里的 `.jpg`；恢复后仍被引用的文件（含缩略图）一律保留。
    private static func removeOrphans(in directory: URL, keeping referenced: Set<String>) {
        let keep = Set(referenced.flatMap { name in
            [ImageStore.fileName(for: name, thumbnail: false),
             ImageStore.fileName(for: name, thumbnail: true)]
        })
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        ) else { return }
        for url in contents where url.pathExtension.lowercased() == "jpg"
            && !keep.contains(url.lastPathComponent) {
            try? FileManager.default.removeItem(at: url)
        }
    }
}
