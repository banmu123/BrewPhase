import Foundation

/// V1 智能层的全部可调参数，集中在一处（协议 §17）。
///
/// 为什么是 enum 而不是 struct：这些是**随版本走的常量**，不是用户偏好。用户可调
/// 的东西在 `RAGSettings`（UserDefaults 里）。两者不能混——改这里不需要迁移任何
/// 数据，改 `RAGSettings` 的形状才需要考虑老用户。
///
/// 这里同时是「证据不足」判据的唯一出处：界面上那句「至少需要 N 条」的 N 必须
/// 从这里读，否则界面在说一个系统不认的数（协议 Case 5 的原话要求）。
enum IntelligenceConfig {

    /// 参与「个人最佳参数」比较至少需要多少条**高评分**冲煮记录。
    static let minimumSamplesForComparison = 3

    /// 多少分算「高评分」。个人最佳与参数偏离都以这批记录为基准。
    ///
    /// 取 4：App 的评分是 1–5，4 以上是用户真觉得好的一次，3 分多半是「还行」。
    static let highRatingThreshold = 4

    // MARK: 相似度排序权重（协议 §17）
    //
    // 语义相似是主信号；评分与时效是次信号；来源偏好（用户数据 vs 知识库）是
    // 小幅修正。调整这三个数不需要动任何检索代码。

    static let similarityWeight = 0.62
    static let qualityWeight = 0.16
    static let recencyWeight = 0.16

    // MARK: 参数偏离的展示容差
    //
    // 这些**不是咖啡科学标准**，而是展示上的「和你常用值足够接近」判据：落在
    // 容差内就不提它，免得每张卡片都列四行毫厘之差把重点淹没。咖啡本身的有效
    // 阈值由 `PhaseRuleBook` 决定（用户可编辑），和这里无关——两件事别混。

    /// 水温容差（°C）。
    static let temperatureTolerance = 1.5
    /// 萃取时间容差（秒）。
    static let timeTolerance = 15.0
    /// 粉水比容差。
    static let ratioTolerance = 0.5
    /// 粉量容差（g）。
    static let doseTolerance = 1.5

    /// 相似冲煮默认取多少条。
    static let similarHistoryLimit = 5

    // MARK: 天气场景的推导边界
    //
    // 这些不是咖啡科学，是把「温度」离散成用户一听就懂的档位。推荐只看档位，
    // 不看 3 度以内的差别。

    /// 高于这个温度算「晴热」。
    static let hotThresholdCelsius = 28.0
    /// 高于这个温度算「温和」（以下再分「转凉」「冷」）。
    static let coolThresholdCelsius = 18.0
    /// 高于这个温度算「转凉」（以下算「冷」）。
    static let coldThresholdCelsius = 8.0

    /// 场景偏好的做法家族，按优先级排。
    ///
    /// 常识规则、可讨论：热天想喝清爽的（冷萃、冰手冲），雨天和冷天想喝热的、
    /// 带奶的。它只影响**排序与措辞**，永远不会把历史高分的做法压下去——
    /// 见 `RecommendationEngine.methodSuggestion` 的融合方式。
    static func preferredFamilies(for scene: WeatherScene) -> [MethodFamily] {
        switch scene {
        case .hot: return [.cold, .filter, .espresso]
        case .rainy: return [.espresso, .filter, .cold]
        case .cold: return [.espresso, .filter, .cold]
        case .warm, .cool, .unknown: return [.filter, .espresso, .cold]
        }
    }

    /// 「今天先喝哪包」的场景契合度。
    ///
    /// 原则和上面一样：热天清爽些、冷天醇厚些。修正量故意很小（±0.2），它只
    /// 够在 PriorityEngine 给出**同档**的两包之间做取舍——天气永远压不过
    /// 「这包已经进入衰退期」这种真正的紧迫性。
    ///
    /// 处理法的判断走 `query_rules.json` 的别名表（「水洗」/「washed」是同一
    /// 件事的两种写法），因为 `process` 字段是自由文本。
    static func weatherAffinity(for scene: WeatherScene, bean: Bean) -> Double {
        let process = bean.process.lowercased()

        func processIs(_ canonical: String) -> Bool {
            QueryRules.loaded.processes.contains { group in
                group.first == canonical && group.contains { process.contains($0.lowercased()) }
            }
        }

        switch scene {
        case .hot:
            var score = 0.0
            if bean.roastLevel == .light { score += 0.15 }
            if processIs("水洗") { score += 0.1 }
            if bean.roastLevel == .mediumDark || bean.roastLevel == .dark { score -= 0.15 }
            return score
        case .cold, .rainy:
            var score = 0.0
            if bean.roastLevel == .mediumDark || bean.roastLevel == .dark { score += 0.15 }
            if processIs("日晒") { score += 0.1 }
            if bean.roastLevel == .light { score -= 0.1 }
            return score
        case .warm, .cool, .unknown:
            return 0
        }
    }

    /// 同档豆子之间要多大的契合度差才值得换推荐。太小的话，推荐会随天气
    /// 抖来抖去，用户记不住。
    static let weatherTieBreakMinimumMargin = 0.1

    // MARK: 多轮对话的边界
    //
    // 对话状态只存标识（豆子 id、实体 id、话题、参数、证据 id），不存正文。
    // 这里的四个数决定「记忆有多长、有多重」——改它们不需要动任何解析或检索代码。

    /// 证据窗口保留最近几轮。
    ///
    /// 取 3：再往前的东西已经和当前问题不在一个语境里了，留着只会让「这个证据
    /// 算不算热」变得含糊。规格 §二十三 点名不要凭感觉，这里就是那个数。
    static let conversationEvidenceTurns = 3
    /// 证据窗口最多留几条。
    static let conversationEvidenceLimit = 8
    /// 「上一轮引用过的资料」在排序里的加权。
    ///
    /// 故意很小：它是**热启动**，不是结论。一条看过的资料不该因为看过就压过更
    /// 贴题的新资料（规格 §四十七 的反面）。
    static let warmEvidenceBoost = 0.04
    /// 检索扩写最多拼几个上下文词。
    ///
    /// 太多会把问题淹没：扩写是给省略句补主体，不是把整包豆子的档案塞进查询。
    static let conversationContextTermLimit = 6
}
