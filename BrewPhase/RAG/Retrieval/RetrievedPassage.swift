import Foundation

/// 一条进入上下文的证据。
///
/// 两种来源在类型上就分开，因为它们的可信度不一样：`structuredFact` 是从库里
/// 现算出来的结论（「最高分是 5 分，出现在 9月25日」），`indexedDocument` 是
/// 索引里的原始记录（某一次冲煮的全文）。混成一堆「相关片段」交给模型，它会
/// 分不清哪句是算出来的、哪句是抄来的——而这个区别在咖啡这种小事上无所谓，
/// 在「我上次用了多少克粉」这种问题上就是全部。
struct RetrievedPassage: Identifiable, Equatable, Sendable {

    enum Origin: String, Equatable, Sendable {
        /// 从数据库直接算出来的。
        case structuredFact
        /// 索引里的一条资料，按相似度取回。
        case indexedDocument
    }

    /// 引用编号之外的稳定标识。同一份资料只会出现一次。
    let id: String
    let origin: Origin
    let sourceType: KnowledgeSourceType
    let title: String
    let content: String
    let metadata: DocumentMetadata

    /// 融合后的相关度，0…1。排序用的就是它。
    var relevance: Double
    /// 向量相似度。只有向量命中才有；结构化事实没有这个概念。
    var similarity: Double?
    var updatedAt: Date

    var isUserData: Bool { sourceType.isUserData }
}
