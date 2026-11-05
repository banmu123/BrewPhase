import Foundation

/// X（原 Twitter）。
///
/// 只认公开的帖子地址，展示用 X 官方嵌入页（`platform.twitter.com/embed/Tweet.html`）。
/// 不调用任何非官方接口去取视频真实地址——带视频的帖子由官方组件自己决定给不给看。
/// 私密、已删、账号不可访问时，oEmbed 会返回错误，卡片退化成「标题 + 打开原帖」。
struct XAdapter: LinkProviderAdapter {

    let provider: LinkProvider = .x

    static let hosts: Set<String> = [
        "x.com", "www.x.com", "mobile.x.com",
        "twitter.com", "www.twitter.com", "mobile.twitter.com",
    ]

    // MARK: - 识别

    func match(_ url: URL) -> LinkMatch? { Self.match(url) }

    static func match(_ url: URL) -> LinkMatch? {
        guard let id = statusID(in: url) else { return nil }
        let user = userName(in: url) ?? "i"
        guard let canonical = URL(string: "https://x.com/\(user)/status/\(id)") else { return nil }
        return LinkMatch(originalURL: url, canonicalURL: canonical,
                         provider: .x, contentKind: .socialPost, platformContentID: id)
    }

    static func statusID(in url: URL?) -> String? {
        guard let url, let host = url.host?.lowercased(), hosts.contains(host) else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }

        // /{user}/status/{id}
        if parts.count >= 3, parts[1] == "status", LinkURL.isDigits(parts[2]) {
            return parts[2]
        }
        // /i/web/status/{id}
        if parts.count >= 4, parts[0] == "i", parts[2] == "status", LinkURL.isDigits(parts[3]) {
            return parts[3]
        }
        return nil
    }

    /// `/i/web/status/…` 里没有用户名；这种情况返回 nil，规范地址用 `i`。
    static func userName(in url: URL?) -> String? {
        guard let url else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 3, parts[1] == "status" else { return nil }
        let name = parts[0]
        guard !name.isEmpty, name != "i" else { return nil }
        return name
    }

    // MARK: - 播放

    static func embed(statusID: String) -> LinkEmbed? {
        guard LinkURL.isDigits(statusID),
              var comps = URLComponents(string: "https://platform.twitter.com/embed/Tweet.html") else {
            return nil
        }
        comps.queryItems = [
            URLQueryItem(name: "id", value: statusID),
            URLQueryItem(name: "dnt", value: "true"),
            URLQueryItem(name: "theme", value: "light"),
        ]
        guard let url = comps.url else { return nil }
        return LinkEmbed(url: url,
                         allowedHosts: ["platform.twitter.com", "platform.x.com"],
                         parentOrigin: URL(string: "https://x.com/"))
    }

    func embed(contentID: String) -> LinkEmbed? { Self.embed(statusID: contentID) }

    // MARK: - 元数据

    func resolve(_ match: LinkMatch) async -> LinkMetadata {
        guard var comps = URLComponents(string: "https://publish.twitter.com/oembed") else {
            return .failure(.unsupported)
        }
        comps.queryItems = [
            URLQueryItem(name: "url", value: match.canonicalURL.absoluteString),
            URLQueryItem(name: "omit_script", value: "1"),
            URLQueryItem(name: "dnt", value: "true"),
        ]
        guard let endpoint = comps.url else { return .failure(.unsupported) }
        guard let (data, status) = await LinkHTTP.json(endpoint) else {
            return .failure(.unreachable)
        }
        if status == 404 { return .failure(.notFound) }
        if status == 401 || status == 403 { return .failure(.restricted) }
        guard status == 200, let payload = Self.decodeOEmbed(data) else {
            return .failure(.parseFailed)
        }

        var metadata = LinkMetadata()
        metadata.siteName = "X"
        metadata.title = payload.title?.trimmed.nonEmpty
        metadata.summary = payload.title?.trimmed.nonEmpty
            ?? payload.html.flatMap(Self.plainText(from:))
        metadata.summary = metadata.summary.map(Self.removingAttribution).flatMap { $0.nonEmpty }
        metadata.authorName = payload.author_name?.trimmed.nonEmpty
        metadata.contentKind = .socialPost
        return metadata.finalized()
    }

    struct OEmbed: Decodable {
        var title: String?
        var html: String?
        var author_name: String?
        var author_url: String?
    }

    static func decodeOEmbed(_ data: Data) -> OEmbed? {
        try? JSONDecoder().decode(OEmbed.self, from: data)
    }

    /// 把 `<blockquote>` 里那段 HTML 变成纯文本。
    ///
    /// 只做几件确定的事：去掉 script、把 `<br>` 换行、剥标签、解实体。oEmbed 的
    /// HTML 是固定模板，不需要一个通用解析器。
    static func plainText(from html: String) -> String? {
        var text = html
        text = text.replacingOccurrences(
            of: "<script[^>]*>[\\s\\S]*?</script>", with: " ",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(
            of: "<br\\s*/?>", with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: [.regularExpression])
        text = LinkPreviewService.decodeEntities(text)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: [.regularExpression])
        let trimmed = text.trimmed
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 模板结尾固定是 `— 名字 (@handle) 日期`，把它切掉，只留帖子正文。
    static func removingAttribution(_ text: String) -> String {
        guard let range = text.range(of: "—", options: .backwards) else { return text }
        let head = String(text[..<range.lowerBound]).trimmed
        return head.isEmpty ? text : head
    }
}
