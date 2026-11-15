import Foundation

/// 首页一张卡片要显示的东西。纯值类型。
///
/// 它是 `@Model` 的**投影**，不是副本：标题、图片文件名、时间都只是读出来的
/// 展示字段，点开时按 `target` 里的 UUID 回到原件。首页因此没有第二套内容，
/// 也不会因为一次预览把业务数据写回去。
struct WorkspaceCard: Identifiable, Equatable {

    /// 身份：一个真实实体，或某个空间空着的那张占位卡。
    enum Identity: Hashable {
        case entity(UUID)
        case empty(AppTab)

        /// 只用于排序兜底：同一时刻的两张卡每次刷新都保持同一顺序。
        var sortKey: String {
            switch self {
            case .entity(let id): return id.uuidString
            case .empty(let space): return "empty-\(space.rawValue)"
            }
        }
    }

    /// 内容种类。三种空间各有自己的种类集合；同一个空间里「先每类取一张」
    /// 靠它去重。记录按**载体**再分一层——否则一列记录会被同一种载体占满。
    enum Kind: Hashable {
        case bean
        case brew
        case tasting
        case record(RecordCarrier)
        case canvas
        case empty
    }

    /// 点开这张卡要去哪。`.none` 表示它不是一个可打开的实体（空态卡）。
    enum Target: Equatable {
        case bean(UUID)
        case record(UUID)
        case canvas(UUID)
        case none
    }

    let id: Identity
    let kind: Kind

    /// 卡片左上角那枚小数据：剩余克数、粉水比、日期。空串表示不放。
    let badge: String
    /// 标题上方一行小字：这是什么东西。
    let overline: String
    /// 真正的标题：豆名、记录标题、画布名。
    let title: String
    /// 真实图片（`ImageStore` 里的文件名）。nil 时不编一张图，改用色块。
    let imagePath: String?

    /// 时间。首页唯一的排序依据。
    let timestamp: Date
    let target: Target

    static func == (lhs: WorkspaceCard, rhs: WorkspaceCard) -> Bool {
        lhs.id == rhs.id
            && lhs.kind == rhs.kind
            && lhs.badge == rhs.badge
            && lhs.overline == rhs.overline
            && lhs.title == rhs.title
            && lhs.imagePath == rhs.imagePath
            && lhs.timestamp == rhs.timestamp
            && lhs.target == rhs.target
    }
}

// MARK: - 从真实数据投影

extension WorkspaceCard {

    init(bean: Bean) {
        self.init(
            id: .entity(bean.id),
            kind: .bean,
            badge: Fmt.grams(bean.remainingG),
            overline: L("咖啡豆"),
            title: bean.name.trimmed.isEmpty ? L("未命名") : bean.name,
            imagePath: bean.imagePath,
            timestamp: bean.createdAt,
            target: .bean(bean.id)
        )
    }

    init(brew: Brew) {
        let bean = brew.bean
        self.init(
            id: .entity(brew.id),
            kind: .brew,
            badge: Self.brewBadge(brew),
            overline: L("冲煮"),
            title: Self.bagName(bean) ?? L("一杯咖啡"),
            // 一杯咖啡的样子就是那包豆的样子：不另找一张「冲煮插画」。
            imagePath: bean?.imagePath,
            timestamp: brew.date,
            // 冲煮没有独立详情页，点开是它所属那包豆的档案。
            target: bean.map { .bean($0.id) } ?? .none
        )
    }

    init(tasting: Tasting) {
        let bean = tasting.bean
        self.init(
            id: .entity(tasting.id),
            kind: .tasting,
            badge: tasting.score > 0 ? Self.scoreBadge(tasting.score) : "",
            overline: L("风味"),
            title: Self.bagName(bean) ?? L("风味记录"),
            imagePath: bean?.imagePath,
            timestamp: tasting.date,
            target: bean.map { .bean($0.id) } ?? .none
        )
    }

    init(record: Record) {
        self.init(
            id: .entity(record.id),
            kind: .record(record.carrier),
            badge: Fmt.short(record.createdAt),
            overline: Self.recordOverline(record),
            title: record.displayTitle.trimmed.isEmpty ? L("未命名记录") : record.displayTitle,
            imagePath: Self.recordImagePath(record),
            timestamp: record.createdAt,
            target: .record(record.id)
        )
    }

