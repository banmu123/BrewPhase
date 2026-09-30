import Foundation

/// 一包豆子 ↔ 一个知识实体的关联边（规格 §十一）。
///
/// 是**值类型**、不落库。理由（架构审查决策 A1）：`Bean.origin` / `process` 随时可改，
/// 实体图谱随包发布，而关联是纯确定性推导——落库只会引入一套「什么时候该作废」
/// 的维护负担，收益为零。将来若需要跨会话沿用、或允许用户手工修正关联，再升级成
/// `@Model`（属「只加实体」的轻量迁移，仓库已有先例）。
struct BeanKnowledgeLink: Identifiable, Equatable, Sendable {

    let beanID: UUID
    let entity: KnowledgeEntity
    let relation: RelationType
    let match: MatchType
    /// **匹配置信**（0–1），不是「这条知识对不对」的置信。
    ///
    /// 由命中方式唯一决定：完全匹配 1.0 → 背景关联 0.4。不做平滑、不做加权叠加，
    /// 保证同一个输入永远得到同一个值（否则界面会显示一个抖动的百分数，测试也
    /// 无从断言）。这是刻意的：规格 §五十六 禁止把推断当事实，一个「75% 置信」
    /// 的推断比一个诚实的「层级匹配」更容易被误读。
    let confidence: Double
    /// 为什么关联上——通常是用户原文里的那一段，界面可以据此解释。
    let evidence: String

    var id: String { "\(beanID.uuidString):\(entity.id)" }

    /// 规格 §十五 的优先级 → 置信度。`priority` 越小越强。
    static func confidence(for match: MatchType) -> Double {
        max(0.35, 1.0 - 0.1 * Double(match.priority))
    }
}

/// 一条被检索到的知识（规格 §二十 的 Knowledge Evidence）。
///
/// 与 `RetrievedPassage` 的区别：那个是「检索管线内部的一条」，这个是「面向某包
/// 豆子的一条知识」，所以它带 `matchedEntities`（为什么它和这包豆子有关）。
struct KnowledgeEvidence: Identifiable, Equatable, Sendable {

    let documentID: String
    let title: String
    let body: String
    let category: String
    /// 人类可读出处，界面署名用。
    let source: String
    /// 溯源 id（对应 `knowledge/SOURCE_REGISTRY.json`）。
    let sourceIDs: [String]
    let authorityTier: Int?
    let scope: String?
    /// 靠哪几个实体命中的（本地化展示名）。空表示这是通用知识，不是「针对这包豆」。
    let matchedEntities: [String]
    /// 排序分。只用于排序与展示阈值，不对外宣称成「准确率」。
    let relevance: Double

    var id: String { documentID }

    var scopeLabel: String? {
        scope.flatMap { EntityScope(rawValue: $0)?.label }
    }

    /// 是否真的「与这包豆子有关」（而不是通用兜底）。
    var isBeanSpecific: Bool { !matchedEntities.isEmpty }

    var categoryLabel: String { KnowledgeBase.categoryLabel(category) }
}

/// 一包豆子的完整知识上下文（规格 §十四）。
///
/// `directLinks` 与 `relatedLinks` 必须分开：前者是「用户写的东西直接对上了」，
/// 后者是「靠层级或泛化沾上的」。规格 §十二 要求这个界限不能糊——界面上一句
/// 「埃塞俄比亚常见花香」只能出现在后一类里。
struct BeanKnowledgeContext: Equatable, Sendable {

    let context: BeanContext
    let directLinks: [BeanKnowledgeLink]
    let relatedLinks: [BeanKnowledgeLink]

    /// 命中了直接实体的知识。
    let directKnowledge: [KnowledgeEvidence]
    /// 靠层级/背景落到的知识（「没有该产区的具体资料，先看更上层的」）。
    let relatedKnowledge: [KnowledgeEvidence]
    /// 与用户填的内容无关、但普遍适用的知识（产区/处理法/烘焙度的通识）。
    let genericKnowledge: [KnowledgeEvidence]
    /// 与当前冲煮方式相关的知识（规格 §二十一/§二十二）。
    let recommendedKnowledge: [KnowledgeEvidence]

    /// 去重后按相关度排序的全部知识。
    var allKnowledge: [KnowledgeEvidence] {
        var seen: Set<String> = []
        var out: [KnowledgeEvidence] = []
        for list in [directKnowledge, recommendedKnowledge, relatedKnowledge, genericKnowledge] {
            for item in list where !seen.contains(item.id) {
                seen.insert(item.id)
                out.append(item)
            }
        }
        return out.sorted { ($0.relevance, $1.documentID) > ($1.relevance, $0.documentID) }
    }

    var totalLinkCount: Int { directLinks.count + relatedLinks.count }
    var totalKnowledgeCount: Int { allKnowledge.count }

    /// 这包豆子有没有「专属」知识。没有时界面必须说「暂时没有该产区的具体资料」，
    /// 而不是把通用知识包装成个性化结论（规格 §五十/§四十九）。
    var hasBeanSpecificKnowledge: Bool { !directKnowledge.isEmpty }

    var isEmpty: Bool { directLinks.isEmpty && relatedLinks.isEmpty && allKnowledge.isEmpty }

    static func empty(context: BeanContext) -> BeanKnowledgeContext {
        BeanKnowledgeContext(
            context: context,
            directLinks: [],
            relatedLinks: [],
            directKnowledge: [],
            relatedKnowledge: [],
            genericKnowledge: [],
            recommendedKnowledge: []
        )
    }
}
