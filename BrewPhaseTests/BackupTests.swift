import SwiftData
import UIKit
import XCTest
@testable import BrewPhase

/// 完整备份与恢复的验收。
///
/// 全部使用内存 ModelContainer + 临时图片目录，不碰开发者的真实数据库；
/// 恢复写入的目标容器也是独立的，因此「异常备份不改动现有数据」可以直接断言。
@MainActor
final class BackupTests: XCTestCase {

    private var source: ModelContainer!
    private var sourceContext: ModelContext!
    private var target: ModelContainer!
    private var sourceImages: URL!
    private var targetImages: URL!
    private var work: URL!

    override func setUpWithError() throws {
        let schema = Schema([Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self])
        source = try ModelContainer(for: schema,
                                    configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)])
        target = try ModelContainer(for: schema,
                                    configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)])
        sourceContext = ModelContext(source)

        work = FileManager.default.temporaryDirectory
            .appendingPathComponent("BackupTests-\(UUID().uuidString)", isDirectory: true)
        sourceImages = work.appendingPathComponent("source-images", isDirectory: true)
        targetImages = work.appendingPathComponent("target-images", isDirectory: true)
        try FileManager.default.createDirectory(at: sourceImages, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: targetImages, withIntermediateDirectories: true)
    }

    override func tearDown() {
        source = nil
        target = nil
        sourceContext = nil
        try? FileManager.default.removeItem(at: work)
    }

    // MARK: - 构造数据

    private func rules() throws -> [PhaseRule] {
        let light = PhaseRule(data: PhaseRuleData(
            roastLevel: .light, restMinDays: 2, restMaxDays: 6,
            peakStartDay: 6, peakEndDay: 20, declineStartDay: 20, enabled: true
        ))
        let dark = PhaseRule(data: PhaseRuleData(
            roastLevel: .dark, restMinDays: 1, restMaxDays: 3,
            peakStartDay: 3, peakEndDay: 12, declineStartDay: 14, enabled: false
        ))
        sourceContext.insert(light)
        sourceContext.insert(dark)
        return [light, dark]
    }

    /// 一包带图片、两条冲煮、两条风味、一条提醒的豆子。
    @discardableResult
    private func seedBean(imageName: String? = nil) throws -> Bean {
        let bean = Bean(
            name: "Guji 日晒", roaster: "启程", origin: "埃塞俄比亚 · Guji", process: "日晒",
            roastLevel: .light,
            roastDate: Date(timeIntervalSince1970: 1_700_000_000.125),
            purchaseDate: Date(timeIntervalSince1970: 1_700_100_000.5),
            openDate: Date(timeIntervalSince1970: 1_700_200_000.75),
            weightG: 200, remainingG: 86.5, price: 138, channel: "门店",
            imagePath: imageName,
            flavorTags: ["茉莉", "柑橘", "蜂蜜"],
            notes: "第一个手冲记录\n第二行"
        )
        bean.isSample = false
        bean.createdAt = Date(timeIntervalSince1970: 1_700_050_000.25)
        bean.updatedAt = Date(timeIntervalSince1970: 1_700_250_000.875)
        sourceContext.insert(bean)

        let first = Brew(date: Date(timeIntervalSince1970: 1_700_300_000.1), method: "V60",
                         grinder: "C40", grindSize: "22 格", waterTemp: 92.5,
                         coffeeG: 18, waterG: 300, timeSeconds: 155, score: 5,
                         acidity: 4, sweetness: 5, bitterness: 2, body: 4, aftertaste: 4,
                         flavorTags: ["蜂蜜", "柑橘"], notes: "很平衡", bean: bean)
        first.createdAt = Date(timeIntervalSince1970: 1_700_300_001)
        let second = Brew(date: Date(timeIntervalSince1970: 1_700_400_000.9), method: "爱乐压",
                          grinder: "C40", grindSize: "18 格", waterTemp: 88,
                          coffeeG: 15, waterG: 220, timeSeconds: 120, score: 3,
                          flavorTags: [], notes: "", bean: bean)
        sourceContext.insert(first)
        sourceContext.insert(second)

        sourceContext.insert(Tasting(date: first.date, dayAfterRoast: 12, flavorTags: ["蜂蜜"],
                                     score: 5, notes: "甜感突出", source: .brew,
                                     brewID: first.id, bean: bean))
        sourceContext.insert(Tasting(date: Date(timeIntervalSince1970: 1_700_350_000), dayAfterRoast: 9,
                                     flavorTags: [], score: 0, notes: "", source: .manual, bean: bean))

        sourceContext.insert(PhaseReminder(kind: .windowOpens,
                                           fireDate: Date(timeIntervalSince1970: 1_700_500_000),
                                           identifier: NotificationPlanner.identifier(
                                               beanID: bean.id, kind: .windowOpens),
                                           enabled: false, bean: bean))

        try sourceContext.save()
        return bean
    }

    private func writeImage(named name: String, into directory: URL, color: UIColor = .brown) throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 18))
        let image = renderer.image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 18))
        }
        let data = try XCTUnwrap(image.jpegData(compressionQuality: 0.8))
        try data.write(to: directory.appendingPathComponent(name))
    }

    /// 测试默认用「全部未设置」的偏好：v2 要求每个白名单键都有交代。
    private func allUnsetPreferences() -> BackupPreferences {
        BackupPreferences(values: [:], unset: BackupPreferenceKeys.all)
    }

    private func makeBackup(now: Date = Date(),
                            preferences: BackupPreferences? = nil)
    throws -> (file: BackupFile, url: URL) {
        let data = BackupManager.snapshot(
            beans: try sourceContext.fetch(FetchDescriptor<Bean>()),
            rules: try sourceContext.fetch(FetchDescriptor<PhaseRule>())
        )
        let url = try BackupManager.write(data,
                                          preferences: preferences ?? allUnsetPreferences(),
                                          appVersion: "test-1.0",
                                          imagesDirectory: sourceImages, now: now)
        return (try BackupManager.read(from: url), url)
    }

    private func rehash(_ file: inout BackupFile) throws {
        file.manifest.dataDigest = try BackupManager.contentDigest(
            data: file.data, preferences: file.preferences ?? .empty)
    }

    private func targetBeans() throws -> [Bean] {
        try ModelContext(target).fetch(FetchDescriptor<Bean>())
    }

    // MARK: - 往返

    func testEmptyBackupIsValidAndRestoresToEmptyState() throws {
        let (file, _) = try makeBackup()
        XCTAssertEqual(file.manifest.summary.beans, 0)
        XCTAssertEqual(file.manifest.schemaVersion, BackupFormat.currentSchemaVersion)
        XCTAssertEqual(file.manifest.format, BackupFormat.identifier)

        let outcome = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)
        XCTAssertEqual(outcome.beans, 0)
        XCTAssertTrue(try targetBeans().isEmpty)
    }

    func testFullBackupRestoresIdsRelationsAndValues() throws {
        let bean = try seedBean()
        _ = try rules()
        let (file, _) = try makeBackup()

        XCTAssertEqual(file.manifest.summary.beans, 1)
        XCTAssertEqual(file.manifest.summary.brews, 2)
        XCTAssertEqual(file.manifest.summary.tastings, 2)
        XCTAssertEqual(file.manifest.summary.reminders, 1)

        let outcome = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)
        XCTAssertEqual(outcome.beans, 1)
        XCTAssertEqual(outcome.brews, 2)

        let restored = try XCTUnwrap(try targetBeans().first)
        XCTAssertEqual(restored.id, bean.id, "稳定 ID 必须原样恢复")
        XCTAssertEqual(restored.name, bean.name)
        XCTAssertEqual(restored.roaster, bean.roaster)
        XCTAssertEqual(restored.origin, bean.origin)
        XCTAssertEqual(restored.process, bean.process)
        XCTAssertEqual(restored.roastLevel, bean.roastLevel)
        XCTAssertEqual(restored.status, bean.status)
        XCTAssertEqual(restored.weightG, bean.weightG)
        XCTAssertEqual(restored.remainingG, bean.remainingG)
        XCTAssertEqual(restored.price, bean.price)
        XCTAssertEqual(restored.channel, bean.channel)
        XCTAssertEqual(restored.notes, bean.notes)
        XCTAssertEqual(restored.flavorTags, bean.flavorTags, "标签顺序也要保留")
        XCTAssertEqual(restored.createdAt, bean.createdAt)
        XCTAssertEqual(restored.updatedAt, bean.updatedAt)
        XCTAssertEqual(restored.roastDate, bean.roastDate, "日期要精确到原始值")
        XCTAssertEqual(restored.purchaseDate, bean.purchaseDate)
        XCTAssertEqual(restored.openDate, bean.openDate)

        let brews = restored.brewsNewestFirst
        XCTAssertEqual(brews.count, 2)
        XCTAssertEqual(brews.first?.method, "爱乐压")
        XCTAssertEqual(brews.last?.method, "V60")
        XCTAssertEqual(brews.last?.waterTemp, 92.5)
        XCTAssertEqual(brews.last?.timeSeconds, 155)
        XCTAssertEqual(brews.last?.flavorTags, ["蜂蜜", "柑橘"])

        let tastings = restored.tastingsNewestFirst
        XCTAssertEqual(tastings.count, 2)
        let fromBrew = try XCTUnwrap(tastings.first { $0.source == .brew })
        XCTAssertEqual(fromBrew.brewID, brews.last?.id, "来自冲煮的风味要记得那条冲煮")
        XCTAssertEqual(fromBrew.dayAfterRoast, 12)

        XCTAssertEqual(restored.reminders?.count, 1)
        let reminder = try XCTUnwrap(restored.reminders?.first)
        XCTAssertEqual(reminder.identifier,
                       NotificationPlanner.identifier(beanID: restored.id, kind: .windowOpens))
        XCTAssertFalse(reminder.enabled)

        let restoredRules = try ModelContext(target).fetch(FetchDescriptor<PhaseRule>())
        XCTAssertEqual(restoredRules.count, 2)
        XCTAssertEqual(restoredRules.first(where: { $0.roastLevel == .dark })?.enabled, false)
        XCTAssertEqual(restoredRules.first(where: { $0.roastLevel == .light })?.peakEndDay, 20)
    }

    func testImagesTravelWithTheBackupAndComeBack() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)

        let (file, _) = try makeBackup()
        XCTAssertEqual(file.manifest.summary.attachments, 1)
        XCTAssertEqual(file.attachments.first?.name, name)

        let outcome = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)
        XCTAssertEqual(outcome.imagesRestored, 1)

        let restored = try XCTUnwrap(try targetBeans().first)
        XCTAssertEqual(restored.imagePath, name)

        let restoredURL = targetImages.appendingPathComponent(try XCTUnwrap(restored.imagePath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: restoredURL.path))
        XCTAssertNotNil(UIImage(contentsOfFile: restoredURL.path), "恢复后的图片应能被正常读取")
        XCTAssertTrue(FileManager.default.fileExists(atPath:
            targetImages.appendingPathComponent(ImageStore.fileName(for: name, thumbnail: true)).path),
            "缩略图应按展示图重建")
    }

    func testEmptyImagePathCountsAsNoImage() throws {
        try seedBean(imageName: "")
        let (file, _) = try makeBackup()
        XCTAssertEqual(file.manifest.summary.attachments, 0)
        XCTAssertTrue(file.attachments.isEmpty)
    }

    /// 同一个备份恢复两次不应产生重复记录（替换模式的幂等性）。
    func testRestoringTwiceDoesNotDuplicateAnything() throws {
        try seedBean()
        _ = try rules()
        let (file, _) = try makeBackup()

        _ = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)
        _ = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)

        let targetContext = ModelContext(target)
        XCTAssertEqual(try targetContext.fetch(FetchDescriptor<Bean>()).count, 1)
        XCTAssertEqual(try targetContext.fetch(FetchDescriptor<Brew>()).count, 2)
        XCTAssertEqual(try targetContext.fetch(FetchDescriptor<Tasting>()).count, 2)
        XCTAssertEqual(try targetContext.fetch(FetchDescriptor<PhaseRule>()).count, 2)
    }

    // MARK: - 偏好

    func testPreferencesTravelWithBackupAndAreAppliedOnRestore() throws {
        let sourceName = "BackupTests-source-\(UUID().uuidString)"
        let targetName = "BackupTests-target-\(UUID().uuidString)"
        let sourceDefaults = try XCTUnwrap(UserDefaults(suiteName: sourceName))
        let targetDefaults = try XCTUnwrap(UserDefaults(suiteName: targetName))
        defer {
            sourceDefaults.removePersistentDomain(forName: sourceName)
            targetDefaults.removePersistentDomain(forName: targetName)
        }

        sourceDefaults.set("爱乐压", forKey: PrefKey.defaultMethod)
        sourceDefaults.set(18.0, forKey: PrefKey.defaultDoseG)
        sourceDefaults.set(false, forKey: PrefKey.askEnabled)
        sourceDefaults.set(false, forKey: PrefKey.reminderEnabled(.windowOpens))

        // 目标设备上预先存在的、备份里未设置的值，恢复后应回到「未设置」。
        targetDefaults.set(300.0, forKey: PrefKey.defaultWaterG)
        targetDefaults.set("随便写的", forKey: "brewphase.device.only")

        try seedBean()
        let preferences = BackupManager.preferences(from: sourceDefaults)
        let (file, _) = try makeBackup(preferences: preferences)

        XCTAssertEqual(file.preferences?.values[PrefKey.defaultMethod],
                       BackupPreferenceValue.string("爱乐压"))
        XCTAssertTrue(file.preferences?.unset.contains(PrefKey.defaultWaterG) ?? false)

        _ = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages,
                                       defaults: targetDefaults)

        XCTAssertEqual(targetDefaults.string(forKey: PrefKey.defaultMethod), "爱乐压")
        XCTAssertEqual(targetDefaults.double(forKey: PrefKey.defaultDoseG), 18)
        XCTAssertFalse(targetDefaults.bool(forKey: PrefKey.askEnabled))
        XCTAssertFalse(targetDefaults.bool(forKey: PrefKey.reminderEnabled(.windowOpens)))
        XCTAssertNil(targetDefaults.object(forKey: PrefKey.defaultWaterG),
                     "备份时没有设置过的键，恢复后必须回到未设置")
        XCTAssertEqual(targetDefaults.string(forKey: "brewphase.device.only"), "随便写的",
                       "白名单之外的设备状态不受恢复影响")
    }

    /// 备份之后再改默认值，恢复旧备份应回到旧备份的状态。
    func testRestoringOldBackupRestoresItsDoseValue() throws {
        let name = "BackupTests-dose-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }

        defaults.set(18.0, forKey: PrefKey.defaultDoseG)
        try seedBean()
        let (file, _) = try makeBackup(preferences: BackupManager.preferences(from: defaults))

        defaults.set(25.0, forKey: PrefKey.defaultDoseG)
        _ = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages,
                                       defaults: defaults)

        XCTAssertEqual(defaults.double(forKey: PrefKey.defaultDoseG), 18)
    }

    /// 偏好也被摘要覆盖：改了值但不改摘要，必须拒绝。
    func testTamperedPreferencesAreRejectedByChecksum() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.preferences?.values[PrefKey.defaultDoseG] = .number(99)
        file.preferences?.unset.removeAll { $0 == PrefKey.defaultDoseG }
        try expectFailure(file, "偏好被改动后摘要必须对不上", expecting: .checksumMismatch)
    }

    func testUnknownPreferenceKeyIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        var preferences = file.preferences ?? .empty
        preferences.values["brewphase.unknown"] = .string("x")
        file.preferences = preferences
        try rehash(&file)
        try expectFailure(file, "白名单之外的偏好键必须拒绝",
                          expecting: .invalidValue("preferences.brewphase.unknown"))
    }

    func testPreferenceWithWrongTypeIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        var preferences = file.preferences ?? .empty
        preferences.values[PrefKey.defaultDoseG] = .string("18")
        preferences.unset.removeAll { $0 == PrefKey.defaultDoseG }
        file.preferences = preferences
        try rehash(&file)
        try expectFailure(file, "数值键写成字符串必须拒绝",
                          expecting: .invalidValue("preferences.\(PrefKey.defaultDoseG)"))
    }

    func testPreferenceOutOfRangeIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        var preferences = file.preferences ?? .empty
        preferences.values[PrefKey.defaultWaterTemp] = .number(200)
        preferences.unset.removeAll { $0 == PrefKey.defaultWaterTemp }
        file.preferences = preferences
        try rehash(&file)
        try expectFailure(file, "水温超出 0…100 必须拒绝",
                          expecting: .invalidValue("preferences.\(PrefKey.defaultWaterTemp)"))
    }

    func testMissingPreferenceEntryIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.preferences?.unset.removeAll { $0 == PrefKey.defaultMethod }
        try rehash(&file)
        try expectFailure(file, "白名单键既没有值也不在 unset 里，必须拒绝", expecting: .missingData)
    }

    /// 写入端不能写出一份自己读不回来的文件：偏好不完整时必须在建文件之前失败。
    func testWriteRejectsIncompletePreferencesWithoutCreatingAFile() throws {
        try seedBean()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("BrewPhaseBackup", isDirectory: true)
        let before = Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])

        XCTAssertThrowsError(
            try BackupManager.write(try snapshot(),
                                    preferences: .empty,
                                    appVersion: "test-1.0",
                                    imagesDirectory: sourceImages)
        ) { error in
            XCTAssertEqual(error as? BackupError, .missingData,
                           "空偏好不应生成一个读取端必然拒绝的备份")
        }

        let after = Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
        XCTAssertEqual(before, after, "被拒绝的写入不得留下半成品")
    }

    /// 生产路径的偏好快照（`BackupManager.preferences()`）必须天然满足 v2 契约，
    /// 不能靠 UI 每次都记得传参来兜底。
    func testProductionPreferencesSnapshotIsCompleteAndReadable() throws {
        let name = "BackupTests-contract-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }

        // 只设一个键，其余全部落在 unset——这正是「全新安装后立刻备份」的形状。
        defaults.set(15.0, forKey: PrefKey.defaultDoseG)
        let preferences = BackupManager.preferences(from: defaults)
        XCTAssertNoThrow(try BackupManager.validatePreferences(preferences))
        XCTAssertEqual(Set(preferences.values.keys).union(preferences.unset),
                       Set(BackupPreferenceKeys.all))

        try seedBean()
        let (file, _) = try makeBackup(preferences: preferences)
        XCTAssertEqual(file.preferences, preferences, "偏好段必须原样往返")
    }

    // MARK: - 异常备份

    private func expectFailure(_ file: BackupFile,
                               _ description: String,
                               expecting expected: BackupError? = nil) throws {
        do {
            _ = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)
            XCTFail("应当失败：\(description)")
        } catch let error as BackupError {
            if let expected {
                XCTAssertEqual(error, expected, description)
            }
        } catch {
            XCTFail("错误类型不对（\(error)）：\(description)")
        }
    }

    func testUnsupportedFutureVersionIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.manifest.schemaVersion = BackupFormat.currentSchemaVersion + 1
        try expectFailure(file, "更高版本的备份必须拒绝，而不是猜着读")
    }

    func testTamperedDataIsRejectedByChecksum() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.beans[0].notes = "被改过的备注"
        try expectFailure(file, "数据被改动后摘要对不上")
    }

    func testDuplicateIdentifierIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.brews[1].id = file.data.brews[0].id
        // 重算摘要，确保拒绝的原因确实是重复 ID，而不是校验和不匹配。
        try rehash(&file)
        try expectFailure(file, "同一类型里的重复 ID 必须拒绝")
    }

    func testBrokenRelationIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.tastings[0].brewID = UUID()
        // 关系破坏的同时摘要也变了；先重算摘要，确保拒绝的原因是关联而不是校验和。
        try rehash(&file)
        try expectFailure(file, "指向不存在的冲煮必须拒绝")
    }

    func testMissingAttachmentIsRejected() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)
        var (file, _) = try makeBackup()
        file.attachments.removeAll()
        file.manifest.summary.attachments = 0
        file.manifest.summary.attachmentBytes = 0
        file.manifest.attachmentDigest = try BackupManager.sha256(Data("".utf8))
        try expectFailure(file, "引用了不存在的图片必须拒绝")
    }

    func testIllegalAttachmentNameIsRejected() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)
        var (file, _) = try makeBackup()
        file.attachments[0].name = "../escape.jpg"
        file.data.beans[0].imagePath = "../escape.jpg"
        try rehash(&file)
        try expectFailure(file, "带路径分隔符的附件名必须拒绝")
    }

    func testCorruptedFileIsRejected() throws {
        let url = try XCTUnwrap(makeBackup().url)
        try Data("not a backup".utf8).write(to: url)
        XCTAssertThrowsError(try BackupManager.read(from: url))
    }

    // MARK: - 恢复安全

    /// 附件写不进去（目录只读）时必须在动数据库之前失败，旧数据保持不变。
    func testStorageFailureLeavesExistingDataUntouched() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)
        let (file, _) = try makeBackup()

        let existing = Bean(name: "原有豆子", roastLevel: .dark,
                            roastDate: Date(timeIntervalSince1970: 1_700_000_000))
        let existingContext = ModelContext(target)
        existingContext.insert(existing)
        try existingContext.save()

        try FileManager.default.setAttributes([.posixPermissions: 0o500],
                                              ofItemAtPath: targetImages.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755],
                                                   ofItemAtPath: targetImages.path)
        }

        XCTAssertThrowsError(try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages))

        let survivors = try targetBeans()
        XCTAssertEqual(survivors.count, 1, "恢复失败不得清空或部分替换现有数据")
        XCTAssertEqual(survivors.first?.name, "原有豆子")
    }

    /// 同名但内容不同的图片：停止恢复，且不覆盖现有文件。
    func testConflictingImageStopsRestoreWithoutOverwriting() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages, color: .brown)
        try seedBean(imageName: name)
        let (file, _) = try makeBackup()

        try writeImage(named: name, into: targetImages, color: .blue)
        let before = try Data(contentsOf: targetImages.appendingPathComponent(name))

        XCTAssertThrowsError(try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages))

        let after = try Data(contentsOf: targetImages.appendingPathComponent(name))
        XCTAssertEqual(before, after, "内容不同的同名图片不能被备份覆盖")
        XCTAssertTrue(try targetBeans().isEmpty, "失败时不得写入任何数据")
    }

    /// 恢复后关闭容器再重新打开（等价于重启 App），数据仍在。
    /// 这是**模型层的持久化验证**，不是 UI 验收。
    func testRestoredDataSurvivesContainerReopen() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("BackupReopen-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let images = root.appendingPathComponent("Images", isDirectory: true)
        try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)

        let schema = Schema([Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self])
        let sourceURL = root.appendingPathComponent("source.store")
        let source = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, url: sourceURL)]
        )

        let sourceContext = ModelContext(source)
        let bean = Bean(name: "持久化", roastLevel: .light, roastDate: Date())
        sourceContext.insert(bean)
        sourceContext.insert(Brew(method: "V60", coffeeG: 15, waterG: 250, bean: bean))
        try sourceContext.save()

        let data = BackupManager.snapshot(
            beans: try sourceContext.fetch(FetchDescriptor<Bean>()), rules: []
        )
        let url = try BackupManager.write(data, preferences: allUnsetPreferences(),
                                          appVersion: "test-1.0", imagesDirectory: images)
        let file = try BackupManager.read(from: url)

        let targetURL = root.appendingPathComponent("target.store")
        let target = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, url: targetURL)]
        )
        _ = try BackupRestorer.restore(file, into: target, imagesDirectory: images)

        // 重新打开同一个库文件：数据与关系都必须还在。
        let reopened = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, url: targetURL)]
        )
        let stored = try ModelContext(reopened).fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?.name, "持久化")
        XCTAssertEqual(stored.first?.brews?.count, 1, "重启后冲煮记录必须仍挂在豆子上")
    }

    // MARK: - 版本与逐字段校验

    func testLegacyVersionIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.manifest.schemaVersion = 1
        try expectFailure(file, "v1 的摘要不覆盖偏好，必须拒绝", expecting: .legacyVersion(1))
    }

    func testInvalidBrewScoreIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.brews[0].score = 6
        try rehash(&file)
        try expectFailure(file, "评分只能是 0…5", expecting: .invalidValue("brew.score"))
    }

    func testNegativeBrewWeightIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.brews[0].coffeeG = -1
        try rehash(&file)
        try expectFailure(file, "", expecting: .invalidValue("brew.coffeeG"))
    }

    func testNegativeTastingDayIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.tastings[0].dayAfterRoast = -1
        try rehash(&file)
        try expectFailure(file, "", expecting: .invalidValue("tasting.dayAfterRoast"))
    }

    func testRuleWithEmptyWindowIsRejected() throws {
        try seedBean()
        _ = try rules()
        var (file, _) = try makeBackup()
        file.data.phaseRules[0].peakEndDay = file.data.phaseRules[0].peakStartDay
        try rehash(&file)
        try expectFailure(file, "", expecting: .invalidValue("rule.peakEndDay"))
    }

    func testRuleWithReversedRestWindowIsRejected() throws {
        try seedBean()
        _ = try rules()
        var (file, _) = try makeBackup()
        file.data.phaseRules[0].restMaxDays = file.data.phaseRules[0].restMinDays - 1
        try rehash(&file)
        try expectFailure(file, "", expecting: .invalidValue("rule.restMaxDays"))
    }

    func testReminderIdentifierMustMatchItsBean() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.reminders[0].identifier = NotificationPlanner.identifier(
            beanID: UUID(), kind: .windowOpens)
        try rehash(&file)
        try expectFailure(file, "", expecting: .invalidValue("reminder.identifier"))
    }

    func testNegativeBeanWeightIsRejected() throws {
        try seedBean()
        var (file, _) = try makeBackup()
        file.data.beans[0].weightG = -1
        try rehash(&file)
        try expectFailure(file, "", expecting: .invalidValue("bean.weightG"))
    }

    // MARK: - 体积策略

    private func snapshot() throws -> BackupData {
        BackupManager.snapshot(
            beans: try sourceContext.fetch(FetchDescriptor<Bean>()),
            rules: try sourceContext.fetch(FetchDescriptor<PhaseRule>())
        )
    }

    /// 纯函数边界：单张、总量、最终文件三个闸门各测一次，不用分配大内存。
    func testSizePolicyBoundaries() {
        let limits = BackupSizeLimits(maxFileBytes: 1_000, maxAttachmentBytes: 600,
                                      maxSingleAttachmentBytes: 300, overheadBytes: 0)

        XCTAssertNoThrow(try BackupSizePolicy.validate(
            attachmentBytes: 300, largestAttachmentBytes: 300, dataBytes: 100, limits: limits))

        XCTAssertThrowsError(try BackupSizePolicy.validate(
            attachmentBytes: 700, largestAttachmentBytes: 300, dataBytes: 0, limits: limits)
        ) { XCTAssertEqual($0 as? BackupError, .attachmentTooLarge) }

        XCTAssertThrowsError(try BackupSizePolicy.validate(
            attachmentBytes: 100, largestAttachmentBytes: 400, dataBytes: 0, limits: limits)
        ) { XCTAssertEqual($0 as? BackupError, .attachmentTooLarge) }

        XCTAssertThrowsError(try BackupSizePolicy.validate(
            attachmentBytes: 600, largestAttachmentBytes: 300, dataBytes: 300, limits: limits)
        ) { XCTAssertEqual($0 as? BackupError, .fileTooLarge) }
    }

    func testGeneratedFileFitsReaderLimitAndReadsBack() throws {
        try seedBean()
        let url = try BackupManager.write(try snapshot(),
                                          preferences: allUnsetPreferences(),
                                          appVersion: "test-1.0",
                                          imagesDirectory: sourceImages)
        let size = try XCTUnwrap(url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        XCTAssertLessThanOrEqual(size, BackupSizeLimits.standard.maxFileBytes)
        XCTAssertNoThrow(try BackupManager.read(from: url))
    }

    func testOversizedBackupIsRejectedWithoutLeavingAFile() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)

        let limits = BackupSizeLimits(maxFileBytes: 500, maxAttachmentBytes: 10_000,
                                      maxSingleAttachmentBytes: 10_000, overheadBytes: 0)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("BrewPhaseBackup", isDirectory: true)
        let before = Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])

        XCTAssertThrowsError(try BackupManager.write(try snapshot(),
                                                     preferences: allUnsetPreferences(),
                                                     appVersion: "test-1.0",
                                                     imagesDirectory: sourceImages,
                                                     limits: limits)) { error in
            XCTAssertEqual(error as? BackupError, .fileTooLarge)
        }

        let after = Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
        XCTAssertEqual(before, after, "超限失败不得留下半成品")
    }

    func testTwoBackupsInTheSameSecondDoNotCollide() throws {
        try seedBean()
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let data = try snapshot()
        let first = try BackupManager.write(data, preferences: allUnsetPreferences(),
                                            appVersion: "t", imagesDirectory: sourceImages, now: now)
        let second = try BackupManager.write(data, preferences: allUnsetPreferences(),
                                             appVersion: "t", imagesDirectory: sourceImages, now: now)
        defer {
            try? FileManager.default.removeItem(at: first)
            try? FileManager.default.removeItem(at: second)
        }

        XCTAssertNotEqual(first, second, "同一秒生成两份不能互相覆盖")
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path))
    }

    /// 上限之间的关系与解码峰值估算：只断言数字，不分配大内存。
    func testStandardLimitsKeepDecodedPeakWithinBudget() {
        let limits = BackupSizeLimits.standard
        XCTAssertLessThan(limits.maxAttachmentBytes, limits.maxFileBytes)
        XCTAssertLessThan(limits.maxSingleAttachmentBytes, limits.maxAttachmentBytes)

        // 最坏情况：文件顶到上限，附件也顶到上限。
        let peak = BackupSizePolicy.estimatedReadPeakBytes(fileBytes: limits.maxFileBytes,
                                                           attachmentBytes: limits.maxAttachmentBytes)
        XCTAssertLessThanOrEqual(peak, 400 * 1024 * 1024,
                                 "标准上限下的解码峰值估算需留在小内存设备可承受的范围")

        // 导出端用同一组数字：附件顶满时估算出的 JSON 仍必须落进文件上限。
        let estimated = BackupSizePolicy.estimatedJSONBytes(
            attachmentBytes: limits.maxAttachmentBytes,
            dataBytes: 0,
            overheadBytes: limits.overheadBytes
        )
        XCTAssertLessThanOrEqual(estimated, limits.maxFileBytes)
    }

    /// 单张图片超限必须在写文件之前被挡住。
    func testSingleAttachmentOverLimitIsRejected() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)

        let limits = BackupSizeLimits(maxFileBytes: 64 * 1024 * 1024,
                                      maxAttachmentBytes: 64 * 1024 * 1024,
                                      maxSingleAttachmentBytes: 1,
                                      overheadBytes: 0)
        XCTAssertThrowsError(try BackupManager.write(try snapshot(),
                                                     preferences: allUnsetPreferences(),
                                                     appVersion: "t",
                                                     imagesDirectory: sourceImages,
                                                     limits: limits)) { error in
            XCTAssertEqual(error as? BackupError, .attachmentTooLarge)
        }
    }

    // MARK: - 设备状态不进入备份

    func testDeviceOnlyStateIsNotCaptured() throws {
        let name = "BackupTests-device-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }

        defaults.set("en", forKey: "brewphase.language")
        defaults.set(true, forKey: PrefKey.askedForNotifications)
        defaults.set(true, forKey: PrefKey.didShowPrefillHint)

        let preferences = BackupManager.preferences(from: defaults)
        for key in ["brewphase.language", PrefKey.askedForNotifications, PrefKey.didShowPrefillHint] {
            XCTAssertFalse(preferences.values.keys.contains(key), "\(key) 不该进备份")
            XCTAssertFalse(preferences.unset.contains(key), "\(key) 连占位都不该有")
        }
    }

    /// 失败路径不能留下半成品文件。
    func testFailedRestoreLeavesNoNewImageFiles() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)
        var (file, _) = try makeBackup()
        file.data.beans[0].name = "改名"
        // 只有数据摘要失配，恢复会在校验阶段就停下。
        XCTAssertThrowsError(try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages))

        let leftovers = try FileManager.default.contentsOfDirectory(atPath: targetImages.path)
        XCTAssertTrue(leftovers.isEmpty, "校验失败的备份不应在图片目录留下文件")
    }

    /// 进程中断留下的孤儿图片不该影响恢复后的数据，成功恢复后应被清理。
    func testRestoreCleansInterruptedOrphans() throws {
        try seedBean()
        let (file, _) = try makeBackup()

        try writeImage(named: "\(UUID().uuidString).jpg", into: targetImages)
        _ = try BackupRestorer.restore(file, into: target, imagesDirectory: targetImages)

        XCTAssertEqual(try targetBeans().count, 1)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: targetImages.path).isEmpty,
                      "成功恢复后，无人引用的孤儿图片应被清理")
    }

    // MARK: - 保存失败

    func testSaveFailureLeavesDataPreferencesAndImagesUntouched() throws {
        let name = "\(UUID().uuidString).jpg"
        try writeImage(named: name, into: sourceImages)
        try seedBean(imageName: name)
        let (file, _) = try makeBackup()

        let existingContext = ModelContext(target)
        existingContext.insert(Bean(name: "原有豆子", roastLevel: .dark,
                                    roastDate: Date(timeIntervalSince1970: 1_700_000_000)))
        try existingContext.save()

        let suiteName = "BackupTests-save-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(15.0, forKey: PrefKey.defaultDoseG)

        let filesBefore = Set(try FileManager.default.contentsOfDirectory(atPath: targetImages.path))

        struct SaveFailed: Error {}
        XCTAssertThrowsError(try BackupRestorer.restore(
            file, into: target, imagesDirectory: targetImages, defaults: defaults,
            save: { _ in throw SaveFailed() }
        ))

        XCTAssertEqual(try targetBeans().map(\.name), ["原有豆子"], "保存失败后原有数据必须还在")
        XCTAssertEqual(defaults.double(forKey: PrefKey.defaultDoseG), 15,
                       "偏好只能在数据库替换成功之后写回")
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: targetImages.path)),
                       filesBefore, "失败时新增图片要回收，已有文件不动")
    }
}
