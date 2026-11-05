import Foundation

/// 一个平台的适配器。
///
/// 它只做三件事：**认不认得这个地址**、**能不能（以及怎样）在 App 里嵌入**、
/// **能不能读出标题与摘要**。播放地址一律由适配器根据内容 ID 拼出，绝不采用
/// 用户输入里的 embed 地址——否则任何人粘一个「播放器地址」就能让 WebView
/// 加载任意页面。
protocol LinkProviderAdapter: Sendable {
    var provider: LinkProvider { get }
    func match(_ url: URL) -> LinkMatch?
    /// 短链展开。只有 b23.tv 这类需要，默认不做事。
    func expand(_ match: LinkMatch) async -> LinkMatch?
    func resolve(_ match: LinkMatch) async -> LinkMetadata
    func embed(contentID: String) -> LinkEmbed?
}

extension LinkProviderAdapter {
    func expand(_ match: LinkMatch) async -> LinkMatch? { nil }
}

// MARK: - URL 规范化

enum LinkURL {

    /// 只为去重与展示服务：这些参数只记录「从哪里点进来的」，不影响内容本身。
    private static let trackingKeys: Set<String> = [
        "fbclid", "gclid", "yclid", "mc_cid", "mc_eid", "igshid",
        "ref_src", "ref_url", "spm_id_from", "vd_source",
        "share_source", "share_medium", "share_plat", "share_session_id", "share_tag",
        "unique_k", "from_source", "timestamp", "si", "feature", "pp",
    ]

    private static let trackingPrefixes = ["utm_"]

    static func isTracking(_ key: String) -> Bool {
        let lower = key.lowercased()
        if trackingKeys.contains(lower) { return true }
        return trackingPrefixes.contains { lower.hasPrefix($0) }
    }

    /// 去掉跟踪参数、锚点、多余的斜杠，主机小写，查询参数排序。
    ///
    /// 排序是为了「同样的链接换一个参数顺序」也能被认为同一条——去重靠它。
    static func cleaned(_ url: URL) -> URL? {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        guard let host = comps.host, !host.isEmpty else { return nil }

        var normalizedHost = host.lowercased()
        if normalizedHost.hasPrefix("www.") { normalizedHost = String(normalizedHost.dropFirst(4)) }
        comps.host = normalizedHost
        comps.scheme = comps.scheme?.lowercased()
        comps.fragment = nil

        if let port = comps.port, (comps.scheme == "https" && port == 443) || (comps.scheme == "http" && port == 80) {
            comps.port = nil
        }

        var path = comps.percentEncodedPath
        if path.isEmpty { path = "/" }
        if path.count > 1, path.hasSuffix("/") { path.removeLast() }
        comps.percentEncodedPath = path

        if let items = comps.queryItems {
            let kept = items
                .filter { !isTracking($0.name) && !($0.value ?? "").isEmpty }
                .sorted { lhs, rhs in
                    lhs.name == rhs.name ? (lhs.value ?? "") < (rhs.value ?? "") : lhs.name < rhs.name
                }
            comps.queryItems = kept.isEmpty ? nil : kept
        }

        return comps.url
    }

    static func host(of url: URL?) -> String? {
        guard let host = url?.host?.lowercased(), !host.isEmpty else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    static func query(_ url: URL, _ name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == name }?.value
    }

    static func isDigits(_ raw: String) -> Bool {
        !raw.isEmpty && raw.allSatisfy(\.isNumber)
    }
}

// MARK: - 网络

enum LinkHTTP {

