import Foundation

/// GitHub 仓库。
///
/// 仓库不是视频，所以这张卡片**没有播放按钮**——它显示 owner、仓库名、一句描述，
/// 以及能拿到时的 star、语言和许可证。信息来自公开 REST API（不需要任何 key），
/// 失败时退回网页 OG 标签。
struct GitHubAdapter: LinkProviderAdapter {

    let provider: LinkProvider = .github

    static let hosts: Set<String> = ["github.com", "www.github.com"]

    /// 第一段是这些词时不是「owner/repo」，而是 GitHub 自己的功能页。
    static let reservedOwners: Set<String> = [
        "settings", "notifications", "explore", "topics", "marketplace", "login",
        "logout", "join", "about", "pricing", "features", "enterprise", "sponsors",
        "orgs", "users", "new", "organizations", "collections", "events", "security",
        "contact", "site", "apps", "codespaces", "discussions", "search", "trending",
        "readme", "customer-stories", "team", "solutions", "resources", "github-copilot",
    ]

    // MARK: - 识别

    func match(_ url: URL) -> LinkMatch? { Self.match(url) }

    static func match(_ url: URL) -> LinkMatch? {
        guard let repo = repository(in: url) else { return nil }

        // 仓库根地址才是「同一条内容」；链接指向某个文件时保留完整地址，
        // 否则同一个仓库下的两个文件会被当成重复记录。
        let canonicalString: String
        if repo.isRoot {
            canonicalString = "https://github.com/\(repo.owner)/\(repo.name)"
        } else {
            canonicalString = (LinkURL.cleaned(url) ?? url).absoluteString
        }
        guard let canonical = URL(string: canonicalString) else { return nil }

        return LinkMatch(originalURL: url, canonicalURL: canonical,
                         provider: .github, contentKind: .repository,
                         platformContentID: "\(repo.owner)/\(repo.name)")
    }

    struct Repository: Equatable {
        var owner: String
        var name: String
        /// 路径正好是 `owner/repo`，没有指到文件或子页面。
        var isRoot: Bool
    }

    static func repository(in url: URL?) -> Repository? {
        guard let url, let host = url.host?.lowercased(), hosts.contains(host) else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 2 else { return nil }

        let owner = parts[0]
        var name = parts[1]
        if name.hasSuffix(".git") { name = String(name.dropLast(4)) }
        guard !owner.isEmpty, !name.isEmpty,
              !reservedOwners.contains(owner.lowercased()),
              !owner.hasPrefix(".") else { return nil }

        return Repository(owner: owner, name: name, isRoot: parts.count == 2)
    }

    // MARK: - 播放

    /// GitHub 没有播放器。返回 nil 比返回一个假地址诚实。
    func embed(contentID: String) -> LinkEmbed? { nil }

    // MARK: - 元数据

    func resolve(_ match: LinkMatch) async -> LinkMetadata {
        if let direct = await resolveViaAPI(match) { return direct }
        // 限流（60 次/小时/IP）或接口异常时，仓库页本身的 OG 标签通常够用。
        var fallback = await GenericLinkAdapter().resolveMetadata(for: match.canonicalURL)
        if fallback.status != .failed {
            fallback.siteName = "GitHub"
            fallback.contentKind = .repository
        }
        return fallback
    }

    private func resolveViaAPI(_ match: LinkMatch) async -> LinkMetadata? {
        guard let repo = Self.repository(in: match.originalURL),
              let endpoint = URL(string: "https://api.github.com/repos/\(repo.owner)/\(repo.name)") else {
            return nil
        }
        guard let (data, status) = await LinkHTTP.json(endpoint, headers: [
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        ]) else {
            return nil
        }
        if status == 404 { return .failure(.notFound) }
        if status == 403 || status == 429 { return nil }
        guard status == 200, let payload = Self.decodeRepo(data) else { return nil }

        var metadata = LinkMetadata()
        metadata.title = payload.full_name ?? "\(repo.owner)/\(repo.name)"
        metadata.summary = payload.description?.trimmed.nonEmpty
        metadata.authorName = payload.owner?.login ?? repo.owner
        metadata.siteName = "GitHub"
        metadata.contentKind = .repository
        metadata.repositoryStars = payload.stargazers_count
        metadata.repositoryForks = payload.forks_count
        metadata.repositoryIssues = payload.open_issues_count
        metadata.repositoryLanguage = payload.language?.trimmed.nonEmpty
        metadata.repositoryLicense = payload.license?.spdx_id?.trimmed.nonEmpty
        // 仓库没有封面图，owner 头像就是它的「缩略图」——卡片与详情页都画它。
        metadata.thumbnailURL = Self.avatarURL(from: payload.owner?.avatar_url)
        return metadata.finalized()
    }

    struct Repo: Decodable {
        struct Owner: Decodable {
            var login: String?
            var avatar_url: String?
        }
        struct License: Decodable {
            var spdx_id: String?
        }
        var full_name: String?
        var description: String?
        var language: String?
        var stargazers_count: Int?
        var forks_count: Int?
        var open_issues_count: Int?
        var owner: Owner?
        var license: License?
    }

    static func decodeRepo(_ data: Data) -> Repo? {
        try? JSONDecoder().decode(Repo.self, from: data)
    }

    /// 头像地址只接受 http/https（`https://github.com/{owner}.png` 这种也认）。
    static func avatarURL(from raw: String?) -> URL? {
        guard let raw = raw?.trimmed.nonEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }
}
