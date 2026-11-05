import AVFoundation
import PhotosUI
import SwiftData
import SwiftUI

/// 新增 / 编辑一条记录。
///
/// 页面按「内容 → 标题与备注 → 标签」排：先放进来的是什么，再写自己的话，最后
/// 贴上意义。标签是最后一步，也完全可以跳过——保存按钮从不因为「没选分类」而
/// 变灰。
struct RecordEditorView: View {

    let carrier: RecordCarrier
    private let existing: Record?
    /// 在「添加」面板里由面板接管关闭；单独弹出时自己关。
    private let onSaved: (() -> Void)?

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \RecordTag.createdAt) private var allTags: [RecordTag]
    /// 只为了「这条链接已经收藏过了」这一句。记录页的查询不会因此变慢。
    @Query private var allRecords: [Record]

    // 内容
    @State private var urlString: String
    @State private var sourceName: String
    @State private var previewPath: String?
    @State private var mediaPath: String?
    @State private var pickedImage: UIImage?
    @State private var pickedVideo: URL?
    @State private var pickedPoster: UIImage?
    @State private var isRemovingMedia = false
    @State private var pickerItem: PhotosPickerItem?

    // 用户的话
    @State private var title: String
    @State private var note: String
    @State private var selectedTags: [RecordTag]

    // 链接
    /// 本地识别结果（不联网，粘贴即得）。
    @State private var match: LinkMatch?
    /// 联网解析结果。失败也是 nil，但 `fetchFailure` 会说为什么。
    @State private var metadata: LinkMetadata?
    /// 平台摘要与作者：保存在记录上，卡片用它，不和用户的备注混在一起。
    @State private var summary: String
    @State private var authorName: String
    @State private var thumbnailURLString: String

    // 过程状态
    @State private var isFetchingLink = false
    @State private var fetchFailure: LinkFailure?
    @State private var lastFetchedURL = ""
    /// 标题如果是我们自动填的，换地址时可以覆盖；用户改过就不再动。
    @State private var fetchedTitle = ""
    /// 我们自己下载的封面。换地址时按它清理，用户挑的图绝不动。
    @State private var autoPreviewPath: String?
    @State private var isLoadingMedia = false
    @State private var errorMessage: String?
    @State private var didSave = false
    @State private var showsTagManager = false

    init(carrier: RecordCarrier,
         existing: Record? = nil,
         initialURL: String = "",
         onSaved: (() -> Void)? = nil) {
        self.carrier = carrier
        self.existing = existing
        self.onSaved = onSaved
        _urlString = State(initialValue: existing?.urlString ?? initialURL)
        _sourceName = State(initialValue: existing?.sourceName ?? "")
        _previewPath = State(initialValue: existing?.previewPath)
        _mediaPath = State(initialValue: existing?.mediaPath)
        _title = State(initialValue: existing?.title ?? "")
        _note = State(initialValue: existing?.note ?? "")
        _selectedTags = State(initialValue: existing?.orderedTags ?? [])
        _summary = State(initialValue: existing?.summary ?? "")
        _authorName = State(initialValue: existing?.authorName ?? "")
        _thumbnailURLString = State(initialValue: existing?.thumbnailURLString ?? "")
        // 打开已有记录时不重新抓一遍：把「上次抓过的地址」预先填上，防抖那段
        // 就会自己跳过。想刷新可以点预览卡下面的「重新获取」。
        _lastFetchedURL = State(initialValue: existing?.urlString ?? "")
        _match = State(initialValue: existing.flatMap { record -> LinkMatch? in
            guard record.carrier == .link, let url = record.resolvedLink else { return nil }
            return LinkResolver.match(url)
        })
    }

    private var isEditing: Bool { existing != nil }

    /// 已经收藏过的同一条链接（按规范地址比较）。只提示，不阻止保存——
    /// 用户可能就是想在另一条记录里写一段完全不同的感受。
    private var duplicateRecord: Record? {
        guard carrier == .link, let match else { return nil }
        let key = match.canonicalURL.absoluteString
        return allRecords.first {
            $0.id != existing?.id && $0.carrier == .link && $0.canonicalKey == key
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    carrierHeader
                    contentSection.padding(.top, 18)
                    writingSection.padding(.top, 22)
                    tagSection.padding(.top, 22)

                    if let errorMessage {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "info.circle").font(.system(size: 13))
                            Text(errorMessage)
                                .font(TypeScale.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(Palette.priority)
                        .padding(.top, 14)
                    }

                    PrimaryButton(title: isEditing ? "保存" : "保存记录", isEnabled: !didSave) {
                        save()
                    }
                    .padding(.top, 22)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            .navigationTitle(carrier.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
            }
            .sheet(isPresented: $showsTagManager) {
                TagManagerView()
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                loadMedia(item)
            }
            // 输入链接时的防抖：停手约一秒再抓，`task(id:)` 会自动取消上一次。
            .task(id: urlString) {
                await fetchLinkPreviewIfNeeded()
            }
            .onDisappear {
                // 选完视频又取消，临时文件要自己收拾。
                if !didSave, let pickedVideo { try? FileManager.default.removeItem(at: pickedVideo) }
            }
        }
    }

    // MARK: - 顶部

    private var carrierHeader: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                    .fill(RecordPresentation.tint(carrier).opacity(0.10))
                Image(systemName: carrier.symbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(RecordPresentation.tint(carrier))
            }
            .frame(width: 44, height: 44)

            Text(carrier.subtitle)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
    }

    // MARK: - 内容

    @ViewBuilder
    private var contentSection: some View {
        switch carrier {
        case .link: linkSection
        case .image: imageSection
        case .video: videoSection
        case .text: EmptyView()
        }
    }

    private var linkSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            EditorSection(title: "链接") {
                EditorRow(title: "网址", showsDivider: false) {
                    HStack(spacing: 8) {
                        TextField("https://", text: $urlString)
                            .font(TypeScale.body)
                            .foregroundStyle(Palette.ink)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit { Task { await fetchLinkPreview(force: true) } }

                        if isFetchingLink {
                            ProgressView().controlSize(.small)
                        } else if match != nil {
                            Button {
                                Task { await fetchLinkPreview(force: true) }
                            } label: {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Palette.inkFaint)
                                    .frame(width: 26, height: 26)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("重新获取网页信息")
                        }
                    }
                }
            }

            if let match {
                platformLine(match).padding(.top, 10)
            }

            linkPreview.padding(.top, 10)

            if let duplicate = duplicateRecord {
                duplicateLine(duplicate).padding(.top, 8)
            }

            linkStatus.padding(.top, 8)

            Text("粘贴后会访问这个网址，只为了读取标题、摘要和封面。你的备注和标签不会离开这台设备。")
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
        }
    }

    /// 本地识别只要几毫秒，所以粘贴的同时就能说出「YouTube 视频」。
    private func platformLine(_ match: LinkMatch) -> some View {
        let name = match.provider.displayName
        return HStack(spacing: 6) {
            Image(systemName: match.provider.symbol)
                .font(.system(size: 10, weight: .semibold))
            Text(verbatim: name.isEmpty ? match.contentKind.label : name)
                .font(TypeScale.caption)
            if !name.isEmpty {
                Text(verbatim: "·")
                    .font(TypeScale.caption)
                Text(verbatim: match.contentKind.label)
                    .font(TypeScale.caption)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.inkSoft)
    }

    /// 解析结果的样子：有封面就露封面，没有就露平台图标。
    @ViewBuilder
    private var linkPreview: some View {
        if let metadata, metadata.hasAnything {
            HStack(alignment: .top, spacing: 12) {
                Group {
                    if let image = ImageStore.shared.image(named: previewPath, thumbnail: true) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        ZStack {
                            Palette.well
                            Image(systemName: match?.provider.symbol ?? "link")
                                .font(.system(size: 18, weight: .light))
                                .foregroundStyle(Palette.inkFaint)
                        }
                    }
                }
                .frame(width: 88, height: 66)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(.alreadyLocalized(previewTitle))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    if let credit = creditLine {
                        Text(verbatim: credit)
                            .font(TypeScale.micro)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                    }

                    if let summary = metadata.summary, !summary.trimmed.isEmpty {
                        Text(verbatim: summary)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkSoft)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 0.8)
            )
        }
    }

    /// 预览卡上的标题：用户填的 → 平台标题 → 正文第一行 → 「未命名链接」。
    private var previewTitle: String {
        if !title.trimmed.isEmpty { return title }
        if let fetched = metadata?.title?.trimmed.nonEmpty { return fetched }
        if let summary = metadata?.summary?.trimmed.split(separator: "\n").first.map(String.init),
           !summary.isEmpty {
            return summary
        }
        return L("未命名链接")
    }

    /// `YouTube · James Hoffmann` / `GitHub · banmu123`
    private var creditLine: String? {
        var parts: [String] = []
        if let match, !match.provider.displayName.isEmpty, match.provider != .x {
            parts.append(match.provider.displayName)
        }
        if let author = authorName.trimmed.nonEmpty { parts.append(author) }
        if parts.isEmpty, let metadata, let site = metadata.siteName?.trimmed.nonEmpty {
            parts.append(site)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func duplicateLine(_ record: Record) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 10, weight: .semibold))
            Text(verbatim: L("这条链接已经收藏过了：%@", record.displayTitle))
                .font(TypeScale.micro)
                .lineLimit(1)
        }
        .foregroundStyle(Palette.roast)
    }

    /// 抓取结果说清楚：抓到了什么、没抓到也可以自己填。这一行不阻塞保存。
    @ViewBuilder
    private var linkStatus: some View {
        if isFetchingLink {
            Text("正在获取网页信息…")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        } else if let fetchFailure {
            Text(fetchFailure.sentence)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        } else if metadata?.status == .partial,
                  let provider = match?.provider,
                  provider == .youtube || provider == .bilibili || provider == .generic {
            Text("只读到了一部分信息，标题和封面可以自己填。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var imageSection: some View {
        EditorSection(title: "图片", detail: "从相册选择") {
            mediaPickerRow(
                symbol: "photo",
                emptyTitle: "选择一张图片",
                replaceTitle: "换一张图片",
                hasMedia: mediaPath != nil || pickedImage != nil,
                preview: pickedImage ?? ImageStore.shared.image(named: mediaPath, thumbnail: true)
            )
        }
    }

    private var videoSection: some View {
        EditorSection(title: "视频", detail: "从相册选择") {
            mediaPickerRow(
                symbol: "play.rectangle",
                emptyTitle: "选择一段视频",
                replaceTitle: "换一段视频",
                hasMedia: mediaPath != nil || pickedVideo != nil,
                preview: pickedPoster ?? ImageStore.shared.image(named: previewPath, thumbnail: true)
            )
        }
    }

    private func mediaPickerRow(symbol: String,
                                emptyTitle: LocalizedStringKey,
                                replaceTitle: LocalizedStringKey,
                                hasMedia: Bool,
                                preview: UIImage?) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Group {
                if let preview {
                    Image(uiImage: preview)
                        .resizable()
                        .scaledToFill()
                } else {
                    ZStack {
                        Palette.well
                        Image(systemName: symbol)
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(Palette.inkFaint)
                    }
                }
            }
            .frame(width: 74, height: 74)
            .clipShape(RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous))

            VStack(alignment: .leading, spacing: 10) {
                PhotosPicker(selection: $pickerItem,
                             matching: carrier == .video ? .videos : .images,
                             photoLibrary: .shared()) {
                    HStack(spacing: 6) {
                        Image(systemName: symbol)
                            .font(.system(size: 12.5, weight: .semibold))
                        Text(hasMedia ? replaceTitle : emptyTitle)
                            .font(TypeScale.callout.weight(.medium))
                    }
                    .foregroundStyle(Palette.roast)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Capsule(style: .continuous).fill(Palette.well))
                }
                .buttonStyle(.plain)
                .disabled(isLoadingMedia)

                if hasMedia {
                    Button {
                        clearMedia()
                    } label: {
                        Text("移除")
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                    }
                    .buttonStyle(.plain)
                } else if isLoadingMedia {
                    ProgressView().controlSize(.small)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(16)
    }

    // MARK: - 标题与备注

    private var writingSection: some View {
        EditorSection(title: "你的话") {
            EditorRow(title: "标题") {
                EditorTextField(placeholder: titlePlaceholder, text: $title)
            }
            EditorRow(title: carrier == .text ? "正文" : "备注", alignsTop: true, showsDivider: false) {
                EditorTextField(placeholder: notePlaceholder, text: $note)
                    .frame(minHeight: carrier == .text ? 140 : 78, alignment: .topLeading)
            }
        }
    }

    private var titlePlaceholder: LocalizedStringKey {
        switch carrier {
        case .link: return LocalizedStringKey("网页标题，留空就用抓到的")
        case .image: return LocalizedStringKey("给这张图起个名字")
        case .video: return LocalizedStringKey("给这段视频起个名字")
        case .text: return LocalizedStringKey("可以留空")
        }
    }

    private var notePlaceholder: LocalizedStringKey {
        switch carrier {
        case .link: return LocalizedStringKey("为什么留下它")
        case .image: return LocalizedStringKey("拍下它的原因、当时的想法")
        case .video: return LocalizedStringKey("看完想到了什么")
        case .text: return LocalizedStringKey("想说的话")
        }
    }

    // MARK: - 标签

    private var tagSection: some View {
        TagPickerSection(allTags: allTags, selected: $selectedTags) {
            showsTagManager = true
        }
    }

    // MARK: - 链接

    private func fetchLinkPreviewIfNeeded() async {
        guard carrier == .link else { return }
        let trimmed = urlString.trimmed
        guard let url = Record(carrier: .link, urlString: trimmed).resolvedLink else {
            match = nil
            return
        }

        // 本地识别不等网络：粘贴的同时就能显示平台与内容类型。
        let quick = LinkResolver.match(url)
        if match != quick { match = quick }

        guard trimmed != lastFetchedURL else { return }
        // 打字过程中不要每敲一个字母就发一次请求。
        try? await Task.sleep(for: .milliseconds(700))
        guard !Task.isCancelled else { return }
        await fetchLinkPreview(force: false)
    }

    private func fetchLinkPreview(force: Bool) async {
        guard carrier == .link else { return }
        let trimmed = urlString.trimmed
        guard let url = Record(carrier: .link, urlString: trimmed).resolvedLink else { return }
        if !force, trimmed == lastFetchedURL { return }

        // 换了一个地址：上一张**自动下载**的封面就过期了。用户自己挑的图不动。
        if lastFetchedURL != trimmed, let old = autoPreviewPath {
            if previewPath == old { previewPath = nil }
            ImageStore.shared.delete(old)
            autoPreviewPath = nil
        }
        AppLog.link.info("resolving: \(trimmed, privacy: .public)")
        lastFetchedURL = trimmed
        isFetchingLink = true
        fetchFailure = nil
        defer { isFetchingLink = false }

        let resolution = await LinkResolver.resolve(url)
        AppLog.link.info(
            "resolved \(resolution.match.provider.rawValue, privacy: .public) status=\(resolution.metadata.status.rawValue, privacy: .public)"
        )
        guard !Task.isCancelled else { return }
        match = resolution.match
        metadata = resolution.metadata
        fetchFailure = resolution.metadata.failure
        apply(resolution)
    }

    private func apply(_ resolution: LinkResolution) {
        let metadata = resolution.metadata

        if let fetched = metadata.title?.trimmed.nonEmpty {
            // 只覆盖「空标题」或「上一次自动填的标题」；用户改过的字一个都不动。
            if title.trimmed.isEmpty || title == fetchedTitle {
                title = fetched
                fetchedTitle = fetched
            }
        }
        if let summaryText = metadata.summary?.trimmed.nonEmpty { summary = summaryText }
        if let author = metadata.authorName?.trimmed.nonEmpty { authorName = author }
        if let site = metadata.siteName?.trimmed.nonEmpty {
            sourceName = site
        } else if sourceName.trimmed.isEmpty, let host = LinkURL.host(of: resolution.match.canonicalURL) {
            sourceName = host
        }
        if let thumbnail = metadata.thumbnailURL { thumbnailURLString = thumbnail.absoluteString }

        guard previewPath == nil, let thumbnail = metadata.thumbnailURL else { return }
        let expected = lastFetchedURL
        let referer = resolution.match.provider == .bilibili ? "https://www.bilibili.com/" : nil
        Task {
            guard let image = await LinkPreviewService.downloadImage(thumbnail, referer: referer),
                  let saved = try? ImageStore.shared.save(image, maxDimension: 1200) else { return }
            guard !Task.isCancelled else { return }
            // 下载期间地址可能又变了：这张图属于旧链接，直接丢掉。
            guard lastFetchedURL == expected else {
                ImageStore.shared.delete(saved)
                return
            }
            previewPath = saved
            autoPreviewPath = saved
        }
    }

    // MARK: - 选择媒体

    private func loadMedia(_ item: PhotosPickerItem) {
        isLoadingMedia = true
        Task {
            defer { isLoadingMedia = false }
            switch carrier {
            case .image:
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    pickedImage = image
                    isRemovingMedia = false
                }
            case .video:
                if let movie = try? await item.loadTransferable(type: PickedVideo.self) {
                    if let previous = pickedVideo {
                        try? FileManager.default.removeItem(at: previous)
                    }
                    pickedVideo = movie.url
                    pickedPoster = await MediaStore.poster(forVideoAt: movie.url)
                    isRemovingMedia = false
                }
            default:
                break
            }
        }
    }

    private func clearMedia() {
        pickedImage = nil
        if let pickedVideo { try? FileManager.default.removeItem(at: pickedVideo) }
        pickedVideo = nil
        pickedPoster = nil
        mediaPath = nil
        previewPath = nil
        isRemovingMedia = true
    }

    // MARK: - 保存

    private func save() {
        guard !didSave else { return }
        errorMessage = nil

        var resolvedURL = ""
        var resolvedLinkURL: URL?
        if carrier == .link {
            guard let url = Record(carrier: .link, urlString: urlString).resolvedLink else {
                errorMessage = L("这个链接看起来不完整，检查一下")
                return
            }
            resolvedURL = url.absoluteString
            resolvedLinkURL = url
        }

        let hasMedia = pickedImage != nil || pickedVideo != nil || (mediaPath != nil && !isRemovingMedia)
        if carrier == .image || carrier == .video, !hasMedia {
            errorMessage = carrier == .image ? L("先选一张图片") : L("先选一段视频")
            return
        }
        if carrier == .text, title.trimmed.isEmpty, note.trimmed.isEmpty {
            errorMessage = L("写一句再保存吧")
            return
        }

        let previousMedia = existing?.mediaPath
        let previousPreview = existing?.previewPath
        var newMedia = isRemovingMedia ? nil : previousMedia
        var newPreview = isRemovingMedia ? nil : previousPreview

        // 1/3 —— 先落文件。
        if let pickedImage, carrier == .image {
            guard let saved = try? ImageStore.shared.save(pickedImage) else {
                errorMessage = L("这张图片没能保存下来，可以换一张试试")
                return
            }
            newMedia = saved
            newPreview = saved
        }
        if let pickedVideo, carrier == .video {
            do {
                newMedia = try MediaStore.shared.save(videoAt: pickedVideo)
            } catch {
                AppLog.images.error("video save failed: \(error.localizedDescription, privacy: .public)")
                errorMessage = L("这段视频没能保存下来，可以换一段试试")
                return
            }
            if let pickedPoster, let saved = try? ImageStore.shared.save(pickedPoster) {
                newPreview = saved
            }
        }

        // 2/3 —— 写库。
        let target: Record
        if let existing {
            target = existing
        } else {
            target = Record(carrier: carrier)
            context.insert(target)
        }
        target.carrier = carrier
        target.title = title.trimmed
        target.note = note.trimmed
        target.urlString = resolvedURL
        target.sourceName = carrier == .link ? sourceName.trimmed : ""
        target.mediaPath = newMedia
        target.previewPath = newPreview
        target.tags = selectedTags
        if carrier == .link, let resolvedLinkURL {
            // 平台身份与内容 ID 由识别器给出，不采信用户输入里的任何 embed 地址。
            target.adopt(match ?? LinkResolver.match(resolvedLinkURL))
            if let metadata {
                target.adopt(metadata)
            } else {
                // 解析还没回来就保存了：如实记「待解析」，详情页可以补一次。
                target.metadataStatus = isFetchingLink ? .pending : .idle
            }
        }
        target.touch()

        do {
            try context.save()
        } catch {
            AppLog.store.error("record save failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            // 落库失败：刚写的文件不能留下，旧文件必须还在。
            if newMedia != previousMedia { ImageStore.shared.delete(newMedia) }
            if newPreview != previousPreview { ImageStore.shared.delete(newPreview) }
            errorMessage = L("没能保存下来，请再试一次")
            return
        }

        // 3/3 —— 落库成功后才清旧文件。
        if let previousMedia, previousMedia != newMedia {
            if existing?.carrier == .video {
                MediaStore.shared.delete(previousMedia)
            } else {
                ImageStore.shared.delete(previousMedia)
            }
        }
        if let previousPreview, previousPreview != newPreview {
            ImageStore.shared.delete(previousPreview)
        }
        if let pickedVideo { try? FileManager.default.removeItem(at: pickedVideo) }

        didSave = true
        if let onSaved { onSaved() } else { dismiss() }
    }
}

// MARK: - 相册里的视频

/// `PhotosPicker` 拿到的视频只有临时访问权，必须复制成自己的文件再用。
struct PickedVideo: Transferable {

    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString).\(ext)")
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return PickedVideo(url: destination)
        }
    }
}
