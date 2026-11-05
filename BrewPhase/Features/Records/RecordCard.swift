import SwiftUI

/// 四种载体的视觉语言：颜色与图标。
///
/// 颜色仍然只从既有色板里取，没有为记录新造色值——载体之间的差别靠「有没有图、
/// 图多大、标题多重」来体现，而不是四种饱和色。
enum RecordPresentation {

    static func tint(_ carrier: RecordCarrier) -> Color {
        switch carrier {
        case .link: return Palette.roast
        case .image: return Palette.moss
        case .video: return Palette.espresso
        case .text: return Palette.inkSoft
        }
    }
}

/// 封面槽的统一状态机：本地有图就画图；有远端地址就先在占位上叠一个转圈，
/// `CoverFetcher` 取到后记录的 `previewPath` 更新，图会自动长出来；取失败
/// （或本轮已经失败过）就安静地退回占位。视频卡与仓库头像共用这一套。
struct RecordCover<Placeholder: View>: View {

    let record: Record
    var thumbnail: Bool = true
    @ViewBuilder var placeholder: Placeholder

    private enum Phase { case initial, loading, settled }
    @State private var phase: Phase = .initial

    var body: some View {
        Group {
            if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: thumbnail) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if phase == .loading {
                placeholder
                    .overlay { ProgressView().controlSize(.regular) }
            } else {
                placeholder
            }
        }
        .task(id: record.id) { await update() }
    }

    private func update() async {
        if ImageStore.shared.image(named: record.previewPath, thumbnail: thumbnail) != nil {
            phase = .settled
            return
        }
        guard record.thumbnailURL != nil else { phase = .settled; return }
        // 视图重建时先同步定一次状态：本轮已经试过失败的不再闪一下转圈。
        phase = CoverFetcher.shared.hasAttempted(record.id) ? .settled : .loading
        let result = await CoverFetcher.shared.fetch(record)
        phase = .settled
        // .fetched 时 previewPath 的更新会自动换到图；失败/跳过则留在占位。
        _ = result
    }
}

/// 一条记录在列表里的样子。
///
/// 四种模板，因为四种内容本来就不一样：链接有来源和预览图，照片有画面，视频有
/// 封面和播放，文字只有字。共用一个空间，但不强求同一种排版。
struct RecordCard: View {

    let record: Record

    var body: some View {
        switch record.carrier {
        case .link: LinkRecordCard(record: record)
        case .image: ImageRecordCard(record: record)
        case .video: VideoRecordCard(record: record)
        case .text: TextRecordCard(record: record)
        }
    }
}

// MARK: - 标签与时间

/// 卡片底部那一行：标签在左（用户赋予的意义），时间在右（系统记录的事实）。
/// 标签用正文色系的中等灰，不做胶囊——它不该抢走标题的位置。
struct RecordMetaLine: View {

    let record: Record
    var showsDate: Bool = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let tagLine = record.tagLine {
                Text(verbatim: tagLine)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.roast.opacity(0.85))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if showsDate {
                Text(verbatim: Fmt.short(record.createdAt))
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
            }
        }
    }
}

// MARK: - 链接

/// 一条链接在列表里的样子。
///
/// 平台不同，卡片就该不同：视频给封面和播放，仓库给描述和 star，帖子给文字，
/// 普通网页给一张小图和域名。共同点是**标题永远最重**，平台名与标签都靠边站。
struct LinkRecordCard: View {

    let record: Record

    var body: some View {
        switch record.provider {
        case .youtube, .bilibili:
            if record.canPlayInline {
                VideoLinkCard(record: record)
            } else {
                PlainLinkCard(record: record)
            }
        case .x:
            PostLinkCard(record: record)
        case .github:
            RepositoryCard(record: record)
        case .generic:
            PlainLinkCard(record: record)
        }
    }
}

/// YouTube / Bilibili：16:9 封面 + 平台角标 + 播放标记。
struct VideoLinkCard: View {

    let record: Record

    var body: some View {
        Card(padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    RecordCover(record: record) {
                        ZStack {
                            LinearGradient(colors: [Palette.wellDeep, Palette.well],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                            Image(systemName: "play.rectangle")
                                .font(.system(size: 46, weight: .ultraLight))
                                .foregroundStyle(Palette.inkFaint.opacity(0.45))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 150)
                    .clipped()

                    Circle()
                        .fill(Palette.card.opacity(0.94))
                        .frame(width: 42, height: 42)
                    Image(systemName: "play.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.espresso)
                        .offset(x: 1.5)
                }
                .frame(height: 150)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(alignment: .topLeading) {
                    HStack(spacing: 4) {
                        Image(systemName: "play.rectangle.fill")
                            .font(.system(size: 8, weight: .semibold))
                        Text(verbatim: record.provider.displayName)
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.black.opacity(0.45)))
                    .padding(9)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(record.displayTitle.isEmpty
                         ? LocalizedStringKey("未命名链接")
                         : .alreadyLocalized(record.displayTitle))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    if let credit = record.handle ?? record.linkHost {
                        Text(verbatim: credit)
                            .font(TypeScale.micro)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                    }

                    if !record.note.trimmed.isEmpty {
                        Text(record.note)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .lineLimit(1)
                    }

                    RecordMetaLine(record: record)
                        .padding(.top, 2)
                }
                .padding(.horizontal, 4)
                .padding(.bottom, 2)
            }
        }
    }
}

/// X：文字为主。没有官方缩略图时不假装有图。
struct PostLinkCard: View {

    let record: Record

