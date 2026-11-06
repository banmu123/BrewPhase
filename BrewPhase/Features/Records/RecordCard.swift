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

/// 一条记录在 Masonry 窄列里的样子（混合式边界 C）。
///
/// 不把所有记录套进同一个 Card 容器：图片与视频让内容自己当主角（只留图片
/// 圆角，不加底板），文字用一层很轻的底色区分，链接走编辑式排版——按平台
/// 各有各的样子，但都适应 ~170pt 的列宽。高度完全由内容决定。
struct MasonryRecordCard: View {

    let record: Record

    var body: some View {
        switch record.carrier {
        case .link: MasonryLinkCard(record: record)
        case .image: MasonryImageCard(record: record)
        case .video: MasonryVideoCard(record: record)
        case .text: MasonryTextCard(record: record)
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

// MARK: - 图片

/// 图片卡：照片就是卡片本身。
///
/// 原始比例完整展示（`ImageStore.imageDimensions` 给出比例，读不到就 4:3
/// 占位），不裁不填。标题只在用户真填过时出现——`displayTitle` 会回退到
/// 备注首行，不区分的话同一句话会出现两遍。
struct MasonryImageCard: View {

    let record: Record

    private var imageRatio: CGFloat {
        ImageStore.shared.imageDimensions(named: record.mediaPath)?.aspectRatio
            ?? RecordCardHeightEstimator.placeholderAspectRatio
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            image
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                        .strokeBorder(Palette.hairline, lineWidth: 0.7)
                )

            if !record.title.trimmed.isEmpty {
                Text(.alreadyLocalized(record.title))
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !record.note.trimmed.isEmpty {
                Text(record.note)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .lineLimit(4)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            RecordMetaLine(record: record)
        }
    }

    @ViewBuilder
    private var image: some View {
        if let uiImage = ImageStore.shared.image(named: record.mediaPath, thumbnail: true) {
            Image(uiImage: uiImage)
                .resizable()
                .aspectRatio(imageRatio, contentMode: .fit)
        } else {
            ZStack {
                Palette.well
                Image(systemName: "photo")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(Palette.inkFaint)
            }
            .aspectRatio(imageRatio, contentMode: .fit)
        }
    }
}

// MARK: - 视频

/// 视频卡：本机 poster 按真实比例铺，列表里只有封面——播放发生在详情页。
struct MasonryVideoCard: View {

    let record: Record

    private var posterRatio: CGFloat {
        ImageStore.shared.imageDimensions(named: record.previewPath)?.aspectRatio
            ?? (16 / 9)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            poster
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                        .strokeBorder(Palette.hairline, lineWidth: 0.7)
                )

            if !record.displayTitle.isEmpty {
                Text(.alreadyLocalized(record.displayTitle))
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let source = record.sourceLine {
                Text(verbatim: source)
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
            }

            RecordMetaLine(record: record)
        }
    }

    @ViewBuilder
    private var poster: some View {
        ZStack(alignment: .center) {
            if let poster = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                Image(uiImage: poster)
                    .resizable()
                    .aspectRatio(posterRatio, contentMode: .fit)
            } else {
                ZStack {
                    LinearGradient(colors: [Palette.wellDeep, Palette.well],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                    Image(systemName: "play.rectangle")
                        .font(.system(size: 30, weight: .ultraLight))
                        .foregroundStyle(Palette.inkFaint.opacity(0.5))
                }
                .aspectRatio(posterRatio, contentMode: .fit)
            }

            Circle()
                .fill(Palette.card.opacity(0.92))
                .frame(width: 38, height: 38)
            Image(systemName: "play.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.espresso)
                .offset(x: 1)
        }
    }
}

// MARK: - 链接

/// 链接卡：平台不同，卡片不同——但都适应窄列的纵向编辑式排版。
struct MasonryLinkCard: View {

    let record: Record

    var body: some View {
        switch record.provider {
        case .youtube, .bilibili:
            videoLinkCard
        case .x:
            postCard
        case .github:
            repositoryCard
        case .generic:
            plainWebCard
        }
    }

    /// YouTube / Bilibili：封面（真实比例，兜底 16:9）+ 平台角标 + 标题。
    private var videoLinkCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                cover(ratio: ImageStore.shared.imageDimensions(named: record.previewPath)?
                    .aspectRatio ?? (16 / 9),
                    placeholderSymbol: "play.rectangle")
                    .overlay(alignment: .bottomTrailing) {
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
                        .padding(8)
                    }
                    .overlay(alignment: .center) {
                        Circle()
                            .fill(Palette.card.opacity(0.92))
                            .frame(width: 34, height: 34)
                            .overlay {
                                Image(systemName: "play.fill")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Palette.espresso)
                                    .offset(x: 1)
                            }
                    }
            }

            Text(record.displayTitle.isEmpty
                 ? LocalizedStringKey("未命名链接")
                 : .alreadyLocalized(record.displayTitle))
                .font(TypeScale.bodyMedium)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            if let credit = record.handle ?? record.linkHost {
                Text(verbatim: credit)
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
            }

            RecordMetaLine(record: record)
        }
    }

    /// X：帖子以文字为主，handle 行下一条细线，没有官方缩略图时不假装有图。
    private var postCard: some View {
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

            Hairline()

            Text(verbatim: record.linkSummary ?? record.displayTitle)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(6)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)

            if let dims = ImageStore.shared.imageDimensions(named: record.previewPath),
               let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(dims.aspectRatio ?? (16 / 9), contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous))
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

    /// GitHub：owner 小字 + 仓库名 + 摘要 + 图标统计行 + 右上小头像。
    private var repositoryCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    if let owner = record.repositoryOwner {
                        Text(verbatim: owner + " /")
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    Text(.alreadyLocalized(record.repositoryName ?? record.displayTitle))
                        .font(TypeScale.bodyMedium.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                RepositoryAvatar(record: record, size: 32)
            }

            if let summary = record.linkSummary {
                Text(verbatim: summary)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .lineLimit(3)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !record.repositoryStatItems.isEmpty {
                HStack(spacing: 10) {
                    ForEach(Array(record.repositoryStatItems.enumerated()), id: \.offset) { _, item in
                        HStack(spacing: 3) {
                            if !item.symbol.isEmpty {
                                Image(systemName: item.symbol)
                                    .font(.system(size: 9, weight: .semibold))
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
                    .lineLimit(2)
            }

            RecordMetaLine(record: record)
                .padding(.top, 1)
        }
    }

    /// 普通网页：有封面就按真实比例放上面，没有就纯文字。
    private var plainWebCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let dims = ImageStore.shared.imageDimensions(named: record.previewPath),
               let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(dims.aspectRatio ?? (16 / 9), contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                    .padding(.bottom, 1)
            }

            Text(record.displayTitle.isEmpty
                 ? LocalizedStringKey("未命名链接")
                 : .alreadyLocalized(record.displayTitle))
                .font(TypeScale.bodyMedium)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            if let source = record.linkCreditLine {
                HStack(spacing: 4) {
                    Image(systemName: "link")
                        .font(.system(size: 9, weight: .semibold))
                    Text(verbatim: source)
                        .lineLimit(1)
                }
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
            }

            // 标题本身可能就是摘要第一行（无标题网页），别显示两遍。
            if !record.title.trimmed.isEmpty, let summary = record.linkSummary {
                Text(verbatim: summary)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .lineLimit(3)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
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
    }

    /// 封面：本地缓存优先；没有缓存但知道远端地址时交给 `RecordCover`
    /// 去取（先占位转圈），取到后自动长出来。
    @ViewBuilder
    private func cover(ratio: CGFloat, placeholderSymbol: String) -> some View {
        if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(ratio, contentMode: .fit)
        } else if record.previewPath != nil || record.thumbnailURL != nil {
            RecordCover(record: record) {
                ZStack {
                    LinearGradient(colors: [Palette.wellDeep, Palette.well],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                    Image(systemName: placeholderSymbol)
                        .font(.system(size: 26, weight: .ultraLight))
                        .foregroundStyle(Palette.inkFaint.opacity(0.5))
                }
            }
            .aspectRatio(ratio, contentMode: .fit)
        } else {
            ZStack {
                LinearGradient(colors: [Palette.wellDeep, Palette.well],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: placeholderSymbol)
                    .font(.system(size: 26, weight: .ultraLight))
                    .foregroundStyle(Palette.inkFaint.opacity(0.5))
            }
            .aspectRatio(ratio, contentMode: .fit)
        }
    }
}

// MARK: - 文字

/// 文字卡：一层很轻的底，字是主角。
struct MasonryTextCard: View {

    let record: Record

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                if !record.title.trimmed.isEmpty {
                    Text(.alreadyLocalized(record.title))
                        .font(TypeScale.bodyMedium.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !record.note.trimmed.isEmpty {
                    Text(record.note)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(10)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.well)
            )

            RecordMetaLine(record: record)
        }
    }
}

// MARK: - 仓库头像

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
