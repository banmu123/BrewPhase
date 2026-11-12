import XCTest
import SwiftData
@testable import BrewPhase

/// 跨端联调：**真实 iOS 快照构建器 → 真实 HTTP → 真实 Desktop 合并 → 真实 SQLite**。
///
/// 不 mock 网络：`SyncNetworkClient` 打真实 HTTP，对端是
/// `Desktop/tests/integration/support/sync-harness.ts` 起的真服务（真 SQLite
/// 文件、真鉴权、真合并语义）。跑完由外层脚本打开那个库核对落库结果。
///
/// 这里的 `Driver` **逐行复刻 `SyncManager.synchronize()` 的增量与基线语义**：
/// 按基线过滤 upsert、由「基线有而当前没有」推导 deletes、删除带上一次成功
/// 同步的指纹、按逐条 `results` 推进基线。直接手搓 deletes 会拿到过期指纹，
/// 桌面端会正确判成删除冲突——那是夹具模拟错误，不是产品行为。
///
/// **不覆盖**：Keychain 凭据读写与扫码配对编排。当前是
/// `CODE_SIGNING_ALLOWED=NO` 的未签名模拟器包，Keychain 返回
/// `errSecMissingEntitlement`，`pairedDevice()` 拿不到凭据；因此这里把 token
/// 直接交给客户端（等价于「已配对、凭据可读」之后的状态）。见报告「未能执行」。
final class SyncCrossEndTests: XCTestCase {

    private struct Harness: Decodable {
        var host: String
        var port: Int
        var token: String
        var deviceId: String
        var dbPath: String
    }

    private func loadHarness() throws -> Harness {
        let documents = try XCTUnwrap(
            FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        )
        let file = documents.appendingPathComponent("sync-harness.json")
        guard let data = try? Data(contentsOf: file) else {
            throw XCTSkip("没有跨端夹具（先运行 sync-harness.ts 并安装 App）")
        }
        return try JSONDecoder().decode(Harness.self, from: data)
    }

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

    private struct Seeded {
        var bean: Bean
        var record: Record
        var tag: RecordTag
        var canvas: Canvas
        var node: CanvasNode
    }

    private func seed(_ context: ModelContext) throws -> Seeded {
        let bean = Bean(name: "跨端测试豆", roaster: "跨端烘焙", weightG: 200, remainingG: 176)
        context.insert(bean)
        let brew = Brew(date: Date(), method: "V60", grinder: "C40", coffeeG: 15, waterG: 240, bean: bean)
        context.insert(brew)
        context.insert(Tasting(date: Date(), dayAfterRoast: 7, score: 87, brewID: brew.id, bean: bean))

        // 标签名有 UNIQUE 约束；联调夹具的库会被多轮用例复用，必须每次唯一，
        // 否则第二次运行就撞 `UNIQUE constraint failed: record_tags.name`。
        let tag = RecordTag(name: "跨端-\(UUID().uuidString.prefix(8))")
        context.insert(tag)
        let record = Record(carrier: .text, title: "跨端记录标题", note: "跨端记录正文")
        record.tags = [tag]
        context.insert(record)

        let canvas = Canvas(name: "跨端画布")
        context.insert(canvas)
        let node = CanvasNode(canvasID: canvas.id, recordID: record.id, width: 160, height: 120)
        context.insert(node)
        try context.save()
        return Seeded(bean: bean, record: record, tag: tag, canvas: canvas, node: node)
    }

    struct Totals {
        var applied = 0
        var skipped = 0
        var conflicts = 0
        var failed = 0
        var requests = 0
        var failures: [String] = []
    }

    /// 复刻 `SyncManager` 的基线推进（只保留与 apply 相关的部分）。
    final class Driver {
        let client: SyncNetworkClient
        var baseline: [String: [String: String]] = [:]

        init(client: SyncNetworkClient) { self.client = client }

        /// 一次完整同步：逐实体批次，按基线算增量，按逐条结果推进基线。
        /// `overrideDeletes` 只用于异常路径：**替换**该实体自动推导出的删除意图
        /// （模拟「iOS 基线落后」），不会与正常 delete 叠加成两条同 id 请求。
        func sync(
            context: ModelContext,
            overrideDeletes: [String: [SyncDelete]]? = nil
        ) async throws -> Totals {
            var totals = Totals()
            let builder = SyncSnapshotBuilder(context: context)
            for batch in try builder.allBatches() {
                let previous = baseline[batch.entityType] ?? [:]
                let upserts = batch.upserts.filter { previous[$0.id] != $0.fingerprint }
                let deletedIDs = previous.keys
                    .filter { !batch.currentIDs.contains($0) }
                    .sorted()
                var deletes = deletedIDs.map {
                    SyncDelete(id: $0, expectedFingerprint: previous[$0])
                }
                if let override = overrideDeletes?[batch.entityType] {
                    deletes = override
                }

                guard !upserts.isEmpty || !deletes.isEmpty else { continue }
                totals.requests += 1
                let outcome = try await client.apply(
                    SyncBatch(operations: [SyncOperation(
                        entityType: batch.entityType, upserts: upserts, deletes: deletes
                    )])
                )
                totals.applied += outcome.appliedCount
                totals.skipped += outcome.skippedCount
                totals.conflicts += outcome.conflictCount
                totals.failed += outcome.failedItems?.count ?? 0
                for item in outcome.failedItems ?? [] {
                    totals.failures.append("\(batch.entityType) \(item.id): \(item.reason)")
                }
                commit(entityType: batch.entityType, upserts: upserts,
                       deletedIDs: deletedIDs, outcome: outcome)
            }
            return totals
        }

