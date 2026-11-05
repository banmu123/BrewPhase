import Foundation
import SwiftData

/// 内容载体：这条记录**是**什么。
///
/// 它与「这条记录对你意味着什么」是两件事。载体只有四种，由系统决定——一段
/// 网页、一张照片、一段视频、一段文字，打开方式和展示方式各不相同；意义则由
/// 用户自己贴的标签决定，可以随时改，也不受载体限制。
enum RecordCarrier: String, CaseIterable, Codable, Identifiable, Sendable {
    case link
    case image
    case video
    case text

    var id: String { rawValue }

    var title: String {
        switch self {
        case .link: return L("链接")
        case .image: return L("图片")
        case .video: return L("视频")
        case .text: return L("文字")
        }
    }

    /// 选类型时的一句话：它说的是「放进来的是什么」，不是「这是什么心情」。
    var subtitle: String {
        switch self {
        case .link: return L("网页、文章、视频平台或 GitHub")
        case .image: return L("从相册选一张照片")
        case .video: return L("从相册选一段视频")
        case .text: return L("随手写一段话")
        }
    }

    var symbol: String {
        switch self {
        case .link: return "link"
        case .image: return "photo"
        case .video: return "play.rectangle"
        case .text: return "text.alignleft"
        }
    }
}

/// 一条记录：内容 + 标题 + 备注 + 用户给的标签。
///
/// 载体决定内容字段怎么用：链接只存 URL 与抓到的元数据，图片与视频存**文件名**
/// （真正的文件在 `ImageStore` / `MediaStore` 里），文字只存正文。标签是多对多，
/// 与载体完全解耦——一条链接可以同时是「开发」和「随记」。
@Model
final class Record {

    var id: UUID = UUID()

    /// `RecordCarrier` 的 rawValue。存字符串而不是枚举，让未知值有回退的余地。
    var carrierRaw: String = RecordCarrier.text.rawValue

    // MARK: - 内容

    /// 链接原文。只在 `.link` 上有意义。
    var urlString: String = ""
    /// 站点名或作者，来自网页元数据，也可以由用户手填。
    var sourceName: String = ""
    /// 卡片上那张图：链接的预览图，或视频的封面。都是 `ImageStore` 里的 jpg。
    var previewPath: String?
    /// 真正的媒体文件：图片是 `ImageStore` 的 jpg，视频是 `MediaStore` 的 mov。
    var mediaPath: String?

    // MARK: - 链接的平台身份（只有 `.link` 有意义）
    //
    // 平台与内容 ID 是**解析出来的事实**，不是用户输入。播放地址每次由 Adapter
    // 现拼，数据库里不存 embed URL——存了就等于允许一条记录带着任意地址进 WebView。

    /// 规范化地址：去掉跟踪参数与锚点。用于去重与「打开原链接」。
    var canonicalURL: String = ""
    /// `LinkProvider` 的 rawValue。空串表示这条记录早于平台识别，按地址现认。
    var providerRaw: String = ""
    /// `LinkContentKind` 的 rawValue。空串同样按地址现认。
    var contentKindRaw: String = ""
    /// 平台自己的内容 ID：YouTube video ID、BV 号、帖子 ID、owner/repo。
    var platformContentID: String = ""
    /// 多 P 视频的分 P。
    var linkPage: Int = 1
    /// 作者 / 账号 / 仓库 owner。
    var authorName: String = ""
    /// 平台给的摘要。用户自己的备注在 `note`，两者不混。
    var summary: String = ""
    /// 平台给的缩略图地址。真正的图仍然缓存成 `previewPath` 的本地 jpg。
    var thumbnailURLString: String = ""
    /// `LinkMetadataStatus` 的 rawValue。
    var metadataStatusRaw: String = LinkMetadataStatus.idle.rawValue

    // GitHub 仓库卡片的数字与文字。别的平台留空，卡片不会去读。
    var repositoryStars: Int = 0
    var repositoryForks: Int = 0
    var repositoryIssues: Int = 0
    var repositoryLanguage: String = ""
    var repositoryLicense: String = ""

    // MARK: - 用户赋予的部分

    var title: String = ""
    /// 备注 / 描述 / 正文。文字记录的正文也在这里。
    var note: String = ""
    /// 多对多。删除标签只解除关系，不会带走记录。
    @Relationship(inverse: \RecordTag.records)
    var tags: [RecordTag]? = []

    var createdAt: Date = Date()
    var updatedAt: Date = Date()

    /// 示例数据标记：只有「示例数据」开关装进来的记录带它，关闭时整批删除。
    var isSample: Bool = false

