import Foundation

/// 窄列 Masonry 卡片的展示高度估算。
///
/// Planner 在分派列归属时需要一个高度数字，而此刻卡片还没渲染——估算就是
/// 给它一个「量级正确」的答案：图片按真实宽高比（`ImageStore.imageDimensions`，
/// 读不到就用 4:3 占位），文本按字符数折行。实测高度回传后由
/// `planner.updateHeight` 接管，估算永远只在「还没量过」时说话。
///
/// 系数都是**刻意的近似**：中英文混排按 0.72 字宽折算，行高按字号 × 1.4。
/// 估算偏差只会让某一张卡去另一列，不会破坏任何不变式——这也是它敢简单的
/// 原因。行数上限与 `MasonryRecordCard` 的排版约定保持一致，两边改一个
/// 都要看另一眼。
enum RecordCardHeightEstimator {

    // MARK: - 排版常数（与 MasonryRecordCard 对齐）

    private static let titleLineHeight: CGFloat = 21      // bodyMedium 15 × 1.4
    private static let bodyLineHeight: CGFloat = 21       // body 15 × 1.4
    private static let captionLineHeight: CGFloat = 17    // caption 12 × 1.4
    private static let microLineHeight: CGFloat = 15      // micro 11 × 1.35
    private static let repoNameLineHeight: CGFloat = 26   // cardTitle 21 × 1.25
    private static let metaBlockHeight: CGFloat = 17      // 标签 + 日期那一行
    private static let textCardPadding: CGFloat = 28      // 文字卡轻底的内边距（上下）
    /// 图片展示高度的两端。极端长图按封顶处理，免得一张竖图占满一屏。
    private static let minImageHeight: CGFloat = 72
    private static let maxImageHeight: CGFloat = 520
    /// 拿不到尺寸时的中性占位：4:3，横图习惯。
    static let placeholderAspectRatio: CGFloat = 4 / 3

    // MARK: - 入口

    static func estimate(for record: Record,
                         columnWidth: CGFloat,
                         image: ImageDimensions?) -> CGFloat {
        let content: CGFloat
        switch record.carrier {
        case .image:
            content = imageHeight(for: image, columnWidth: columnWidth)
                + belowImageTextHeight(record, columnWidth: columnWidth)
        case .video:
            // 列表只展示封面（poster 的比例），播放发生在详情页。
            content = posterHeight(for: image, columnWidth: columnWidth,
                                   fallbackRatio: 9 / 16)
                + belowImageTextHeight(record, columnWidth: columnWidth, showsSource: true)
        case .link:
            content = linkHeight(record, columnWidth: columnWidth, image: image)
        case .text:
            content = textCardHeight(record, columnWidth: columnWidth)
        }
        return max(64, content) // 再短的卡片也要有点存在感
    }

    // MARK: - 分载体

    /// 图片卡：图占主体，标题与备注在下方。
    ///
    /// 标题只在用户真填过时计——`displayTitle` 会回退到备注首行，不区分的话
    /// 同一句话会在卡片上出现两遍（`MasonryImageCard` 同此约定）。
    private static func belowImageTextHeight(_ record: Record, columnWidth: CGFloat,
                                             showsSource: Bool = false) -> CGFloat {
        var height: CGFloat = 8 // 图与文字之间的呼吸
        if !record.title.trimmed.isEmpty {
            height += widthHeight(record.title, lineHeight: titleLineHeight,
                                  width: columnWidth, maxLines: 2) + 4
        }
        if showsSource, record.sourceLine != nil {
            height += microLineHeight + 2
        }
        if !record.note.trimmed.isEmpty {
            height += widthHeight(record.note, lineHeight: captionLineHeight,
                                  width: columnWidth, maxLines: 3) + 2
        }
        return height + metaBlockHeight
    }

