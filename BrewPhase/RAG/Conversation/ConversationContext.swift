import Foundation

/// 对话里正在聊哪个知识领域（规格 §二十一）。
///
/// 与 `knowledge_entities.json` 里的 `topic.*` 节点**一一对应**（`bean`、
/// `personalHistory`、`recommendation` 三者除外，它们不是知识节点，是对话自己的
/// 主题）。这样做的直接好处是：话题的展示名直接取自实体自带的多语言名，
/// 不需要为「水质」「萃取」这些词再维护一份界面文案。
///
/// 枚举而不是字符串：话题要参与测试断言与状态比较，拼错的字符串不会报错，
/// 只会让继承悄悄失效。
enum ConversationTopic: String, CaseIterable, Sendable {
    case bean
    case origin
    case variety
    case processing
    case roast
    case freshness
    case storage
    case grinding
    case brewing
    case espresso
    case water
    case extraction
    case sensory
    case milk
    case cleaning
    case troubleshooting
    case safety
    case health
    case industry
    case terminology
    /// 用户自己的记录（个人历史）。
    case personalHistory
    /// 「今天先喝哪包」这类推荐。
    case recommendation

    /// 对应的知识实体 id。没有对应节点的三个话题返回 nil。
    var entityID: String? {
        switch self {
        case .bean, .personalHistory, .recommendation: return nil
        case .origin: return "topic.origin"
        case .variety: return "topic.variety"
        case .processing: return "topic.process"
        case .roast: return "topic.roast"
        case .freshness: return "topic.freshness"
        case .storage: return "topic.storage"
        case .grinding: return "topic.grind"
        case .brewing: return "topic.brewing"
        case .espresso: return "topic.espresso"
        case .water: return "topic.water"
        case .extraction: return "topic.extraction"
        case .sensory: return "topic.sensory"
        case .milk: return "topic.milk"
        case .cleaning: return "topic.cleaning"
        case .troubleshooting: return "topic.troubleshooting"
        case .safety: return "topic.safety"
        case .health: return "topic.health"
        case .industry: return "topic.industry"
        case .terminology: return "topic.terminology"
        }
    }

    /// 实体 id 前缀 → 话题。用于「上一轮聊到 region.guji，这条消息在问这个产区」。
    ///
    /// 前缀约定来自 `knowledge_entities.json` 的实际取值（`origin.` / `region.` /
    /// `process.` / `roast.` / `variety.` / `sensory.` / `method.` / `family.`），
    /// 所以这里有据可依，不是猜的。
    static func forEntityID(_ id: String) -> ConversationTopic? {
        if id.hasPrefix("origin.") || id.hasPrefix("region.") { return .origin }
        if id.hasPrefix("variety.") || id.hasPrefix("varietyGroup.") { return .variety }
        if id.hasPrefix("process.") { return .processing }
        if id.hasPrefix("roast.") { return .roast }
        if id.hasPrefix("method.") || id.hasPrefix("family.") { return .brewing }
        if id.hasPrefix("sensory.") { return .sensory }
        switch id {
        case "topic.origin": return .origin
        case "topic.variety": return .variety
        case "topic.process": return .processing
        case "topic.roast": return .roast
        case "topic.freshness": return .freshness
        case "topic.storage": return .storage
        case "topic.grind": return .grinding
        case "topic.brewing": return .brewing
        case "topic.espresso": return .espresso
        case "topic.water": return .water
        case "topic.extraction": return .extraction
        case "topic.sensory": return .sensory
        case "topic.milk": return .milk
        case "topic.cleaning": return .cleaning
        case "topic.troubleshooting": return .troubleshooting
        case "topic.safety": return .safety
        case "topic.health": return .health
        case "topic.industry": return .industry
        case "topic.terminology": return .terminology
        default: return nil
        }
    }

    /// 展示名。有对应知识实体的走实体自带的多语言名（与界面语言一致），
    /// 没有对应节点的三者用界面文案。
    func label(languageCode: String) -> String {
        if let entityID, let entity = EntityGraph.loaded.entity(withID: entityID) {
            return entity.displayName(for: languageCode)
        }
        switch self {
        case .bean: return L("豆子")
        case .personalHistory: return L("你的记录")
        case .recommendation: return L("推荐")
        default: return rawValue
        }
    }
}

