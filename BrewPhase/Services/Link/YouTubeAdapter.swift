import Foundation

/// YouTube。
///
/// 支持 watch / shorts / youtu.be / m.youtube.com / embed 五种写法，全部还原成
/// 同一个 11 位 video ID。播放走官方 IFrame 播放器（youtube-nocookie 域名，
/// 播放前不写 cookie），不自行提取视频流，也不默认自动播放。
struct YouTubeAdapter: LinkProviderAdapter {

    let provider: LinkProvider = .youtube

    static let hosts: Set<String> = [
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
    ]

    // MARK: - 识别

    func match(_ url: URL) -> LinkMatch? { Self.match(url) }

    static func match(_ url: URL) -> LinkMatch? {
        guard let id = videoID(in: url) else { return nil }
        guard let canonical = URL(string: "https://www.youtube.com/watch?v=\(id)") else { return nil }
        return LinkMatch(originalURL: url, canonicalURL: canonical,
                         provider: .youtube, contentKind: .video, platformContentID: id)
    }

    /// 从任何一种 YouTube 地址里取出 video ID。取不到就是 nil——不猜。
    static func videoID(in url: URL?) -> String? {
        guard let url, let host = url.host?.lowercased(), hosts.contains(host) else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }

        var candidate: String?
        if host.hasSuffix("youtu.be") {
            candidate = parts.first
        } else if parts.first == "watch" {
            candidate = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "v" }?.value
        } else if parts.count >= 2, ["shorts", "embed", "live", "v"].contains(parts[0]) {
            candidate = parts[1]
        }

        guard let candidate, isVideoID(candidate) else { return nil }
        return candidate
    }

    /// 11 位 base64url。`watch?v=` 后面跟着一长串别的东西时不要当成 ID。
    static func isVideoID(_ raw: String) -> Bool {
        guard raw.count == 11 else { return false }
        return raw.allSatisfy { character in
            character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "-")
        }
    }

    // MARK: - 播放

    static func embed(videoID: String) -> LinkEmbed? {
        guard isVideoID(videoID),
              var comps = URLComponents(string: "https://www.youtube-nocookie.com/embed/\(videoID)") else {
            return nil
        }
        comps.queryItems = [
            URLQueryItem(name: "playsinline", value: "1"),
            URLQueryItem(name: "rel", value: "0"),
            URLQueryItem(name: "modestbranding", value: "1"),
        ]
        guard let url = comps.url else { return nil }
        return LinkEmbed(url: url,
                         allowedHosts: ["youtube-nocookie.com", "youtube.com"],
                         parentOrigin: URL(string: "https://www.youtube.com/"))
    }

    func embed(contentID: String) -> LinkEmbed? {
        Self.embed(videoID: contentID)
    }

    // MARK: - 元数据

    func resolve(_ match: LinkMatch) async -> LinkMetadata {
        guard var comps = URLComponents(string: "https://www.youtube.com/oembed") else {
            return .failure(.unsupported)
        }
        comps.queryItems = [
            URLQueryItem(name: "url", value: match.canonicalURL.absoluteString),
            URLQueryItem(name: "format", value: "json"),
        ]
        guard let endpoint = comps.url else { return .failure(.unsupported) }
        guard let (data, status) = await LinkHTTP.json(endpoint) else {
            return .failure(.unreachable)
        }
        if status == 401 || status == 403 || status == 404 {
            // 私享、被删、或不允许嵌入。地址仍然保留。
            return .failure(status == 404 ? .notFound : .restricted)
        }
        guard status == 200, let payload = Self.decodeOEmbed(data) else {
            return .failure(.parseFailed)
        }

        var metadata = LinkMetadata()
        metadata.title = payload.title?.trimmed.nonEmpty
        metadata.authorName = payload.author_name?.trimmed.nonEmpty
        metadata.siteName = "YouTube"
        if let raw = payload.thumbnail_url, let image = URL(string: raw),
           image.scheme == "https" || image.scheme == "http" {
            metadata.thumbnailURL = image
        }
        return metadata.finalized()
    }

    struct OEmbed: Decodable {
        var title: String?
        var author_name: String?
        var thumbnail_url: String?
    }

    static func decodeOEmbed(_ data: Data) -> OEmbed? {
        try? JSONDecoder().decode(OEmbed.self, from: data)
    }
}
