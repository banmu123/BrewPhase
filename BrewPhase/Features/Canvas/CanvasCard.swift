import SwiftUI

/// 画布封面：由名字生成，不下载、不占空间。
///
/// 还没有内容可预览的时候，一块空白色块比一张假图片诚实得多。取名字的第一个
/// 字做字标，配一组低饱和的品牌色——它只负责让每块画布在列表里认得出彼此。
struct CanvasCover: View {

    let name: String
    var height: CGFloat = 104

    /// 由名字决定的稳定色组。不用 `hashValue`：它每次启动都会变，封面会闪。
    private var palette: (top: Color, bottom: Color) {
        let seed = name.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        switch seed % 4 {
        case 0: return (Palette.roast.opacity(0.28), Palette.latte.opacity(0.22))
        case 1: return (Palette.moss.opacity(0.26), Palette.cream.opacity(0.55))
        case 2: return (Palette.latte.opacity(0.45), Palette.cream.opacity(0.35))
        default: return (Palette.espresso.opacity(0.16), Palette.latte.opacity(0.30))
        }
    }

    /// 取名字的头两个字。只取一个字时，两块钱「我的…」「我想…」的画布会长得
    /// 一模一样；两个字足够区分，又不会变成一条标题。还没起名字时给一个图标，
    /// 而不是一个孤零零的标点。
    private var monogram: String {
        let trimmed = name.trimmed
        guard !trimmed.isEmpty else { return "" }
        return String(trimmed.prefix(2))
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [palette.top, palette.bottom],
                           startPoint: .topLeading, endPoint: .bottomTrailing)

            if monogram.isEmpty {
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: height * 0.20, weight: .light))
                    .foregroundStyle(Palette.espresso.opacity(0.28))
            } else {
                Text(verbatim: monogram)
                    .font(.system(size: height * 0.26, weight: .light, design: .serif))
                    .foregroundStyle(Palette.espresso.opacity(0.45))
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
    }
}

/// 画布在列表里的样子：封面 + 名字 + 一句说明。
struct CanvasCard: View {

    let canvas: Canvas

    var body: some View {
        Card(padding: 10) {
            VStack(alignment: .leading, spacing: 0) {
                CanvasCover(name: canvas.name, height: 96)

                VStack(alignment: .leading, spacing: 4) {
                    Text(LocalizedStringKey.alreadyLocalized(canvas.displayName))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    if !canvas.note.trimmed.isEmpty {
                        Text(canvas.note)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }

                    Text(verbatim: Fmt.short(canvas.createdAt))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .padding(.top, 10)
                .padding(.bottom, 2)
            }
        }
    }
}