/// 用户在问哪个参数维度（规格 §三十七/§三十八）。
enum QueryParameter: String, CaseIterable, Sendable {
    case temperature
    case grind
    case time
    case ratio
    case dose
    case water
    case pressure

    var label: String {
        switch self {
        case .temperature: return L("水温")
        case .grind: return L("研磨")
        case .time: return L("时间")
        case .ratio: return L("粉水比")
        case .dose: return L("粉量")
        case .water: return L("水量")
        case .pressure: return L("压力")
        }
    }

    /// 这个参数落在哪个话题下。用于「问参数时话题跟着走」。
    var topic: ConversationTopic {
        switch self {
        case .temperature, .water: return .water
        case .grind: return .grinding
        case .pressure: return .espresso
        case .time, .ratio, .dose: return .brewing
        }
    }
}

/// 参数调整方向（规格 §三十八）：高/低/细/粗/快/慢/多/少。
///
/// 它**只表示方向**。解析出来的方向不产生任何新数值——数值只能来自用户的记录或
/// 知识库，规则不允许凭空算一个「低一点 = 89°C」出来。
enum ParameterDirection: String, CaseIterable, Sendable {
    case higher
    case lower
    case finer
    case coarser
    case faster
    case slower
    case more
    case less

    var label: String {
        switch self {
        case .higher: return L("高一点")
        case .lower: return L("低一点")
        case .finer: return L("细一点")
        case .coarser: return L("粗一点")
        case .faster: return L("快一点")
        case .slower: return L("慢一点")
        case .more: return L("多一点")
        case .less: return L("少一点")
        }
    }

    /// 方向本身强烈暗示的参数。「细/粗」只能是研磨，「快/慢」只能是时间；
    /// 「高/低」「多/少」不定，必须由上下文决定——那是会话状态的工作，不是这里的。
    var impliedParameter: QueryParameter? {
        switch self {
        case .finer, .coarser: return .grind
        case .faster, .slower: return .time
        case .higher, .lower, .more, .less: return nil
        }
    }
}

/// 一件冲煮工具（方式或器具）在对话里被提到的样子。
///
/// 为什么两个字段都要：`label` 是**用户自己说的那个词**（展示与追问时用它才自然），
/// `spellings` 是词表里的整组写法（过滤要用它，因为库里存的很可能是另一种语言）。
struct MethodReference: Equatable, Sendable {
    let label: String
    let spellings: [String]

    init(label: String, spellings: [String]) {
        self.label = label
        self.spellings = spellings
    }
}

/// 一轮答案里出现过的一条证据（规格 §十五：只存标识，不存内容）。
struct EvidenceRef: Equatable, Sendable {
    let id: String
    let sourceType: KnowledgeSourceType
    let beanID: UUID?
    /// 出现在的第几轮（从 1 开始）。用来做证据过期，而不是靠猜。
    let turnIndex: Int

    /// 索引里冲煮记录的键是 `brew:<uuid>`（`CoffeeKnowledgeDocument.id` 的拼写约定），
    /// 所以「刚才那杯」能落到一条确定的记录上，而不是靠相似度碰运气。
    var brewID: UUID? {
        guard sourceType == .brew else { return nil }
        let parts = id.split(separator: ":")
        guard parts.count == 2, parts[0] == "brew" else { return nil }
        return UUID(uuidString: String(parts[1]))
    }
}

/// 多轮对话的语义状态（规格 §七）。
///
/// **它不是聊天记录。** 只保存「对下一轮检索有价值的东西」：锁定的是哪包豆子、
/// 聊过哪些实体、用哪种冲法、在问哪个参数、话题是什么、上一轮引用过哪几条证据。
/// 真正的数据（豆子、冲煮、风味、知识）永远从 SwiftData / 向量索引 / 随包知识里
/// 现查——把整个数据库塞进来既没有意义，也会让这个值类型失去可测试性。
///
/// 全部字段都有默认值，`ConversationContext.empty` 就是「第一次打开问一问」。
struct ConversationContext: Equatable, Sendable {

    /// 会话标识。同一轮对话内不变，用来把日志串起来。
    var conversationID: UUID = UUID()
    /// 已经完成了几轮问答。从 0 开始。
    var turnIndex: Int = 0

