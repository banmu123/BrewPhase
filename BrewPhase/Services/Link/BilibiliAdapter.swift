import Foundation

/// 哔哩哔哩。
///
/// 支持 `bilibili.com/video/BV…`、`av…`、`m.bilibili.com`、`b23.tv` 短链与
/// `player.bilibili.com` 播放页。播放只用官方外链播放器，不抓流、不下载。
///
/// 短链要先跟一次重定向才知道是哪条视频；`expand` 就是为它准备的，展开失败时
/// 记录照样保存，卡片退化成一张普通网页卡。
struct BilibiliAdapter: LinkProviderAdapter {

    let provider: LinkProvider = .bilibili

    static let hosts: Set<String> = [
        "bilibili.com", "www.bilibili.com", "m.bilibili.com",
        "player.bilibili.com", "b23.tv", "www.b23.tv",
    ]

    static let shortHosts: Set<String> = ["b23.tv", "www.b23.tv"]

    // MARK: - 识别

    func match(_ url: URL) -> LinkMatch? { Self.match(url) }

    static func match(_ url: URL) -> LinkMatch? {
        guard let host = url.host?.lowercased(), hosts.contains(host) else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }

        if shortHosts.contains(host) {
            // 短链：只知道「这是一条 B 站链接」，具体是哪条得等重定向。
            guard let code = parts.first, !code.isEmpty else { return nil }
            return LinkMatch(originalURL: url, canonicalURL: url,
                             provider: .bilibili, contentKind: .video, platformContentID: "")
        }

        var token: String?
        if host == "player.bilibili.com" {
            // 用户可能直接把播放页粘进来。只取其中的 bvid / aid，重新拼我们自己的
            // 播放地址——用户给的其余参数（autoplay 等）一律丢弃。
            token = LinkURL.query(url, "bvid").flatMap { isBV($0) ? $0 : nil }
                ?? LinkURL.query(url, "aid").flatMap { LinkURL.isDigits($0) ? "av\($0)" : nil }
        } else if parts.count >= 2, parts[0] == "video" {
            token = normalize(parts[1])
        }