    /// 用移动端 Safari 的 UA。有些平台会按 UA 决定给不给 OG 标签。
    static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
        + "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    /// 抓 JSON。超过 2 MB 直接放弃——这几个公开接口没有一个会返回这么大。
    static func json(_ url: URL,
                     headers: [String: String] = [:],
                     timeout: TimeInterval = 8) async -> (data: Data, status: Int)? {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        applyBrowserHeaders(&request)
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, data.count <= 2_000_000 else {
                AppLog.link.error("json: bad response for \(url.absoluteString, privacy: .public)")
                return nil
            }
            return (data, http.statusCode)
        } catch {
            AppLog.link.error(
                "json failed: \(url.absoluteString, privacy: .public) — \(error.localizedDescription, privacy: .public)"
            )
            return nil
        }
    }

    /// 只补上浏览器都会带、而 `URLSession` 默认不发的几个头。
    ///
    /// 有些站点（B 站是其中之一）的风控会把「只有 UA 的裸请求」判成爬虫，
    /// 直接回 412；带上 `Accept-Language` 与 `Sec-Fetch-*` 之后才按普通页面
    /// 处理。这不是伪装，只是把浏览器本来就会说清楚的事情说清楚。
    private static func applyBrowserHeaders(_ request: inout URLRequest) {
        request.setValue("zh-CN,zh;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        request.setValue("empty", forHTTPHeaderField: "Sec-Fetch-Dest")
        request.setValue("cors", forHTTPHeaderField: "Sec-Fetch-Mode")
        request.setValue("same-site", forHTTPHeaderField: "Sec-Fetch-Site")
    }

    /// 页面只读到 `maxBytes` 为止。OG 标签都在 `<head>` 里，几百 KB 足够；
    /// 整页下载既慢又违背「不要把整张网页搬到本地」。
    static func html(at url: URL,
                     maxBytes: Int = 600_000,
                     timeout: TimeInterval = 8) async -> (html: String, finalURL: URL, status: Int)? {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                         forHTTPHeaderField: "Accept")
        applyBrowserHeaders(&request)

        let stream: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (stream, response) = try await URLSession.shared.bytes(for: request)
        } catch {
            AppLog.link.error(
                "html failed: \(url.absoluteString, privacy: .public) — \(error.localizedDescription, privacy: .public)"
            )
            return nil
        }
        guard let http = response as? HTTPURLResponse else { return nil }

        var bytes: [UInt8] = []
        bytes.reserveCapacity(min(maxBytes, 128 * 1024))
        do {
            for try await byte in stream {
                bytes.append(byte)
                if bytes.count >= maxBytes { break }
            }
        } catch {
            // 读到一半连接断了：已经读到的部分仍然可能有完整的 head。
        }
        guard !bytes.isEmpty else { return nil }

        let data = Data(bytes)
        let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
        guard let text, !text.isEmpty else { return nil }
        return (text, response.url ?? url, http.statusCode)
    }

    /// 跟随重定向之后落到哪里。b23.tv 这类短链只有拿到最终地址才知道是哪条视频。
    static func finalURL(for url: URL, timeout: TimeInterval = 8) async -> URL? {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        do {
            let (_, response) = try await URLSession.shared.bytes(for: request)
            return response.url
        } catch {
            AppLog.link.error(
                "redirect failed: \(url.absoluteString, privacy: .public) — \(error.localizedDescription, privacy: .public)"
            )
            return nil
        }
    }
}

// MARK: - 统一入口

enum LinkResolver {

    private static let adapterList: [any LinkProviderAdapter] = [
        YouTubeAdapter(),
        BilibiliAdapter(),
        XAdapter(),
        GitHubAdapter(),
    ]

    static func adapter(for provider: LinkProvider) -> (any LinkProviderAdapter)? {
        adapterList.first { $0.provider == provider } ?? (provider == .generic ? GenericLinkAdapter() : nil)
    }

    /// 本地识别，不联网。粘贴的瞬间就能说出「这是 YouTube 视频」。
    static func match(_ url: URL) -> LinkMatch {
        for adapter in adapterList {
            if let match = adapter.match(url) { return match }
        }
        return GenericLinkAdapter.matchOrFallback(url)
    }

    /// 识别 + 联网解析。短链会先展开再解析。
    static func resolve(_ url: URL) async -> LinkResolution {
        var match = self.match(url)
        if let adapter = adapter(for: match.provider),
           let expanded = await adapter.expand(match) {
            match = expanded
        }
        let metadata = await adapter(for: match.provider)?.resolve(match)
            ?? LinkMetadata.failure(.unsupported)
        return LinkResolution(match: match, metadata: metadata)
    }

    /// 记录只存平台与内容 ID，播放地址每次现拼——所以数据库里不会留下一个
    /// 能被改写的 embed URL。
    static func embed(provider: LinkProvider, contentID: String, url: URL?, page: Int = 1) -> LinkEmbed? {
        switch provider {
        case .youtube:
            let id = contentID.isEmpty ? (YouTubeAdapter.videoID(in: url) ?? "") : contentID
            return YouTubeAdapter.embed(videoID: id)
        case .bilibili:
            let id = contentID.isEmpty ? BilibiliAdapter.contentID(in: url) : contentID
            return BilibiliAdapter.embed(contentID: id, page: page)
        case .x:
            let id = contentID.isEmpty ? (XAdapter.statusID(in: url) ?? "") : contentID
            return XAdapter.embed(statusID: id)
        case .github, .generic:
            return nil
        }
    }
}
