import Foundation

/// 喂给模型的一次输入：App 手上关于这包豆子的**全部**信息，缺的用 nil 表示。
///
/// 为什么要单独建这个类型，而不是直接把 `Bean` 递进去：模型要的 85 个特征里有
/// 一大半 App 今天根本没有（品种、海拔、发展时间、包装、储存方式……）。把「有」
/// 和「没有」摆在一个明确的结构里，缺什么就是 nil，缺什么就在诊断里说出来——
/// 而不是在编码的时候悄悄填个「差不多」的值，让人以为预测用上了这些资料。
struct FlavorInput: Equatable, Hashable, Sendable {

    // MARK: - App 已经有，且必定有

    var roastLevel: RoastLevel
    /// 产地原文，例如「埃塞俄比亚」。模型要的是国家，App 只有一整串产区文本。
    ///
    /// 国家和产区**分开两个字段**，哪怕 App 今天把两者存在同一个字符串里：模型的
    /// 契约本来就是两维，合并着传会在「只写了国家、没写产区」时悄悄丢掉一维，
    /// 而这一层不该替 App 的数据形态做决定。合成一个的活儿归 `FlavorInputFactory`。
    var originCountryText: String
    /// 产区原文，例如「Guji」。
    var originRegionText: String
    /// 处理法原文，例如「水洗」。
    var processText: String
    /// 烘焙商原文。模型那边的取值是 Roaster_01…20 这类合成占位名，所以真实
    /// 烘焙商名**必然**匹配不上、整组留 0——这是设计好的行为，不是 bug。
    var roasterText: String
    /// 器具原文，例如「V60」。
    var brewMethodText: String

    /// 开封日折算成「烘焙后第几天」。nil 表示不知道什么时候开的。
    ///
    /// 用相对天数而不是 `Date`：模型只认天数，而曲线是逐天推进的，两者用同一
    /// 坐标才谈得上「第 12 天开没开袋」。
    var openDayAfterRoast: Int?
    /// 上面那个天数是哪来的：真实开封日期、按第一次冲煮推算，还是干脆没有线索。
    var openBasis: FlavorOpenBasis = .assumedSealed

    // MARK: - App 有，但可能没填

    var doseG: Double?
    var waterTempC: Double?
    var waterWeightG: Double?
    /// 液重。App 没有这个字段；有水量时按水量算（和协议里的参考示例一致）。
    var beverageWeightG: Double?
    var brewTimeSeconds: Double?
    /// 研磨度，**1–10 相对刻度**。App 存的是「22 格」这种自由文本，没有跨磨豆机
    /// 的换算关系，所以这里只接受已经是 1–10 的数，其余一律 nil。
    var grindSizeTenScale: Double?

    // MARK: - App 还没有的字段
    //
    // 留在这里不是占位符，是为了让「接一个字段」这件事只是填一个值：
    // `FlavorInputFactory` 里把对应的 Bean 属性接过来，编码层一行都不用改。

    var varietyText: String?
    var altitudeM: Double?
    var developmentTimeSeconds: Double?
    var packagingTypeText: String?
    var storageMethodText: String?
    var storageTemperatureC: Double?
    var oneWayValve: Bool?
}

/// `opened` / `days_since_open` 是怎么定下来的。界面要如实说明，因为这三个
/// 特征里的天数直接决定曲线形状。
enum FlavorOpenBasis: Equatable, Hashable, Sendable {
    /// 有真实的开封日期。
    case openDate
    /// 没有开封日期，但记过冲煮——那袋豆子显然开过，按第一次记录推算。
    case firstBrew
    /// 什么线索都没有，按「一直封着」处理。
    case assumedSealed

    var isInferred: Bool { self != .openDate }
}

/// 这一次预测里哪些资料没派上用场。存在的意义只有一个：**让缺失可见**。
///
/// 一份「85 个特征里 40 个是填出来的」的预测，和一份资料齐全的预测，算出来的
/// 数看起来一模一样。既然模型自己没法表达不确定性，那就由这一层替它说出来。
///
/// 分成三桶而不是一桶，是因为三者的**处理方式不一样**：App 没有的字段要加字段，
/// 对不上的说法要么改写法要么扩别名表，而原文本身含混的（「厌氧日晒」）得先做个
/// 决定。混成一句「资料不全」，用户既不知道问题在哪，也不知道该做什么。
struct FlavorDiagnostics: Equatable, Sendable {

    /// App 还没有这个字段，或者这次没有值——模型用了训练时的典型值。
    var unavailable: [String] = []
    /// App 有内容，但模型不认识这个说法。
    var unmatched: [String] = []
    /// 原文本身没法对应到单一类别，记的是原文而不是字段名。
    var uninterpretable: [String] = []
    var openBasis: FlavorOpenBasis = .assumedSealed

