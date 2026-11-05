import SwiftData
import XCTest
@testable import BrewPhase

/// 链接识别、可信嵌入与元数据解码。
///
/// 这一组全部离线：不发一个请求，只喂字符串和 JSON。真正的网络解析由模拟器
/// 验收覆盖（B 站 / GitHub 的公开接口），这里钉住的是「认错平台」「拼错播放
/// 地址」「把用户给的 embed 地址当真」这一类不会在截图里显形、却最危险的问题。
final class LinkProviderTests: XCTestCase {

    override func setUp() {
        super.setUp()
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    private func match(_ raw: String) -> LinkMatch {
        guard let url = URL(string: raw) else {
            XCTFail("bad fixture: \(raw)")
            return LinkResolver.match(URL(string: "https://example.com")!)
        }
        return LinkResolver.match(url)
    }

    // MARK: - YouTube

    func testYouTubeWatchURL() {
        let result = match("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2")
        XCTAssertEqual(result.provider, .youtube)
        XCTAssertEqual(result.contentKind, .video)
        XCTAssertEqual(result.platformContentID, "dQw4w9WgXcQ")
        XCTAssertEqual(result.canonicalURL.absoluteString, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        let embed = LinkResolver.embed(provider: .youtube, contentID: result.platformContentID, url: nil)
        let text = embed?.url.absoluteString ?? ""
        XCTAssertTrue(text.hasPrefix("https://www.youtube.com/embed/dQw4w9WgXcQ?"), text)
        XCTAssertTrue(text.contains("playsinline=1"), text)
        XCTAssertFalse(text.lowercased().contains("autoplay=1"), "默认不允许自动播放：\(text)")
        XCTAssertFalse(text.contains("youtube-nocookie.com"), "App 内不用隐私增强模式：\(text)")
        XCTAssertEqual(embed?.allowedHosts, ["youtube.com"])
        XCTAssertEqual(embed?.parentOrigin?.absoluteString, "https://com.brewphase.ios/",
                       "包装页来源必须是应用自己的身份，而不是 youtube.com")
    }

    func testYouTubeShortForms() {
        let shorts = match("https://youtube.com/shorts/dQw4w9WgXcQ?feature=share")
        XCTAssertEqual(shorts.platformContentID, "dQw4w9WgXcQ")

        let short = match("https://youtu.be/dQw4w9WgXcQ?si=tracking")
        XCTAssertEqual(short.provider, .youtube)
        XCTAssertEqual(short.platformContentID, "dQw4w9WgXcQ")

        let mobile = match("https://m.youtube.com/watch?v=dQw4w9WgXcQ")
        XCTAssertEqual(mobile.platformContentID, "dQw4w9WgXcQ")

        let embedded = match("https://www.youtube.com/embed/dQw4w9WgXcQ")
        XCTAssertEqual(embedded.platformContentID, "dQw4w9WgXcQ")
    }

    func testYouTubeRejectsNonVideoPages() {
        // 频道页、首页都不是视频，不能凭「是 YouTube 域名」就给出一个播放按钮。
        XCTAssertEqual(match("https://www.youtube.com/@jameshoffmann").provider, .generic)
        XCTAssertEqual(match("https://www.youtube.com/").provider, .generic)
        XCTAssertNil(YouTubeAdapter.videoID(in: URL(string: "https://youtu.be/short")))
    }

    // MARK: - Bilibili

    func testBilibiliVideoURL() {
        let result = match("https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333.999")
        XCTAssertEqual(result.provider, .bilibili)
        XCTAssertEqual(result.platformContentID, "BV1GJ411x7h7")
        XCTAssertEqual(result.canonicalURL.absoluteString, "https://www.bilibili.com/video/BV1GJ411x7h7")
        XCTAssertEqual(result.page, 1)

        let embed = LinkResolver.embed(provider: .bilibili, contentID: "BV1GJ411x7h7", url: nil)
        let text = embed?.url.absoluteString ?? ""
        XCTAssertTrue(text.contains("bvid=BV1GJ411x7h7"), text)
        XCTAssertTrue(text.contains("autoplay=0"), text)
        XCTAssertEqual(embed?.allowedHosts, ["bilibili.com"])
    }

    func testBilibiliMultiPageKeepsThePart() {
        let result = match("https://www.bilibili.com/video/BV1GJ411x7h7?p=3")
        XCTAssertEqual(result.page, 3)
        XCTAssertEqual(result.canonicalURL.absoluteString,
                       "https://www.bilibili.com/video/BV1GJ411x7h7?p=3")

        let embed = LinkResolver.embed(provider: .bilibili, contentID: "BV1GJ411x7h7",
                                       url: nil, page: 3)
        XCTAssertTrue(embed?.url.absoluteString.contains("page=3") == true)
    }

    func testBilibiliShortLinkIsRecognisedButNotIdentifiedYet() {
        let result = match("https://b23.tv/abc123")
        XCTAssertEqual(result.provider, .bilibili)
        XCTAssertEqual(result.platformContentID, "")
        // 还没有 BV 号就不该有播放器——等重定向回来再说。
        XCTAssertNil(LinkResolver.embed(provider: .bilibili, contentID: "", url: result.originalURL))
    }

    func testBilibiliAVIsConvertedToAid() {
        let result = match("https://www.bilibili.com/video/av170001")
        XCTAssertEqual(result.platformContentID, "av170001")
        let text = LinkResolver.embed(provider: .bilibili, contentID: "av170001", url: nil)?.url.absoluteString ?? ""
        XCTAssertTrue(text.contains("aid=170001"), text)
        XCTAssertFalse(text.contains("bvid="), text)
    }

    /// 用户直接把播放页粘进来时，只采用其中的 bvid，其余参数（autoplay 等）
    /// 一律丢弃，播放地址重新拼。
    func testUserSuppliedPlayerURLIsRebuiltNotTrusted() {
        let result = match("https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&autoplay=1&danmaku=1&high_quality=1")
        XCTAssertEqual(result.provider, .bilibili)
        XCTAssertEqual(result.platformContentID, "BV1GJ411x7h7")

        let embed = LinkResolver.embed(provider: .bilibili,
                                       contentID: result.platformContentID, url: nil)
        let text = embed?.url.absoluteString ?? ""
        XCTAssertTrue(text.contains("autoplay=0"), "用户传入的 autoplay 不能生效：\(text)")
        XCTAssertTrue(text.contains("danmaku=0"), "用户传入的 danmaku 不能生效：\(text)")
    }

    // MARK: - X

    func testXPostURL() {
        let result = match("https://x.com/jack/status/20?s=20")
        XCTAssertEqual(result.provider, .x)
        XCTAssertEqual(result.contentKind, .socialPost)
        XCTAssertEqual(result.platformContentID, "20")
        XCTAssertEqual(result.canonicalURL.absoluteString, "https://x.com/jack/status/20")

        let embed = LinkResolver.embed(provider: .x, contentID: "20", url: nil)
        XCTAssertTrue(embed?.url.absoluteString.contains("platform.twitter.com/embed/Tweet.html") == true)
        XCTAssertTrue(embed?.url.absoluteString.contains("id=20") == true)
    }

    func testTwitterAndWebStatusForms() {
        XCTAssertEqual(match("https://twitter.com/jack/status/20").platformContentID, "20")
        XCTAssertEqual(match("https://mobile.twitter.com/jack/status/20").platformContentID, "20")
        XCTAssertEqual(match("https://x.com/i/web/status/20").platformContentID, "20")
        XCTAssertEqual(match("https://x.com/jack").provider, .generic, "个人主页不是帖子")
    }

    // MARK: - GitHub

    func testGitHubRepository() {
        let result = match("https://github.com/NiftyTreeStudios/Bean-Juice")
        XCTAssertEqual(result.provider, .github)
        XCTAssertEqual(result.contentKind, .repository)
        XCTAssertEqual(result.platformContentID, "NiftyTreeStudios/Bean-Juice")
        // 仓库不是视频：不该有任何播放能力。
        XCTAssertNil(LinkResolver.embed(provider: .github, contentID: result.platformContentID, url: nil))
    }

    func testGitHubFileKeepsItsOwnCanonical() {
        let repo = match("https://github.com/apple/swift")
        let file = match("https://github.com/apple/swift/blob/main/README.md")
        XCTAssertEqual(repo.platformContentID, "apple/swift")
        XCTAssertEqual(file.platformContentID, "apple/swift")
        XCTAssertNotEqual(repo.canonicalKey, file.canonicalKey,
                          "同一个仓库下的两个文件不能被当成重复记录")
        XCTAssertTrue(file.canonicalURL.absoluteString.contains("/blob/main/README.md"))
    }

    func testGitHubReservedPathsAreNotRepositories() {
        XCTAssertEqual(match("https://github.com/settings/profile").provider, .generic)
        XCTAssertEqual(match("https://github.com/explore").provider, .generic)
        XCTAssertEqual(match("https://github.com/apple").provider, .generic, "只有 owner 没有仓库")
    }

    // MARK: - 普通网页与规范化

    func testGenericPageIsStillSaveable() {
        let result = match("https://example.com/story?id=7#section")
        XCTAssertEqual(result.provider, .generic)
        XCTAssertEqual(result.contentKind, .webpage)
        XCTAssertEqual(result.canonicalURL.absoluteString, "https://example.com/story?id=7")
        XCTAssertNil(LinkResolver.embed(provider: .generic, contentID: "", url: result.canonicalURL))
    }

    func testTrackingParametersAndFragmentAreDroppedForDedupe() {
        let a = match("https://www.example.com/post/?utm_source=x&utm_medium=y&id=3#top")
        let b = match("https://example.com/post?id=3")
        XCTAssertEqual(a.canonicalURL, b.canonicalURL)
        XCTAssertEqual(a.canonicalKey, b.canonicalKey)
    }

    func testQueryOrderDoesNotChangeIdentity() {
        let a = match("https://example.com/search?b=2&a=1")
        let b = match("https://example.com/search?a=1&b=2")
        XCTAssertEqual(a.canonicalURL, b.canonicalURL)
    }

    func testInvalidLinkIsNotALink() {
        XCTAssertNil(Record(carrier: .link, urlString: "随便写点什么").resolvedLink)
        XCTAssertNil(Record(carrier: .link, urlString: "ftp://example.com/file").resolvedLink)
        XCTAssertNotNil(Record(carrier: .link, urlString: "example.com").resolvedLink)
        XCTAssertEqual(match("https://example.com").provider, .generic)
    }

    // MARK: - 记录字段

    func testRecordAdoptsMatchAndRebuildsTheSameEmbed() {
        let record = Record(carrier: .link)
        record.adopt(match("https://youtu.be/dQw4w9WgXcQ?si=abc"))
        XCTAssertEqual(record.urlString, "https://youtu.be/dQw4w9WgXcQ?si=abc")
        XCTAssertEqual(record.canonicalURL, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        XCTAssertEqual(record.provider, .youtube)
        XCTAssertEqual(record.embedCapability, .player)
        XCTAssertTrue(record.canPlayInline)
        XCTAssertEqual(record.linkEmbed?.url.absoluteString.contains("/embed/dQw4w9WgXcQ"), true)
    }

    /// 旧记录只有 urlString，没有平台字段。它必须仍然被认成 YouTube，而不是
    /// 一张「网页」卡——升级不该让已有记录的卡片降级。
    func testLegacyRecordWithoutProviderIsDetectedFromItsURL() {
        let record = Record(carrier: .link, urlString: "https://www.bilibili.com/video/BV1GJ411x7h7")
        XCTAssertEqual(record.providerRaw, "")
        XCTAssertEqual(record.provider, .bilibili)
        XCTAssertEqual(record.contentKind, .video)
        XCTAssertEqual(record.linkEmbed?.allowedHosts, ["bilibili.com"])
    }

    func testRepositoryStatsLineLeavesOutWhatWeDoNotKnow() {
        let record = Record(carrier: .link, urlString: "https://github.com/apple/swift")
        record.providerRaw = LinkProvider.github.rawValue
        XCTAssertEqual(record.repositoryStats, [])

        record.repositoryStars = 65_432
        record.repositoryLanguage = "C++"
        record.repositoryLicense = "Apache-2.0"
        XCTAssertEqual(record.repositoryStats, ["★ 65k", "C++", "Apache-2.0"])

        record.repositoryLicense = "NOASSERTION"
        XCTAssertEqual(record.repositoryStats, ["★ 65k", "C++"])
    }

    func testStarCountShortensLargeNumbers() {
        XCTAssertEqual(Fmt.starCount(0), "0")
        XCTAssertEqual(Fmt.starCount(987), "987")
        XCTAssertEqual(Fmt.starCount(1_000), "1k")
        XCTAssertEqual(Fmt.starCount(1_250), "1.2k")
        XCTAssertEqual(Fmt.starCount(65_432), "65k")
    }

    func testThumbnailURLOnlyAcceptsWebSchemes() {
        var record = Record(carrier: .link, urlString: "https://example.com")
        record.thumbnailURLString = "https://i.ytimg.com/vi/x/hqdefault.jpg"
        XCTAssertEqual(record.thumbnailURL?.absoluteString,
                       "https://i.ytimg.com/vi/x/hqdefault.jpg")

        record.thumbnailURLString = "javascript:alert(1)"
        XCTAssertNil(record.thumbnailURL)
        record.thumbnailURLString = "   "
        XCTAssertNil(record.thumbnailURL)
    }

    // MARK: - 元数据解码

    func testYouTubeOEmbedDecoding() {
        let json = #"{"title":"Big Buck Bunny","author_name":"Blender","thumbnail_url":"https://i.ytimg.com/vi/x/hqdefault.jpg"}"#
        let payload = YouTubeAdapter.decodeOEmbed(Data(json.utf8))
        XCTAssertEqual(payload?.title, "Big Buck Bunny")
        XCTAssertEqual(payload?.author_name, "Blender")
        XCTAssertEqual(payload?.thumbnail_url?.hasPrefix("https://i.ytimg.com/"), true)
    }

    func testBilibiliViewDecoding() {
        let json = #"{"code":0,"message":"OK","data":{"title":"标题","pic":"http://i1.hdslb.com/a.jpg","desc":"简介","owner":{"name":"UP主"}}}"#
        let payload = BilibiliAdapter.decodeView(Data(json.utf8))
        XCTAssertEqual(payload?.code, 0)
        XCTAssertEqual(payload?.data?.title, "标题")
        XCTAssertEqual(payload?.data?.owner?.name, "UP主")
    }

    func testGitHubRepoDecoding() {
        let json = #"{"full_name":"apple/swift","description":"The Swift Programming Language","language":"C++","stargazers_count":65432,"owner":{"login":"apple"},"license":{"spdx_id":"Apache-2.0"}}"#
        let payload = GitHubAdapter.decodeRepo(Data(json.utf8))
        XCTAssertEqual(payload?.full_name, "apple/swift")
        XCTAssertEqual(payload?.stargazers_count, 65_432)
        XCTAssertEqual(payload?.license?.spdx_id, "Apache-2.0")
    }

    func testXPostHTMLBecomesPlainText() {
        let html = #"<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">November 21, 2006</a></blockquote><script async src="https://platform.twitter.com/widgets.js"></script>"#
        let text = XAdapter.plainText(from: html) ?? ""
        XCTAssertTrue(text.contains("just setting up my twttr"))
        XCTAssertFalse(text.contains("<"), text)
        XCTAssertFalse(text.contains("script"), text)
        XCTAssertEqual(XAdapter.removingAttribution(text), "just setting up my twttr")
    }

    // MARK: - 持久化

    /// 关掉 App 再打开，卡片的平台身份必须还在——否则每次启动都会退回「网页」。
    func testLinkFieldsSurviveAStoreReopen() throws {
        let schema = BrewPhaseSchema.schema
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: configuration)

        let context = ModelContext(container)
        let record = Record(carrier: .link)
        record.adopt(match("https://www.bilibili.com/video/BV1GJ411x7h7?p=2"))
        record.title = "标题"
        record.summary = "简介"
        record.authorName = "UP主"
        record.metadataStatus = .resolved
        context.insert(record)
        try context.save()

        let reopened = ModelContext(container)
        let fetched = try reopened.fetch(FetchDescriptor<Record>())
        let first = try XCTUnwrap(fetched.first)
        XCTAssertEqual(first.provider, .bilibili)
        XCTAssertEqual(first.platformContentID, "BV1GJ411x7h7")
        XCTAssertEqual(first.linkPage, 2)
        XCTAssertEqual(first.summary, "简介")
        XCTAssertEqual(first.metadataStatus, .resolved)
        XCTAssertEqual(first.linkEmbed?.url.absoluteString.contains("page=2"), true)
    }
}
