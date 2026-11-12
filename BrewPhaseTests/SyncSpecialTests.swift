import XCTest
import SwiftData
@testable import BrewPhase

/// 同步专项（本轮新增）：跨语言指纹金标 + 快照构建器覆盖全部同步实体。
///
/// 为什么要单独一组：
/// - 指纹是同步的地基。两端算法任何一处漂移，**不会报错**，只会让全量数据
///   在桌面端变成「两端都改过」的假冲突，或让「没改」被当成「改过」而反复重传。
///   现有 `SyncModelsTests` 只覆盖了几个数字的自洽性，没有与 TS 实现对齐的金标。
/// - `SyncSnapshotBuilder` 决定「哪些实体、按什么顺序、带哪些字段」出去，
///   之前完全没有测试；漏一个实体不会有任何编译或运行时错误。
///
/// 金标由桌面端生产实现（`Desktop/src/main/sync/snapshot-importer.ts` 的
/// `canonical` + `fingerprint`）算出，Swift 侧必须逐字节一致。
final class SyncSpecialTests: XCTestCase {

    // MARK: - 跨语言指纹金标

    /// 18 字段的豆子（含中文、null、布尔、毫秒时间戳、小数）。
    func testBeanFingerprintMatchesDesktopGolden() {
        let canonical = SyncFingerprint.canonical([
            "耶加雪菲 科契尔", "测试烘焙", "埃塞俄比亚", "washed", "light",
            Int64(1_735_689_600_000), Int64(1_735_689_600_000), Int64(1_735_689_600_000),
            200.0, 168.5, 88.0, "门店",
            "abc.jpg", "花香,柑橘", "带\u{1F}分隔符与\"引号\"", "active",
            Int64(1_735_689_600_000), false
        ])
        XCTAssertEqual(
            SyncFingerprint.of(canonical),
            "56668faa76bd9c131e78539af7b596498506ea7d3c845ca48b4ed90be0ba9212"
        )
    }

    /// 数字归一：1 与 1.0 同值、6 位小数截断、尾零去掉。
    func testNumberFingerprintMatchesDesktopGolden() {
        let canonical = SyncFingerprint.canonical([1, 1.0, 1.0000001, -0.5, 0, 1e6, 0.000001, 2.50])
        XCTAssertEqual(
            canonical,
            "1\u{1F}1\u{1F}1\u{1F}-0.5\u{1F}0\u{1F}1000000\u{1F}0.000001\u{1F}2.5"
        )
        XCTAssertEqual(
            SyncFingerprint.of(canonical),
            "545f41eeac6a72bcc9962100dbeb5594d204f493b6707d1f16ee8e5515c85e83"
        )
    }

    /// null / undefined / 空串 / "~" / 布尔：空串不等于 null，`"~"` 不是 null 的替身。
    func testNullAndBooleanFingerprintMatchesDesktopGolden() {
        let canonical = SyncFingerprint.canonical([nil, nil, "", "~", false, true])
        XCTAssertEqual(canonical, "~\u{1F}~\u{1F}\u{1F}~\u{1F}false\u{1F}true")
        XCTAssertEqual(
            SyncFingerprint.of(canonical),
            "b7db2175b192cd1839ae878ca907bbf408574ccfe45217ef098e79c014d82369"
        )
    }

    /// 文本里的换行、引号必须原样进入指纹（不做转义或折叠）。
    func testRecordTextFingerprintMatchesDesktopGolden() {
        let canonical = SyncFingerprint.canonical([
            "text", "标题", "正文\n换行", "", nil, "generic", "", nil, 1, "", "", "", nil, "idle",
            nil, nil, nil, nil, nil, nil, nil, false
        ])
        XCTAssertEqual(
            SyncFingerprint.of(canonical),
            "d8ff1e18c44dd31452e32765c3360f7be7de10265571c38c7ad38f0d2c30c791"
        )
    }

    /// 大数（epoch 毫秒）与浮点小数：不能被科学计数法劫持。
    func testLargeNumberFingerprintMatchesDesktopGolden() {
        let canonical = SyncFingerprint.canonical([
            Int64(1_735_689_600_000), 1e12, 0.0000005, 1.0000004
        ])
        XCTAssertEqual(
            SyncFingerprint.of(canonical),
            "4080b5a7fb2905c2052642bf69f79d543ee653adcac47fdbc6c680118b85a871"
        )
    }

    /// 画布节点：坐标是浮点，字段序与桌面端一致。
    func testCanvasNodeFingerprintMatchesDesktopGolden() {
        let canonical = SyncFingerprint.canonical([
            "88888888-8888-4888-8888-000000000001",
            "77777777-7777-4777-8777-000000000001",
            24.5, 48.25, 160.0, 120.0, 3, "旁注"
        ])
        XCTAssertEqual(
            SyncFingerprint.of(canonical),
            "d79bb41e07cdc7351c0ca5641c262e30d9db23454704f9c1503f0ef7a4397cb2"
        )
    }

    /// **已知跨语言差异**：负零。
    ///
    /// TS 的 `String(-0)` 是 `"0"`；Swift 的 `String(format: "%.6f", -0.0)`
    /// 得到 `"-0.000000"`，去尾零后是 `"-0"`。两端于是算出不同指纹。
    ///
    /// 影响面窄（只在该字段恰好是 -0 时发生，例如节点坐标被算成 -0.0），
    /// 但后果是**该实体永久假冲突**：iOS 每次同步都推一个和桌面端不一致的指纹。
    /// 本轮按要求不改生产代码，先把差异钉成断言，避免它被静默忽略。
    func testNegativeZeroDiffersFromDesktop() {
        XCTAssertEqual(SyncFingerprint.number(-0.0), "-0", "Swift 现状：负零保留符号")
        // 桌面端同一输入得到 "0"，因此指纹不同——这是待修项，不是期望行为。
        XCTAssertNotEqual(
            SyncFingerprint.of(SyncFingerprint.canonical([-0.0])),
            SyncFingerprint.of(SyncFingerprint.canonical([0.0]))
        )
    }

