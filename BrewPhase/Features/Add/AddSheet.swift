import SwiftUI

/// 统一添加流程：一张紧凑的「选载体」卡，选完在它上面再铺一张编辑器。
///
/// 之前的实现是「添加记录 / 新建画布」两个选项加一个内部 NavigationStack，
/// 推入编辑器时还要切 sheet 的 detent。在 iOS 18 上「导航推入中切换 detent」
/// 这条路会崩（选载体 → 返回 → 再选一次就能撞上）。现在整个流程**没有任何
/// 导航、没有任何 detent 切换**：
///
/// * 载体卡是固定高度的 sheet，选完不关；
/// * 编辑器作为第二张 sheet 铺在它上面，取消回到载体卡（重选很自然）；
/// * 保存后两级一起收起。
///
/// 「新建画布」也不再出现在这里——画布由画布页自己的 + 和空状态入口负责，
/// 添加记录的路上不该出现另一个概念。
struct AddFlowView: View {

    @Environment(\.dismiss) private var dismiss

    @State private var carrier: RecordCarrier?
    @State private var savedInside = false

    var body: some View {
        RecordCarrierPicker { carrier = $0 }
            .sheet(item: $carrier, onDismiss: {
                // 从编辑器里保存出来时，连载体卡一起收掉；取消则留在这张卡上，
                // 用户可以换个载体再试。
                if savedInside {
                    savedInside = false
                    dismiss()
                }
            }) { picked in
                RecordEditorView(carrier: picked, onSaved: {
                    savedInside = true
                    carrier = nil
                })
            }
    }
}

/// 第一步：这条记录**是**什么。
///
/// 只问载体，不问意义。标签在编辑器里才出现，也可以完全不选。
struct RecordCarrierPicker: View {

    let onPick: (RecordCarrier) -> Void

    @Environment(\.dismiss) private var dismiss

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header

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
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 16)
            .padding(.bottom, 24)
        }
        .background(Palette.paper)
        .presentationDetents([.height(372)])
        .presentationCornerRadius(28)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text("添加记录")
                    .font(TypeScale.cardTitle)
                    .foregroundStyle(Palette.ink)
                Text("记下一段网页、照片、视频或文字")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            Spacer(minLength: 8)
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
