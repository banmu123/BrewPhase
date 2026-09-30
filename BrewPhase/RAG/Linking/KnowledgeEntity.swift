import Foundation

/// 知识实体的类型（规格 §十）。
///
/// `rawValue` 必须与 `Resources/knowledge_entities.json` 里的 `type` 字面量一致——
/// 这份 JSON 是词表数据，进 Swift 会被本地化流水线收成待翻译的键（与
/// `flavor_mapping.json` / `query_rules.json` 同因），所以留在资源里。
///
/// `water` / `troubleshooting` / `maintenance` 是规格 §十 点名、V1 暂由 `topic.*`
/// 承载的类型：保留 case 是为了将来把知识条目挂到更细的节点上时**不用改枚举**
/// （改枚举会让已经落库的 `entityIds` 语义漂移）。
enum EntityType: String, Codable, CaseIterable, Sendable {
    case topic
    case origin
    case region
    case variety
    case varietyGroup
    case process
    case roast
    case brewMethod
    case brewFamily
    case sensory
    case grinder
    case equipment
    // 规格 §十 的词汇，V1 预留
    case water
    case troubleshooting
    case maintenance

    /// 展示名用的本地化键。中文文案走 `L()`，英文走资源表。
    var label: String {
        switch self {
        case .topic: return L("主题")
        case .origin: return L("产地")
        case .region: return L("产区")
        case .variety: return L("品种")
        case .varietyGroup: return L("品种谱系")
        case .process: return L("处理法")
        case .roast: return L("烘焙度")
        case .brewMethod: return L("冲煮方式")
        case .brewFamily: return L("冲煮家族")
        case .sensory: return L("风味")
        case .grinder: return L("磨豆机")
        case .equipment: return L("设备")
        case .water: return L("水质")
        case .troubleshooting: return L("故障")
        case .maintenance: return L("维护")
        }
    }
}

/// 知识的适用范围（规格 §十三）。
///
/// 这是「排序」的依据，不是装饰：用户问「我的 Breville Barista Express 怎么除垢」
/// 时，`equipment_model` 必须排在 `generic` 前面（规格 §五十九）。
enum EntityScope: String, Codable, CaseIterable, Sendable {
    case generic
    case country
    case region
    case variety
    case process
    case roast
    case brewMethod = "brew_method"
    case equipmentBrand = "equipment_brand"
    case equipmentModel = "equipment_model"

    /// 越具体越大。用于「同分时谁先上」的确定性排序。
    var rank: Int {
        switch self {
        case .equipmentModel: return 100
        case .equipmentBrand: return 90
        case .variety: return 70
        case .region: return 65
        case .country: return 60
        case .process: return 55
        case .roast: return 50
        case .brewMethod: return 45
        case .generic: return 10
        }
    }

    var label: String {
        switch self {
        case .generic: return L("通用")
        case .country: return L("国家级")
        case .region: return L("产区级")
        case .variety: return L("品种级")
        case .process: return L("处理法级")
        case .roast: return L("烘焙级")
        case .brewMethod: return L("冲煮方式级")
        case .equipmentBrand: return L("品牌级")
        case .equipmentModel: return L("型号级")
        }
    }
}

/// 一个可被链接的知识节点（规格 §十）。
///
/// 注意它**不是**知识内容本身：内容在 `knowledge_base.json` 的文档里，带来源与
/// 权威等级。实体只回答「有哪些点、它们怎么互相归属、有哪些别名」。
struct KnowledgeEntity: Identifiable, Equatable, Sendable {

    let id: String
    let type: EntityType
    let canonicalName: String
    let display: [String: String]
    let aliases: [String]
    let parentId: String?
    let scope: EntityScope
    /// 与端侧模型的规范类目对齐时的取值（`feature_schema.json` 的拼写）。
    /// 只用于「词典不漂移」的核对，不参与任何模型输入。
    let modelValue: String?
    /// 该节点的归属依据（品种谱系引 WCR 目录）。
    let sourceId: String?
    let note: String?

    init(
        id: String,
        type: EntityType,
        canonicalName: String,
        display: [String: String] = [:],
        aliases: [String] = [],
        parentId: String? = nil,
        scope: EntityScope = .generic,
        modelValue: String? = nil,
        sourceId: String? = nil,
        note: String? = nil
    ) {
        self.id = id
        self.type = type
        self.canonicalName = canonicalName
        self.display = display
        self.aliases = aliases
        self.parentId = parentId
        self.scope = scope
        self.modelValue = modelValue
        self.sourceId = sourceId
        self.note = note
    }

