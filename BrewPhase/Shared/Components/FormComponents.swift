import SwiftUI

/// Editor building blocks.
///
/// The editors are cards and rows rather than `Form` sections, because a
/// `Form` makes the app look like a settings database — which §24 rules out. A
/// row here is a label and a control on one line, separated by hairlines that
/// only appear between rows inside the same card.
///
/// Titles and placeholders are `LocalizedStringKey`: that is the type SwiftUI
/// resolves against the active language, so a title written as a literal at the
/// call site is translated without the caller doing anything. Anything the app
/// assembles itself (a date, a count, a phase name) arrives pre-localised through
/// `L()` and is wrapped by the caller.
struct EditorSection<Content: View>: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, detail: detail)
            Card(padding: 0) {
                VStack(spacing: 0) {
                    content
                }
            }
        }
    }
}

/// One row inside an `EditorSection`.
struct EditorRow<Content: View>: View {
    var title: LocalizedStringKey?
    var showsDivider: Bool = true
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if let title {
                    Text(title)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.inkSoft)
                        .frame(width: 68, alignment: .leading)
                }
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 50)

            if showsDivider {
                CardDivider().padding(.leading, title == nil ? 0 : 16)
            }
        }
    }
}

/// A row whose quick-fill chips sit under the field and wrap onto as many lines
/// as they need.
///
/// These rows were first written as a horizontal `ScrollView`, which failed in
/// two ways: with clipping disabled the chips slid out past the card's rounded
/// edge, and the values that did not fit were invisible with nothing to suggest
/// they existed. Seven presets do not justify hiding some of them, so they wrap
/// instead — the same `FlowLayout` the flavour tags already use, one row below.
struct EditorChipsRow<Field: View>: View {
    let title: LocalizedStringKey
    let options: [String]
    var isOn: (String) -> Bool = { _ in false }
    var onPick: (String) -> Void
    var showsDivider: Bool = true
    @ViewBuilder var field: Field

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(title)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.inkSoft)
                    .frame(width: 68, alignment: .leading)
                field
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 9)
            .frame(minHeight: 50)

            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(options, id: \.self) { option in
                    SelectableTag(text: option, isOn: isOn(option)) {
                        onPick(option)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)

            if showsDivider { CardDivider() }
        }
    }
}

/// A text field styled to disappear into the row until it has focus.
struct EditorTextField: View {
    let placeholder: LocalizedStringKey
    @Binding var text: String
    var alignment: TextAlignment = .leading
    var keyboard: UIKeyboardType = .default

    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .font(TypeScale.body)
            .foregroundStyle(Palette.ink)
            .multilineTextAlignment(alignment)
            .keyboardType(keyboard)
            .focused($focused)
            .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
            .padding(.vertical, 2)
    }
}

/// Numeric field that keeps the keyboard honest and shows the unit inline.
struct NumberField: View {
    let placeholder: LocalizedStringKey
    @Binding var value: Double
    var unit: String = "g"
    var decimal: Bool = false
    var alignment: TextAlignment = .trailing

    @FocusState private var focused: Bool

    private var text: Binding<String> {
        Binding(
            get: {
                guard value > 0 else { return "" }
                return decimal ? String(format: "%.1f", value) : "\(Int(value.rounded()))"
            },
            set: { newValue in
                let cleaned = newValue.filter { $0.isNumber || ($0 == "." && decimal) }
                value = Double(cleaned) ?? 0
            }
        )
    }

    var body: some View {
        HStack(spacing: 3) {
            TextField(placeholder, text: text)
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.ink)
                .multilineTextAlignment(alignment)
                .keyboardType(decimal ? .decimalPad : .numberPad)
                .focused($focused)
            Text(unit)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
    }
}

/// A whole row that is a toggle.
struct EditorToggleRow: View {
    let title: LocalizedStringKey
    var detail: LocalizedStringKey?
    @Binding var isOn: Bool
    var showsDivider: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(TypeScale.body)
                        .foregroundStyle(Palette.ink)
                    if let detail {
                        Text(detail)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                Toggle("", isOn: $isOn)
                    .labelsHidden()
                    .tint(Palette.roast)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 50)

            if showsDivider { CardDivider() }
        }
    }
}

/// Label / value pair used in the bean detail page.
struct InfoRow: View {
    let label: LocalizedStringKey
    let value: String
    var showsDivider: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(label)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.inkSoft)
                Spacer(minLength: 8)
                Text(value)
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .multilineTextAlignment(.trailing)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)

            if showsDivider { CardDivider() }
        }
    }
}

/// A picker row that looks like a value you can tap, not a form control.
struct MenuRow<T: Hashable>: View {
    let title: LocalizedStringKey
    let options: [T]
    let label: (T) -> String
    @Binding var selection: T
    var showsDivider: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(title)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.inkSoft)
                Spacer(minLength: 8)
                Menu {
                    ForEach(options, id: \.self) { option in
                        Button {
                            selection = option
                        } label: {
                            if option == selection {
                                Label(label(option), systemImage: "checkmark")
                            } else {
                                Text(label(option))
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(label(selection))
                            .font(TypeScale.bodyMedium)
                            .foregroundStyle(Palette.ink)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Palette.inkFaint)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 50)

            if showsDivider { CardDivider() }
        }
    }
}

/// Date row with an optional "clear" affordance, since open/purchase dates are
/// allowed to be empty (§3).
struct DateRow: View {
    let title: LocalizedStringKey
    @Binding var date: Date?
    var showsDivider: Bool = true

    /// 最近一次的非空日期。清空的那一帧里 DatePicker 还挂在视图树上、仍会读一次
    /// 它的值——`Binding($date)` 的自动解包在那个时机读到 nil 会直接崩溃
    /// （实测：添加豆子弹窗里点清除烘焙日期即崩）。这个兜底值让读取永远有值
    /// 可给；真正的 nil 只由清除按钮写入，且写入后选择器立即离场。
    @State private var lastKnown: Date = Date()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(title)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.inkSoft)
                Spacer(minLength: 8)

                if date != nil {
                    // 手写绑定而不是 `Binding($date)` 自动解包：get 永不踩空。
                    DatePicker(
                        "",
                        selection: Binding(
                            get: { date ?? lastKnown },
                            set: { lastKnown = $0; date = $0 }
                        ),
                        displayedComponents: .date
                    )
                    .labelsHidden()
                    .datePickerStyle(.compact)
                    Button {
                        withAnimation(Motion.quick) { date = nil }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(Palette.inkFaint.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        withAnimation(Motion.quick) { date = lastKnown }
                    } label: {
                        Text("未填写")
                            .font(TypeScale.body)
                            .foregroundStyle(Palette.inkFaint)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(minHeight: 50)

            if showsDivider { CardDivider() }
        }
    }
}