    init(canvas: Canvas) {
        self.init(
            id: .entity(canvas.id),
            kind: .canvas,
            badge: Fmt.short(canvas.updatedAt),
            overline: L("画布"),
            title: canvas.displayName,
            // 画布的封面不是一张图片文件，而是节点分布（见 `CanvasThumbnailPreview`）。
            imagePath: nil,
            timestamp: canvas.updatedAt,
            target: .canvas(canvas.id)
        )
    }

    /// 空间空着时唯一的那张卡。它和其他卡同尺寸、同重量，只是没有内容。
    static func empty(for space: AppTab) -> WorkspaceCard {
        WorkspaceCard(
            id: .empty(space),
            kind: .empty,
            badge: "",
            overline: L("空着"),
            title: space.emptyTitle,
            imagePath: nil,
            timestamp: .distantPast,
            target: .none
        )
    }

    // MARK: 投影细节

    private static func bagName(_ bean: Bean?) -> String? {
        guard let bean, !bean.name.trimmed.isEmpty else { return nil }
        return bean.name
    }

    private static func scoreBadge(_ score: Int) -> String {
        "★ \(score)"
    }

    private static func brewBadge(_ brew: Brew) -> String {
        if brew.score > 0 { return scoreBadge(brew.score) }
        if brew.coffeeG > 0 { return Fmt.doseLine(coffeeG: brew.coffeeG, waterG: brew.waterG) }
        return ""
    }

    private static func recordOverline(_ record: Record) -> String {
        guard record.carrier == .link else { return record.carrier.title }
        let provider = record.provider.displayName
        return provider.isEmpty ? L("链接") : provider
    }

    /// 卡片上真正能画出来的那张图。与记录列表同一条规则：
    /// 图片读原图，视频与链接读封面，文字没有图。
    private static func recordImagePath(_ record: Record) -> String? {
        switch record.carrier {
        case .image: return record.mediaPath
        case .video, .link: return record.previewPath
        case .text: return nil
        }
    }
}

// MARK: - 一列卡片怎么选

/// 首页三列共用的选卡规则。
///
/// 三列必须是同一种策略，否则「Coffee 比 Records 显眼」会从数据层就开始了。
/// 规则只有两条，对三个空间一视同仁：
///
/// 1. **先按种类各取一张**（时间最新的那张）。Coffee 因此总能看到一包豆，
///    Records 会横跨图片、链接、文字，而不是被同一种载体占满。
/// 2. **再按时间补齐**。画布只有一种「种类」，于是第二、三张回到时间顺序。
///
/// 上限是三张，和 `WorkspaceStackLayout.visibleLimit` 是同一个数——列里画几张，
/// 就只取几张，不为看不见的卡片读数据。
enum WorkspaceHomeFeed {

    static let cardLimit = WorkspaceStackLayout.visibleLimit

    static func cards(from candidates: [WorkspaceCard],
                      limit: Int = cardLimit) -> [WorkspaceCard] {
        guard limit > 0, !candidates.isEmpty else { return [] }

        let ordered = candidates.sorted { lhs, rhs in
            if lhs.timestamp != rhs.timestamp { return lhs.timestamp > rhs.timestamp }
            return lhs.id.sortKey < rhs.id.sortKey
        }

        var picked: [WorkspaceCard] = []
        var kinds: Set<WorkspaceCard.Kind> = []

        for card in ordered where !kinds.contains(card.kind) {
            picked.append(card)
            kinds.insert(card.kind)
            if picked.count == limit { return picked }
        }

        for card in ordered {
            guard !picked.contains(where: { $0.id == card.id }) else { continue }
            picked.append(card)
            if picked.count == limit { break }
        }

        return picked
    }
}

// MARK: - 问候

/// 首页页头那一句问候。按小时分三档，不猜用户的作息。
enum WorkspaceGreeting: String, CaseIterable {
    case morning
    case afternoon
    case evening

    static func at(hour: Int) -> WorkspaceGreeting {
        switch hour {
        case 5..<12: return .morning
        case 12..<18: return .afternoon
        default: return .evening
        }
    }

    var line: String {
        switch self {
        case .morning: return L("早上好。")
        case .afternoon: return L("下午好。")
        case .evening: return L("晚上好。")
        }
    }
}
