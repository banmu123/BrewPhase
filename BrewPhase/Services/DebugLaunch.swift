import Foundation

/// Screens the app can be asked to open straight from a launch argument.
///
/// This exists so the UI can be inspected on a simulator without a UI-test
/// harness: `simctl launch` cannot tap, and hand-driving the app to reach the
/// detail page or an editor is the slowest possible way to find a layout bug.
///
/// It is inert in normal use — nothing reads it unless the process was launched
/// with `-BrewPhaseScreen`, which only `Tools/run.sh` ever passes. The sibling
/// app uses the same trick for the same reason.
enum DebugScreen: String, CaseIterable, Identifiable {
    case beanDetail
    case beanEditor
    case brewEditor
    case tasting
    /// The flavour timeline on its own, because on the detail page it sits below
    /// the fold and cannot be reached without scrolling.
    case tastingTimeline
    case rules
    case export
    /// The language row, which sits below the fold on the More screen and so
    /// cannot be screenshotted in place.
    case language
    /// 本地问答页。和 `language` 一样，它在更多页的折叠线以下，截不到。
    case ask
    /// 洞察页——V1 智能层的主界面，四张卡片各占一屏的一部分。
    case insights

    var id: String { rawValue }
}

enum DebugLaunch {

    private static func value(for flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        let value = args[index + 1]
        return value.hasPrefix("-") ? nil : value
    }

    /// `-BrewPhaseScreen beanDetail`
    static var screen: DebugScreen? {
        guard let raw = value(for: "-BrewPhaseScreen") else { return nil }
        return DebugScreen(rawValue: raw)
    }

    /// `-BrewPhaseTab brews`
    static var tab: AppTab? {
        switch value(for: "-BrewPhaseTab") {
        case "cellar": return .cellar
        case "brews": return .brews
        case "more": return .more
        default: return nil
        }
    }

    /// `-BrewPhaseAsk "这包豆什么时候开封的？"`
    ///
    /// 让问答页一打开就自动问这一句。存在的原因和 `screen` 一样：`simctl launch`
    /// 不能点击，而整条检索与生成链路只有在真的问过一次之后才有东西可看。
    /// 它也让「换一个 LLM provider 之后回答变成什么样」可以截图对比。
    static var askQuestion: String? {
        value(for: "-BrewPhaseAsk")
    }
}
