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

    /// 读取**会抛错**：把一次失败的查询伪装成「这块画布没有节点」，会让上层
    /// 误判成空画布、把已加入的记录当成新记录重复添加，甚至把节点当成孤儿删掉。
    /// 失败就得让调用方知道，由它决定「什么都不做」。
    static func nodes(in canvasID: UUID, context: ModelContext) throws -> [CanvasNode] {
        let descriptor = FetchDescriptor<CanvasNode>(
            predicate: #Predicate { $0.canvasID == canvasID },
            sortBy: [SortDescriptor(\.zIndex), SortDescriptor(\.createdAt)]
        )
        return try context.fetch(descriptor)
    }

    static func nodes(referencing recordID: UUID, context: ModelContext) throws -> [CanvasNode] {
        let descriptor = FetchDescriptor<CanvasNode>(
            predicate: #Predicate { $0.recordID == recordID }
        )
        return try context.fetch(descriptor)
    }

    static func existingRecordIDs(in canvasID: UUID, context: ModelContext) throws -> Set<UUID> {
        Set(try nodes(in: canvasID, context: context).map(\.recordID))
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
        // 去重必须建立在一次**成功**的读取上：读失败就当空集合，会把已经在
        // 画布上的记录再加一遍。
        let existing = try nodes(in: canvas.id, context: context)
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
    /// - Returns: 是否真的落库成功。界面据此决定要不要把它从渲染列表里拿掉——
    ///   保存失败时节点仍在库里，界面不该显示成「已经没了」。
    @discardableResult
    static func remove(_ node: CanvasNode, context: ModelContext) -> Bool {
        let canvasID = node.canvasID
        context.delete(node)
        touchCanvas(canvasID, context: context)
        do {
            try context.save()
            return true
        } catch {
            AppLog.store.error("canvas node remove failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return false
        }
    }

    // MARK: - 级联清理（不单独 save，和调用方的删除同一次提交）

    /// 画布时间：只在节点集合或摆放真的变了之后更新，不在拖动过程中调用。
    static func touchCanvas(_ canvasID: UUID, context: ModelContext) {
        var descriptor = FetchDescriptor<Canvas>(predicate: #Predicate { $0.id == canvasID })
        descriptor.fetchLimit = 1
        (try? context.fetch(descriptor))?.first?.touch()
    }

    /// 源记录被删除前调用：清掉所有画布里引用它的节点，并更新**仍然存在**的
    /// 那些画布的时间——缩略图靠 `canvas.updatedAt` 刷新，不更新就会一直显示
    /// 一张已经少了一条内容的旧封面。
    ///
    /// 不在这里 `save()`——调用方随后删记录，并在同一个事务里提交；
    /// 失败时 `rollback()` 会把节点与画布时间一并恢复。
    static func deleteNodes(referencing recordID: UUID, context: ModelContext) {
        let doomed: [CanvasNode]
        do {
            doomed = try nodes(referencing: recordID, context: context)
        } catch {
            // 读不出来就一条都不删：宁可留下稍后能自愈的孤儿节点，
            // 也不要凭一次失败的查询去猜该删谁。
            AppLog.store.error("canvas: node lookup failed, no cascade — \(error.localizedDescription, privacy: .public)")
            return
        }
        for node in doomed { context.delete(node) }
        for canvasID in Set(doomed.map(\.canvasID)) {
            touchCanvas(canvasID, context: context)
        }
    }

    /// 画布被删除前调用：清掉这块画布上的全部节点。
    static func deleteNodes(in canvasID: UUID, context: ModelContext) {
        let doomed: [CanvasNode]
        do {
            doomed = try nodes(in: canvasID, context: context)
        } catch {
            AppLog.store.error("canvas: node lookup failed, no cascade — \(error.localizedDescription, privacy: .public)")
            return
        }
        for node in doomed { context.delete(node) }
    }

    /// 删除示例数据：只清挂在示例画布上、或引用示例记录的节点。
    /// 如果一条节点挂在**真实画布**上（记录是示例的、画布不是），那块画布的时间
    /// 也要更新；被一起删掉的示例画布不需要。
    static func deleteSampleNodes(records: [Record], canvases: [Canvas], context: ModelContext) {
        let recordIDs = Set(records.map(\.id))
        let canvasIDs = Set(canvases.map(\.id))
        let all: [CanvasNode]
        do {
            all = try context.fetch(FetchDescriptor<CanvasNode>())
        } catch {
            AppLog.store.error("canvas: sample node lookup failed — \(error.localizedDescription, privacy: .public)")
            return
        }
        let doomed = all.filter {
            recordIDs.contains($0.recordID) || canvasIDs.contains($0.canvasID)
        }
        for node in doomed { context.delete(node) }
        for canvasID in Set(doomed.map(\.canvasID)) where !canvasIDs.contains(canvasID) {
            touchCanvas(canvasID, context: context)
        }
    }
}