    /// 界面展示名。三级回退与 `LocalizedText` 一致：精确 → 语言前缀 → 规范名。
    func displayName(for languageCode: String) -> String {
        if let exact = display[languageCode] { return exact }
        let base = languageCode.split(separator: "-").first.map(String.init) ?? languageCode
        if let prefixed = display.first(where: { $0.key.hasPrefix(base) })?.value { return prefixed }
        return canonicalName
    }

    /// 解析时把 JSON 的一个条目转成实体。缺关键字段就当这条不存在，而不是给默认值——
    /// 一个 id 拼错、type 认不出的节点混进图里，会让链接结果莫名其妙。
    init?(json: [String: Any]) {
        guard let id = json["id"] as? String,
              let rawType = json["type"] as? String,
              let type = EntityType(rawValue: rawType),
              let canonicalName = json["canonicalName"] as? String
        else { return nil }

        let scope = (json["scope"] as? String).flatMap(EntityScope.init(rawValue:)) ?? .generic

        self.init(
            id: id,
            type: type,
            canonicalName: canonicalName,
            display: (json["display"] as? [String: String]) ?? [:],
            aliases: (json["aliases"] as? [String]) ?? [],
            parentId: json["parentId"] as? String,
            scope: scope,
            modelValue: json["modelValue"] as? String,
            sourceId: json["sourceId"] as? String,
            note: json["note"] as? String
        )
    }
}

/// 实体图里的一次命中（规格 §九）。
///
/// 带 `match` 是刻意的：界面与排序都要能区分「用户写的正是规范名」和
/// 「这是从一个别名蒙出来的」。后者不该被当成事实呈现（规格 §十二）。
struct EntityResolution: Equatable, Sendable {
    let entity: KnowledgeEntity
    let match: MatchType
    /// 实际命中的那个写法（规范名或别名），便于解释「为什么关联上了」。
    let matchedAlias: String

    var id: String { entity.id }
}

/// 链接的方向（规格 §十一）。
enum RelationType: String, Codable, CaseIterable, Sendable {
    case origin
    case region
    case variety
    case process
    case roast
    case recommendedBrew = "recommended_brew"
    case equipment
    case sensory
    case freshness
    /// 规格 §十二：泛化倾向（「埃塞俄比亚常见花香」）只能算背景，**不是**这包豆子的事实。
    case generalContext = "general_context"

    var label: String {
        switch self {
        case .origin: return L("产地")
        case .region: return L("产区")
        case .variety: return L("品种")
        case .process: return L("处理法")
        case .roast: return L("烘焙")
        case .recommendedBrew: return L("推荐冲煮")
        case .equipment: return L("设备")
        case .sensory: return L("风味")
        case .freshness: return L("新鲜度")
        case .generalContext: return L("背景知识")
        }
    }

    /// 实体类型 → 关系类型。`topic` 在图上没有专属关系，落在 `generalContext`。
    static func forEntityType(_ type: EntityType) -> RelationType {
        switch type {
        case .origin, .region: return .origin
        case .variety, .varietyGroup: return .variety
        case .process: return .process
        case .roast: return .roast
        case .brewMethod, .brewFamily: return .recommendedBrew
        case .equipment, .grinder: return .equipment
        case .sensory: return .sensory
        case .water, .troubleshooting, .maintenance, .topic: return .generalContext
        }
    }
}

/// 命中方式（规格 §十一）。顺序即优先级（规格 §十五）。
enum MatchType: String, Codable, CaseIterable, Sendable {
    /// 用户写的与规范名逐字相同。
    case exact
    /// 只在大小写 / 全半角 / 分隔符上不同。
    case normalized
    /// 命中的是别名（「瑰夏」→ Gesha、「耶加雪菲」→ Yirgacheffe）。
    case alias
    /// 由层级推导出来的（只写 Guji 时，Ethiopia 属于这一档）。
    case hierarchy
    /// 由字段语义推断（例如烘焙度枚举 → 烘焙实体）。
    case inferred
    /// 用户显式选择。
    case userSelected = "user_selected"
    /// 泛化背景（不做事实使用）。
    case generalContext = "general_context"

    /// 越小越优先。排序时先比这个，再比 scope。
    var priority: Int {
        switch self {
        case .exact: return 0
        case .normalized: return 1
        case .alias: return 2
        case .userSelected: return 3
        case .inferred: return 4
        case .hierarchy: return 5
        case .generalContext: return 6
        }
    }

    var label: String {
        switch self {
        case .exact: return L("完全匹配")
        case .normalized: return L("规范匹配")
        case .alias: return L("别名匹配")
        case .hierarchy: return L("层级匹配")
        case .inferred: return L("推断匹配")
        case .userSelected: return L("你指定的")
        case .generalContext: return L("背景关联")
        }
    }
}
