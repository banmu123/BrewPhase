import Foundation
import SwiftData

/// 把「当前数据」同步进索引。
///
/// 每一次提问前都会跑一遍，所以它必须是**便宜**的：建文档、读一遍现有指纹、
/// 算出差集，只有真正变了的那几条才会送去算向量。没有任何改动时，整件事情是
/// 几百次字符串哈希加一次数据库读，几毫秒。
///
/// 没有改用「数据版本号」之类的缓存来判断要不要同步，是因为任何这样的版本号都
/// 得自己维护、自己失效，而它一旦漏了一次更新，索引就会悄悄落后于数据——那种
/// 错误不报错、不崩，只是回答里少了一条记录，最难发现。代价是每次多几毫秒。
@MainActor
final class IndexCoordinator {

    /// 一轮同步做了什么。界面上用来说清「索引现在有多少条、是谁算的」。
    struct Report: Equatable, Sendable {
        var embedded: Int = 0
        var removed: Int = 0
        var reused: Int = 0
        var total: Int = 0
        var backend: EmbeddingBackend = .lexical
        var isFallback: Bool = false
        var modelIdentifier: String = ""
        /// 供用户自己判断的一行说明。
        var note: String?
    }

    private let index: SwiftDataVectorIndex

    /// 解析出来的 provider 会留着重用。
    ///
    /// 一次提问里只解析一次；而跨提问也要复用——`NLEmbedding.sentenceEmbedding(for:)`
    /// 每次调用都要重新拿一遍模型，几百次累积起来是能感觉到的开销。
    /// 缓存键是（用户选择的后端，界面语言），两者任一变化都说明向量空间变了。
    private var cached: (requested: EmbeddingBackend, language: String, resolution: EmbeddingProviderFactory.Resolution)?

    init(index: SwiftDataVectorIndex) {
        self.index = index
    }

    // MARK: - Provider

    /// 拿到这一轮该用的 provider。
    func resolution(settings: RAGSettings, languageCode: String) async -> EmbeddingProviderFactory.Resolution {
        if let cached, cached.requested == settings.embeddingBackend, cached.language == languageCode {
            return cached.resolution
        }
        let resolved = await EmbeddingProviderFactory.resolve(settings: settings, languageCode: languageCode)
        cached = (settings.embeddingBackend, languageCode, resolved)
        AppLog.rag.info("embedding provider: \(resolved.provider.modelIdentifier, privacy: .public) dim=\(resolved.provider.dimension)")
        return resolved
    }

    /// 设置或语言变了之后调它，下一次会重新解析 provider。
    func invalidateProvider() { cached = nil }

    // MARK: - 同步

    /// 同步索引。
    ///
    /// - Parameter force: 忽略指纹，全部重算。给设置页的「重建索引」用。
    @discardableResult
    func sync(
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook?,
        settings: RAGSettings,
        languageCode: String,
        now: Date = Date(),
        force: Bool = false
    ) async -> Report {
        let resolution = await resolution(settings: settings, languageCode: languageCode)
        let provider = resolution.provider

        var documents = DocumentBuilder.documents(
            beans: beans, brews: brews, tastings: tastings, book: book, now: now
        )
        // 知识库也进同一个索引：用户数据优先是**排序**上的优先（见 HybridRetriever），
        // 不是「不检索知识库」。合成一个数组而不是两个索引，是为了让相似度能在
        // 同一条数轴上直接比较。
        documents.append(contentsOf: KnowledgeBase.documents(languageCode: languageCode, updatedAt: now))

        var report = Report(
            backend: provider.backend,
            isFallback: resolution.isFallback,
            modelIdentifier: provider.modelIdentifier
        )

        let existing: [IndexedSummary]
        do {
            existing = try index.summaries()
        } catch {
            AppLog.rag.error("index read failed: \(error.localizedDescription, privacy: .public)")
            report.note = L("读取索引失败，这一轮没有可用的历史记录。")
            return report
        }

        // 向量空间的一致性优先于增量：只要库里有任何一条是别的模型或别的语言算的，
        // 整个索引就作废。混着用会得到「有点相关」的相似度——不报错，但全是错的。
        let mismatched = existing.contains {
            $0.modelIdentifier != provider.modelIdentifier || $0.languageCode != languageCode
        }
        if mismatched, !existing.isEmpty {
            AppLog.rag.info("index rebuilt: embedding space changed")
            do {
                try index.removeAll()
            } catch {
                AppLog.rag.error("index reset failed: \(error.localizedDescription, privacy: .public)")
            }
            report.note = L("换了向量模型或界面语言，索引已重建。")
            return await embed(documents, provider: provider, languageCode: languageCode, report: report)
        }

        let fingerprints = Dictionary(existing.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let currentKeys = Set(documents.map(\.id))

        // 数据没了，索引里那份也得走，否则检索会引用一条已经不存在的记录。
        let stale = Set(fingerprints.keys).subtracting(currentKeys)
        if !stale.isEmpty {
            do {
                try index.remove(keys: stale)
                report.removed = stale.count
            } catch {
                AppLog.rag.error("index prune failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        let toEmbed: [CoffeeKnowledgeDocument]
        if force {
            toEmbed = documents
        } else {
            toEmbed = documents.filter { document in
                guard let known = fingerprints[document.id] else { return true }
                return known.contentHash != document.contentHash
            }
        }
        report.reused = documents.count - toEmbed.count

        if toEmbed.isEmpty {
            report.total = documents.count
            return report
        }
        return await embed(toEmbed, provider: provider, languageCode: languageCode, report: report)
    }

    /// 送去做向量，然后写回索引。
    private func embed(
        _ documents: [CoffeeKnowledgeDocument],
        provider: EmbeddingProvider,
        languageCode: String,
        report: Report
    ) async -> Report {
        var report = report
        let texts = documents.map(\.content)

        // 放到主 actor 之外算。端侧模型是同步的 CPU 工作，几百条累积起来足够让
        // 界面卡一下；而 provider 是 Sendable 的，挪出去没有额外代价。
        let vectors = await Task.detached(priority: .userInitiated) {
            await provider.embedBatch(texts)
        }.value

        var entries: [VectorIndexEntry] = []
        entries.reserveCapacity(documents.count)
        for (offset, document) in documents.enumerated() {
            guard offset < vectors.count, let vector = vectors[offset], !vector.isEmpty else {
                AppLog.rag.error("embedding failed for \(document.id, privacy: .public)")
                continue
            }
            entries.append(VectorIndexEntry(
                document: document,
                vector: vector,
                modelIdentifier: provider.modelIdentifier,
                languageCode: languageCode
            ))
        }

        do {
            try index.upsert(entries)
            report.embedded = entries.count
        } catch {
            AppLog.rag.error("index write failed: \(error.localizedDescription, privacy: .public)")
            report.note = L("写入索引失败，这一轮的回答可能不完整。")
        }
        report.total = (try? index.count()) ?? entries.count

        if entries.count < documents.count {
            // 有资料没算出来就不假装完整——这些资料在检索里就是缺的。
            report.note = L("有 %@ 条资料没能算出向量，这次检索里没有它们。",
                            String(documents.count - entries.count))
        }
        return report
    }
}