    /// 链接卡：各平台不同，但都适配窄列的纵向排版。
    private static func linkHeight(_ record: Record, columnWidth: CGFloat,
                                   image: ImageDimensions?) -> CGFloat {
        var height: CGFloat = 0
        switch record.provider {
        case .youtube, .bilibili:
            height += posterHeight(for: image, columnWidth: columnWidth,
                                   fallbackRatio: 16 / 9)
            height += widthHeight(record.displayTitle, lineHeight: titleLineHeight,
                                  width: columnWidth, maxLines: 2) + 6
            if record.handle != nil || record.linkHost != nil { height += microLineHeight + 2 }
        case .x:
            height += microLineHeight + 4 // handle 行
            height += widthHeight(record.linkSummary ?? record.displayTitle,
                                  lineHeight: bodyLineHeight,
                                  width: columnWidth, maxLines: 6) + 4
            if image != nil {
                height += posterHeight(for: image, columnWidth: columnWidth,
                                       fallbackRatio: 16 / 9) + 6
            }
        case .github:
            if record.repositoryOwner != nil { height += captionLineHeight }
            height += widthHeight(record.repositoryName ?? record.displayTitle,
                                  lineHeight: repoNameLineHeight,
                                  width: columnWidth, maxLines: 2) + 4
            if let summary = record.linkSummary {
                height += widthHeight(summary, lineHeight: captionLineHeight,
                                      width: columnWidth, maxLines: 3) + 4
            }
            if !record.repositoryStatItems.isEmpty { height += microLineHeight + 4 }
        case .generic:
            if image != nil {
                height += posterHeight(for: image, columnWidth: columnWidth,
                                       fallbackRatio: 16 / 9) + 8
            }
            height += widthHeight(record.displayTitle, lineHeight: titleLineHeight,
                                  width: columnWidth, maxLines: 2) + 4
            if record.linkCreditLine != nil { height += microLineHeight + 2 }
            if let summary = record.linkSummary, !record.title.trimmed.isEmpty {
                height += widthHeight(summary, lineHeight: captionLineHeight,
                                      width: columnWidth, maxLines: 2) + 2
            }
        }
        if !record.note.trimmed.isEmpty {
            height += widthHeight(record.note, lineHeight: captionLineHeight,
                                  width: columnWidth, maxLines: 2) + 2
        }
        return height + metaBlockHeight + 4
    }

    /// 文字卡：轻底内是标题与正文，meta 行在底外。
    private static func textCardHeight(_ record: Record, columnWidth: CGFloat) -> CGFloat {
        var height = textCardPadding
        if !record.title.trimmed.isEmpty {
            height += widthHeight(record.title, lineHeight: repoNameLineHeight,
                                  width: columnWidth, maxLines: 2) + 6
        }
        height += widthHeight(record.note, lineHeight: bodyLineHeight,
                              width: columnWidth, maxLines: 8)
        return height + metaBlockHeight + 8
    }

    // MARK: - 图与文

    /// 图片的展示高度：列宽 ÷ 宽高比，钳在两端之间。
    private static func imageHeight(for image: ImageDimensions?, columnWidth: CGFloat) -> CGFloat {
        guard columnWidth > 0 else { return minImageHeight }
        let ratio = image?.aspectRatio ?? placeholderAspectRatio
        let height = columnWidth / ratio
        return min(max(height, minImageHeight), maxImageHeight)
    }

    /// 封面的展示高度：poster 拿不到尺寸时按平台习惯比例兜底。
    private static func posterHeight(for image: ImageDimensions?, columnWidth: CGFloat,
                                     fallbackRatio: CGFloat) -> CGFloat {
        guard columnWidth > 0 else { return minImageHeight }
        // fallbackRatio 是「高 ÷ 宽」的习惯说法（16:9），换算成宽高比再除。
        let ratio = image?.aspectRatio ?? (1 / fallbackRatio)
        let height = columnWidth / ratio
        return min(max(height, 80), maxImageHeight)
    }

    /// 按列宽折行的高度。中英文混排的近似：CJK 一个字宽 ≈ 字号，
    /// 拉丁字母 ≈ 0.55 字号，取 0.72 折中。
    private static func widthHeight(_ text: String, lineHeight: CGFloat,
                                    width: CGFloat, maxLines: Int) -> CGFloat {
        let trimmed = text.trimmed
        guard !trimmed.isEmpty, maxLines > 0, width > 0 else { return 0 }
        let fontSize = lineHeight / 1.4
        let charsPerLine = max(4, width / (fontSize * 0.72))
        var lines: CGFloat = 0
        for paragraph in trimmed.split(separator: "\n") {
            lines += CGFloat(max(1, Int(ceil(CGFloat(paragraph.count) / charsPerLine))))
        }
        return lineHeight * CGFloat(min(CGFloat(maxLines), max(1, lines)))
    }
}
