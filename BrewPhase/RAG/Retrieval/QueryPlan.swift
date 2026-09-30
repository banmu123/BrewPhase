import Foundation
import SwiftData

/// 用户这句话在问什么。
///
/// 意图决定**检索策略**，不是决定文案——所以它是有限的八种，而不是自由标签。
/// 多标签是常态：「这包豆什么时候冲得最好」同时是 `timing` 和 `rating`。
enum QueryIntent: String, CaseIterable, Sendable {
    case inventory
    case recipe
    case timing
    case rating
    case status
    case preference
    case similarity
    case knowledge

    var label: String {
        switch self {
        case .inventory: return L("有哪些豆子")
        case .recipe: return L("冲煮参数")
        case .timing: return L("时间与天数")
        case .rating: return L("评分")
        case .status: return L("当前状态")
        case .preference: return L("口味偏好")
        case .similarity: return L("相似经历")
        case .knowledge: return L("咖啡知识")
        }
    }

    /// 这一类问题是不是主要在问**用户自己的记录**。
    ///
    /// 用来决定要不要收窄检索范围：问「我有几包豆」时把咖啡知识库也捞进来只会
    /// 挤掉真正的答案。
    var isAboutUserData: Bool { self != .knowledge }
}

/// 分析器需要知道的豆子信息。
///
/// 刻意**不**直接传 `Bean`：`@Model` 对象不能跨 actor，而意图识别是纯字符串
/// 处理，本该能在没有数据库的情况下测。做成值类型之后，规则的测试就是喂几个
/// 字符串进去看输出。
struct BeanHint: Equatable, Sendable {
    let id: UUID
    let name: String
    let origin: String
    let process: String
    let roaster: String

    init(id: UUID, name: String, origin: String, process: String, roaster: String) {
        self.id = id
        self.name = name
        self.origin = origin
        self.process = process
        self.roaster = roaster
    }

    init(bean: Bean) {
        self.init(id: bean.id, name: bean.name, origin: bean.origin,
                  process: bean.process, roaster: bean.roaster)
    }

    /// 用来在问题里找这包豆子的词。名字、产地、处理法都算——用户说「埃塞那包」
    /// 或者「Guji」都是在指同一包。
    var matchTokens: [String] {
        var tokens: [String] = []
        for field in [name, origin, roaster] {
            for token in field.components(separatedBy: CharacterSet(charactersIn: " ··-—_/,()（）")) {
                let trimmed = token.trimmed
                // 太短的 token 会误命中：一个字符的产地缩写能匹配上半个问题。
                guard trimmed.count >= 2 else { continue }
                tokens.append(trimmed)
            }
        }
        return tokens
    }

    /// 只取产地里的词。用来在没锁定单包豆子时按产区筛。
    var originTokens: [String] {
        origin
            .components(separatedBy: CharacterSet(charactersIn: " ··-—_/,()（）"))
            .map(\.trimmed)
            .filter { $0.count >= 2 }
    }
}

/// 查询策略（协议 §3 里「查询策略」那一格）。
///
/// 这一层的产物是**该怎么查**，而不是查到的东西——所以它不碰数据库，只描述范围、
/// 条件、条数和意图。
struct QueryPlan: Equatable, Sendable {

    var question: String
    var intents: Set<QueryIntent> = []
    var filter: MetadataFilter = .none

    /// 问题里被认出来的关键词。抽取式回答用它决定哪几句话最该出现。
    var terms: [String] = []

    /// 用户明确问了几条（「最近三次」）。nil 表示没提，用默认上限。
    var requestedCount: Int?

    /// 匹配到的豆子。多个时取最具体的那个。
    var focusBeanID: UUID?
    var focusBeanName: String?

    /// 要不要走结构化直查（精确事实）。
    var wantsStructuredFacts: Bool = true
    /// 要不要走向量检索。
    var wantsVectorSearch: Bool = true

    /// 给用户看的一句说明：「按『最近 3 次冲煮』来查」。
    ///
    /// 有意暴露出来：检索策略是这次回答为什么会是这样的一部分，藏起来的话用户
    /// 只能猜为什么没搜到他要的东西。
    var summary: String?

    var hasFocusBean: Bool { focusBeanID != nil }
}

extension QueryPlan {
    /// 最终取多少条进上下文。
    func passageLimit(default fallback: Int) -> Int {
        guard let requestedCount else { return fallback }
        // 用户明确说了条数就尊重它，但仍然夹在合理区间里：问「最近一百次」
        // 不该把上下文撑爆。
        return max(1, min(requestedCount, 20))
    }
}
