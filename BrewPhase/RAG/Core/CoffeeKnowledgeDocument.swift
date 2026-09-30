import Foundation

// MARK: - 一条可检索的资料

/// RAG 里「一条可检索的资料」的统一种类（协议 §5）。
///
/// 前四个来自用户自己的数据，`knowledge` 来自 BrewPhase 自带的知识库。这个
/// 区分**不是分类装饰**：协议 §6 明确要求回答时必须能说清哪句话出自用户的
/// 记录、哪句话出自知识库，所以它在类型上就得分得开，不能只靠文案描述。
enum KnowledgeSourceType: String, Codable, CaseIterable, Sendable {
    case bean
    case brew
    case tasting
    case preference
    case knowledge

    /// 用户自己的数据，还是 App 自带的资料。
    ///
    /// 上下文构建器按这个属性分组（协议 §6 的最后一条要求），界面上也是
    /// 靠它决定引用列表分几段。
    var isUserData: Bool { self != .knowledge }

    var label: String {
        switch self {
        case .bean: return L("豆子")
        case .brew: return L("冲煮记录")
        case .tasting: return L("风味记录")
        case .preference: return L("口味偏好")
        case .knowledge: return L("咖啡知识")
        }
    }
}

/// 一条资料的可过滤字段。
///
/// 为什么是结构体而不是 `[String: String]`：这些字段要参与**元数据过滤**
/// （协议 §7 的第三层）。用字典的话，拼错一个键名只会让过滤静默失效——不报错、
/// 不崩，只是搜出来的东西不对，这种错最难查。结构体让编译器盯着。
///
/// 序列化成 JSON 存进库，所以以后加字段不必动存储层。
struct DocumentMetadata: Codable, Equatable, Sendable {
    /// 这条资料属于哪包豆子。跨类型过滤的主键。
    var beanID: UUID?
    var brewID: UUID?
    var tastingID: UUID?

    /// 冲煮相关。
    var method: String?
    var grinder: String?

    /// 时间与天数。`docDate` 用于日期区间过滤与时效加权。
    var docDate: Date?
    var dayAfterRoast: Int?

    /// 0 表示没打分（这是 App 的约定，不是 1 分）。
    var score: Int?

    /// 豆子属性，用于按产地/处理法筛。
    var origin: String?
    var process: String?
    var roaster: String?
    var roastLevel: String?

    /// 知识库专用：分类与出处。协议要求 source 必须能记录来源。
    var category: String?
    var reference: String?
    /// 知识实体 id（规格 §十一/§十三）。
    ///
    /// 这是 Bean↔Knowledge Linking 的落点：知识文档带 `entityIds`，检索时按「豆子
    /// 解析出的实体」做交集过滤，而不是靠相似度碰运气。用户自己的记录也会带
    /// （`DocumentBuilder` 从豆子解析），这样「同一产区/处理法的往次记录」也能筛。
    var entityIds: [String]?
    /// 知识的适用范围（规格 §十三）：generic / country / region / variety / process /
    /// roast / brew_method / equipment_brand / equipment_model。排序时越具体越靠前。
    var scope: String?
    /// 权威等级 1–4（来源分级）。知识文档才有，用户记录为 nil。
    var authorityTier: Int?
    /// 用户写下的原话（冲煮/风味记录的备注）。
    ///
    /// 相似冲煮的证据行要展示「为什么这条算相似」——那就是用户的原话。正文里
    /// 固然有它，但正文是给 embedding 用的整段文本，从里面截取要靠猜前缀；放
    /// 元数据里则是一个稳定的字段。老索引条目没有这个键，解码为 nil，证据行
    /// 就少一句原话，不影响其它功能。
    var note: String?

    init(
        beanID: UUID? = nil,
        brewID: UUID? = nil,
        tastingID: UUID? = nil,
        method: String? = nil,
        grinder: String? = nil,
        docDate: Date? = nil,
        dayAfterRoast: Int? = nil,
        score: Int? = nil,
        origin: String? = nil,
        process: String? = nil,
        roaster: String? = nil,
        roastLevel: String? = nil,
        category: String? = nil,
        reference: String? = nil,
        entityIds: [String]? = nil,
        scope: String? = nil,
        authorityTier: Int? = nil,
        note: String? = nil
    ) {
        self.beanID = beanID
        self.brewID = brewID
        self.tastingID = tastingID
        self.method = method
        self.grinder = grinder
        self.docDate = docDate
        self.dayAfterRoast = dayAfterRoast
        self.score = score
        self.origin = origin
        self.process = process
        self.roaster = roaster
        self.roastLevel = roastLevel
        self.category = category
        self.reference = reference
        self.entityIds = entityIds
        self.scope = scope
        self.authorityTier = authorityTier
        self.note = note
    }
}

/// 统一的可检索文档（协议 §5）。
///
/// `content` 是喂给 embedding 的**自然语言**，不是数据库字段的拼接。别的都只是
/// 为了过滤和展示：协议明确要求「不要直接把数据库原始 JSON 当成 embedding 文本」，
/// 因为那样嵌入的是键名和标点，不是语义。这个文本由 `DocumentBuilder` 生成，
/// 生成规则集中在那一处，改表述不会波及检索与回答。
///
/// 注意这里**没有** `embedding` 字段。协议 §5 的示意里有，但把它放在文档上会
/// 造成两个后果：文档一旦带上向量就不再是可比较的值类型，而向量属于索引、
/// 不属于资料本身——同一份资料换一个 embedding 模型仍然成立。所以向量存在
/// `KnowledgeChunkRecord` 里，和 `modelIdentifier` 绑在一起，见 `RAG/Store`。
struct CoffeeKnowledgeDocument: Identifiable, Equatable, Sendable {

    let sourceType: KnowledgeSourceType
    /// 源对象的稳定标识：豆子/冲煮/风味的 UUID 字符串，或知识库文档的 id。
    let sourceId: String
    let title: String
    /// 用于 embedding 的自然语言正文。
    let content: String
    let metadata: DocumentMetadata
    let updatedAt: Date

    /// 全局唯一 id。`sourceType` 参与其中，因为同一个 UUID 不会跨类型重名，
    /// 而显式带上类型让日志和索引一眼能看出这是哪种资料。
    var id: String { "\(sourceType.rawValue):\(sourceId)" }

    /// 内容指纹。索引靠它判断「这条要不要重新算向量」。
    ///
    /// 只覆盖会影响嵌入结果的字段：正文和标题。`updatedAt` 不参与——一包豆子
    /// 的剩余量变了会改 `updatedAt`，但正文里那句话也变了，所以正文指纹自然
    /// 会变；反过来若只有元数据变了，就不值得重算向量。
    ///
    /// **这里不能用 Swift `Hasher`。** `Hasher` 每进程随机播种，同一段文本在两
    /// 次启动里会得到不同的值，而这个指纹是要落进 `EmbeddingRecord.contentHash`
    /// 并跨启动比较的——那样每次冷启动都会判定「全部变了」，增量索引退化成全量
    /// 重算（功能还对，但白算几百条向量）。所以用 FNV-1a 64。
    var contentHash: String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in (title + "\u{1F}" + content).utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}
