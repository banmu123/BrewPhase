import SwiftData
import SwiftUI

/// 一块画布在列表里的缩略内容：节点按世界坐标缩放到封面里。
///
/// 它不渲染完整的 `CanvasNodeCard`：不创建播放器、不建 WebView、不请求网络、
/// 不读原图。每一块只取最多 8 个有代表性的节点（四种载体各一个，再按创建
/// 时间补齐），并且**用全部节点计算包围盒**——缩略图看的是真实的空间关系，
/// 不是把四张图排成网格。
struct CanvasThumbnailPreview: View {

    let canvas: Canvas
    var height: CGFloat = 96

    @Environment(\.modelContext) private var context
    @State private var data: CanvasThumbnailData?
    @State private var recordsByID: [UUID: Record] = [:]

    var body: some View {
        ZStack {
            if let data, !data.items.isEmpty {
                composition(data)
            } else {
                CanvasCover(name: canvas.name, height: height)
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .background(Palette.well.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
        .task(id: canvas.updatedAt) { load() }
    }

    private func composition(_ data: CanvasThumbnailData) -> some View {
        GeometryReader { geo in
            let layout = ThumbnailLayout(data: data, size: geo.size)
            ZStack(alignment: .topLeading) {
                ForEach(data.items) { item in
                    if let record = recordsByID[item.recordID] {
                        itemView(record)
                            .frame(width: layout.size(of: item).width,
                                   height: layout.size(of: item).height)
                            .position(layout.center(of: item))
                    }
                }

                if data.total > data.items.count {
                    Text(verbatim: "+\(data.total - data.items.count)")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Palette.inkFaint)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Palette.card.opacity(0.9)))
                        .padding(6)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                }
            }
        }
    }

    @ViewBuilder
    private func itemView(_ record: Record) -> some View {
        switch record.carrier {
        case .image:
            previewImage(record.mediaPath, symbol: "photo")
        case .video:
            previewImage(record.previewPath, symbol: "play.rectangle")
        case .link:
            if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                Image(uiImage: image).resizable().scaledToFill().clipped()
            } else {
                tintedBlock(symbol: record.provider.symbol)
            }
        case .text:
            textBlock
        }
    }

    private func previewImage(_ path: String?, symbol: String) -> some View {
        Group {
            if let image = ImageStore.shared.image(named: path, thumbnail: true) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                tintedBlock(symbol: symbol)
            }
        }
        .clipped()
    }

    private func tintedBlock(symbol: String) -> some View {
        ZStack {
            Palette.cream
            Image(systemName: symbol)
                .font(.system(size: 7, weight: .light))
                .foregroundStyle(Palette.inkFaint.opacity(0.7))
        }
    }

    /// 文字节点用几行细线表示——缩略图尺寸下，真文字读不出来，块面反而更诚实。
    private var textBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Capsule().fill(Palette.inkSoft.opacity(0.55)).frame(height: 2.5)
            Capsule().fill(Palette.inkFaint.opacity(0.45)).frame(height: 1.6)
            Capsule().fill(Palette.inkFaint.opacity(0.45)).frame(height: 1.6)
            Spacer(minLength: 0)
        }
        .padding(4)
        .background(Palette.card)
    }

    private func load() {
        let nodes = CanvasNodeStore.nodes(in: canvas.id, context: context)
        guard !nodes.isEmpty else {
            data = nil
            recordsByID = [:]
            return
        }
        let ids = Array(Set(nodes.map(\.recordID)))
        let descriptor = FetchDescriptor<Record>(predicate: #Predicate { ids.contains($0.id) })
        let records = (try? context.fetch(descriptor)) ?? []
        recordsByID = Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0) })
        data = CanvasThumbnailData.make(nodes: nodes, records: records)
    }
}

// MARK: - 缩略图数据

/// 缩略图要画哪些节点、画在多大的范围里。纯值类型，便于离屏验证
/// 「选点确定性」与「包围盒包含全部节点」。
struct CanvasThumbnailData: Equatable {

    struct Item: Identifiable, Equatable {
        let id: UUID
        let recordID: UUID
        /// 世界坐标里的摆放。
        let frame: CGRect
    }

    /// 最多画几个节点：再多封面就糊成一团了。
    static let limit = 8

    let items: [Item]
    /// 全部节点（不只是被选中的）的包围盒。
    let bounds: CGRect
    /// 画布上实际有多少节点。
    let total: Int

    static func make(nodes: [CanvasNode], records: [Record],
                     limit: Int = CanvasThumbnailData.limit) -> CanvasThumbnailData? {
        guard !nodes.isEmpty else { return nil }
        guard let bounds = CanvasViewport.contentBounds(nodes.map(\.frame)) else { return nil }

        let recordsByID = Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0) })
        let ordered = nodes.sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }

        // 四种载体各先来一个：缩略图要让人一眼看出「这块画布装了什么」。
        var selected: [CanvasNode] = []
        var used = Set<UUID>()
        for carrier in RecordCarrier.allCases {
            if let match = ordered.first(where: {
                !used.contains($0.id) && recordsByID[$0.recordID]?.carrier == carrier
            }) {
                selected.append(match)
                used.insert(match.id)
            }
        }
        for node in ordered where selected.count < limit && !used.contains(node.id) {
            selected.append(node)
            used.insert(node.id)
        }

        let items = selected.prefix(limit).compactMap { node -> Item? in
            guard recordsByID[node.recordID] != nil else { return nil }
            return Item(id: node.id, recordID: node.recordID, frame: node.frame)
        }
        guard !items.isEmpty else { return nil }
        return CanvasThumbnailData(items: Array(items), bounds: bounds, total: nodes.count)
    }
}

/// 缩略图里节点的尺寸与位置：把世界包围盒等比装进封面。
private struct ThumbnailLayout {

    let data: CanvasThumbnailData
    let size: CGSize
    var padding: CGFloat = 10

    private var scale: CGFloat {
        let available = CGSize(width: max(1, size.width - padding * 2),
                               height: max(1, size.height - padding * 2))
        return min(available.width / max(data.bounds.width, 1),
                   available.height / max(data.bounds.height, 1))
    }

    private var origin: CGPoint {
        CGPoint(x: (size.width - data.bounds.width * scale) / 2,
                y: (size.height - data.bounds.height * scale) / 2)
    }

    func size(of item: CanvasThumbnailData.Item) -> CGSize {
        CGSize(width: max(6, item.frame.width * scale),
               height: max(5, item.frame.height * scale))
    }

    func center(of item: CanvasThumbnailData.Item) -> CGPoint {
        CGPoint(x: origin.x + (item.frame.midX - data.bounds.minX) * scale,
                y: origin.y + (item.frame.midY - data.bounds.minY) * scale)
    }
}
