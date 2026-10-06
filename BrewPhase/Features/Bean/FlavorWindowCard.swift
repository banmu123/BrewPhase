import SwiftUI

/// 预计风味窗口卡：模型对这包豆子的**第二种看法**。
///
/// 三条自我约束，和协议 §6.4 / §7 对齐：
///
/// * 所有说法都带「预计」，从不出现「科学」「保证」「准确」这类词；
/// * 它不替代、也不改写阶段卡。阶段卡是 App 按窗口规则算出的结论，这里是模型
///   的估计值，两张卡并排出现、可能不一致，这是允许的——把其中一个藏起来才是
///   真的误导；
/// * 缺了哪些资料就说出来。模型没法自己表达不确定性，那就由这一层替它说。
///
/// 整个模型是**合成数据**训练的，所以卡片顶端常驻「实验预测」标签；整张卡的
/// 视觉权重刻意低于阶段卡——它提供另一种看法，不提供结论。
struct FlavorWindowCard: View {

    let bean: Bean
    let defaults: BrewDefaults
    /// 今天在烘焙后的第几天，用来在曲线上标当前位置。
    let todayDay: Int?

    /// 实验功能，可以在「更多」里关掉；关掉时这张卡整个消失。
    @AppStorage(PrefKey.experimentalFlavorPrediction)
    private var isEnabled: Bool = true

    @State private var curve: FlavorCurve?
    @State private var didEvaluate = false

    var body: some View {
        Group {
            if isEnabled {
                Card {
                    VStack(alignment: .leading, spacing: 14) {
                        header
                        if let curve {
                            figures(curve)
                            FlavorSparkline(curve: curve, todayDay: todayDay)
                            footnotes(curve)
                        } else if didEvaluate {
                            Text("这台设备上暂时算不出预计风味窗口")
                                .font(TypeScale.callout)
                                .foregroundStyle(Palette.inkSoft)
                        } else {
                            // 首次求值前的占位：高度一致，避免卡片跳一下。
                            Text(verbatim: " ")
                                .font(TypeScale.callout)
                                .frame(height: 54)
                        }
                    }
                }
            }
        }
        .task(id: taskID) { evaluate() }
    }

    // MARK: - Pieces

