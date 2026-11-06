import XCTest
@testable import BrewPhase

/// 详情页的「只说一遍」契约。
///
/// 详情页不缺少字段，它的问题是同一件事可能出现在两处：文字记录的正文被
/// 当成备注再显示一次、链接摘要与标题本来就是同一句话、域名既当标题又当
/// 来源。这些判断都在 `RecordDetailPresentation` 里，这里逐条钉死。
final class RecordDetailPresentationTests: XCTestCase {

    // MARK: - 文字

    /// 文字记录：note 是原文，进内容区；绝不能同时出现在「我的备注」。
    func testTextNoteIsTheContentNotAPersonalNote() {
        let record = Record(carrier: .text, title: "周一", note: "第一行\n第二行")
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "周一")
        XCTAssertEqual(view.content, "第一行\n第二行", "正文保留原始换行")
        XCTAssertNil(view.personalNote, "文字记录不进入备注区")
    }

    /// 没有标题的文字记录：标题区留空，正文仍然是正文。
    func testTextWithoutTitleHasNoPromotedTitle() {
        let record = Record(carrier: .text, note: "只写了一句")
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "")
        XCTAssertEqual(view.content, "只写了一句")
    }

    /// 空正文不占内容区。
    func testEmptyTextHasNoContent() {
        let record = Record(carrier: .text, title: "只有标题")
        XCTAssertNil(RecordDetailPresentation(record: record).content)
    }

    // MARK: - 图片 / 视频

    /// 图片没有标题时，不能拿备注首行冒充标题——否则备注会出现两次。
    func testImageWithoutTitleDoesNotPromoteTheNote() {
        let record = Record(carrier: .image, note: "第一行备注\n第二行")
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "")
        XCTAssertEqual(view.personalNote, "第一行备注\n第二行")
        XCTAssertNil(view.content)
    }

    func testImageWithTitleKeepsTheTitle() {
        let record = Record(carrier: .image, title: "滤杯", note: "今天的光")
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "滤杯")
        XCTAssertEqual(view.personalNote, "今天的光")
    }

    func testVideoUsesPersonalNote() {
        let record = Record(carrier: .video, title: "一段视频", note: "拍糊了")
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "一段视频")
        XCTAssertEqual(view.personalNote, "拍糊了")
        XCTAssertNil(view.sourceURL, "本地视频没有外部来源")
    }

    // MARK: - 链接

    func testYouTubeTitleComesFromTheVideoAndSummaryIsNotRepeated() {
        let record = Record(carrier: .link, urlString: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        record.summary = "Me at the zoo"
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "Me at the zoo", "视频标题就是标题")
        XCTAssertNil(view.content, "标题已经承载摘要，内容区不再复述")
        XCTAssertNotNil(view.sourceURL)
    }

    /// 普通网页：用户写了标题，摘要才是补充说明。
    func testGenericLinkShowsSummaryWhenTheUserWroteATitle() {
        let record = Record(carrier: .link, title: "一篇文章",
                            urlString: "https://example.com/post")
        record.summary = "文章的第一段"
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "一篇文章")
        XCTAssertEqual(view.content, "文章的第一段")
    }

    /// 普通网页没有用户标题：摘要就是内容，标题区留空，不截断也不重复。
    func testGenericLinkWithoutTitleKeepsTheSummaryWhole() {
        let record = Record(carrier: .link, urlString: "https://example.com/post")
        record.summary = "第一行\n第二行"
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "")
        XCTAssertEqual(view.content, "第一行\n第二行")
    }

    /// 标题与摘要恰好是同一句话：只留一处。
    func testIdenticalTitleAndSummaryCollapse() {
        let record = Record(carrier: .link, title: "同样的句子",
                            urlString: "https://example.com/post")
        record.summary = "同样的句子"

        XCTAssertNil(RecordDetailPresentation(record: record).content)
    }

    /// X：帖子正文是内容，不是标题；作者进 credit。
    func testPostBodyIsContentAndTheAuthorIsTheCredit() {
        let record = Record(carrier: .link, urlString: "https://x.com/jack/status/20")
        record.summary = "just setting up my twttr"
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "")
        XCTAssertEqual(view.content, "just setting up my twttr")
        XCTAssertEqual(view.credit, "@jack")
    }

    /// GitHub：仓库名是标题、描述是内容，owner 在标题区，credit 不重复。
    func testRepositoryNameIsTheTitleAndTheDescriptionIsTheContent() {
        let record = Record(carrier: .link, urlString: "https://github.com/banmu123/BrewPhase")
        record.providerRaw = LinkProvider.github.rawValue
        record.platformContentID = "banmu123/BrewPhase"
        record.summary = "A personal coffee studio."
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "BrewPhase")
        XCTAssertEqual(view.content, "A personal coffee studio.")
        XCTAssertNil(view.credit, "owner 已经在标题区，不再单列作者")
    }

    /// 没有任何标题与摘要的链接：标题区留空，域名只由来源区承担，
    /// 不把「example.com」抬成标题再说一遍。
    func testBareLinkDoesNotPromoteTheHostToATitle() {
        let record = Record(carrier: .link, urlString: "https://example.com/post")
        let view = RecordDetailPresentation(record: record)

        XCTAssertEqual(view.title, "")
        XCTAssertNil(view.content)
        XCTAssertNotNil(view.sourceURL)
    }

    /// 作者名与标题相同：不重复。
    func testCreditMatchingTheTitleIsDropped() {
        let record = Record(carrier: .link, title: "@jack",
                            urlString: "https://x.com/jack/status/20")
        record.summary = "帖子正文"

        XCTAssertNil(RecordDetailPresentation(record: record).credit)
    }

    // MARK: - 来源

    func testSourceURLComesFromTheRecordOnlyForLinks() {
        let link = Record(carrier: .link, urlString: "example.com/post")
        XCTAssertEqual(RecordDetailPresentation(record: link).sourceURL?.absoluteString,
                       "https://example.com/post")

        let text = Record(carrier: .text, note: "一句话")
        XCTAssertNil(RecordDetailPresentation(record: text).sourceURL)
    }

    /// 无效地址：来源区与菜单项都不出现，不留一个点了没反应的入口。
    func testInvalidLinkHasNoSource() {
        let record = Record(carrier: .link, title: "不是链接", urlString: "不是链接")
        XCTAssertNil(RecordDetailPresentation(record: record).sourceURL)
    }

    // MARK: - 备注

    func testBlankNoteIsNotShown() {
        let record = Record(carrier: .image, title: "图", note: "   \n  ")
        XCTAssertNil(RecordDetailPresentation(record: record).personalNote)
    }
}
