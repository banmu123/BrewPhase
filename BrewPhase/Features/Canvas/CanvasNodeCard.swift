import AVKit
import SwiftUI

/// 画布上的一张节点卡：内容来自 Record，尺寸由节点决定。
///
/// 卡片只负责「长什么样」：点开原记录、播放/暂停由外层工作区决定，
/// 同一时刻只有一个节点在播（`isPlaying`）。图片一律读缩略图——画布上可能
/// 同时摆着几十张卡，原图不该为此常驻内存。
struct CanvasNodeCard: View {

    static let cornerRadius: CGFloat = 14

    let record: Record
    var annotation: String = ""
    var isPlaying: Bool
    var onTogglePlay: () -> Void
    var onOpenSource: () -> Void

    @State private var player: AVPlayer?
    @State private var externalState: ExternalPlayerState = .loading

    var body: some View {
        Group {
            switch record.carrier {
            case .image: imageCard
            case .video: videoCard
            case .link: linkCard
            case .text: textCard
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
        .contentShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .onChange(of: isPlaying) { _, playing in
            if !playing {
                player?.pause()
                player = nil
            }
        }
        .onDisappear {
            player?.pause()
            player = nil
        }
    }

    // MARK: - 图片

    private var imageCard: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if let image = ImageStore.shared.image(named: record.mediaPath, thumbnail: true) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    missingMedia(symbol: "photo")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()

            mediaCaption
        }
    }

    // MARK: - 视频

    @ViewBuilder
    private var videoCard: some View {
        ZStack(alignment: .bottomLeading) {
            if isPlaying {
                playerSurface
                    // 播放中给一个明确的暂停口，别让用户只能离开画布才能停。
                    .overlay(alignment: .topTrailing) {
                        pauseBadge.padding(8)
                    }
            } else {
                posterSurface(showsPlay: canPlay)
                mediaCaption
            }
        }
    }

    /// 本地视频优先；没有本地文件但有官方嵌入的链接（YouTube/Bilibili）走
    /// 现有的 `ExternalMediaPlayer`。两者都只在用户点过播放之后才创建。
    @ViewBuilder
    private var playerSurface: some View {
        if let path = record.mediaPath, MediaStore.shared.exists(path) {
            VideoPlayer(player: player)
                .onAppear {
                    if player == nil {
                        player = AVPlayer(url: MediaStore.shared.url(for: path))
                    }
                    player?.play()
                }
                .onTapGesture { onTogglePlay() }
        } else if let embed = record.linkEmbed {
            ZStack {
                Color.black
                ExternalMediaPlayer(
                    embed: embed,
                    state: $externalState,
                    isScrollEnabled: false,
                    prefersDarkChrome: true,
                    onExternalOpen: { _ in }
                )
                if externalState == .loading { ProgressView().tint(.white) }
            }
        } else {
            missingMedia(symbol: "video.slash")
        }
    }

    private var canPlay: Bool {
        if let path = record.mediaPath, MediaStore.shared.exists(path) { return true }
        return record.linkEmbed != nil && record.canPlayInline
    }

    // MARK: - 链接

    @ViewBuilder
    private var linkCard: some View {
        if isPlaying, canPlay {
            // 官方嵌入的播放器占满整张卡：240pt 宽的节点里再塞标题只会两边都小。
            playerSurface
                .overlay(alignment: .topTrailing) { pauseBadge.padding(8) }
        } else {
            linkBody
        }
    }

    private var linkBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .center) {
                if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    missingMedia(symbol: record.provider.symbol)
                }
                if canPlay {
                    playBadge
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 96)
            .clipped()

            VStack(alignment: .leading, spacing: 4) {
                Text(record.displayTitle.isEmpty
                     ? LocalizedStringKey("未命名链接")
                     : .alreadyLocalized(record.displayTitle))
                    .font(TypeScale.caption.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)

                HStack(spacing: 4) {
                    Text(verbatim: record.providerLabel ?? record.linkHost ?? "")
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if record.openLink != nil {
                        Button(action: onOpenSource) {
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(Palette.inkFaint)
                                .frame(width: 22, height: 22)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("打开原始来源")
                    }
                }

                if let summary = record.linkSummary,
                   !record.title.trimmed.isEmpty || record.provider == .x {
                    Text(verbatim: summary)
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(2)
                }

                if !annotation.isEmpty { annotationLine }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
        }
    }

    // MARK: - 文字

    private var textCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !record.title.trimmed.isEmpty {
                Text(record.title)
                    .font(TypeScale.caption.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
            }
            Text(record.note)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(2)
                .lineLimit(record.title.trimmed.isEmpty ? 7 : 5)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if !annotation.isEmpty { annotationLine }
        }
        .padding(11)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - 碎片

    private var mediaCaption: some View {
        VStack(alignment: .leading, spacing: 3) {
            if !record.displayTitle.isEmpty {
                Text(.alreadyLocalized(record.displayTitle))
                    .font(TypeScale.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
            }
            if !annotation.isEmpty {
                Text(verbatim: annotation)
                    .font(TypeScale.micro)
                    .italic()
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [.clear, .black.opacity(0.62)],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    private var annotationLine: some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "quote.opening")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(Palette.inkFaint)
            Text(verbatim: annotation)
                .font(TypeScale.micro)
                .italic()
                .foregroundStyle(Palette.inkSoft)
                .lineLimit(2)
        }
    }

    /// 播放是一个**独立按钮**：点它只播放，不会冒泡成「打开详情」。
    private var playBadge: some View {
        Button(action: onTogglePlay) {
            ZStack {
                Circle().fill(Palette.card.opacity(0.92))
                    .frame(width: 34, height: 34)
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.espresso)
                    .offset(x: isPlaying ? 0 : 1)
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isPlaying ? "暂停" : "播放")
    }

    /// 播放器自己的控件在上方；这个角标只负责“停”。
    private var pauseBadge: some View {
        Button(action: onTogglePlay) {
            ZStack {
                Circle().fill(Color.black.opacity(0.45))
                    .frame(width: 30, height: 30)
                Image(systemName: "pause.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("暂停")
    }

    private func posterSurface(showsPlay: Bool) -> some View {
        ZStack {
            if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: true) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                missingMedia(symbol: "play.rectangle")
            }
            if showsPlay { playBadge }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }

    private func missingMedia(symbol: String) -> some View {
        ZStack {
            Palette.well
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .ultraLight))
                .foregroundStyle(Palette.inkFaint)
        }
    }
}
