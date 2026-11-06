import Foundation
import SwiftData

/// 模拟器验收用的画布样例：把最近几条记录摆进第一块画布。
///
/// 存在的理由和 `DebugScreen` 其它入口一样：`simctl` 不能点击，而「退出画布再
/// 进来，节点还在不在」这条路必须真的进一次工作区才能看。它只在启动参数
/// `-BrewPhaseCanvasSeed yes` 时执行，**幂等**（画布上已有节点就什么都不做），
/// 正常运行时是死代码。
enum CanvasDebugSeed {

    static var isRequested: Bool {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-BrewPhaseCanvasSeed") else { return false }
        let next = args.indices.contains(index + 1) ? args[index + 1] : "yes"
        return next != "no" && next != "false" && next != "0"
    }

    /// - Returns: 用来打开工作区的那块画布。没有画布时返回 nil。
    @discardableResult
    static func prepare(context: ModelContext) -> Canvas? {
        guard let canvas = workspaceCanvas(context: context) else { return nil }
        guard isRequested else { return canvas }
        seedNodes(on: canvas, context: context)
        return canvas
    }

    private static func seedNodes(on canvas: Canvas, context: ModelContext) {
        let existing = (try? CanvasNodeStore.nodes(in: canvas.id, context: context)) ?? []
        guard existing.isEmpty else { return }

        let records = (try? context.fetch(
            FetchDescriptor<Record>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        )) ?? []
        guard !records.isEmpty else { return }

        // 四种载体尽量都来一条，缩略图与节点样式才有东西可看。
        var picked: [Record] = []
        for carrier in RecordCarrier.allCases {
            if let match = records.first(where: { $0.carrier == carrier }) {
                picked.append(match)
            }
        }
        for record in records where picked.count < 4 && !picked.contains(where: { $0.id == record.id }) {
            picked.append(record)
        }
        guard !picked.isEmpty else { return }

        let created = (try? CanvasNodeStore.add(
            picked, to: canvas,
            visibleWorldRect: CGRect(x: 0, y: 0, width: 390, height: 700),
            context: context
        )) ?? []

        // 把第一条挪到一个负的世界坐标：这正是「装窗算早了」会把整块画布
        // 甩到屏幕外的那种布局，用来验收重新进入时的装窗逻辑。
        if let first = created.first {
            CanvasNodeStore.move(first, to: CGPoint(x: -620, y: -480), context: context)
        }
        AppLog.store.info("canvas debug seed: \(created.count) node(s) placed")
    }

    /// `-BrewPhaseCanvasFailLoad nodes|records`：人为让加载失败。
    ///
    /// 模拟器上制造不出真正的数据库故障，而「失败态 + 重试」正是这一版要验收的
    /// 界面。只影响这一次加载，不改任何数据。
    static var simulatedLoadFailure: CanvasLoadFailure? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-BrewPhaseCanvasFailLoad"),
              args.indices.contains(index + 1) else { return nil }
        return CanvasLoadFailure(rawValue: args[index + 1])
    }

    /// `-BrewPhaseCanvasPicker yes`：进画布后直接把「添加记录」面板打开。
    static var opensPicker: Bool {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-BrewPhaseCanvasPicker") else { return false }
        let next = args.indices.contains(index + 1) ? args[index + 1] : "yes"
        return next != "no" && next != "false" && next != "0"
    }

    /// 工作区要打开的那块画布：优先示例/最近编辑那块。
    static func workspaceCanvas(context: ModelContext) -> Canvas? {
        var descriptor = FetchDescriptor<Canvas>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
        descriptor.fetchLimit = 1
        return (try? context.fetch(descriptor))?.first
    }
}
