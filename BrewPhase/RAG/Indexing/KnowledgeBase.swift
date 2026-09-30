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
///
/// v2 起它同时携带**可链接的元数据**：`entityIds` / `scope` / `authorityTier`。
/// 这些字段在 v1 的 JSON 里不存在，解析时统统为 nil，所以老文件仍然可用。
struct KnowledgeDocument: Equatable, Sendable {
    let id: String
    let category: String
    /// 出处。协议要求 `source` 必须能记录来源——界面上也会显示，免得被当成
    /// App 自制的经验之谈（v2 的来源是真实出版方，见 `knowledge/SOURCE_REGISTRY.json`）。
    let source: String
    let title: LocalizedText
    let content: LocalizedText
    /// 溯源用的来源 id 列表（对应 Source Registry）。
    let sourceIds: [String]
    /// 1–4 的权威等级。排序用。
    let authorityTier: Int?
    /// 适用范围（规格 §十三）。
    let scope: String?
    /// 这条知识挂在哪几个知识实体上（规格 §十一）。
    let entityIds: [String]

    init(
        id: String,
        category: String,
        source: String,
        title: LocalizedText,
        content: LocalizedText,
        sourceIds: [String] = [],
        authorityTier: Int? = nil,
        scope: String? = nil,
        entityIds: [String] = []
    ) {
        self.id = id
        self.category = category
        self.source = source
        self.title = title
        self.content = content
        self.sourceIds = sourceIds
        self.authorityTier = authorityTier
        self.scope = scope
        self.entityIds = entityIds
    }
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
                    content: LocalizedText(content),
                    sourceIds: (entry["sourceIds"] as? [String]) ?? [],
                    authorityTier: entry["authorityTier"] as? Int,
                    scope: entry["scope"] as? String,
                    entityIds: (entry["entityIds"] as? [String]) ?? []
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
                    reference: document.source,
                    entityIds: document.entityIds.isEmpty ? nil : document.entityIds,
                    scope: document.scope,
                    authorityTier: document.authorityTier
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
        // v2 新增的分类
        case "fundamentals": return L("咖啡基础")
        case "origins": return L("产地")
        case "varieties": return L("品种")
        case "processing": return L("处理法")
        case "espresso": return L("意式浓缩")
        case "cleaning": return L("清洁维护")
        case "sensory": return L("感官")
        case "health": return L("咖啡与健康")
        case "terminology": return L("术语")
        default: return category
        }
    }
}
