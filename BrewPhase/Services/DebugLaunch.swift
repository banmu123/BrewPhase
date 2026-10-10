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
    /// 打不开本地数据库时的恢复页。它不在任何正常的视图树里——最外层就被拦下了
    /// （见 `BrewPhaseApp`），所以它需要自己的入口才能被截图。
    case persistenceRecovery
    /// 「调整剩余量」弹层。它平时是详情页上的一个 sheet，模拟器点不到；
    /// 而这轮重新写过的提示文案（剩余量 > 总量时）需要真看一眼。
    case stockAdjust
    /// 「高级设置 → 本地智能」：向量模型、检索条数、重建索引住的那一层。
    /// 平时在更多页的第三层，截不到。
    case askAdvanced
    /// 预计风味窗口单独一屏：它在豆子页的折叠线以下，而这批要检查它的
    /// 视觉权重是否真的低于阶段卡。
    case flavorPrediction

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

    /// `-BrewPhaseScreen persistenceRecovery` 时让 App 直接以「容器打不开」的姿态启动。
    ///
    /// 理由和上面几个入口一样：模拟器上的存储是好的，真正的打开失败没法人为制造，
    /// 恢复页需要这条专用开关才能被看到。它只改变启动状态——不删任何文件、
    /// 不动数据库。
    static var recoveryDemo: Bool {
        screen == .persistenceRecovery
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

    /// `-BrewPhaseQuickLogExpand params|flavor|all`
    ///
    /// 「更多参数」和「风味标签」默认都是折着的，而模拟器不能点击——这两个折叠区
    /// 展开之后长什么样，只有先替用户展开、再滚到它跟前才看得到。
    static var quickLogFocus: String? {
        value(for: "-BrewPhaseQuickLogExpand")
    }

    /// `-BrewPhaseBean <豆名>`
    ///
    /// 让需要「某一包豆」的调试屏（详情页、冲煮 / 风味编辑器、库存调整）打开
    /// 指定的那包，而不是默认挑今天最该喝的那包。有几个场景只有特定的豆子身上
    /// 才看得到：没有冲煮记录的、已经喝完的、没有烘焙日期的。
    static var beanName: String? {
        value(for: "-BrewPhaseBean")
    }

    /// `-BrewPhaseBeanAction finish|restore`
    ///
    /// 打开详情页后对聚焦的那包豆执行一次「标记喝完 / 恢复在喝」。菜单本身是弹层、
    /// 截不到图，所以这条路的验收靠动作发生**之后**页面变成什么样：状态词、
    /// 剩余量、主要行动按钮。
    static var beanAction: String? {
        value(for: "-BrewPhaseBeanAction")
    }

    /// `-BrewPhaseStockOvershoot yes`
    ///
    /// 让「调整剩余量」以上限超过总量的状态打开：「保存后总量会调整为 …」这句
    /// 提示只在那个分支上出现，正常演示数据里造不出来。
    static var stockOvershoot: Bool {
        value(for: "-BrewPhaseStockOvershoot") == "yes"
    }

    /// `-BrewPhaseBeanEditorExpand yes`
    ///
    /// 豆子编辑器的「更多信息」默认折着，而模拟器不能点击——展开之后的长英文
    /// 标签（Roaster / Process / Channel…）在固定宽标题列旁边长什么样，只有先
    /// 替用户展开才截得到。
    static var beanEditorExpand: Bool {
        value(for: "-BrewPhaseBeanEditorExpand") == "yes"
    }
}
