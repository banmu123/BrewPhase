import XCTest
@testable import BrewPhase

/// 画布缩略图的数据契约：选点确定、包围盒覆盖全部节点、数量有上限。
///
/// 缩略图不渲染完整卡片，也不创建任何播放器——这里验证的是「画哪些、画在哪」
/// 这件事本身，视觉效果留给真机。
final class CanvasThumbnailDataTests: XCTestCase {

    private let canvasID = UUID()

    private func makeRecord(_ carrier: RecordCarrier, _ title: String) -> Record {
        Record(carrier: carrier, title: title, note: title)
    }

    private func makeNode(_ record: Record, x: CGFloat, y: CGFloat,
                          createdAt: TimeInterval) -> CanvasNode {
        CanvasNode(canvasID: canvasID, recordID: record.id,
                   positionX: x, positionY: y,
                   width: 220, height: 170,
                   createdAt: Date(timeIntervalSince1970: createdAt))
    }

    func testPicksOneOfEachCarrierFirst() {
        let text = makeRecord(.text, "文字")
        let image = makeRecord(.image, "图片")
        let link = makeRecord(.link, "链接")
        let video = makeRecord(.video, "视频")
        let nodes = [
            makeNode(text, x: 0, y: 0, createdAt: 1),
            makeNode(image, x: 300, y: 0, createdAt: 2),
            makeNode(link, x: 600, y: 0, createdAt: 3),
            makeNode(video, x: 900, y: 0, createdAt: 4),
        ]

        let data = CanvasThumbnailData.make(nodes: nodes, records: [text, image, link, video])
        let carriers = Set(data!.items.compactMap { item in
            [text, image, link, video].first { $0.id == item.recordID }?.carrier
        })
        XCTAssertEqual(carriers, Set(RecordCarrier.allCases), "四种载体各有一个代表")
    }

    func testCapsAtTheLimit() {
        let records = (0..<20).map { makeRecord(.text, "第 \($0) 条") }
        let nodes = records.enumerated().map {
            makeNode($0.element, x: CGFloat($0.offset) * 40, y: 0,
                     createdAt: TimeInterval($0.offset))
        }

        let data = CanvasThumbnailData.make(nodes: nodes, records: records)
        XCTAssertEqual(data?.items.count, CanvasThumbnailData.limit)
        XCTAssertEqual(data?.total, 20)
    }

    /// 包围盒用**全部节点**算，不是只算被画出来的那 8 个——否则缩略图会把
    /// 画布的留白裁掉，看起来比实际更挤。
    func testBoundsCoverEveryNodeNotOnlyThePickedOnes() throws {
        let far = makeRecord(.text, "很远的一条")
        let near = makeRecord(.image, "近的一条")
        let nodes = [
            makeNode(near, x: 0, y: 0, createdAt: 1),
            makeNode(far, x: 1_000, y: 800, createdAt: 2),
        ]

        let data = try XCTUnwrap(CanvasThumbnailData.make(nodes: nodes, records: [near, far]))
        XCTAssertEqual(data.bounds.minX, 0, accuracy: 0.001)
        XCTAssertEqual(data.bounds.minY, 0, accuracy: 0.001)
        XCTAssertEqual(data.bounds.maxX, 1_220, accuracy: 0.001)
        XCTAssertEqual(data.bounds.maxY, 970, accuracy: 0.001)
    }

    func testEmptyCanvasHasNoPreviewData() {
        XCTAssertNil(CanvasThumbnailData.make(nodes: [], records: []))
    }

    func testSelectionIsDeterministic() {
        let records = (0..<12).map { makeRecord(.text, "记录 \($0)") }
        let nodes = records.enumerated().map {
            makeNode($0.element, x: CGFloat($0.offset) * 40, y: 0,
                     createdAt: TimeInterval($0.offset))
        }

        let first = CanvasThumbnailData.make(nodes: nodes, records: records)
        let second = CanvasThumbnailData.make(nodes: nodes.reversed(), records: records)
        XCTAssertEqual(first, second, "同一块画布每次打开都必须得到同一张缩略图")
    }

    /// 节点指向的记录已经不在了：跳过它，其余照常画。
    func testMissingRecordIsSkipped() throws {
        let alive = makeRecord(.text, "还在")
        let orphanNode = CanvasNode(canvasID: canvasID, recordID: UUID(),
                                    positionX: 500, positionY: 500,
                                    width: 220, height: 170)
        let nodes = [makeNode(alive, x: 0, y: 0, createdAt: 1), orphanNode]

        let data = try XCTUnwrap(CanvasThumbnailData.make(nodes: nodes, records: [alive]))
        XCTAssertEqual(data.items.count, 1)
        XCTAssertEqual(data.items.first?.recordID, alive.id)
    }
}
