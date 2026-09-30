import Foundation
import SwiftData

/// 挂在 SwiftData（也就是 SQLite）上的向量索引。
///
/// **为什么不引 ANN 索引**：协议 §8 给的目标规模是「单用户、几百～几万条」。
/// 这个量级下，把向量装进内存用 `vDSP` 全量点积一遍，10,000 条 × 640 维大既是
/// 6 毫秒左右——比任何近似索引都快得让人不必去想召回率。引入 HNSW 之类的结构
/// 会带来一个必须维护的额外文件、一套必须调对的参数，换来的是一份当前用不上的
/// 性能。真到了十万条那一档，换掉的是这个类，而不是整个检索层。
///
/// 缓存：向量只在第一次检索时从库里读出来解包一次，之后常驻内存。写入会让缓存
/// 失效。内存代价是 `条数 × 维度 × 4 字节`（10,000 × 640 ≈ 25MB），在手机上
/// 是可接受的；如果将来逼近这个量级，先做的是把向量量化成 `Int8`，而不是换存储。
@MainActor
final class SwiftDataVectorIndex: VectorIndex {

    private let context: ModelContext

    /// `nil` 表示还没加载或已失效。
    private var cache: [String: CachedEntry]?

    private struct CachedEntry {
        let passage: StoredPassage
        let vector: [Float]
        let contentHash: String
        let modelIdentifier: String
        let languageCode: String
    }

    init(context: ModelContext) {
        self.context = context
    }

    /// 丢掉内存缓存。外部改了库（比如豆子被删）之后调用。
    func invalidateCache() { cache = nil }

    // MARK: - 读

    func count() throws -> Int {
        try context.fetchCount(FetchDescriptor<EmbeddingRecord>())
    }

    func summaries() throws -> [IndexedSummary] {
        try context.fetch(FetchDescriptor<EmbeddingRecord>()).map {
            IndexedSummary(
                key: $0.recordKey,
                contentHash: $0.contentHash,
                modelIdentifier: $0.modelIdentifier,
                languageCode: $0.languageCode
            )
        }
    }

    func search(vector: [Float], filter: MetadataFilter, limit: Int) throws -> [VectorHit] {
        guard limit > 0, !vector.isEmpty else { return [] }
        let entries = try loadCache()
        guard !entries.isEmpty else { return [] }

        // 查询向量也归一化：库里存的都是单位向量，只有两边都是单位向量，
        // 点积才等于余弦相似度。
        let query = VectorMath.normalised(vector)

        var hits: [VectorHit] = []
        hits.reserveCapacity(entries.count)
        for entry in entries {
            // 维度不同的向量属于另一个空间，直接跳过而不是补零去比——补出来的
            // 相似度是个数，但它没有意义。
            guard entry.vector.count == query.count else { continue }
            guard filter.isEmpty || filter.matches(entry.passage) else { continue }
            hits.append(VectorHit(passage: entry.passage, similarity: Double(VectorMath.dot(query, entry.vector))))
        }

        hits.sort { $0.similarity > $1.similarity }
        return Array(hits.prefix(limit))
    }

    // MARK: - 写

    func upsert(_ entries: [VectorIndexEntry]) throws {
        guard !entries.isEmpty else { return }
        let existing = try existingRecords()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        for entry in entries {
            let document = entry.document
            let metadataJSON = (try? encoder.encode(document.metadata)) ?? Data()
            let packed = VectorMath.pack(VectorMath.normalised(entry.vector))

            if let record = existing[document.id] {
                record.sourceTypeRaw = document.sourceType.rawValue
                record.sourceId = document.sourceId
                record.title = document.title
                record.content = document.content
                record.beanID = document.metadata.beanID
                record.score = document.metadata.score ?? 0
                record.docDate = document.metadata.docDate
                record.metadataJSON = metadataJSON
                record.vector = packed
                record.dimension = entry.vector.count
                record.modelIdentifier = entry.modelIdentifier
                record.languageCode = entry.languageCode
                record.contentHash = document.contentHash
                record.updatedAt = document.updatedAt
            } else {
                context.insert(EmbeddingRecord(
                    recordKey: document.id,
                    sourceType: document.sourceType,
                    sourceId: document.sourceId,
                    title: document.title,
                    content: document.content,
                    metadata: document.metadata,
                    metadataJSON: metadataJSON,
                    vector: packed,
                    dimension: entry.vector.count,
                    modelIdentifier: entry.modelIdentifier,
                    languageCode: entry.languageCode,
                    contentHash: document.contentHash,
                    updatedAt: document.updatedAt
                ))
            }
        }

        try context.save()
        cache = nil
    }

    func remove(keys: Set<String>) throws {
        guard !keys.isEmpty else { return }
        let all = try context.fetch(FetchDescriptor<EmbeddingRecord>())
        var removed = false
        for record in all where keys.contains(record.recordKey) {
            context.delete(record)
            removed = true
        }
        guard removed else { return }
        try context.save()
        cache = nil
    }

    func removeAll() throws {
        let all = try context.fetch(FetchDescriptor<EmbeddingRecord>())
        guard !all.isEmpty else {
            cache = nil
            return
        }
        for record in all { context.delete(record) }
        try context.save()
        cache = nil
    }

    // MARK: - 内部

    private func existingRecords() throws -> [String: EmbeddingRecord] {
        let all = try context.fetch(FetchDescriptor<EmbeddingRecord>())
        return Dictionary(all.map { ($0.recordKey, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func loadCache() throws -> [CachedEntry] {
        if let cache { return Array(cache.values) }

        let records = try context.fetch(FetchDescriptor<EmbeddingRecord>())
        var built: [String: CachedEntry] = [:]
        built.reserveCapacity(records.count)

        for record in records {
            let vector = VectorMath.unpack(record.vector)
            guard !vector.isEmpty, vector.count == record.dimension else {
                // 向量和记录本身不一致：与其拿一条坏数据去算相似度，不如把它
                // 排除在外，等下一次同步自然修好。
                AppLog.rag.error("index entry \(record.recordKey, privacy: .public) has an unusable vector")
                continue
            }
            built[record.recordKey] = CachedEntry(
                passage: StoredPassage(
                    recordKey: record.recordKey,
                    sourceType: record.sourceType,
                    sourceId: record.sourceId,
                    title: record.title,
                    content: record.content,
                    metadata: record.metadata,
                    updatedAt: record.updatedAt
                ),
                vector: vector,
                contentHash: record.contentHash,
                modelIdentifier: record.modelIdentifier,
                languageCode: record.languageCode
            )
        }

        cache = built
        return Array(built.values)
    }
}