    var isEmpty: Bool { unavailable.isEmpty && unmatched.isEmpty && !openBasis.isInferred }

    /// 「缺了哪些字段」的清单，类别在前、数值在后。
    var unavailableLabels: [String] { unavailable.map(FlavorFeatureLabel.label) }

    var unmatchedLabels: [String] { unmatched.map(FlavorFeatureLabel.label) }
}

/// 特征的中文名。只服务于「哪些资料没派上用场」这一条说明。
///
/// 单独放一层而不是散在编码逻辑里：将来这些名字会变成表单上的字段名，两边该是
/// 同一句话。用计算属性而不是 `let`，否则第一次取到的翻译会被永久缓存下来，
/// 界面语言一换就露馅（`DefaultPhaseRules.disclaimer` 有同样的注释）。
enum FlavorFeatureLabel {

    /// 组名和数值特征名互不重叠，所以一个入口就够。
    static func label(_ name: String) -> String {
        if let group = groupLabels[name] { return group }
        if let numeric = numericLabels[name] { return numeric }
        return name
    }

    private static var groupLabels: [String: String] {
        [
            "origin_country": L("产地"),
            "origin_region": L("产区"),
            "variety": L("品种"),
            "processing_method": L("处理法"),
            "roaster": L("烘焙商"),
            "roast_level": L("烘焙度"),
            "packaging_type": L("包装类型"),
            "storage_method": L("储存方式"),
            "brew_method": L("冲煮方式"),
        ]
    }

    private static var numericLabels: [String: String] {
        [
            "altitude": L("海拔"),
            "development_time": L("发展时间"),
            "storage_temperature": L("储存温度"),
            "dose": L("粉量"),
            "water_temperature": L("水温"),
            "water_weight": L("水量"),
            "beverage_weight": L("液重"),
            "brew_time": L("冲煮时长"),
            "grind_size": L("研磨度"),
        ]
    }
}

/// 把 `FlavorInput` 编成模型要的那一条 85 维向量。
///
/// 这是唯一的编码实现，对应 Python 侧的 `feature_engineering.py`。三条铁律照抄
/// 协议 §3.2：名义类别**绝不做** ordinal 编码；未知类别整组填 0、不报错也不猜；
/// 向量顺序严格按 `feature_schema.json → feature_names`。
enum FlavorFeatureBuilder {

    /// 模型只看曲线上的「第几天」，协议和参考实现都取 1…30。
    static let curveDays = 1...30

    /// 最佳窗口的判定容差：分数 ≥ 峰值 − 0.25 的天算在窗口里。
    /// 和 `predict.py → predict_curve(tol=0.25)` 一致。
    static let windowTolerance = 0.25

    struct Output: Equatable, Sendable {
        var values: [Double]
        var diagnostics: FlavorDiagnostics
    }

    static func build(
        input: FlavorInput,
        dayAfterRoast day: Int,
        schema: FlavorSchema,
        mapping: FlavorMapping,
        index: FlavorAliasIndex
    ) -> Output {
        var raw: [String: Double] = [:]
        var diagnostics = FlavorDiagnostics()
        diagnostics.openBasis = input.openBasis

        // MARK: 二值特征
        //
        // 先算它们，因为 days_since_open 和 opened 出自同一个判断。
        let openDay = input.openDayAfterRoast
        let isOpen = openDay.map { day >= $0 } ?? false

        for name in schema.binaryNames {
            switch name {
            case "opened":
                raw[name] = isOpen ? 1.0 : 0.0
            case "one_way_valve":
                if let valve = input.oneWayValve {
                    raw[name] = valve ? 1.0 : 0.0
                } else {
                    // App 没有这个字段，取 0——不假设袋子一定有单向阀。
                    // 这里不进「缺字段」清单：它是一个二值特征，且缺省值写在
                    // flavor_mapping.json 里，不是一条需要用户去补的资料。
                    raw[name] = mapping.binaryDefaults[name]?.value ?? 0.0
                }
            default:
                raw[name] = mapping.binaryDefaults[name]?.value ?? 0.0
            }
        }

        // MARK: 数值特征
        for name in schema.numericNames {
            if let value = numericValue(name, input: input, day: day, isOpen: isOpen, openDay: openDay) {
                raw[name] = value
            } else {
                raw[name] = mapping.numericDefaults[name]?.value ?? 0.0
                diagnostics.unavailable.append(name)
            }
        }

        // MARK: one-hot 特征
        for group in schema.categoricalNames {
            let categories = schema.oneHotCategories[group] ?? []
            let text = categoricalText(group, input: input)

            if let canonical = index.canonical(group: group, raw: text),
               categories.contains(canonical) {
                for category in categories {
                    raw["\(group)__\(category)"] = (category == canonical) ? 1.0 : 0.0
                }
            } else {
                // 未知类别：整组 0。不猜、不填「最像」的那个，也不默认填 Medium。
                for category in categories {
                    raw["\(group)__\(category)"] = 0.0
                }
                recordMiss(group: group, text: text, mapping: mapping, into: &diagnostics)
            }
        }

        return Output(
            // 顺序就是契约，一个都不能错、不能少。
            values: schema.featureNames.map { raw[$0] ?? 0.0 },
            diagnostics: diagnostics
        )
    }