    init(
        carrier: RecordCarrier,
        title: String = "",
        note: String = "",
        urlString: String = "",
        sourceName: String = "",
        previewPath: String? = nil,
        mediaPath: String? = nil,
        createdAt: Date = Date(),
        isSample: Bool = false
    ) {
        self.id = UUID()
        self.carrierRaw = carrier.rawValue
        self.title = title
        self.note = note
        self.urlString = urlString
        self.sourceName = sourceName
        self.previewPath = previewPath
        self.mediaPath = mediaPath
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.isSample = isSample
    }

    /// 未知的 rawValue 回退到「文字」：一条记录总得能被显示出来。
    var carrier: RecordCarrier {
        get { RecordCarrier(rawValue: carrierRaw) ?? .text }
        set { carrierRaw = newValue.rawValue }
    }

    /// 卡片标题：没有标题时用正文第一行，避免卡片顶上出现一行空白。
    /// 链接连正文也没有时退回域名——「example.com」比「未命名链接」有用。
    var displayTitle: String {
        let trimmedTitle = title.trimmed
        if !trimmedTitle.isEmpty { return trimmedTitle }
        if carrier == .link {
            // 帖子没有标题，它的正文就是标题。
            if let summaryLine = summary.trimmed.split(separator: "\n").first.map(String.init),
               !summaryLine.isEmpty {
                return summaryLine
            }
            if let host = linkHost { return host }
        }
        let firstLine = note.trimmed.split(separator: "\n").first.map(String.init) ?? ""
        return firstLine
    }

    /// 卡片正文区：平台摘要。用户自己的备注单独显示在底部。
    var linkSummary: String? {
        let trimmed = summary.trimmed
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 标签按创建时间排，保证同一条记录每次显示的次序一致。
    var orderedTags: [RecordTag] {
        (tags ?? []).sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
            return lhs.name < rhs.name
        }
    }

    /// `到访 · 灵感` —— 卡片上只露一行，最多三个，多余的折成 `+2`。
    var tagLine: String? {
        let names = orderedTags.map(\.displayName)
        guard !names.isEmpty else { return nil }
        let shown = names.prefix(3)
        let extra = names.count - shown.count
        return extra > 0
            ? shown.joined(separator: " · ") + " +\(extra)"
            : shown.joined(separator: " · ")
    }

    // MARK: - 链接

    /// `example.com` —— 卡片上只露主机名。
    var linkHost: String? {
        guard let host = resolvedLink?.host else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// 可以交给 `Link` / `URLSession` 的地址。没有协议时补 https；
    /// 主机里没有点（「不是链接」这种）就当作无效，不猜。
    var resolvedLink: URL? {
        let trimmed = urlString.trimmed
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: normalized),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, host.contains(".") else {
            return nil
        }
        return url
    }

    /// 卡片副标题：来源优先，没有就用主机名。
    var sourceLine: String? {
        let trimmedSource = sourceName.trimmed
        if !trimmedSource.isEmpty { return trimmedSource }
        return linkHost
    }

    // MARK: - 链接的平台身份

    var provider: LinkProvider {
        if let stored = LinkProvider(rawValue: providerRaw) { return stored }
        // 这条记录写在这套识别之前：按地址现认一次，卡片不会退化成「普通网页」。
        guard carrier == .link, let url = resolvedLink else { return .generic }
        return LinkResolver.match(url).provider
    }

    var contentKind: LinkContentKind {
        if let stored = LinkContentKind(rawValue: contentKindRaw) { return stored }
        guard carrier == .link, let url = resolvedLink else { return .webpage }
        return LinkResolver.match(url).contentKind
    }

    var metadataStatus: LinkMetadataStatus {
        get { LinkMetadataStatus(rawValue: metadataStatusRaw) ?? .idle }
        set { metadataStatusRaw = newValue.rawValue }
    }

    /// 可信的嵌入目标。没有官方组件、或者内容 ID 不成立时返回 nil——这样卡片上
    /// 就不会出现一个点了没反应的播放按钮。
    var linkEmbed: LinkEmbed? {
        guard carrier == .link, provider.hasOfficialEmbed else { return nil }
        return LinkResolver.embed(provider: provider,
                                  contentID: platformContentID,
                                  url: resolvedLink,
                                  page: linkPage)
    }

    var embedCapability: LinkEmbedCapability {
        guard linkEmbed != nil else { return .none }
        return contentKind == .socialPost ? .post : .player
    }

    /// 只有视频类才配一个播放按钮。仓库和普通网页没有。
    var canPlayInline: Bool { embedCapability == .player }

