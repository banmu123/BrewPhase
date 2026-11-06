import Foundation

/// 记录详情页的展示决策：哪些信息该出现、哪些只是同一件事的第二种说法。
///
/// 详情页最容易犯的错不是漏字段，而是重复：文字记录的正文被当成「我的备注」
/// 再显示一遍；链接的摘要与标题本来是同一句话；域名既当标题又当来源。
/// 这些判断放进一个纯值类型，视图只负责排版，
/// `RecordDetailPresentationTests` 直接钉住「同一件事只说一遍」。
struct RecordDetailPresentation {

    /// 标题区的标题。空串表示这条记录没有标题，标题区不占位——
    /// 绝不把备注首行（或域名）冒充成标题再展示一次。
    let title: String

    /// 作者 / handle。域名不在这里，它属于来源区。
    let credit: String?

    /// 内容区正文：文字载体的原文、X 帖子正文、仓库描述、网页摘要。
    let content: String?

    /// 「我的备注」。文字载体的 `note` 就是原文，永远不进这一栏。
    let personalNote: String?

    /// 可打开的原始来源。没有合法地址时来源区与菜单项都不出现，
    /// 不做「看起来能点、点了没反应」的入口。
    let sourceURL: URL?

    init(record: Record) {
        let userTitle = record.title.trimmed
        let note = record.note
        let hasNote = !note.trimmed.isEmpty

        var title = userTitle
        var credit: String?
        var content: String?
        var personalNote: String?
        var sourceURL: URL?

        switch record.carrier {
        case .text:
            // 正文就是记录本身：标题（若有）在标题区，正文在这里，
            // 不再作为「我的备注」出现第二遍。
            content = hasNote ? note : nil

        case .image, .video:
            personalNote = hasNote ? note : nil

        case .link:
            personalNote = hasNote ? note : nil
            sourceURL = record.openLink
            let summary = record.linkSummary
            switch record.provider {
            case .github:
                // owner 与仓库名在标题区，描述属于内容区。
                title = record.repositoryName ?? record.displayTitle
                content = summary
            case .x:
                // 帖子正文是内容，不是标题。
                title = userTitle
                content = summary
                credit = record.handle
            case .youtube, .bilibili:
                // 平台给的视频标题就是标题，卡片与详情都不再单列摘要。
                title = userTitle.isEmpty ? record.displayTitle : userTitle
                credit = record.handle
            case .generic:
                // 没有用户标题时，摘要就是内容本身，标题区留空；
                // 有标题时摘要才是补充说明。
                content = summary
                credit = record.handle
            }
        }

        // 链接的标题与正文/作者可能是同一段文字（元数据把摘要首行当标题），
        // 只保留一处。文字载体不参与：那是标题与正文，两处都该有。
        if record.carrier == .link {
            // 标题退化成域名时交给来源区——「example.com」当标题没有信息量。
            if let host = record.linkHost, title == host { title = "" }

            let normalized = title.trimmed.lowercased()
            if !normalized.isEmpty {
                if content?.trimmed.lowercased() == normalized { content = nil }
                if credit?.trimmed.lowercased() == normalized { credit = nil }
            }
        }

        self.title = title
        self.credit = credit
        self.content = content
        self.personalNote = personalNote
        self.sourceURL = sourceURL
    }
}
