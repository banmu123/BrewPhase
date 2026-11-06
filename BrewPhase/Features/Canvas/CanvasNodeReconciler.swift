import Foundation
import SwiftData

/// 画布节点与源记录的对账：哪些记录还读得到、哪些节点确实成了孤儿。
///
/// 这一层存在的唯一理由是**数据安全**。视图在加载时顺手清理孤儿节点，而加载
/// 本身可能失败；把「读取失败」当成「记录都不存在」，就会在一次查询异常里删掉
/// 用户辛苦摆好的整块画布。所以判断与删除都收在这里，并且遵守两条硬规矩：
///
/// 1. 读取失败 → 一个节点都不删，返回 `didFail`，由调用方保留现状；
/// 2. 读取成功 → 只删确认取不到的那几条，同时更新受影响画布的时间
///    （列表排序与缩略图刷新都靠它）。
///
/// 判断逻辑与 `ModelContext` 的耦合只到「传进来一个 context」为止：真正取数可以
/// 注入（`fetch`），所以「读取失败不删节点」能离屏验证，不必等线上出一次故障。
enum CanvasNodeReconciler {

    struct Outcome {
        /// 成功读到的记录。失败时为空——调用方不要拿它覆盖已有内容。
        var recordsByID: [UUID: Record]
        /// 真正被清掉的节点。保存失败时为空（rollback 已经把删除撤销）。
        var purgedNodeIDs: [UUID]
        var didFail: Bool
        var failureMessage: String?

        static let empty = Outcome(recordsByID: [:], purgedNodeIDs: [], didFail: false)
    }

    typealias RecordFetch = ([UUID], ModelContext) throws -> [Record]

    static func reconcile(nodes: [CanvasNode],
                          context: ModelContext,
                          fetch: RecordFetch = CanvasNodeReconciler.fetchRecords) -> Outcome {
        let ids = Array(Set(nodes.map(\.recordID)))
        guard !ids.isEmpty else { return .empty }

        let found: [Record]
        do {
            found = try fetch(ids, context)
        } catch {
            // 关键：失败就是失败，不降级成「一条都没找到」。
            let message = error.localizedDescription
            AppLog.store.error("canvas: record fetch failed (\(ids.count) id(s)), keeping every node — \(String(describing: error), privacy: .public)")
            return Outcome(recordsByID: [:], purgedNodeIDs: [], didFail: true, failureMessage: message)
        }

        let mapped = Dictionary(found.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let orphans = nodes.filter { mapped[$0.recordID] == nil }
        guard !orphans.isEmpty else {
            return Outcome(recordsByID: mapped, purgedNodeIDs: [], didFail: false)
        }

        let purgedIDs = orphans.map(\.id)
        let canvasIDs = Set(orphans.map(\.canvasID))
        for node in orphans { context.delete(node) }
        for canvasID in canvasIDs { CanvasNodeStore.touchCanvas(canvasID, context: context) }
        do {
            try context.save()
        } catch {
            context.rollback()
            let message = error.localizedDescription
            AppLog.store.error("canvas: orphan cleanup rolled back — \(message, privacy: .public)")
            return Outcome(recordsByID: mapped, purgedNodeIDs: [],
                           didFail: true, failureMessage: message)
        }
        AppLog.store.info("canvas: purged \(purgedIDs.count) orphan node(s)")
        return Outcome(recordsByID: mapped, purgedNodeIDs: purgedIDs, didFail: false)
    }

    /// 一批 ID 一次取回：节点上的 `recordID` 是 UUID，`contains` 会翻成 `IN`。
    static func fetchRecords(_ ids: [UUID], _ context: ModelContext) throws -> [Record] {
        let descriptor = FetchDescriptor<Record>(predicate: #Predicate { ids.contains($0.id) })
        return try context.fetch(descriptor)
    }
}