        guard let token, let page = pageNumber(in: url) else { return nil }
        let canonicalString = page > 1
            ? "https://www.bilibili.com/video/\(token)?p=\(page)"
            : "https://www.bilibili.com/video/\(token)"
        guard let canonical = URL(string: canonicalString) else { return nil }
        return LinkMatch(originalURL: url, canonicalURL: canonical,
                         provider: .bilibili, contentKind: .video,
                         platformContentID: token, page: page)
    }

    /// 从记录里存的地址反推内容 ID（老记录没有存 platformContentID）。
    static func contentID(in url: URL?) -> String {
        guard let url, let host = url.host?.lowercased(), hosts.contains(host) else { return "" }
        let parts = url.pathComponents.filter { $0 != "/" }
        if host == "player.bilibili.com" {
            return LinkURL.query(url, "bvid").flatMap { isBV($0) ? $0 : nil } ?? ""
        }
        if parts.count >= 2, parts[0] == "video" {
            return normalize(parts[1]) ?? ""
        }
        return ""
    }

    /// `BV1xx411c7mD`（12 位）或 `av170001`。大小写敏感——BV 号里的大小写有意义。
    static func isBV(_ raw: String) -> Bool {
        guard raw.count == 12, raw.hasPrefix("BV") else { return false }
        return raw.dropFirst(2).allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    static func isAV(_ raw: String) -> Bool {
        guard raw.count > 2, raw.lowercased().hasPrefix("av") else { return false }
        return raw.dropFirst(2).allSatisfy(\.isNumber)
    }

    private static func normalize(_ raw: String) -> String? {
        if isBV(raw) { return raw }
        if isAV(raw) { return "av" + raw.dropFirst(2) }
        return nil
    }

    private static func pageNumber(in url: URL) -> Int? {
        guard let raw = LinkURL.query(url, "p"), let value = Int(raw) else { return 1 }
        return value >= 1 ? value : 1
    }

    // MARK: - 短链

    func expand(_ match: LinkMatch) async -> LinkMatch? {
        guard match.provider == .bilibili, match.platformContentID.isEmpty else { return nil }
        guard let final = await LinkHTTP.finalURL(for: match.originalURL),
              final != match.originalURL else { return nil }
        guard let expanded = Self.match(final) else { return nil }
        // 最终地址换成了 BV 号，但用户提交的仍然是那条短链。
        return LinkMatch(originalURL: match.originalURL,
                         canonicalURL: expanded.canonicalURL,
                         provider: .bilibili,
                         contentKind: .video,
                         platformContentID: expanded.platformContentID,
                         page: expanded.page)
    }

    // MARK: - 播放

    static func embed(contentID: String, page: Int = 1) -> LinkEmbed? {
        guard var comps = URLComponents(string: "https://player.bilibili.com/player.html") else { return nil }
        var items: [URLQueryItem] = []
        if isBV(contentID) {
            items.append(URLQueryItem(name: "bvid", value: contentID))
        } else if isAV(contentID) {
            items.append(URLQueryItem(name: "aid", value: String(contentID.dropFirst(2))))
        } else {
            return nil
        }
        items.append(URLQueryItem(name: "page", value: String(max(1, page))))
        items.append(URLQueryItem(name: "high_quality", value: "1"))
        items.append(URLQueryItem(name: "danmaku", value: "0"))
        items.append(URLQueryItem(name: "autoplay", value: "0"))
        comps.queryItems = items
        guard let url = comps.url else { return nil }
        return LinkEmbed(url: url, allowedHosts: ["bilibili.com"])
    }

    func embed(contentID: String) -> LinkEmbed? { Self.embed(contentID: contentID) }

    // MARK: - 元数据

    func resolve(_ match: LinkMatch) async -> LinkMetadata {
        if let direct = await resolveViaAPI(match) { return direct }
        // 接口不通（限流、地区、改了字段）时退回网页 OG 标签，标题通常还在。
        var fallback = await GenericLinkAdapter().resolveMetadata(for: match.canonicalURL)
        if fallback.status == .failed { return fallback }
        fallback.siteName = LinkProvider.bilibili.displayName
        fallback.contentKind = .video
        return fallback.finalized()
    }

    private func resolveViaAPI(_ match: LinkMatch) async -> LinkMetadata? {
        guard var comps = URLComponents(string: "https://api.bilibili.com/x/web-interface/view") else { return nil }
        if Self.isBV(match.platformContentID) {
            comps.queryItems = [URLQueryItem(name: "bvid", value: match.platformContentID)]
        } else if Self.isAV(match.platformContentID) {
            comps.queryItems = [URLQueryItem(name: "aid", value: String(match.platformContentID.dropFirst(2)))]
        } else {
            return .failure(.parseFailed)
        }
        guard let endpoint = comps.url else { return nil }

        guard let (data, status) = await LinkHTTP.json(endpoint, headers: [
            // 没有 Referer 时这个接口有时返回 -412（风控）。
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
        ]) else {
            return nil
        }
        guard status == 200 else {
            AppLog.link.error("bilibili api status \(status)")
            if status == 404 { return .failure(.notFound) }
            if status == 403 || status == 412 || status == 429 { return .failure(.refused) }
            return nil
        }
        guard let payload = Self.decodeView(data) else {
            AppLog.link.error("bilibili api decode failed")
            return nil
        }
        guard payload.code == 0, let block = payload.data else {
            AppLog.link.error("bilibili api code \(payload.code)")
            switch payload.code {
            case -404: return .failure(.notFound)
            case -403, 62002, 62004: return .failure(.restricted)
            default: return nil
            }
        }

        var metadata = LinkMetadata()
        metadata.title = block.title?.trimmed.nonEmpty
        metadata.summary = block.desc?.trimmed.nonEmpty
        metadata.authorName = block.owner?.name?.trimmed.nonEmpty
        metadata.siteName = LinkProvider.bilibili.displayName
        metadata.contentKind = .video
        if var raw = block.pic?.trimmed, !raw.isEmpty {
            if raw.hasPrefix("//") { raw = "https:" + raw }
            // 接口返回的封面经常是 http://，ATS 会拦下，直接升到 https。
            if raw.hasPrefix("http://") { raw = "https://" + raw.dropFirst(7) }
            metadata.thumbnailURL = URL(string: raw)
        }
        return metadata.finalized()
    }

    struct ViewResponse: Decodable {
        struct Block: Decodable {
            struct Owner: Decodable { var name: String? }
            var title: String?
            var pic: String?
            var desc: String?
            var owner: Owner?
        }
        var code: Int
        var message: String?
        var data: Block?
    }

    static func decodeView(_ data: Data) -> ViewResponse? {
        try? JSONDecoder().decode(ViewResponse.self, from: data)
    }
}
