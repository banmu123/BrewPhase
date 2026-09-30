import Foundation

/// 索引里取出来的一条资料（不含向量）。
struct StoredPassage: Identifiable, Equatable, Sendable {
    let recordKey: String
    let sourceType: KnowledgeSourceType
    let sourceId: String
    let title: String
    let content: String
    let metadata: DocumentMetadata
    let updatedAt: Date

    var id: String { recordKey }
}

/// 一次向量检索的结果。
struct VectorHit: Equatable, Sendable {
    let passage: StoredPassage
    /// 余弦相似度，-1…1。因为两边都是单位向量，它就是点积。
    let similarity: Double
}

/// 要写进索引的一条。
struct VectorIndexEntry: Sendable {
    let document: CoffeeKnowledgeDocument
    /// 已归一化。
    let vector: [Float]
    let modelIdentifier: String
    let languageCode: String
}

/// 索引里某一条的现状，用来判断要不要重建。
struct IndexedSummary: Equatable, Sendable {
    let key: String
    let contentHash: String
    let modelIdentifier: String
    let languageCode: String
}

/// 本地向量存储（协议 §8）。
///
/// 协议给了两条路——SQLite + 向量扩展，或者「项目已经有 SQLite 时就地扩展」。
/// 这个工程已经有 SQLite（SwiftData 的底座），所以走第二条：**不引入任何新的
/// 存储依赖**，没有服务、没有进程、没有文件格式要维护。
///
/// `@MainActor` 是因为实现要拿 `ModelContext`，而它在这个 App 里是主 actor 绑定的。
/// 把它标出来而不是靠 `@unchecked Sendable` 绕过去：检索本身是内存里的点积，
/// 几百条的规模下在主 actor 上跑完是零点几毫秒，不值得为它承担一个数据竞争。
@MainActor
protocol VectorIndex: AnyObject {

    /// 索引里现有多少条。
    func count() throws -> Int

    /// 现有条目的指纹，用于增量同步。
    func summaries() throws -> [IndexedSummary]

    /// 写入或覆盖。传进来的向量必须已归一化。
    func upsert(_ entries: [VectorIndexEntry]) throws

    /// 删掉这些 key。
    func remove(keys: Set<String>) throws

    /// 清空。
    func removeAll() throws

    /// 相似度检索。
    func search(vector: [Float], filter: MetadataFilter, limit: Int) throws -> [VectorHit]
}
