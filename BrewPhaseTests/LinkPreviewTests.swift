import XCTest
@testable import BrewPhase

/// 网页元数据解析。
///
/// 只测解析，不测网络：抓取是否成功取决于对方的服务器，而「属性顺序不同也能认出
/// og:title」这件事是纯粹的字符串处理，值得钉住——它一旦坏了，所有链接都会退回
/// 到「未命名链接」。
final class LinkPreviewTests: XCTestCase {

    func testMetaTagsFindValuesRegardlessOfAttributeOrder() {
        let html = """
        <html><head>
        <meta property="og:title" content="A &amp; B">
        <meta content="Standart" property="og:site_name">
        <meta name="description" content="ordinary">
        </head></html>
        """
        let tags = LinkPreviewService.metaTags(in: html)
        XCTAssertEqual(tags.first { $0.key == "og:title" }?.content, "A & B")
        XCTAssertEqual(tags.first { $0.key == "og:site_name" }?.content, "Standart")
        XCTAssertEqual(tags.first { $0.key == "description" }?.content, "ordinary")
    }

    func testMetaTagsAcceptSingleQuotes() {
        let html = "<meta property='og:title' content='Hello'/>"
        XCTAssertEqual(LinkPreviewService.metaTags(in: html).first?.content, "Hello")
    }

    func testTitleTagIsTheFallback() {
        let html = "<html><head><title>\n  手冲的水温  \n</title></head></html>"
        XCTAssertEqual(LinkPreviewService.titleTag(in: html)?.trimmed, "手冲的水温")
    }

    func testNumericEntitiesAreDecoded() {
        XCTAssertEqual(LinkPreviewService.decodeEntities("It&#8217;s here"), "It’s here")
        XCTAssertEqual(LinkPreviewService.decodeEntities("&lt;b&gt; &amp; &quot;x&quot;"), "<b> & \"x\"")
    }

    func testPageWithoutMetaYieldsNoTags() {
        XCTAssertTrue(LinkPreviewService.metaTags(in: "<html><body>hi</body></html>").isEmpty)
        XCTAssertNil(LinkPreviewService.titleTag(in: "<html><body>hi</body></html>"))
    }
}