        /// 与 `SyncManager.commitBaseline` 同语义：仅 applied/skipped 推进。
        private func commit(
            entityType: String,
            upserts: [SyncUpsert],
            deletedIDs: [String],
            outcome: ApplyOutcome
        ) {
            var entityBaseline = baseline[entityType] ?? [:]
            if let results = outcome.results, !results.isEmpty {
                let byID = Dictionary(results.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                for upsert in upserts {
                    guard let status = byID[upsert.id]?.status else { continue }
                    if status == "applied" || status == "skipped" {
                        entityBaseline[upsert.id] = upsert.fingerprint
                    }
                }
                for id in deletedIDs {
                    guard let status = byID[id]?.status else { continue }
                    if status == "applied" || status == "skipped" {
                        entityBaseline.removeValue(forKey: id)
                    }
                }
            }
            baseline[entityType] = entityBaseline
        }
    }

    /// 完整生命周期：新建 → 幂等 → 修改 → 删除 → 不复活 → 冲突保护。
    /// 单条用例共用同一个数据库与同一组 id，避免拆开后互相污染。
    func testFullLifecycleAgainstRealDesktop() async throws {
        let harness = try loadHarness()
        let client = SyncNetworkClient(host: harness.host, port: harness.port, token: harness.token)
        let context = try makeContext()
        let seeded = try seed(context)
        let driver = Driver(client: client)

        // ---- 0. 连通性与协议版本（真实 GET） ----
        let status = try await client.serviceStatus()
        XCTAssertEqual(status.service, "brewphase-sync")
        XCTAssertEqual(status.protocolVersion, SyncManager.protocolVersion)

        // ---- 1. 首次同步：8 类实体全部落库 ----
        let first = try await driver.sync(context: context)
        XCTAssertEqual(first.failed, 0, "首次同步不该有失败条目：\(first.failures)")
        XCTAssertEqual(first.conflicts, 0, "首次同步不该产生冲突")
        // seed 的是 bean / brew / tasting / tag / record / tagLink / canvas / node = 8 类
        XCTAssertEqual(first.applied, 8, "8 类实体的写入应全部 applied")

        // ---- 2. 重复同步：iOS 侧增量过滤后**一个请求都不发** ----
        let second = try await driver.sync(context: context)
        XCTAssertEqual(second.requests, 0, "基线一致时不应产生任何网络请求")
        XCTAssertEqual(second.applied, 0)
        XCTAssertEqual(second.conflicts, 0)

        // 强制重发全部 upsert，验证服务端幂等（跳过客户端增量过滤）。
        // 只发非空批次：空 operation 也会被服务端计入请求数，干扰断言。
        let replay = try await client.apply(
            SyncBatch(operations: try SyncSnapshotBuilder(context: context).allBatches()
                .filter { !$0.upserts.isEmpty }
                .map { SyncOperation(entityType: $0.entityType, upserts: $0.upserts, deletes: []) })
        )
        XCTAssertEqual(replay.appliedCount, 0, "服务端重放同一批不该重复写入")
        XCTAssertGreaterThan(replay.skippedCount, 0, "重放应全部 skipped")
        XCTAssertEqual(replay.conflictCount, 0)

        // ---- 3. 修改同步：标题 + 节点坐标 ----
        seeded.record.title = "跨端记录标题（已修改）"
        seeded.node.positionX = 320
        try context.save()
        let modified = try await driver.sync(context: context)
        XCTAssertEqual(modified.applied, 2, "记录与节点都应被更新")
        XCTAssertEqual(modified.conflicts, 0, "桌面端未改动时不该冲突")
        XCTAssertEqual(modified.failed, 0, "修改同步不该失败：\(modified.failures)")

        // 修改确认后再推：重新收敛为 0 请求。
        let afterModify = try await driver.sync(context: context)
        XCTAssertEqual(afterModify.requests, 0, "修改确认后不该再发请求")

        // ---- 4. 删除同步：Driver 自动带上一次成功同步的指纹 ----
        context.delete(seeded.record)
        try context.save()
        let deletion = try await driver.sync(context: context)
        XCTAssertGreaterThanOrEqual(deletion.applied, 1, "删除应被应用")
        XCTAssertEqual(deletion.conflicts, 0, "本地未改动时删除不该冲突")
        XCTAssertEqual(deletion.failed, 0, "删除同步不该失败：\(deletion.failures)")

        // ---- 5. 删除后重复同步：不能复活 ----
        for round in 0..<2 {
            let again = try await driver.sync(context: context)
            XCTAssertEqual(again.requests, 0, "第 \(round + 1) 轮：不该再发请求")
            XCTAssertEqual(again.conflicts, 0, "第 \(round + 1) 轮：不该产生冲突")
        }
    }

