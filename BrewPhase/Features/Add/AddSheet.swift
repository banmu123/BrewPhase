import SwiftUI

/// 新增：一个入口，两条路。
///
/// 「咖啡」「记录」「画布」三个页面上的 + 打开的都是这一个面板——不是三套
/// 各自实现的添加流程。第一步选做什么（记录还是画布），第二步才是具体表单，
/// 所以从任一页面出发，能做的事完全一样。
///
/// 面板用 `.sheet` 而不是自定义浮层：下拉关闭、返回手势、键盘避让都由系统
/// 负责，这三件事自己写一遍只会写得更差。
struct AddSheet: View {

    /// 直接落到某一步（仅调试启动用于截图，正常入口从第一步开始）。
    init(initialRoute: AddRoute? = nil) {
        let initial = initialRoute.map { [$0] } ?? []
        _path = State(initialValue: initial)
        // 从第二步开始时，面板必须一开始就是整屏：`onChange` 只在路径真的变化
        // 时才会调高度，初始化时设好的路径不会触发它。
        _detent = State(initialValue: initial.isEmpty ? .height(Self.choiceHeight) : .large)
    }

    @Environment(\.dismiss) private var dismiss
    @State private var path: [AddRoute] = []
    /// 第一步只需要一条窄条，进入表单之后要整屏。
    @State private var detent: PresentationDetent = .height(Self.choiceHeight)

    private static let choiceHeight: CGFloat = 306

    var body: some View {
        NavigationStack(path: $path) {
            choice
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: AddRoute.self) { route in
                    destination(for: route)
                }
        }
        .presentationDetents([.height(Self.choiceHeight), .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .onChange(of: path) { _, newPath in
            withAnimation(Motion.settle) {
                detent = newPath.isEmpty ? .height(Self.choiceHeight) : .large
            }
        }
    }

    @ViewBuilder
    private func destination(for route: AddRoute) -> some View {
        switch route {
        case .recordCarriers:
            RecordCarrierPicker { carrier in
                path.append(.newRecord(carrier))
            }
        case .newRecord(let carrier):
            RecordEditorView(carrier: carrier, onSaved: { dismiss() })
        case .newCanvas:
            CanvasEditorView(onSaved: { dismiss() })
        }
    }

    // MARK: - 第一步

    private var choice: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("添加")
                    .font(TypeScale.cardTitle)
                    .foregroundStyle(Palette.ink)
                Spacer(minLength: 0)
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.inkFaint)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(Palette.well))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭")
            }
            .padding(.bottom, 2)

            option(symbol: "square.and.pencil",
                   title: "添加记录",
                   subtitle: "记下一段网页、照片、视频或文字") {
                path.append(.recordCarriers)
            }

            option(symbol: "square.grid.2x2",
                   title: "新建画布",
                   subtitle: "创建一个新的内容组织空间") {
                path.append(.newCanvas)
            }
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.paper)
    }

    private func option(symbol: String,
                        title: LocalizedStringKey,
                        subtitle: LocalizedStringKey,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                        .fill(Palette.cream.opacity(0.55))
                    Image(systemName: symbol)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.espresso)
                }
                .frame(width: 44, height: 44)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                    Text(subtitle)
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 6)

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 0.8)
            )
            .contentShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
        }
        .buttonStyle(CardButtonStyle())
    }
}

/// 面板内部的路线。
enum AddRoute: Hashable {
    case recordCarriers
    case newRecord(RecordCarrier)
    case newCanvas
}

/// 第二步：这条记录**是**什么。
///
/// 只问载体，不问意义。此前这里是「到访/视频/文章/开发/人生」六个分类，等于
/// 让系统替用户决定这条内容属于什么；现在分类变成了标签，在这一步之后才出现，
/// 也可以完全不选。
struct RecordCarrierPicker: View {

    let onPick: (RecordCarrier) -> Void

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(RecordCarrier.allCases) { carrier in
                    Button {
                        onPick(carrier)
                    } label: {
                        tile(carrier)
                    }
                    .buttonStyle(CardButtonStyle())
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(Palette.paper)
        .navigationTitle("添加记录")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func tile(_ carrier: RecordCarrier) -> some View {
        let tint = RecordPresentation.tint(carrier)
        return VStack(alignment: .leading, spacing: 9) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(tint.opacity(0.10))
                Image(systemName: carrier.symbol)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(tint)
            }
            .frame(width: 34, height: 34)

            VStack(alignment: .leading, spacing: 3) {
                Text(carrier.title)
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                Text(carrier.subtitle)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(13)
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
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
