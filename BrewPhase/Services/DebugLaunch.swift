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
    /// 30 秒快记。它是新闭环的入口，但入口在首页工具栏里，一屏截不全整个表单。
    case quickLog
    /// 诊断卡单独一屏。和 `tastingTimeline` 同一个理由：它在豆子页上位于折叠线以下，
    /// 而这张卡是这一次交付最需要看清楚的一块界面。
    case brewDiagnosis

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

    /// `-BrewPhaseAskMore "那用 V60 呢？" -BrewPhaseAskMore "水温呢？"`（可重复）
    ///
    /// 第一个问题之后的**追问**，按顺序一条条问，每条都等上一条答完。
    ///
    /// 为什么必须真的有这个入口：多轮上下文（指代解析、继承、换豆子清理）只有
    /// 在第二轮以后才存在，而 `simctl launch` 不能点击输入框。没有它，就只能靠
    /// 单元测试证明多轮是对的，界面上那张「正在讨论」的提示条截不到真图。
    static var askFollowUps: [String] {
        let args = ProcessInfo.processInfo.arguments
        var questions: [String] = []
        for (index, argument) in args.enumerated() where argument == "-BrewPhaseAskMore" {
            guard args.indices.contains(index + 1) else { continue }
            let value = args[index + 1]
            guard !value.hasPrefix("-") else { continue }
            questions.append(value)
        }
        return questions
    }

    /// `-BrewPhaseQuickLogDemo yes`
    ///
    /// 让 30 秒快记一打开就记下「一杯不太好的咖啡」（酸高、甜低、口感薄）并直接
    /// 停在结果页。存在的理由和 `-BrewPhaseAsk` 一样：`simctl launch` 不能点击，
    /// 而「记完立刻看到本次分析与下一杯建议」这条路只有真记下一杯才有东西可看。
    /// 它只在演示库里写一条记录，正常使用里是 nil。
    static var quickLogDemo: Bool {
        value(for: "-BrewPhaseQuickLogDemo") == "yes"
    }
}
