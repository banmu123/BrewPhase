import SwiftUI

/// 把 `AnswerMarkup` 排成有层次的正文。
///
/// 界面这一层只做三件事：**分组**（小节标题）、**留白**（块与块之间的间距按类型
/// 不同）、**分级**（重点加深、脚注变浅）。不加分割线、不加图标、不做折叠——
/// 一张回答卡里已经有一个引用列表了，再叠一种容器只会更乱。
struct AnswerBody: View {

    let text: String

    private var blocks: [AnswerMarkup.Block] { AnswerMarkup.parse(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                view(for: block)
                    .padding(.top, gap(before: index))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 间距跟着语义走：小节标题上面留得最多（它开一个新话题），同一个列表里的
    /// 条目之间留得最少（它们是同一个话题的并列项）。
    private func gap(before index: Int) -> CGFloat {
        guard index > 0, blocks.indices.contains(index - 1) else { return 0 }
        let current = blocks[index].kind
        let previous = blocks[index - 1].kind
        if current == .heading { return 18 }
        if previous == .heading { return 8 }
        if current == .note { return 14 }
        if current == .callout || previous == .callout { return 11 }
        if current == .bullet, previous == .bullet { return 7 }
        return 10
    }

    @ViewBuilder
    private func view(for block: AnswerMarkup.Block) -> some View {
        switch block.kind {
        case .heading:
            inline(block.runs, font: TypeScale.section, colour: Palette.inkSoft)
                .tracking(1.1)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("•")
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.latte)
                    .frame(width: 12, alignment: .leading)
                inline(block.runs, font: TypeScale.body, colour: Palette.ink)
            }
        case .callout:
            callout(block.runs)
        case .note:
            inline(block.runs, font: TypeScale.caption, colour: Palette.inkFaint)
        case .paragraph:
            inline(block.runs, font: TypeScale.body, colour: Palette.ink)
        }
    }

    /// 重点块：浅底 + 左侧一道色条。
    ///
    /// 色条是必要的——只靠底色，在「连续两个重点」或者重点紧跟在标题下面时，
    /// 边界会糊掉；一道 2.5pt 的实线让它在任何位置都一眼可辨。
    private func callout(_ runs: [AnswerMarkup.Run]) -> some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(Palette.roast)
                .frame(width: 2.5)
            inline(runs, font: TypeScale.bodyMedium, colour: Palette.ink)
                .padding(.leading, 11)
                .padding(.trailing, 13)
                .padding(.vertical, 10)
        }
        .background(Palette.cream.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous))
    }

    /// 行内片段拼成一整段 `Text`。
    ///
    /// 每个片段自己带字号与颜色，而不是最后统一套一层——`Text` 的拼接里，
    /// 后加的 `font` / `foregroundColor` 会盖掉先前每一段的设置，角标的浅褐色
    /// 和上标位置会在最后一刻被冲掉。
    private func inline(_ runs: [AnswerMarkup.Run], font: Font, colour: Color) -> some View {
        runs
            .reduce(Text(verbatim: "")) { partial, run in
                switch run {
                case .text(let value):
                    return partial + Text(verbatim: value).font(font).foregroundColor(colour)
                case .strong(let value):
                    return partial + Text(verbatim: value).font(font).fontWeight(.semibold).foregroundColor(colour)
                case .citation(let value):
                    // 角标前面留一个空格：解析时把行尾的空格吃掉了，这里补回来，
                    // 否则角标会贴着句号。
                    return partial + Text(verbatim: " [\(value)]")
                        .font(TypeScale.micro.monospacedDigit())
                        .foregroundColor(Palette.latte)
                        .baselineOffset(2)
                }
            }
            .lineSpacing(3)
    }
}
