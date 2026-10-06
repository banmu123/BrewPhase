import SwiftUI

/// Choosing the interface language.
///
/// §18 does not list a language row, but a bilingual app needs a way to choose
/// one. It is deliberately a preference of this app rather than a device
/// setting: the change takes effect on the spot, and "Follow System" hands the
/// decision back to the phone.
///
/// This is the one place where an option is written in its own language —
/// `English`, `简体中文` — so a user can always find theirs whichever language
/// the interface is currently in. Only "follow the system" is translated.
struct LanguageSection: View {

    @ObservedObject var language: LanguageManager

    /// 更多页按「咖啡 / 本地智能 / 数据 / 应用」分组后，组头已经说明了语境，
    /// 这里可以不再重复自己的标题。
    var showsHeader: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsHeader {
                SectionHeader(title: "语言", detail: "立即生效")
            }

            Card(padding: 0) {
                MenuRow(
                    title: "界面语言",
                    options: AppLanguage.allCases,
                    label: \.displayName,
                    selection: Binding(
                        get: { language.current },
                        set: { language.set($0) }
                    ),
                    showsDivider: false
                )
            }

            Text("换语言不用重启，也不用改系统设置。选「跟随系统」就跟着手机走。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
