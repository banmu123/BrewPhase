import SwiftData
import XCTest
@testable import BrewPhase

/// 记录与标签里属于「显示逻辑」的那部分。
///
/// 它们不碰数据库：卡片标题、链接归一化、未知载体的回退、标签行的拼接，都是
/// 纯函数式的判断，出错的表现却很明显——空白标题、点不开的链接、四个载体里
/// 少一个。
final class RecordModelTests: XCTestCase {

    override func setUp() {
        super.setUp()
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    // MARK: - 标题

    func testTitleFallsBackToTheFirstLineOfTheNote() {
        let record = Record(carrier: .text, note: "第一行\n第二行")
        XCTAssertEqual(record.displayTitle, "第一行")
    }

    func testTitleWinsOverTheNote() {
        let record = Record(carrier: .text, title: "换城市之后", note: "正文")
        XCTAssertEqual(record.displayTitle, "换城市之后")
    }

    func testBlankRecordHasNoTitle() {
        XCTAssertEqual(Record(carrier: .text).displayTitle, "")
    }

    // MARK: - 载体

    func testUnknownCarrierFallsBackInsteadOfCrashing() {
        let record = Record(carrier: .link)
        record.carrierRaw = "podcast"      // 更新的版本可能写入的载体
        XCTAssertEqual(record.carrier, .text)
    }

    func testEveryCarrierHasItsOwnSymbol() {
        let symbols = Set(RecordCarrier.allCases.map(\.symbol))
        XCTAssertEqual(symbols.count, RecordCarrier.allCases.count)
    }

    // MARK: - 链接

    func testLinkHostDropsSchemeAndWWW() {
        let record = Record(carrier: .link, urlString: "https://www.example.com/posts/1")
        XCTAssertEqual(record.linkHost, "example.com")
        XCTAssertNotNil(record.resolvedLink)
    }

    func testLinkWithoutSchemeStillResolves() {
        let record = Record(carrier: .link, urlString: "github.com/banmu123/BrewPhase")
        XCTAssertEqual(record.resolvedLink?.absoluteString, "https://github.com/banmu123/BrewPhase")
        XCTAssertEqual(record.linkHost, "github.com")
    }

    func testGarbageLinkResolvesToNothing() {
        let record = Record(carrier: .link, urlString: "不是链接")
        XCTAssertNil(record.resolvedLink)
        XCTAssertNil(record.linkHost)
    }

    func testNonWebSchemesAreRejected() {
        // 只接受 http/https：`file:` 或自定义 scheme 不该被当成网页去抓。
        XCTAssertNil(Record(carrier: .link, urlString: "file:///etc/passwd").resolvedLink)
        XCTAssertNil(Record(carrier: .link, urlString: "javascript:alert(1)").resolvedLink)
    }

    func testEmptyLinkIsSimplyNoLink() {
        let record = Record(carrier: .link, urlString: "  ")
        XCTAssertNil(record.resolvedLink)
        XCTAssertNil(record.linkHost)
    }

    func testSourceLinePrefersTheCapturedSiteName() {
        let withName = Record(carrier: .link, urlString: "https://example.com/a", sourceName: "Example")
        XCTAssertEqual(withName.sourceLine, "Example")

        let withoutName = Record(carrier: .link, urlString: "https://example.com/a")
        XCTAssertEqual(withoutName.sourceLine, "example.com")
    }

    // MARK: - 标签

    func testTagsAreOrderedByCreation() {
        let record = Record(carrier: .text, note: "x")
        let first = RecordTag(name: "到访", createdAt: Date(timeIntervalSince1970: 100))
        let second = RecordTag(name: "随记", createdAt: Date(timeIntervalSince1970: 200))
        record.tags = [second, first]
        XCTAssertEqual(record.orderedTags.map(\.name), ["到访", "随记"])
    }

    func testTagLineCapsAtThreeAndCountsTheRest() {
        let record = Record(carrier: .text, note: "x")
        record.tags = ["a", "b", "c", "d", "e"].enumerated().map { index, name in
            RecordTag(name: name, createdAt: Date(timeIntervalSince1970: Double(index)))
        }
        XCTAssertEqual(record.tagLine, "a · b · c +2")
    }

    func testRecordWithoutTagsHasNoTagLine() {
        XCTAssertNil(Record(carrier: .text, note: "x").tagLine)
    }

    func testBlankTagFallsBackToAPlaceholder() {
        XCTAssertEqual(RecordTag(name: "   ").displayName, "未命名标签")
        XCTAssertEqual(RecordTag(name: "到访").displayName, "到访")
    }

    // MARK: - 画布

    func testCanvasFallsBackToAPlaceholderName() {
        XCTAssertEqual(Canvas().displayName, "未命名画布")
        XCTAssertEqual(Canvas(name: "  ").displayName, "未命名画布")
        XCTAssertEqual(Canvas(name: "咖啡探索").displayName, "咖啡探索")
    }

    // MARK: - 标签与记录的关系

    /// 删除标签只解除关联，记录一条都不能少——这是「标签不是分类」的底线。
    @MainActor
    func testDeletingATagKeepsItsRecords() throws {
        let schema = Schema([Record.self, RecordTag.self])
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        let context = ModelContext(container)

        let tag = RecordTag(name: "到访")
        let record = Record(carrier: .text, note: "午后坐了一小时")
        record.tags = [tag]
        context.insert(tag)
        context.insert(record)
        try context.save()
        XCTAssertEqual(record.tags?.count, 1)

        context.delete(tag)
        try context.save()

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Record>()), 1, "记录不能被标签带走")
        XCTAssertEqual(record.tags?.count ?? 0, 0, "关系要断开")
    }
}