    /// 视觉刻意比阶段卡轻一档：这是合成数据上的实验估计，不该和确定性的
    /// 阶段判断抢权重。「实验预测」是常驻标签，不是可以忽略的脚注。
    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("实验预测")
                .font(TypeScale.micro)
                .tracking(0.8)
                .foregroundStyle(Palette.inkFaint)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("预计风味窗口")
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.inkSoft)
                Spacer(minLength: 0)
            }
        }
    }

    private func figures(_ curve: FlavorCurve) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Fmt.day(curve.peakDay))
                    .font(TypeScale.numeral)
                    .foregroundStyle(Palette.inkSoft)
                Text("预计最佳")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
            }

            Text(L("预计黄金风味期 %@ – %@", Fmt.day(curve.windowStart), Fmt.day(curve.windowEnd)))
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)

            if let todayDay {
                HStack(spacing: 6) {
                    Text(Fmt.day(todayDay))
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkFaint)
                    Text(verbatim: "·")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkFaint)
                    Text(statusText(curve.status(onDay: todayDay)))
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.tint(phaseForStatus(curve.status(onDay: todayDay))))
                }
            }
        }
    }

    private func footnotes(_ curve: FlavorCurve) -> some View {
        let diagnostics = curve.diagnostics
        return VStack(alignment: .leading, spacing: 5) {
            if !diagnostics.unavailableLabels.isEmpty {
                Text(L("这些资料 App 还没有，已用模型训练时的典型值补上：%@",
                       diagnostics.unavailableLabels.joined(separator: L("、"))))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !diagnostics.unmatchedLabels.isEmpty {
                Text(L("这些内容模型不认识，没有参与预测：%@",
                       diagnostics.unmatchedLabels.joined(separator: L("、"))))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(diagnostics.uninterpretable, id: \.self) { value in
                Text(L("「%@」对应不到模型认识的类别，这次没有参与预测。", value))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if diagnostics.openBasis == .firstBrew {
                Text("没有开封日期，开封时间按最早一次冲煮记录推算。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("模型用合成数据训练，结果只是估算，不能当成真实规律。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Status wording

    private func statusText(_ status: FlavorWindowStatus) -> String {
        switch status {
        case .resting: return L("预计还在养豆期")
        case .inWindow: return L("预计已进入窗口")
        case .past: return L("预计已过峰值")
        }
    }

    /// 借用阶段卡的配色，两张卡上的同一个词是同一种颜色。
    private func phaseForStatus(_ status: FlavorWindowStatus) -> BeanPhase {
        switch status {
        case .resting: return .resting
        case .inWindow: return .peak
        case .past: return .declining
        }
    }

    // MARK: - Evaluation

    /// 输入没变就不重算。`Body` 会反复求值，30 次预测不能跟着反复跑。
    private var taskID: String {
        [bean.id.uuidString, String(bean.updatedAt.timeIntervalSince1970),
         String(todayDay ?? -1), String(bean.brewsCount)].joined(separator: "|")
    }

    private func evaluate() {
        let input = FlavorInputFactory.input(for: bean, defaults: defaults)
        curve = input.flatMap { FlavorWindowPredictor.shared.curve(for: $0) }
        didEvaluate = true
    }
}

/// 30 天预计曲线的折线。
///
/// 只画形状和位置，不标坐标轴：这张图的用处是「什么时候起来、什么时候落下去」，
/// 给它配一套刻度反而会让人以为那些数字是可以对照的测量值。
private struct FlavorSparkline: View {

    let curve: FlavorCurve
    let todayDay: Int?

    private static let height: CGFloat = 56

    var body: some View {
        GeometryReader { geometry in
            let layout = Layout(curve: curve, size: geometry.size)

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Palette.well)

                // 窗口那一段铺一层浅色，一眼能看出「好在哪几天」。
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Palette.peak.opacity(0.16))
                    .frame(width: max(6, layout.x(curve.windowEnd) - layout.x(curve.windowStart)),
                           height: geometry.size.height)
                    .offset(x: layout.x(curve.windowStart))

                layout.line
                    .stroke(Palette.roast,
                            style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))

                if let point = layout.todayPoint(todayDay) {
                    Circle()
                        .fill(Palette.espresso)
                        .frame(width: 6, height: 6)
                        .offset(x: point.x - 3, y: point.y - 3)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .frame(height: Self.height)
    }

    /// 把曲线换算成某个尺寸下的坐标。
    ///
    /// 单独一个结构体，不是因为逻辑复杂，而是因为算坐标要用 `func` 和 `return`，
    /// 而 `GeometryReader` 的闭包是 `ViewBuilder`——把带 `return` 的函数写进去，
    /// 编译器会把它当成视图表达式解析。
    private struct Layout {

        let size: CGSize
        private let curve: FlavorCurve
        private let low: Double
        private let span: Double
        private let step: CGFloat

        init(curve: FlavorCurve, size: CGSize) {
            self.curve = curve
            self.size = size
            let low = curve.scores.min() ?? 0
            let high = curve.scores.max() ?? 1
            self.low = low
            // 一条平线也得画得出来，所以给纵向留一个最小跨度。
            self.span = max(high - low, 0.15)
            self.step = curve.scores.count > 1
                ? size.width / CGFloat(curve.scores.count - 1)
                : size.width
        }

        func x(_ day: Int) -> CGFloat {
            let index = min(max(day - curve.firstDay, 0), curve.scores.count - 1)
            return CGFloat(index) * step
        }

        func y(_ score: Double) -> CGFloat {
            size.height - CGFloat((score - low) / span) * (size.height - 6) - 3
        }

        var line: Path {
            var path = Path()
            for (index, score) in curve.scores.enumerated() {
                let point = CGPoint(x: CGFloat(index) * step, y: y(score))
                if index == 0 {
                    path.move(to: point)
                } else {
                    path.addLine(to: point)
                }
            }
            return path
        }

        func todayPoint(_ day: Int?) -> CGPoint? {
            guard let day, curve.scores.indices.contains(day - curve.firstDay) else { return nil }
            return CGPoint(x: x(day), y: y(curve.scores[day - curve.firstDay]))
        }
    }
}
