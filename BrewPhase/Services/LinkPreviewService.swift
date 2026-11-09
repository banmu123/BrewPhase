import UIKit

/// 普通网页的元数据。
///
/// 只做一件事：把用户粘进来的地址变成标题、摘要、站点名、封面和规范地址。
/// **它永远是可选的**——抓不到就返回 nil，用户自己填标题；保存流程不依赖它。
/// 这里没有第三方解析服务，只有一个够用的 meta / link 解析器，页面只读前
/// 600 KB（见 `LinkHTTP.html`）。
enum LinkPreviewService {

    struct Preview: Sendable, Equatable {
        var title: String?
        var summary: String?
        var siteName: String?
        var imageURL: URL?
        var ogType: String?

        var isEmpty: Bool {
            title == nil && summary == nil && siteName == nil && imageURL == nil
        }
    }

    enum FetchResult: Sendable {
        case preview(Preview)
        /// 页面打开了，但没读出任何有用字段。
        case empty
        /// 连不上、超时。
        case unreachable
        /// 站点风控拒绝了这次读取（403 / 412 / 429）。
        case refused
    }

    /// 下载预览图时的上限。它只是卡片上的一张缩略图。
    private static let maxImageBytes = 4_000_000

    // MARK: - 抓取

    static func fetch(_ url: URL) async -> FetchResult {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return .unreachable
        }
        guard let page = await LinkHTTP.html(at: url) else { return .unreachable }
        guard (200..<300).contains(page.status) else {
            AppLog.link.error("html status \(page.status) for \(url.absoluteString, privacy: .public)")
            return page.status == 403 || page.status == 412 || page.status == 429
                ? .refused : .unreachable
        }

        let html = page.html
        let base = page.finalURL
        let metas = metaTags(in: html)
        func meta(_ keys: String...) -> String? {
            for key in keys {
                if let value = metas.first(where: { $0.key == key })?.content.trimmed, !value.isEmpty {
                    return value
                }
            }
            return nil
        }

        var preview = Preview()
        preview.title = meta("og:title", "twitter:title") ?? titleTag(in: html)?.trimmed.nonEmpty
        preview.summary = meta("og:description", "twitter:description", "description")
        preview.siteName = meta("og:site_name", "application-name")
        preview.ogType = meta("og:type")

        if let raw = meta("og:image", "twitter:image", "twitter:image:src") {
            preview.imageURL = absolute(raw, base: base)
        }

        return preview.isEmpty ? .empty : .preview(preview)
    }

    /// 下载预览图。失败返回 nil——卡片会少一张图，别的都不受影响。
    static func downloadImage(_ url: URL, referer: String? = nil) async -> UIImage? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue(LinkHTTP.userAgent, forHTTPHeaderField: "User-Agent")
        if let referer { request.setValue(referer, forHTTPHeaderField: "Referer") }

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              data.count <= maxImageBytes,
              let image = UIImage(data: data),
              image.size.width > 0 else {
            return nil
        }
        return image
    }

    /// 相对地址按最终页面的地址补全，只接受 http/https。
    static func absolute(_ raw: String, base: URL) -> URL? {
        guard let candidate = URL(string: raw, relativeTo: base)?.absoluteURL,
              let scheme = candidate.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return candidate
    }

    // MARK: - 解析

    /// 把每个 `<meta …>` 拆成键值对。属性顺序在每个站点都不一样，所以先收集
    /// 再查找，而不是用一条「property 在前 content 在后」的正则去赌。
    static func metaTags(in html: String) -> [(key: String, content: String)] {
        let tagPattern = try? NSRegularExpression(pattern: "<meta\\s+[^>]*>", options: [.caseInsensitive])
        let range = NSRange(html.startIndex..., in: html)
        let tags = tagPattern?.matches(in: html, range: range) ?? []

        var result: [(key: String, content: String)] = []
        for match in tags {
            guard let tagRange = Range(match.range, in: html) else { continue }
            let attributes = attributePairs(in: String(html[tagRange]))
            guard let content = attributes["content"]?.trimmed, !content.isEmpty else { continue }
            guard let key = (attributes["property"] ?? attributes["name"] ?? attributes["itemprop"])?
                .trimmed.lowercased(), !key.isEmpty else { continue }
            result.append((key, decodeEntities(content)))
        }
        return result
    }

    static func titleTag(in html: String) -> String? {
        let pattern = try? NSRegularExpression(pattern: "<title[^>]*>(.*?)</title>",
                                               options: [.caseInsensitive, .dotMatchesLineSeparators])
        let range = NSRange(html.startIndex..., in: html)
        guard let match = pattern?.firstMatch(in: html, range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: html) else { return nil }
        return decodeEntities(String(html[valueRange]))
    }

    private static func attributePairs(in tag: String) -> [String: String] {
        let pattern = try? NSRegularExpression(pattern: "([A-Za-z_:][-A-Za-z0-9_:.]*)\\s*=\\s*(\"([^\"]*)\"|'([^']*)')",
                                               options: [])
        let range = NSRange(tag.startIndex..., in: tag)
        var pairs: [String: String] = [:]
        pattern?.enumerateMatches(in: tag, range: range) { match, _, _ in
            guard let match, let keyRange = Range(match.range(at: 1), in: tag) else { return }
            let key = String(tag[keyRange]).lowercased()
            let value: String
            if match.range(at: 3).location != NSNotFound, let r = Range(match.range(at: 3), in: tag) {
                value = String(tag[r])
            } else if match.range(at: 4).location != NSNotFound, let r = Range(match.range(at: 4), in: tag) {
                value = String(tag[r])
            } else {
                value = ""
            }
            pairs[key] = value
        }
        return pairs
    }

    /// 只处理最常见的几个实体。标题里出现 `&amp;` 很常见，别的交给现实。
    static func decodeEntities(_ text: String) -> String {
        var result = text
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            // 推文模板用 &mdash; 分隔正文与署名；不还原它，切署名会切不掉。
            .replacingOccurrences(of: "&mdash;", with: "—")
            .replacingOccurrences(of: "&ndash;", with: "–")
            .replacingOccurrences(of: "&hellip;", with: "…")

        // 数字实体：&#8217; 这类。
        if result.contains("&#") {
            let pattern = try? NSRegularExpression(pattern: "&#(\\d{1,6});")
            let range = NSRange(result.startIndex..., in: result)
            var output = result
            for match in (pattern?.matches(in: result, range: range) ?? []).reversed() {
                guard let full = Range(match.range, in: output),
                      let digits = Range(match.range(at: 1), in: output),
                      let code = UInt32(output[digits]),
                      let scalar = Unicode.Scalar(code) else { continue }
                output.replaceSubrange(full, with: String(Character(scalar)))
            }
            result = output
        }
        return result
    }
}
