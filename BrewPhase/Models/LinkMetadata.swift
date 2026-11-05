import Foundation

/// 一条链接来自哪个平台。
///
/// 平台不是用户给的标签，而是从 URL 本身读出来的事实：它决定这张卡片长什么样、
/// 能不能在 App 里播放、播放器该用谁家的官方地址。`generic` 不是「失败」，
/// 只是一张普通网页——它同样能保存、能打开。
enum LinkProvider: String, CaseIterable, Codable, Sendable {
    case youtube
    case bilibili
    case x
    case github
    case generic

    var id: String { rawValue }

    /// 卡片与详情页上的平台名。`generic` 没有名字——它只是一张网页。
    var displayName: String {
        switch self {
        case .youtube: return "YouTube"
        case .bilibili: return L("哔哩哔哩")
        case .x: return "X"
        case .github: return "GitHub"
        case .generic: return ""
        }
    }

    var symbol: String {
        switch self {
        case .youtube, .bilibili: return "play.rectangle"
        case .x: return "bubble.left"
        case .github: return "chevron.left.forwardslash.chevron.right"
        case .generic: return "globe"
        }
    }

    /// 平台自己提供了官方嵌入组件（播放器或帖子）。没有的一律走普通卡片。
    var hasOfficialEmbed: Bool {
        switch self {
        case .youtube, .bilibili, .x: return true
        case .github, .generic: return false
        }
    }
}

/// 这条内容在平台上是什么。与「载体」不同：载体说的是我们把它存成了什么，
/// 内容类型说的是它本来是什么。
enum LinkContentKind: String, Codable, Sendable {
    case video
    case socialPost
    case repository
    case article
    case webpage

    var label: String {
        switch self {
        case .video: return L("视频")
        case .socialPost: return L("帖子")
        case .repository: return L("仓库")
        case .article: return L("文章")
        case .webpage: return L("网页")
        }
    }
}

/// 能不能在 App 内看，以及用哪种方式看。
///
/// 这是**派生**的：由平台与解析出的内容 ID 决定，不单独存一份，免得数据库里
/// 出现「写着能播、实际没有播放器」的状态。
enum LinkEmbedCapability: String, Codable, Sendable {
    /// 只能外部打开。
    case none
    /// 官方视频播放器。
    case player
    /// 官方帖子嵌入。
    case post
}

/// 元数据的解析状态。失败不是「保存失败」，只是这张卡暂时只有标题和域名。
enum LinkMetadataStatus: String, Codable, Sendable {
    /// 还没试过（文字、图片、视频载体，或者刚粘贴还没停手）。
    case idle
    /// 正在解析。
    case pending
    /// 拿到了标题等主要信息。
    case resolved
    /// 拿到了一部分（比如只有标题，没有封面）。
    case partial
    /// 失败了。记录照常保存。
    case failed

    var isFailure: Bool { self == .failed }
}

/// 解析失败的原因。只说给用户听，不参与存储。
enum LinkFailure: String, Codable, Sendable {
    /// 连不上、超时。
    case unreachable
    /// 404 / 内容被删。
    case notFound
    /// 私密、年龄限制、地区限制、禁止嵌入。
    case restricted
    /// 平台不支持这种地址。
    case unsupported
    /// 页面打开了，但没读出任何有用的东西。
    case parseFailed
    /// 站点风控拒绝了这次读取（B 站的 412 就是它）。
    case refused

    var sentence: String {
        switch self {
        case .unreachable:
            return L("现在连不上这个网站，可以先保存，之后再补标题。")
        case .notFound:
            return L("这个地址可能已经不存在了。")
        case .restricted:
            return L("这条内容不公开，或者在当前地区看不到。")
        case .unsupported:
            return L("暂时不认这种链接，会按普通网页保存。")
        case .parseFailed:
            return L("网页打开了，但没读到标题和摘要。")
        case .refused:
            return L("这个网站拒绝了这次读取。标题可以自己填，不影响保存。")
        }
    }
}

/// 一条 URL 被识别之后的结果：平台、内容 ID、规范地址。
///
/// `platformContentID` 是唯一可以被信任、用来拼播放地址的东西——播放地址不来自
/// 用户输入，只从这个 ID 由对应 Adapter 生成。
struct LinkMatch: Equatable, Sendable {
    let originalURL: URL
    let canonicalURL: URL
    let provider: LinkProvider
    let contentKind: LinkContentKind
    let platformContentID: String
    /// 多 P 视频的分 P。只对 Bilibili 有意义，其余平台恒为 1。
    var page: Int = 1

    var isIdentified: Bool { !platformContentID.isEmpty }

    /// 去重键。同一个视频的三种写法必须相等。
    var canonicalKey: String { canonicalURL.absoluteString }
}

/// 可信的嵌入目标：地址由 Adapter 拼出，并附带允许在主框架里导航的域名。
/// WebView 只放行这些域名，点出去的一律交给系统浏览器。
struct LinkEmbed: Equatable, Sendable {
    let url: URL
    let allowedHosts: Set<String>
    /// 非 nil 时用一段**固定的** iframe 包装页加载，并把 `baseURL` 设成它。
    ///
    /// 两个原因都用得上：YouTube 直接打开 `/embed/` 没有 Referer，会回
    /// 「错误 153」；X 的帖子组件需要一个移动视口才会按屏宽排版。包装页里除了
    /// 适配器给出的地址之外没有任何内容，也不执行任何用户输入。
    var parentOrigin: URL?

    func allows(_ host: String) -> Bool {
        let lower = host.lowercased()
        return allowedHosts.contains { lower == $0 || lower.hasSuffix("." + $0) }
    }
}

/// 解析出来的平台信息。全部可选——任何一项缺失都不影响保存。
struct LinkMetadata: Equatable, Sendable {
    var title: String?
    var summary: String?
    var authorName: String?
    var siteName: String?
    var thumbnailURL: URL?
    var iconURL: URL?
    var canonicalURL: URL?
    var contentKind: LinkContentKind?
    var status: LinkMetadataStatus
    var failure: LinkFailure?

    // 仓库专用。别的平台留空，卡片不会去读。
    var repositoryStars: Int?
    var repositoryLanguage: String?
    var repositoryLicense: String?

    init(status: LinkMetadataStatus = .idle) {
        self.status = status
    }

    /// 有人会说「解析成功」但实际上只拿到一个空壳。这里以「有没有东西可显示」
    /// 为准，而不是以 HTTP 200 为准。
    var hasAnything: Bool {
        [title, summary, authorName, siteName].contains { value in
            !(value ?? "").trimmed.isEmpty
        } || thumbnailURL != nil
    }

    static func failure(_ reason: LinkFailure) -> LinkMetadata {
        var metadata = LinkMetadata(status: .failed)
        metadata.failure = reason
        return metadata
    }

    /// 有标题也有封面才算完整；只拿到一部分就如实标 partial。
    func finalized() -> LinkMetadata {
        var copy = self
        if !hasAnything {
            copy.status = .failed
            copy.failure = copy.failure ?? .parseFailed
        } else if thumbnailURL == nil {
            copy.status = .partial
        } else {
            copy.status = .resolved
        }
        return copy
    }
}

/// 识别 + 解析的最终产物。短链重定向之后 `match` 可能已经换成了最终地址。
struct LinkResolution: Sendable {
    var match: LinkMatch
    var metadata: LinkMetadata
}