    /// 打开原链接：优先规范化地址，老记录退回原文。
    var openLink: URL? {
        let raw = canonicalURL.trimmed
        if !raw.isEmpty, let url = URL(string: raw), url.scheme != nil { return url }
        return resolvedLink
    }

    /// 去重只看规范地址。同一个视频的三种写法算同一条。
    var canonicalKey: String {
        let raw = canonicalURL.trimmed
        return raw.isEmpty ? (resolvedLink?.absoluteString ?? "") : raw
    }

    /// 平台名；普通网页用域名。
    var providerLabel: String? {
        let name = provider.displayName
        return name.isEmpty ? linkHost : name
    }

    /// `@handle` / 仓库 owner。X 的用户名就在规范地址里。
    var handle: String? {
        if provider == .x {
            let parts = openLink?.pathComponents.filter { $0 != "/" } ?? []
            if parts.count >= 3, parts[1] == "status", parts[0] != "i" { return "@" + parts[0] }
        }
        let author = authorName.trimmed
        return author.isEmpty ? nil : author
    }

    /// 详情页标题下面那一行：有作者就写作者，没有就写域名。
    var linkCreditLine: String? {
        if let handle { return handle }
        return linkHost
    }

    /// 平台给的封面地址。本地还没缓存（`previewPath == nil`）时，详情页会拿
    /// 它补一次下载；只接受 http/https。
    var thumbnailURL: URL? {
        let raw = thumbnailURLString.trimmed
        guard let url = URL(string: raw), !raw.isEmpty,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    /// 仓库卡片的信息行：`☆ 2k ⑂ 124 ! 3 Swift MIT`。没有的项不占位——
    /// 一个 0 star 的新仓库不应该顶着四个零。
    /// symbol 为空表示纯文本（语言、许可证），由界面决定怎么画。
    var repositoryStatItems: [(symbol: String, text: String)] {
        guard provider == .github else { return [] }
        var items: [(String, String)] = []
        if repositoryStars > 0 { items.append(("star", Fmt.starCount(repositoryStars))) }
        if repositoryForks > 0 { items.append(("arrow.triangle.branch", Fmt.starCount(repositoryForks))) }
        if repositoryIssues > 0 { items.append(("exclamationmark.circle", Fmt.starCount(repositoryIssues))) }
        let language = repositoryLanguage.trimmed
        if !language.isEmpty { items.append(("", language)) }
        let license = repositoryLicense.trimmed
        if !license.isEmpty, license.uppercased() != "NOASSERTION" { items.append(("", license)) }
        return items
    }

    /// `owner` / `repo` 拆开显示：owner 是小字，仓库名才是标题。
    /// 旧记录没有 platformContentID 时拿不到，界面退回整行标题。
    var repositoryOwner: String? {
        guard provider == .github else { return nil }
        let parts = platformContentID.split(separator: "/")
        return parts.isEmpty ? nil : String(parts[0])
    }

    var repositoryName: String? {
        guard provider == .github else { return nil }
        let parts = platformContentID.split(separator: "/")
        return parts.count >= 2 ? String(parts[1]) : nil
    }

    /// 把识别结果写进记录。编辑器与示例数据共用这一条路，免得字段漏写。
    func adopt(_ match: LinkMatch) {
        urlString = match.originalURL.absoluteString
        canonicalURL = match.canonicalURL.absoluteString
        providerRaw = match.provider.rawValue
        contentKindRaw = match.contentKind.rawValue
        platformContentID = match.platformContentID
        linkPage = match.page
    }

    /// 把解析结果写进记录。空的字段不覆盖用户已经填好的东西。
    func adopt(_ metadata: LinkMetadata) {
        summary = metadata.summary ?? summary
        authorName = metadata.authorName ?? authorName
        if let thumbnail = metadata.thumbnailURL { thumbnailURLString = thumbnail.absoluteString }
        if let kind = metadata.contentKind { contentKindRaw = kind.rawValue }
        if let site = metadata.siteName, sourceName.trimmed.isEmpty { sourceName = site }
        metadataStatus = metadata.status
        repositoryStars = metadata.repositoryStars ?? repositoryStars
        repositoryForks = metadata.repositoryForks ?? repositoryForks
        repositoryIssues = metadata.repositoryIssues ?? repositoryIssues
        repositoryLanguage = metadata.repositoryLanguage ?? repositoryLanguage
        repositoryLicense = metadata.repositoryLicense ?? repositoryLicense
    }

    func touch() {
        updatedAt = Date()
    }
}
