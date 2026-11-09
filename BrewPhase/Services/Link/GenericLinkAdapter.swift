import Foundation

/// 其余所有网页。
///
/// 能读到 OG 标签就做一张有标题、摘要、封面的卡；读不到就退成「域名 + 链接」的
/// 简洁卡片。**它不会失败到无法保存**——解析只是给卡片补内容，不是保存的前提。
struct GenericLinkAdapter: LinkProviderAdapter {

    let provider: LinkProvider = .generic

    func match(_ url: URL) -> LinkMatch? {
        guard Self.isWebURL(url) else { return nil }
        return Self.matchOrFallback(url)
    }

    /// 识别失败时的兜底：只要是 http(s) 且主机里有「.」，就一定是条能保存的记录。
    static func matchOrFallback(_ url: URL) -> LinkMatch {
        let canonical = LinkURL.cleaned(url) ?? url
        return LinkMatch(originalURL: url, canonicalURL: canonical,
                         provider: .generic, contentKind: .webpage, platformContentID: "")
    }

    static func isWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let host = url.host, host.contains(".") else { return false }
        return true
    }

    func resolve(_ match: LinkMatch) async -> LinkMetadata {
        await resolveMetadata(for: match.originalURL)
    }

    /// 也供 Bilibili / GitHub 在接口失败时退回来用。
    func resolveMetadata(for url: URL) async -> LinkMetadata {
        switch await LinkPreviewService.fetch(url) {
        case .preview(let preview):
            var metadata = LinkMetadata()
            metadata.title = preview.title
            metadata.summary = preview.summary
            metadata.siteName = preview.siteName
            metadata.thumbnailURL = preview.imageURL
            if let type = preview.ogType?.lowercased(), type.contains("article") {
                metadata.contentKind = .article
            }
            return metadata.finalized()
        case .empty:
            return .failure(.parseFailed)
        case .unreachable:
            return .failure(.unreachable)
        case .refused:
            return .failure(.refused)
        }
    }

    func embed(contentID: String) -> LinkEmbed? { nil }
}