    /// 跨语言数字归一边界：Swift `String(format: "%.6f", -1e-7)` → `"-0"`，
    /// TypeScript `String(Number((-1e-7).toFixed(6)))` → `"0"`。极小负数
    /// （画布世界坐标完全可能出现）会让两端对同一行算出不同指纹。
    /// 这条用真服务验证它是否会在重放时变成假冲突。
    func testTinyNegativeCoordinateFingerprintDrift() async throws {
        let harness = try loadHarness()
        let client = SyncNetworkClient(host: harness.host, port: harness.port, token: harness.token)
        let context = try makeContext()
        let driver = Driver(client: client)

        let tag = RecordTag(name: "负零边界-\(UUID().uuidString.prefix(8))")
        context.insert(tag)
        let record = Record(carrier: .text, title: "负零边界记录")
        record.tags = [tag]
        context.insert(record)
        let canvas = Canvas(name: "负零边界画布")
        context.insert(canvas)
        let node = CanvasNode(canvasID: canvas.id, recordID: record.id, width: 160, height: 120)
        node.positionX = -0.0000001   // |x| < 5e-7：Swift 归一为 "-0"，TS 归一为 "0"
        context.insert(node)
        try context.save()

        let first = try await driver.sync(context: context)
        XCTAssertEqual(first.failed, 0, "首次同步不该失败：\(first.failures)")
        XCTAssertEqual(first.conflicts, 0, "首次同步不该冲突")

        // 强制重放全批（跳过 iOS 增量过滤），模拟「重复同步」在服务端的判定。
        let replay = try await client.apply(
            SyncBatch(operations: try SyncSnapshotBuilder(context: context).allBatches()
                .filter { !$0.upserts.isEmpty }
                .map { SyncOperation(entityType: $0.entityType, upserts: $0.upserts, deletes: []) })
        )
        let drifted = replay.results?.filter { $0.status == "conflict" } ?? []
        // 现状记录：若这里 > 0，说明同一行因跨语言归一差异被误判为「桌面改过」。
        // seed 只建 tag / record / tagLink / canvas / node = 5 条（不含咖啡实体）。
        XCTAssertEqual(first.applied, 5)
        print("[负零边界] replay conflicts=\(replay.conflictCount) applied=\(replay.appliedCount) skipped=\(replay.skippedCount) drifted=\(drifted.map { $0.entityType })")
    }

    /// 桌面端现行指纹与 iOS 基线不一致时，删除必须进冲突而非静默删除。
    /// 这里**故意不推进基线**再删（模拟上次同步响应丢失 / 基线写入失败），
    /// 验证删除保护确实生效——这是 §6 非破坏性的关键边界。
    func testDeletionWithStaleBaselineBecomesConflict() async throws {
        let harness = try loadHarness()
        let client = SyncNetworkClient(host: harness.host, port: harness.port, token: harness.token)
        let context = try makeContext()
        let driver = Driver(client: client)

        let tag = RecordTag(name: "删除冲突-\(UUID().uuidString.prefix(8))")
        context.insert(tag)
        let record = Record(carrier: .text, title: "删除冲突记录")
        record.tags = [tag]
        context.insert(record)
        try context.save()

        let first = try await driver.sync(context: context)
        XCTAssertEqual(first.failed, 0, "准备数据不该失败：\(first.failures)")
        XCTAssertGreaterThanOrEqual(first.applied, 3, "tag / record / tagLink 都应落库")

        context.delete(record)
        try context.save()

        // 注入一个过时期望指纹，模拟「iOS 基线落后于桌面端」。
        let stale = String(repeating: "0", count: 64)
        let outcome = try await driver.sync(
            context: context,
            overrideDeletes: ["record": [SyncDelete(id: record.id.uuidString, expectedFingerprint: stale)]]
        )
        XCTAssertEqual(outcome.conflicts, 1, "指纹不符时必须进删除冲突")
        XCTAssertEqual(outcome.failed, 0, "删除冲突不是失败：\(outcome.failures)")
    }
}
