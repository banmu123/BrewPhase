import Foundation
import SwiftData

/// 画布内容的加载状态。
///
/// 存在的理由只有一个：**「读不到」不是「没有」**。空画布必须是「读取成功且
/// 确实零个节点」这唯一一种结论；查询失败、记录对账失败都要能被界面看见，
/// 而不是掉进空数组里，长成一块看起来正常的空画布。
enum CanvasLoadState: Equatable {
    /// 正在读取。只在还没有内容时显示加载指示，不覆盖上一屏。
    case loading
    /// 读取成功，且画布上有节点。
    case loaded
    /// 读取成功，画布确实是空的。
    case empty
    /// 读取失败。保留上一次成功加载的内容，界面给失败提示与重试。
    case failed(CanvasLoadFailure)

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}

enum CanvasLoadFailure: String, Equatable {
    /// 连节点都没读出来：什么都别显示，也别删；给提示与重试。
    case nodes
    /// 节点读到了，但源记录批量读取失败：节点保留，用占位卡占住位置。
    case records
}

/// 一次加载的结果：节点、记录缓存、以及这三者共同对应的状态。
///
/// 用值类型表达，而不是三个各自 `@State` 的变量——「失败时不能清空上一屏」
/// 这条约束才有地方落，也才能在离屏测试里断言。
struct CanvasContentLoad {
    var nodes: [CanvasNode]
    var recordsByID: [UUID: Record]
    var state: CanvasLoadState

    static let initial = CanvasContentLoad(nodes: [], recordsByID: [:], state: .loading)
}

/// 画布内容的唯一加载流程：读节点 → 与源记录对账。
///
/// 两条硬规矩：
/// 1. 任何一步失败都只**报告**，不删节点、不清缓存；
/// 2. 只有「节点读取成功且对账成功、且确实零个节点」才给出 `.empty`。
///
/// 取数与对账都可以注入，所以「数据库读失败时界面是什么状态」可以在单测里
/// 断言，而不必等一次线上故障。
enum CanvasContentLoader {

    typealias NodeFetch = (UUID, ModelContext) throws -> [CanvasNode]
    typealias Reconciler = ([CanvasNode], ModelContext) -> CanvasNodeReconciler.Outcome

    static func load(canvasID: UUID,
                     context: ModelContext,
                     previous: CanvasContentLoad,
                     nodeFetch: NodeFetch = CanvasNodeStore.nodes(in:context:),
                     reconcile: Reconciler = { nodes, context in
                         CanvasNodeReconciler.reconcile(nodes: nodes, context: context)
                     },
                     simulatedFailure: CanvasLoadFailure? = nil) -> CanvasContentLoad {
        // 验收用：人为制造失败，好让「失败态 + 重试」在模拟器上看得见。
        // 正常运行时永远是 nil。
        if simulatedFailure == .nodes {
            return CanvasContentLoad(nodes: previous.nodes,
                                     recordsByID: previous.recordsByID,
                                     state: .failed(.nodes))
        }

        let nodes: [CanvasNode]
        do {
            nodes = try nodeFetch(canvasID, context)
        } catch {
            AppLog.store.error("canvas: node load failed, keeping \(previous.nodes.count) node(s) — \(error.localizedDescription, privacy: .public)")
            return CanvasContentLoad(nodes: previous.nodes,
                                     recordsByID: previous.recordsByID,
                                     state: .failed(.nodes))
        }

        if simulatedFailure == .records {
            return CanvasContentLoad(nodes: nodes, recordsByID: [:], state: .failed(.records))
        }

        let outcome = reconcile(nodes, context)
        if outcome.didFail {
            // 记录读不到：节点与上一次的记录缓存都保留，界面用占位卡撑住位置。
            return CanvasContentLoad(nodes: nodes,
                                     recordsByID: previous.recordsByID,
                                     state: .failed(.records))
        }

        let purged = Set(outcome.purgedNodeIDs)
        let kept = purged.isEmpty ? nodes : nodes.filter { !purged.contains($0.id) }
        return CanvasContentLoad(nodes: kept,
                                 recordsByID: outcome.recordsByID,
                                 state: kept.isEmpty ? .empty : .loaded)
    }
}