    // MARK: - 快照构建器

    private func makeContext() throws -> ModelContext {
        let schema = Schema([
            Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self,
            Record.self, RecordTag.self, Canvas.self, CanvasNode.self
        ])
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        return ModelContext(container)
    }

    /// 全部同步实体都必须出现在批次里，且顺序满足依赖（父先子后）。
    func testSnapshotCoversEverySyncedEntityInDependencyOrder() throws {
        let context = try makeContext()

        let bean = Bean(name: "测试豆", roaster: "烘焙", weightG: 200, remainingG: 180)
        context.insert(bean)
        let brew = Brew(date: Date(), method: "V60", coffeeG: 15, waterG: 240, bean: bean)
        context.insert(brew)
        context.insert(Tasting(date: Date(), score: 85, brewID: brew.id, bean: bean))
        context.insert(PhaseRule(data: PhaseRuleData(
            roastLevel: .light, restMinDays: 7, restMaxDays: 14,
            peakStartDay: 14, peakEndDay: 28, declineStartDay: 35, enabled: true
        )))
        context.insert(PhaseReminder(kind: .restComplete, fireDate: Date(), identifier: "id-1", bean: bean))

        let tag = RecordTag(name: "专项")
        context.insert(tag)
        let record = Record(carrier: .text, title: "标题")
        record.tags = [tag]
        context.insert(record)

        let canvas = Canvas(name: "画布")
        context.insert(canvas)
        context.insert(CanvasNode(canvasID: canvas.id, recordID: record.id, width: 160, height: 120))
        try context.save()

        let builder = SyncSnapshotBuilder(context: context)
        let batches = try builder.allBatches()
        let types = batches.map(\.entityType)

        XCTAssertEqual(
            types,
            ["bean", "brew", "tasting", "phaseRule", "phaseReminder", "recordTag", "record", "recordTagLink", "canvas", "canvasNode"],
            "实体顺序即依赖顺序：父实体必须排在子实体之前"
        )

        // 依赖顺序的硬约束：tagLink 必须在 record 与 tag 之后。
        let tagIndex = try XCTUnwrap(types.firstIndex(of: "recordTag"))
        let recordIndex = try XCTUnwrap(types.firstIndex(of: "record"))
        let linkIndex = try XCTUnwrap(types.firstIndex(of: "recordTagLink"))
        XCTAssertGreaterThan(linkIndex, tagIndex)
        XCTAssertGreaterThan(linkIndex, recordIndex)

        // 每类至少一条 upsert（没有空批次漏进去）。
        for batch in batches {
            XCTAssertFalse(batch.upserts.isEmpty, "\(batch.entityType) 批次为空")
            XCTAssertFalse(batch.entityType.isEmpty)
        }
    }

    /// recordTagLink 的 id 必须是确定性复合键 `recordId:tagId`，两端同一构造。
    func testTagLinkIDIsDeterministicCompositeKey() throws {
        let context = try makeContext()
        let tag = RecordTag(name: "开发")
        context.insert(tag)
        let record = Record(carrier: .text, title: "带标签")
        record.tags = [tag]
        context.insert(record)
        try context.save()

        let builder = SyncSnapshotBuilder(context: context)
        let batches = try builder.allBatches()
        let linkBatch = try XCTUnwrap(batches.first { $0.entityType == "recordTagLink" })
        let upsert = try XCTUnwrap(linkBatch.upserts.first)

        XCTAssertEqual(upsert.id, "\(record.id.uuidString):\(tag.id.uuidString)")
        guard case .string(let payloadRecordId)? = upsert.payload["recordId"],
              case .string(let payloadTagId)? = upsert.payload["tagId"] else {
            return XCTFail("recordTagLink payload 必须是字符串 id")
        }
        XCTAssertEqual(payloadRecordId, record.id.uuidString)
        XCTAssertEqual(payloadTagId, tag.id.uuidString)
    }

    /// 每类实体的 upsert 都必须带指纹，且指纹是 64 位十六进制。
    func testEveryUpsertCarriesAWellFormedFingerprint() throws {
        let context = try makeContext()
        let bean = Bean(name: "豆")
        context.insert(bean)
        context.insert(Record(carrier: .text, title: "记录"))
        context.insert(Canvas(name: "画布"))
        try context.save()

        let builder = SyncSnapshotBuilder(context: context)
        for batch in try builder.allBatches() {
            for upsert in batch.upserts {
                XCTAssertEqual(upsert.fingerprint.count, 64, "\(batch.entityType) 指纹长度")
                XCTAssertTrue(
                    upsert.fingerprint.allSatisfy { $0.isHexDigit },
                    "\(batch.entityType) 指纹必须是十六进制"
                )
            }
        }
    }

    /// 引用了但本地读不到的媒体必须进 `errors`，不能静默跳过。
    func testMediaManifestReportsUnreadableReferences() throws {
        let context = try makeContext()
        let record = Record(carrier: .image, title: "缺图")
        record.mediaPath = "aaaaaaaa-1111-4111-8111-000000000001.jpg" // 不写文件
        context.insert(record)
        try context.save()

        let result = SyncSnapshotBuilder(context: context).mediaManifest()
        XCTAssertEqual(result.entries.count, 0)
        XCTAssertFalse(result.errors.isEmpty, "读不到的文件必须显式报告")
    }
}