    var body: some View {
        Card(padding: 15) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 5) {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 9, weight: .semibold))
                    Text(verbatim: record.handle ?? "X")
                        .font(TypeScale.caption.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(verbatim: "X")
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                }
                .foregroundStyle(Palette.inkSoft)

                Text(verbatim: record.linkSummary ?? record.displayTitle)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(5)
                    .lineSpacing(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(height: 120)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }

                if !record.note.trimmed.isEmpty {
                    Text(record.note)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(2)
                }

                RecordMetaLine(record: record)
            }
        }
    }
}

/// GitHub 仓库卡：owner 小字 + 仓库名大字 + 右上头像 + 描述 + 图标统计行。
/// 仓库没有视频，所以没有播放按钮——它是一张「项目卡」。
struct RepositoryCard: View {

    let record: Record

    var body: some View {
        Card(padding: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        if let owner = record.repositoryOwner {
                            Text(verbatim: owner + " /")
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        Text(.alreadyLocalized(record.repositoryName ?? record.displayTitle))
                            .font(TypeScale.cardTitle)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }

                    Spacer(minLength: 8)

                    RepositoryAvatar(record: record, size: 54)
                }

                if let summary = record.linkSummary {
                    Text(verbatim: summary)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(3)
                        .lineSpacing(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !record.repositoryStatItems.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(Array(record.repositoryStatItems.enumerated()), id: \.offset) { _, item in
                            HStack(spacing: 3) {
                                if !item.symbol.isEmpty {
                                    Image(systemName: item.symbol)
                                        .font(.system(size: 9.5, weight: .semibold))
                                }
                                Text(verbatim: item.text)
                                    .font(TypeScale.micro)
                            }
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                        }
                    }
                }

                if !record.note.trimmed.isEmpty {
                    Text(record.note)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(1)
                }

                RecordMetaLine(record: record)
                    .padding(.top, 1)
            }
        }
    }
}

/// 仓库的「缩略图」就是 owner 头像；没缓存到时退回一个克制的斜杠徽标。
struct RepositoryAvatar: View {

    let record: Record
    var size: CGFloat = 44

    var body: some View {
        RecordCover(record: record) {
            ZStack {
                Palette.well
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: size * 0.24, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.8)
        )
    }
}

/// 普通网页：有封面就用封面占位，没有就只留文字。
struct PlainLinkCard: View {

    let record: Record

    var body: some View {
        Card(padding: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(record.displayTitle.isEmpty
                         ? LocalizedStringKey("未命名链接")
                         : .alreadyLocalized(record.displayTitle))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    if let source = record.linkCreditLine {
                        HStack(spacing: 4) {
                            Image(systemName: record.provider == .generic ? "link" : record.provider.symbol)
                                .font(.system(size: 9, weight: .semibold))
                            Text(verbatim: source)
                                .lineLimit(1)
                        }
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                    }

                    // 标题本身可能就是摘要第一行（帖子、无标题网页），别显示两遍。
                    if !record.title.trimmed.isEmpty, let summary = record.linkSummary {
                        Text(verbatim: summary)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .lineLimit(2)
                    }

                    if !record.note.trimmed.isEmpty {
                        Text(record.note)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .lineLimit(2)
                    }

                    RecordMetaLine(record: record)
                        .padding(.top, 2)
                }

                Spacer(minLength: 0)

                if let preview = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                    Image(uiImage: preview)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 62, height: 62)
                        .clipShape(RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous))
                }
            }
        }
    }
}

// MARK: - 图片

struct ImageRecordCard: View {

    let record: Record

    var body: some View {
        Card(padding: 12) {
            HStack(alignment: .top, spacing: 12) {
                Group {
                    if let image = ImageStore.shared.image(named: record.mediaPath, thumbnail: true) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        ZStack {
                            Palette.well
                            Image(systemName: "photo")
                                .font(.system(size: 18, weight: .light))
                                .foregroundStyle(Palette.inkFaint)
                        }
                    }
                }
                .frame(width: 92, height: 92)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    if !record.displayTitle.isEmpty {
                        Text(LocalizedStringKey.alreadyLocalized(record.displayTitle))
                            .font(TypeScale.bodyMedium)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                    }
                    if !record.note.trimmed.isEmpty {
                        Text(record.note)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    RecordMetaLine(record: record)
                }

                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - 视频

struct VideoRecordCard: View {

    let record: Record

    var body: some View {
        Card(padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    if let poster = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                        Image(uiImage: poster)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Palette.well
                    }

                    Circle()
                        .fill(Palette.card.opacity(0.92))
                        .frame(width: 38, height: 38)
                    Image(systemName: "play.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.espresso)
                        .offset(x: 1)
                }
                .frame(height: 132)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous))

                VStack(alignment: .leading, spacing: 5) {
                    Text(record.displayTitle.isEmpty
                         ? LocalizedStringKey("未命名视频")
                         : .alreadyLocalized(record.displayTitle))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    RecordMetaLine(record: record)
                }
                .padding(.horizontal, 4)
                .padding(.bottom, 2)
            }
        }
    }
}

// MARK: - 文字

struct TextRecordCard: View {

    let record: Record

    var body: some View {
        Card(padding: 16) {
            VStack(alignment: .leading, spacing: 7) {
                if !record.title.trimmed.isEmpty {
                    Text(LocalizedStringKey.alreadyLocalized(record.title))
                        .font(TypeScale.title)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                Text(verbatim: record.note.isEmpty ? "—" : record.note)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(5)
                    .lineSpacing(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                RecordMetaLine(record: record)
                    .padding(.top, 2)
            }
        }
    }
}
