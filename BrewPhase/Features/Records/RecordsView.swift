import AVKit
import SwiftData
import SwiftUI

/// 记录 —— 一级页面之二，一个人的内容收集空间。
///
/// 页面只做三件事：按时间列出所有内容、按标签筛、把新的放进来。它不预设这套
/// 内容「应该」分成几类——分类是用户自己贴的标签，随时能改；系统只认四种载体：
/// 链接、图片、视频、文字。
struct RecordsView: View {

    @Environment(\.modelContext) private var context

    @Query(sort: \Record.createdAt, order: .reverse) private var records: [Record]
    @Query(sort: \RecordTag.createdAt) private var tags: [RecordTag]

    @State private var filter: RecordTag?
    @State private var detail: Record?
    /// 长按删除要先过确认：列表上的长按太容易误触。
    @State private var pendingDelete: Record?
    @State private var showsAdd = false
    @State private var isSearching = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    /// 筛选条只列「真的被用过」的标签：六个建议标签一条记录都没贴的时候，
    /// 摆六个点不动的筛选项只是噪音。
    private var filters: [RecordTag] {
        tags.filter { $0.usageCount > 0 }
    }

    private var filtered: [Record] {
        var result = records
        if let filter {
            result = result.filter { record in
                (record.tags ?? []).contains { $0.id == filter.id }
            }
        }
        let keyword = query.trimmed.lowercased()
        if !keyword.isEmpty {
            result = result.filter { record in
                record.title.lowercased().contains(keyword)
                || record.note.lowercased().contains(keyword)
                || record.sourceName.lowercased().contains(keyword)
                || (record.linkHost?.lowercased().contains(keyword) ?? false)
                || (record.tags ?? []).contains { $0.name.lowercased().contains(keyword) }
            }
        }
        return result
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header

                    if isSearching {
                        searchField.padding(.top, 14)
                    }

                    if !filters.isEmpty {
                        filterBar.padding(.top, 14)
                    }

                    content.padding(.top, 16)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, 28)
            }
            .background(Palette.paper)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $detail) { record in
                RecordDetailView(record: record)
            }
            .sheet(isPresented: $showsAdd) {
                AddFlowView()
            }
            .task {
                guard filter == nil, let name = DebugLaunch.recordTagName else { return }
                filter = tags.first { $0.name == name || $0.name == L(name) }
            }
            .confirmationDialog(
                "删除这条记录？",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除", role: .destructive) {
                    if let record = pendingDelete { delete(record) }
                    pendingDelete = nil
                }
                Button("取消", role: .cancel) { pendingDelete = nil }
            } message: {
                Text("删除后不可恢复。")
            }
        }
    }

    // MARK: - 顶部

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                Text("记录")
                    .font(TypeScale.display)
                    .foregroundStyle(Palette.ink)

                if !records.isEmpty {
                    Text(L("%@ 条", String(records.count)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }

            Spacer(minLength: 0)

            Button {
                withAnimation(Motion.settle) {
                    isSearching.toggle()
                    if isSearching {
                        searchFocused = true
                    } else {
                        query = ""
                    }
                }
            } label: {
                Image(systemName: isSearching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Palette.inkSoft)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.card))
                    .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isSearching ? "关闭搜索" : "搜索")

            Button {
                showsAdd = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.card)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.espresso))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("添加记录")
        }
        .padding(.top, 10)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.inkFaint)
            TextField("搜索标题、备注、标签", text: $query)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
                .focused($searchFocused)
                .submitLabel(.search)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.inkFaint)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Capsule(style: .continuous).fill(Palette.card))
        .overlay(Capsule(style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.8))
    }

    private var filterBar: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 7) {
                FilterChip(title: L("全部"), isOn: filter == nil) {
                    withAnimation(Motion.quick) { filter = nil }
                }
                ForEach(filters) { tag in
                    FilterChip(title: tag.displayName, isOn: filter?.id == tag.id) {
                        withAnimation(Motion.quick) {
                            filter = filter?.id == tag.id ? nil : tag
                        }
                    }
                }
            }
            .padding(.vertical, 1)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    // MARK: - 列表

    @ViewBuilder
    private var content: some View {
        if records.isEmpty {
            EmptyStateView(
                symbol: "rectangle.stack",
                title: "还没有记录",
                message: "一段网页、一张照片、一段视频、一句话。放进来，再决定它对你意味着什么。",
                actionLabel: "添加第一条",
                action: { showsAdd = true }
            )
            .padding(.top, 28)
        } else if filtered.isEmpty {
            VStack(spacing: 8) {
                Text(query.trimmed.isEmpty ? "这个标签下还没有记录。" : "没有匹配的记录。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)
                if query.trimmed.isEmpty {
                    Button {
                        showsAdd = true
                    } label: {
                        Text("添加一条")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.roast)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 60)
        } else {
            LazyVStack(spacing: 10) {
                ForEach(filtered) { record in
                    Button {
                        detail = record
                    } label: {
                        RecordCard(record: record)
                    }
                    .buttonStyle(CardButtonStyle())
                    .contextMenu {
                        Button(role: .destructive) {
                            pendingDelete = record
                        } label: {
                            Label("删除这条记录", systemImage: "trash")
                        }
                    }
                }
            }
        }
    }

    // MARK: - 删除

    /// 与豆子删除同一个次序：**先让数据库删成功，再动磁盘上的文件**。
    /// 反过来一旦落库失败，就是「记录还在、文件没了」。
    private func delete(_ record: Record) {
        let media = record.mediaPath
        let preview = record.previewPath
        let carrier = record.carrier
        context.delete(record)
        do {
            try context.save()
        } catch {
            AppLog.store.error("record delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return
        }
        if carrier == .video {
            MediaStore.shared.delete(media)
        } else {
            ImageStore.shared.delete(media)
        }
        ImageStore.shared.delete(preview)
    }
}

// MARK: - 详情

/// 一条记录的完整样子：内容、自己的话、贴过的标签。
///
/// 视频在这里才真正播放；图片在这里才铺满宽度。列表里它们都是缩略的，因为
/// 列表回答的是「我收过什么」，不是「它长什么样」。
struct RecordDetailView: View {

    let record: Record

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    /// 播放器只在用户点过之后才存在：列表和详情打开时都不加载任何嵌入内容。
    @State private var isPlaying = false
    @State private var isFullscreen = false
    @State private var isRefreshing = false
    @State private var refreshFailure: LinkFailure?
    @State private var isHydratingCover = false

    /// `autoPlay` 只给调试截图用：正常路径必须先点封面才会创建播放器。
    init(record: Record, autoPlay: Bool = false) {
        self.record = record
        _isPlaying = State(initialValue: autoPlay)
    }

    private var tint: Color { RecordPresentation.tint(record.carrier) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                if record.carrier == .image, let image = ImageStore.shared.image(named: record.mediaPath, thumbnail: false) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                        .padding(.top, 18)
                }

                if record.carrier == .video {
                    videoPlayer.padding(.top, 18)
                }

                if record.carrier == .link {
                    linkMedia.padding(.top, 18)
                }

                if record.carrier == .link, let summary = record.linkSummary {
                    Text(verbatim: summary)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 16)
                }

                if !record.note.trimmed.isEmpty {
                    Text(record.note)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.ink)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 16)
                }

                if record.carrier == .link, let url = record.openLink {
                    Link(destination: url) {
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 12, weight: .semibold))
                            Text(verbatim: record.linkHost ?? record.urlString)
                                .font(TypeScale.callout)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(Palette.roast)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .padding(.top, 10)
                    .accessibilityLabel(record.urlString)
                }

                if !record.orderedTags.isEmpty {
                    FlowLayout(spacing: 6, lineSpacing: 6) {
                        ForEach(record.orderedTags) { tag in
                            Chip(text: tag.displayName, tint: Palette.inkSoft, background: Palette.well)
                        }
                    }
                    .padding(.top, 16)
                }

                Hairline().padding(.top, 20)

                VStack(alignment: .leading, spacing: 6) {
                    // 来源与作者已经写在标题下面，这里只留时间——同一件事不说两遍。
                    detailLine("记录于", Fmt.precise(record.createdAt, calendar: DateMath.calendar))
                }
                .padding(.top, 16)

                if needsMetadataRefresh {
                    refreshRow.padding(.top, 16)
                }

                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    Text("删除这条记录")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.priority)
                }
                .buttonStyle(.plain)
                .padding(.top, 28)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { isEditing = true }
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.roast)
            }
        }
        .sheet(isPresented: $isEditing) {
            RecordEditorView(carrier: record.carrier, existing: record)
        }
        .fullScreenCover(isPresented: $isFullscreen) {
            if let embed = record.linkEmbed {
                FullScreenPlayerView(record: record, embed: embed)
            }
        }
        .onChange(of: isFullscreen) { _, showing in
            // 全屏是一次独立的播放：退出后行内回到封面，避免两个播放器同时出声。
            if !showing { isPlaying = false }
        }
        .task(id: record.previewPath) {
            // 详情页是唯一的 force 重试口：列表里失败过的封面，打开详情再试一次。
            guard record.carrier == .link, record.previewPath == nil,
                  record.thumbnailURL != nil else { return }
            isHydratingCover = true
            _ = await CoverFetcher.shared.fetch(record, force: true)
            isHydratingCover = false
        }
        .confirmationDialog("删除这条记录？", isPresented: $isConfirmingDelete,
                            titleVisibility: .visible) {
            Button("删除", role: .destructive) { delete() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后不可恢复。")
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 5) {
                    Image(systemName: record.carrier == .link ? record.provider.symbol : record.carrier.symbol)
                        .font(.system(size: 10, weight: .semibold))
                    Text(verbatim: headerBadge)
                        .font(TypeScale.micro)
                        .tracking(0.8)
                }
                .foregroundStyle(tint)

                if record.provider == .github {
                    // 仓库照 GitHub 的习惯拆两行：owner 是小字，仓库名才是标题。
                    VStack(alignment: .leading, spacing: 2) {
                        if let owner = record.repositoryOwner {
                            Text(verbatim: owner + " /")
                                .font(TypeScale.callout)
                                .foregroundStyle(Palette.inkFaint)
                                .lineLimit(1)
                        }
                        Text(.alreadyLocalized(record.repositoryName ?? record.displayTitle))
                            .font(TypeScale.beanName)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text(record.displayTitle.isEmpty
                         ? LocalizedStringKey(record.carrier.title)
                         : .alreadyLocalized(record.displayTitle))
                        .font(TypeScale.beanName)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if record.carrier == .link, let credit = record.linkCreditLine,
                   !(record.provider == .github && record.repositoryOwner != nil) {
                    // GitHub 的 owner 已经拆在标题上了，不再重复。
                    Text(verbatim: credit)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                }

                if !record.repositoryStatItems.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(Array(record.repositoryStatItems.enumerated()), id: \.offset) { _, item in
                            HStack(spacing: 3) {
                                if !item.symbol.isEmpty {
                                    Image(systemName: item.symbol)
                                        .font(.system(size: 10, weight: .semibold))
                                }
                                Text(verbatim: item.text)
                                    .font(TypeScale.caption)
                            }
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                        }
                    }
                }
            }

            Spacer(minLength: 10)

            if record.provider == .github {
                RepositoryAvatar(record: record, size: 64)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    /// 链接的徽标只说平台，不说载体——「链接」这两个字对读者没有信息量。
    private var headerBadge: String {
        guard record.carrier == .link else { return record.carrier.title }
        return record.provider.displayName.isEmpty ? L("网页") : record.provider.displayName
    }

    // MARK: - 链接播放

    private var providerName: String {
        record.provider.displayName.isEmpty ? L("网页") : record.provider.displayName
    }

    /// 有官方组件就显示「封面 + 播放」；点之前不创建任何 WebView。
    @ViewBuilder
    private var linkMedia: some View {
        if let embed = record.linkEmbed {
            if isPlaying {
                LinkPlayerView(
                    record: record,
                    embed: embed,
                    isPost: record.embedCapability == .post,
                    onCollapse: { withAnimation(Motion.quick) { isPlaying = false } },
                    onFullscreen: { isFullscreen = true }
                )
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    linkPoster
                    Text(verbatim: record.embedCapability == .post
                         ? L("点击后加载 %@ 的官方帖子组件，届时会与对方服务器通信。", providerName)
                         : L("点击后加载 %@ 官方播放器，届时会与对方服务器通信。", providerName))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if record.provider != .github,
                  let preview = ImageStore.shared.image(named: record.previewPath, thumbnail: false) {
            Image(uiImage: preview)
                .resizable()
                .scaledToFill()
                .frame(height: 200)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
        }
    }

    private var linkPoster: some View {
        Button {
            withAnimation(Motion.quick) { isPlaying = true }
        } label: {
            ZStack(alignment: .bottomLeading) {
                Group {
                    if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: false) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        ZStack {
                            LinearGradient(colors: [Palette.wellDeep, Palette.well],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                            Image(systemName: record.provider.symbol)
                                .font(.system(size: 34, weight: .ultraLight))
                                .foregroundStyle(Palette.inkFaint)
                            if isHydratingCover {
                                ProgressView().controlSize(.regular)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: record.embedCapability == .post ? 260 : 200)
                .clipped()

                LinearGradient(colors: [.clear, .black.opacity(0.72)],
                               startPoint: .center, endPoint: .bottom)

                HStack(spacing: 9) {
                    ZStack {
                        Circle().fill(Color.white)
                        Image(systemName: "play.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Palette.espresso)
                            .offset(x: 1)
                    }
                    .frame(width: 30, height: 30)

                    Text(record.canPlayInline ? "点击播放" : "点击查看帖子")
                        .font(TypeScale.callout.weight(.medium))
                        .foregroundStyle(.white)

                    Spacer(minLength: 0)
                }
                .padding(14)
            }
            .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(record.canPlayInline ? "播放" : "查看帖子")
    }

    /// 只在这条链接**还没有**一份完整元数据时出现。抓不到的时候它就是个出口，
    /// 抓到了就不必占一行位置。
    private var needsMetadataRefresh: Bool {
        guard record.carrier == .link else { return false }
        switch record.metadataStatus {
        case .failed, .idle, .pending: return true
        case .resolved, .partial: return false
        }
    }

    private var refreshRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                refreshMetadata()
            } label: {
                HStack(spacing: 6) {
                    if isRefreshing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    Text(isRefreshing ? "正在重新获取…" : "重新获取网页信息")
                        .font(TypeScale.caption)
                }
                .foregroundStyle(Palette.roast)
            }
            .buttonStyle(.plain)
            .disabled(isRefreshing)

            if let refreshFailure {
                Text(refreshFailure.sentence)
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func refreshMetadata() {
        guard let url = record.resolvedLink, !isRefreshing else { return }
        isRefreshing = true
        refreshFailure = nil
        Task {
            let resolution = await LinkResolver.resolve(url)
            isRefreshing = false
            guard !Task.isCancelled else { return }

            record.adopt(resolution.match)
            if resolution.metadata.status == .failed {
                refreshFailure = resolution.metadata.failure ?? .parseFailed
                record.metadataStatus = resolution.metadata.status
            } else {
                record.adopt(resolution.metadata)
                if record.title.trimmed.isEmpty, let fetched = resolution.metadata.title {
                    record.title = fetched
                }
            }
            record.touch()
            do {
                try context.save()
            } catch {
                AppLog.store.error("link refresh failed: \(error.localizedDescription, privacy: .public)")
                context.rollback()
            }
        }
    }

    @ViewBuilder
    private var videoPlayer: some View {
        if let path = record.mediaPath, MediaStore.shared.exists(path) {
            VideoPlayer(player: AVPlayer(url: MediaStore.shared.url(for: path)))
                .frame(height: 220)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
        } else {
            VStack(spacing: 8) {
                Image(systemName: "video.slash")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(Palette.inkFaint)
                Text("这段视频的文件不在本机。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 160)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.well)
            )
        }
    }

    private func detailLine(_ label: LocalizedStringKey, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .frame(width: 48, alignment: .leading)
            Text(verbatim: value)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
            Spacer(minLength: 0)
        }
    }

    private func delete() {
        let media = record.mediaPath
        let preview = record.previewPath
        let carrier = record.carrier
        context.delete(record)
        do {
            try context.save()
        } catch {
            AppLog.store.error("record delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return
        }
        if carrier == .video {
            MediaStore.shared.delete(media)
        } else {
            ImageStore.shared.delete(media)
        }
        ImageStore.shared.delete(preview)
        dismiss()
    }
}
