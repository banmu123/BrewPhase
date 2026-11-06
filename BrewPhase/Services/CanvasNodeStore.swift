import CoreGraphics
import Foundation
import SwiftData

/// CanvasNode 的全部写操作入口。
///
/// 节点用 UUID 引用画布与记录（没有 SwiftData 关系），所以「删除源记录要清掉
/// 引用它的节点」这件事必须由应用层显式完成。把这些清理集中在一个类型里，
/// 而不是散落在 Records/Canvas/示例数据的删除路径上——散开一次，就会有一条
/// 路径忘记清，留下点开就崩的空节点。
enum CanvasNodeStore {

    // MARK: - 读取

    static func nodes(in canvasID: UUID, context: ModelContext) -> [CanvasNode] {
        let descriptor = FetchDescriptor<CanvasNode>(
            predicate: #Predicate { $0.canvasID == canvasID },
            sortBy: [SortDescriptor(\.zIndex), SortDescriptor(\.createdAt)]
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    static func nodes(referencing recordID: UUID, context: ModelContext) -> [CanvasNode] {
        let descriptor = FetchDescriptor<CanvasNode>(
            predicate: #Predicate { $0.recordID == recordID }
        )
        return (try? context.fetch(descriptor)) ?? []
    }

    static func existingRecordIDs(in canvasID: UUID, context: ModelContext) -> Set<UUID> {
        Set(nodes(in: canvasID, context: context).map(\.recordID))
    }

    // MARK: - 添加

    /// 节点的默认逻辑尺寸。按载体给一个「一眼能认出内容」的大小，图片按
    /// 真实宽高比（读不到就 4:3），但都钳在可阅读的范围内。
    static func defaultSize(for record: Record) -> CGSize {
        switch record.carrier {
        case .image:
            let ratio = ImageStore.shared.imageDimensions(named: record.mediaPath)?.aspectRatio
                ?? RecordCardHeightEstimator.placeholderAspectRatio
            let width: CGFloat = 220
            let height = min(max(width / max(ratio, 0.1), 140), 320)
            return CGSize(width: width, height: height)
        case .video:
            return CGSize(width: 240, height: 210)
        case .link:
            return CGSize(width: 240, height: 220)
        case .text:
            return CGSize(width: 220, height: 170)
        }
    }

    /// 把一批记录放进画布。同一画布内按 `recordID` 去重（数据库不保证复合
    /// 唯一性，应用层必须自己保证），位置由 `CanvasPlacement` 在当前可见区里
    /// 找空位。返回真正新建的节点。
    @discardableResult
    static func add(_ records: [Record],
                    to canvas: Canvas,
                    visibleWorldRect: CGRect,
                    context: ModelContext) throws -> [CanvasNode] {
        let existing = nodes(in: canvas.id, context: context)
        let known = Set(existing.map(\.recordID))
        let fresh = records.filter { !known.contains($0.id) }
        guard !fresh.isEmpty else { return [] }

        let sizes = fresh.map(defaultSize)
        let origins = CanvasPlacement.origins(sizes: sizes,
                                              occupied: existing.map(\.frame),
                                              in: visibleWorldRect)
        var zIndex = existing.map(\.zIndex).max() ?? 0
        var created: [CanvasNode] = []

        for (index, record) in fresh.enumerated() {
            zIndex += 1
            let node = CanvasNode(canvasID: canvas.id,
                                  recordID: record.id,
                                  positionX: origins[index].x,
                                  positionY: origins[index].y,
                                  width: sizes[index].width,
                                  height: sizes[index].height,
                                  zIndex: zIndex)
            context.insert(node)
            created.append(node)
        }
        canvas.touch()

        do {
            try context.save()
        } catch {
            context.rollback()
            throw error
        }
        return created
    }

    /// 移动一个节点并落库。拖动过程只改内存状态，结束时才走这里。
    /// 画布的 `updatedAt` 跟着走：列表按「最近编辑」排序，也靠它刷新缩略图。
    static func move(_ node: CanvasNode, to origin: CGPoint, context: ModelContext) {
        node.move(to: origin)
        node.touch()
        touchCanvas(node.canvasID, context: context)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas node move failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }

    /// 画布备注是节点自己的字段，只更新节点与画布时间，不碰 Record。
    static func setAnnotation(_ text: String, on node: CanvasNode, context: ModelContext) {
        node.annotation = text.trimmed
        node.touch()
        touchCanvas(node.canvasID, context: context)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas annotation failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }

    /// 从画布移除一个节点。**只删节点**，源记录原样保留。
    static func remove(_ node: CanvasNode, context: ModelContext) {
        let canvasID = node.canvasID
        context.delete(node)
        touchCanvas(canvasID, context: context)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas node remove failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }

    // MARK: - 级联清理（不单独 save，和调用方的删除同一次提交）

    /// 画布时间：只在节点集合或摆放真的变了之后更新，不在拖动过程中调用。
    static func touchCanvas(_ canvasID: UUID, context: ModelContext) {
        var descriptor = FetchDescriptor<Canvas>(predicate: #Predicate { $0.id == canvasID })
        descriptor.fetchLimit = 1
        (try? context.fetch(descriptor))?.first?.touch()
    }

    /// 源记录被删除前调用：清掉所有画布里引用它的节点。
    /// 不在这里 `save()`——调用方随后删记录，并在同一个事务里提交；
    /// 失败时 `rollback()` 会把节点一并恢复。
    static func deleteNodes(referencing recordID: UUID, context: ModelContext) {
        for node in nodes(referencing: recordID, context: context) {
            context.delete(node)
        }
    }

    /// 画布被删除前调用：清掉这块画布上的全部节点。
    static func deleteNodes(in canvasID: UUID, context: ModelContext) {
        for node in nodes(in: canvasID, context: context) {
            context.delete(node)
        }
    }

    /// 删除示例数据：只清挂在示例画布上、或引用示例记录的节点。
    static func deleteSampleNodes(records: [Record], canvases: [Canvas], context: ModelContext) {
        let recordIDs = Set(records.map(\.id))
        let canvasIDs = Set(canvases.map(\.id))
        let all = (try? context.fetch(FetchDescriptor<CanvasNode>())) ?? []
        for node in all where recordIDs.contains(node.recordID) || canvasIDs.contains(node.canvasID) {
            context.delete(node)
        }
    }
}
