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

    /// 画布铺得开时，缩略图不能把八个名额全用在左上角那几张旧卡上：
    /// 远端的节点也要有代表，否则封面看起来像「画布只有一角有东西」。
    func testSelectionSpreadsAcrossTheWholeCanvas() throws {
        var records: [Record] = []
        var nodes: [CanvasNode] = []
        // 八张同载体的旧卡挤在左上角。
        for index in 0..<8 {
            let record = makeRecord(.text, "角落 \(index)")
            records.append(record)
            nodes.append(makeNode(record, x: CGFloat(index) * 8, y: CGFloat(index) * 8,
                                  createdAt: TimeInterval(index)))
        }
        // 两张后来才加的卡，摊在很远的右下角。
        for offset in 0..<2 {
            let record = makeRecord(.text, "远处 \(offset)")
            records.append(record)
            nodes.append(makeNode(record, x: 2_400 + CGFloat(offset) * 260, y: 1_800,
                                  createdAt: 100 + TimeInterval(offset)))
        }

        let data = try XCTUnwrap(CanvasThumbnailData.make(nodes: nodes, records: records))
        XCTAssertEqual(data.items.count, CanvasThumbnailData.limit)
        let farIDs = Set(nodes.suffix(2).map(\.id))
        XCTAssertTrue(data.items.contains { farIDs.contains($0.id) },
                      "远处的节点必须在缩略图里占一个位置")
        XCTAssertEqual(data.bounds.maxX, 2_880, accuracy: 0.001,
                       "包围盒仍然覆盖全部节点")
    }

    /// 选中顺序与输入顺序无关：把同一批节点倒着喂进去，结果一样。
    func testSpatialSelectionIsDeterministicRegardlessOfInputOrder() {
        var records: [Record] = []
        var nodes: [CanvasNode] = []
        for index in 0..<10 {
            let record = makeRecord(index.isMultiple(of: 2) ? .text : .image, "第 \(index) 条")
            records.append(record)
            nodes.append(makeNode(record, x: CGFloat(index) * 300, y: CGFloat(index % 3) * 200,
                                  createdAt: TimeInterval(index)))
        }

        let forward = CanvasThumbnailData.make(nodes: nodes, records: records)
        let backward = CanvasThumbnailData.make(nodes: nodes.reversed(), records: records)
        XCTAssertEqual(forward, backward)
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
