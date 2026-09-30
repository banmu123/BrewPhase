import Foundation

/// 同一段文本的多种语言版本。
///
/// 知识库内容放在 JSON 里而不是 Swift 字面量里，有两个理由：一是它是**数据**
/// 而不是界面文案，不该进 `strings.py` 那套键表；二是它必须能同时携带中英两份，
/// 才能让界面语言切换时检索语言跟着切（见 `IndexCoordinator` 里关于索引语言的说明）。
struct LocalizedText: Equatable, Sendable {

    let values: [String: String]

    init(_ values: [String: String]) { self.values = values }

    /// 取某一种语言的文本。
    ///
    /// 三级回退：精确匹配（`zh-Hans`）→ 同语言前缀（`zh` 命中 `zh-Hans`）→
    /// 随便哪一种。最后一级不是偷懒：宁可用另一种语言的内容，也不要在界面上
    /// 留一块空白。
    func text(for languageCode: String) -> String? {
        if let exact = values[languageCode] { return exact }
        let base = languageCode.split(separator: "-").first.map(String.init) ?? languageCode
        if let prefix = values.first(where: { $0.key.hasPrefix(base) })?.value { return prefix }
        return values.values.sorted().first
    }
}

/// 一条本地静态知识文档（协议 §6）。
struct KnowledgeDocument: Equatable, Sendable {
    let id: String
    let category: String
    /// 出处。协议要求 `source` 必须能记录来源——这一版全部是 App 自制内容，
    /// 所以在 JSON 里写明了，界面上也会显示，免得被当成外部权威资料。
    let source: String
    let title: LocalizedText
    let content: LocalizedText
}

/// `knowledge_base.json` —— BrewPhase 的最小本地知识库。
///
/// 第一阶段**不做任何抓取**（协议 §6）：全部内容随 App 一起发布，离线可用，
/// 没有网络请求，也就没有失效的链接和被缓存污染的正文。
enum KnowledgeBase {

    static let fileName = "knowledge_base"

    /// 懒加载一次。解析失败不是致命错误：知识库读不到时 RAG 仍然能用用户自己的
    /// 数据回答，只是少一类资料。
    static let payload: Payload = {
        guard let json = BundleResource.jsonObject(named: fileName) else {
            AppLog.rag.error("knowledge_base.json not found in the bundle")
            return .empty
        }
        guard let payload = Payload(json: json), !payload.documents.isEmpty else {
            AppLog.rag.error("knowledge_base.json is not in the expected shape")
            return .empty
        }
        AppLog.rag.info("knowledge base loaded: \(payload.documents.count) documents, revision \(payload.revision)")
        return payload
    }()

    struct Payload: Sendable {
        let revision: Int
        let provenance: LocalizedText?
        let documents: [KnowledgeDocument]

        static let empty = Payload(revision: 0, provenance: nil, documents: [])

        init(revision: Int, provenance: LocalizedText?, documents: [KnowledgeDocument]) {
            self.revision = revision
            self.provenance = provenance
            self.documents = documents
        }

        init?(json: [String: Any]) {
            guard let rawDocuments = json["documents"] as? [[String: Any]] else { return nil }
            self.revision = json["revision"] as? Int ?? 0
            if let raw = json["provenance"] as? [String: String] {
                self.provenance = LocalizedText(raw)
            } else {
                self.provenance = nil
            }
            self.documents = rawDocuments.compactMap { entry in
                guard let id = entry["id"] as? String,
                      let category = entry["category"] as? String,
                      let source = entry["source"] as? String,
                      let title = entry["title"] as? [String: String],
                      let content = entry["content"] as? [String: String],
                      !content.isEmpty
                else { return nil }
                return KnowledgeDocument(
                    id: id,
                    category: category,
                    source: source,
                    title: LocalizedText(title),
                    content: LocalizedText(content)
                )
            }
        }
    }

    /// 当前语言下的知识文档，已经转成统一的可检索资料。
    ///
    /// `updatedAt` 取进程内首次加载的时刻：知识库没有「什么时候写的」这个信息，
    /// 而这个时间戳只影响按时间排序，且排序时知识类资料走的是中性时效（见
    /// `HybridRetriever`），所以这里不需要一个更精确的值。
    static func documents(languageCode: String, updatedAt: Date = Date()) -> [CoffeeKnowledgeDocument] {
        payload.documents.compactMap { document in
            guard let title = document.title.text(for: languageCode),
                  let content = document.content.text(for: languageCode)
            else { return nil }
            return CoffeeKnowledgeDocument(
                sourceType: .knowledge,
                sourceId: document.id,
                title: title,
                content: content,
                metadata: DocumentMetadata(
                    docDate: updatedAt,
                    category: document.category,
                    reference: document.source
                ),
                updatedAt: updatedAt
            )
        }
    }

    /// 分类的中文名，用于界面分组与引用展示。
    static func categoryLabel(_ category: String) -> String {
        switch category {
        case "brewing": return L("冲煮")
        case "grind": return L("研磨")
        case "water": return L("水温")
        case "ratio": return L("粉水比")
        case "time": return L("萃取时间")
        case "process": return L("处理法")
        case "roast": return L("烘焙")
        case "freshness": return L("新鲜度")
        case "tasting": return L("品鉴")
        default: return category
        }
    }
}