    /// 当前在聊哪包豆子（规格 §十九：换豆子要清理豆子专属状态）。
    var focusBeanID: UUID?
    /// 展示用。界面要能说「正在讨论：Ethiopia Guji」，而豆名来自用户数据，
    /// 不该为了显示一句话再去查一遍库。
    var focusBeanName: String?

    /// 当前话题显式提到的实体（命中方式为 exact / normalized / alias / userSelected）。
    var directEntityIDs: [String] = []
    /// 由层级或字段语义推出来的实体（hierarchy / inferred），例如只写 Guji 时的 Ethiopia。
    /// **不能与上面混为一谈**：推导出来的东西呈现时要标明来路（规格 §十二）。
    var ancestorEntityIDs: [String] = []

    var activeMethod: MethodReference?
    var activeEquipment: MethodReference?
    var activeParameter: QueryParameter?
    /// 上一轮的方向。存它是为了让「再低一点呢」能连上上一轮的方向语义，
    /// 而不是每次都要求用户重说一遍。
    var lastDirection: ParameterDirection?
    var activeTopic: ConversationTopic?
    /// 最近一轮的主要意图（`QueryIntent` 是多标签的，这里是按固定优先级取出的主意图）。
    var activeIntent: QueryIntent?

    var recentQuestion: String = ""
    var recentQuestionTerms: [String] = []
    /// 证据窗口。只留最近若干轮，换豆子时清空（规格 §十八/§十九）。
    var recentEvidence: [EvidenceRef] = []

    static let empty = ConversationContext()

    /// 是不是一个还没开始的会话。
    var isFresh: Bool {
        turnIndex == 0 && focusBeanID == nil && directEntityIDs.isEmpty && recentQuestion.isEmpty
    }

    /// 当前豆子相关的全部实体（含祖先），去重且保持顺序。
    var allEntityIDs: [String] {
        var seen = Set<String>()
        return (directEntityIDs + ancestorEntityIDs).filter { seen.insert($0).inserted }
    }

    var recentEvidenceIDs: [String] { recentEvidence.map(\.id) }

    var recentEvidenceSourceTypes: Set<KnowledgeSourceType> {
        Set(recentEvidence.map(\.sourceType))
    }

    /// 证据窗口里最近一次冲煮记录的 id。「刚才那杯」靠它落地。
    var recentBrewID: UUID? {
        recentEvidence.compactMap(\.brewID).last
    }

    /// 界面那一行「正在讨论」（规格 §四十二）。
    ///
    /// 参数比话题具体，两者都有时只说参数——「水温 · 水质」这种并列是机器话，
    /// 不是人话。
    func discussionLabel(languageCode: String) -> String? {
        var parts: [String] = []
        if let focusBeanName, !focusBeanName.trimmed.isEmpty { parts.append(focusBeanName) }
        if let activeMethod { parts.append(activeMethod.label) }
        if let activeParameter {
            parts.append(activeParameter.label)
        } else if let activeTopic, activeTopic != .bean {
            parts.append(activeTopic.label(languageCode: languageCode))
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ")
    }
}

/// 实体是怎么来的（规格 §十五 的两档）。
///
/// 分档不是为了好看：`Guji` 是豆子上写着的，`Ethiopia` 是从层级推出来的，
/// 两者在「为什么关联上这包豆」的解释里分量不同，在界面上也不该说成同一件事。
enum EntityProvenance {
    /// 写的或说的：完全匹配、规范匹配、别名匹配、用户指定。
    static let direct: Set<MatchType> = [.exact, .normalized, .alias, .userSelected]
    /// 推出来的：层级推导、字段语义推断、泛化背景。
    static let inferred: Set<MatchType> = [.hierarchy, .inferred, .generalContext]
}

extension BeanContext {
    /// 这包豆子**明说**的实体。
    var directlyStatedEntityIDs: [String] {
        resolutions.filter { EntityProvenance.direct.contains($0.match) }.map(\.id)
    }

    /// 这包豆子**推出来**的实体（祖先等）。
    var inferredEntityIDs: [String] {
        resolutions.filter { EntityProvenance.inferred.contains($0.match) }.map(\.id)
    }
}
