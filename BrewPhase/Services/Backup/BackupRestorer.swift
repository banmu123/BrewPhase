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
        var imagesRestored: Int
    }

    static func restore(
        _ file: BackupFile,
        into container: ModelContainer,
        imagesDirectory: URL,
        defaults: UserDefaults = .standard
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

            let outcome = try replaceDatabase(file, in: container)

            // 偏好放在数据提交之后：数据是主，设置是辅；设置写失败也不该
            // 让一次已经成功的恢复变成「失败」。
            applyPreferences(file.preferences, to: defaults)

            // 3) 成功之后才清孤儿：此刻旧记录已经不在了，旧图片才真的没用了。
            removeOrphans(in: imagesDirectory, keeping: Set(file.data.beans.compactMap(\.imagePath)))
            ImageStore.shared.clearCache()

            AppLog.export.info(
                "restore finished: \(outcome.beans) bean(s), \(outcome.brews) brew(s), \(created.count) new image(s)"
            )
            return Outcome(
                beans: outcome.beans, brews: outcome.brews, tastings: outcome.tastings,
                reminders: outcome.reminders, phaseRules: outcome.phaseRules,
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
        in container: ModelContainer
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

            // 一次提交：删除与写入在同一个事务里，要么全成，要么全不成。
            try context.save()

            return Outcome(
                beans: file.data.beans.count, brews: file.data.brews.count,
                tastings: file.data.tastings.count, reminders: file.data.reminders.count,
                phaseRules: file.data.phaseRules.count, imagesRestored: 0
            )
        } catch {
            context.rollback()
            throw error
        }
    }

    // MARK: - 偏好

    /// 只写白名单键，值按各自类型写回；`@AppStorage` 会据此即时刷新界面。
    private static func applyPreferences(_ preferences: BackupPreferences?, to defaults: UserDefaults) {
        guard let preferences else { return }
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