    // MARK: - 取值

    /// 一组没匹配上时，如实记一笔——记成哪一种，决定用户该去做什么。
    private static func recordMiss(
        group: String,
        text: String,
        mapping: FlavorMapping,
        into diagnostics: inout FlavorDiagnostics
    ) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // App 里没有这个字段，或者这次没填。这一桶对应「要加字段」。
            diagnostics.unavailable.append(group)
            return
        }
        if mapping.cannotMap[FlavorAliasIndex.normalised(text)] != nil {
            // 原文自己就含混（「厌氧日晒」同时是厌氧和日晒）。报原文而不是字段名，
            // 因为这里要的不是「去加个字段」，而是「先决定它算哪一类」。
            diagnostics.uninterpretable.append(text)
            return
        }
        if mapping.expectedUnmatched[group] != nil {
            // 本来就对不上、而且每包豆子都会这样（烘焙商）。报出来只会稀释
            // 真正值得看的缺失提示。
            return
        }
        diagnostics.unmatched.append(group)
    }

    private static func numericValue(
        _ name: String,
        input: FlavorInput,
        day: Int,
        isOpen: Bool,
        openDay: Int?
    ) -> Double? {
        switch name {
        case "altitude": return input.altitudeM
        case "development_time": return input.developmentTimeSeconds
        // 曲线上的那一天本身就是这个特征的取值。
        case "days_since_roast": return Double(day)
        case "storage_temperature": return input.storageTemperatureC
        case "days_since_open":
            guard isOpen, let openDay else { return 0 }
            return Double(max(0, day - openDay))
        case "dose": return input.doseG
        case "water_temperature": return input.waterTempC
        case "water_weight": return input.waterWeightG
        // 有水量就按水量算液重，比拿训练均值填更贴合这包豆子。
        case "beverage_weight": return input.beverageWeightG ?? input.waterWeightG
        case "brew_time": return input.brewTimeSeconds
        case "grind_size": return input.grindSizeTenScale
        default: return nil
        }
    }

    private static func categoricalText(_ group: String, input: FlavorInput) -> String {
        switch group {
        case "origin_country": return input.originCountryText
        case "origin_region": return input.originRegionText
        case "variety": return input.varietyText ?? ""
        case "processing_method": return input.processText
        case "roaster": return input.roasterText
        // 对不上时把 App 自己的枚举名当作原文递出去，而不是空串：空串会被记成
        // 「App 没这个字段」，而烘焙度 App 是有的，只是「意式拼配」不是模型认识
        // 的任何一个烘焙度。
        case "roast_level": return FlavorRoastLevel.modelValue(input.roastLevel) ?? input.roastLevel.rawValue
        case "packaging_type": return input.packagingTypeText ?? ""
        case "storage_method": return input.storageMethodText ?? ""
        case "brew_method": return input.brewMethodText
        default: return ""
        }
    }
}

/// App 的烘焙度 → 模型 `roast_level` 的五个取值。
///
/// 这张表是**唯一**的映射处，单独摆出来是因为它是协议里点名的红线：
/// 未知的烘焙度必须整组填 0，绝不能默认填 Medium。App 的「意式拼配」不是烘焙度
/// （它是一个拼配标识），模型的五个取值里没有对应的，所以返回 nil —— 整组 0。
///
/// 反过来，模型的 `Medium-Light` 在 App 里**没有对应项**：App 把「浅烘」和
/// 「中烘」之间留白了，所以这一段信号目前取不到。要补就得先加烘焙度档位。
enum FlavorRoastLevel {

    static func modelValue(_ level: RoastLevel) -> String? {
        switch level {
        case .light: return "Light"
        case .medium: return "Medium"
        case .mediumDark: return "Medium-Dark"
        case .dark: return "Dark"
        // 拼配不是烘焙度；App 也没有「中浅烘」这一档。
        case .espressoBlend: return nil
        }
    }
}
