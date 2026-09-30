import Foundation

/// Bean Profile 里可能缺失的字段（规格 §十六/§十七）。
///
/// 存在的意义是**诚实**：真实用户可能只填了「埃塞俄比亚」。这套枚举让上层能说
/// 「我不知道产区」，而不是假装有一个。
enum BeanContextField: String, CaseIterable, Sendable {
    case origin
    case region
    case variety
    case process
    case method
    case freshness

    var label: String {
        switch self {
        case .origin: return L("产地")
        case .region: return L("产区")
        case .variety: return L("品种")
        case .process: return L("处理法")
        case .method: return L("冲煮方式")
        case .freshness: return L("烘焙日期")
        }
    }
}

/// 一包豆子的标准化检索上下文（规格 §七）。
///
/// 这是「用户那包豆子」到「该看哪些知识」之间的那个中间层。它**只做翻译**：
/// 把自由文本（`Bean.origin` 存的是「埃塞俄比亚 · Guji」这种本地化混写串）与枚举
/// 变成一组带命中方式的知识实体，不产生任何新事实。
///
/// 规格 §六 要求「不得硬造数据库字段」，所以这里没有 `variety` 这种属性——
/// 品种是从豆名与备注里**尽力识别**出来的关联，识别不到就是没有。
struct BeanContext: Equatable, Sendable {

    /// 规格 §七 的示意：`origin.country` / `origin.region` / `process[]` / `roastLevel`。
    /// 这里用实体 id 承载，比裸字符串更严——字符串没法参与层级 fallback。
    struct OriginRef: Equatable, Sendable {
        let country: KnowledgeEntity?
        let regions: [KnowledgeEntity]
    }

    let beanID: UUID
    let beanName: String
    let rawOrigin: String
    let rawProcess: String
    let rawRoaster: String
    let roastLevelRaw: String
    let roastLevelLabel: String
    let flavorTags: [String]
    let methodText: String?
    let daysSinceRoast: Int?
    let daysSinceOpen: Int?
    /// 全部命中，已按（命中方式 → 适用范围 → 写法长度 → id）确定性排序。
    let resolutions: [EntityResolution]

    var origin: OriginRef {
        OriginRef(
            country: resolutions.first { $0.entity.type == .origin }?.entity,
            regions: resolutions.filter { $0.entity.type == .region }.map(\.entity)
        )
    }

    var isEmpty: Bool { resolutions.isEmpty }

    var entityIDs: [String] { resolutions.map(\.id) }

    /// 哪些字段是**真的没有**。规格 §十七：缺什么只能说缺什么，不能自动补。
    var missingFields: [BeanContextField] {
        var missing: [BeanContextField] = []
        if !resolutions.contains(where: { $0.entity.type == .origin }) { missing.append(.origin) }
        if !resolutions.contains(where: { $0.entity.type == .region }) { missing.append(.region) }
        if !resolutions.contains(where: { $0.entity.type == .variety || $0.entity.type == .varietyGroup }) {
            missing.append(.variety)
        }
        if !resolutions.contains(where: { $0.entity.type == .process }) { missing.append(.process) }
        if methodText == nil { missing.append(.method) }
        if daysSinceRoast == nil { missing.append(.freshness) }
        return missing
    }

    func resolutions(ofType type: EntityType) -> [EntityResolution] {
        resolutions.filter { $0.entity.type == type }
    }

    /// 某个关系方向下的实体 id。用于给检索层拼元数据过滤条件。
    func entityIDs(for relation: RelationType) -> [String] {
        resolutions
            .filter { RelationType.forEntityType($0.entity.type) == relation }
            .map(\.id)
    }
}
