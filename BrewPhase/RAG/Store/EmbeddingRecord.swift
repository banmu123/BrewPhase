import Foundation
import SwiftData

/// 索引里的一条：资料 + 它的向量 + 是谁算的。
///
/// 为什么向量不放在 `CoffeeKnowledgeDocument` 上（协议 §5 的示意图把它画在文档里）：
/// 文档是**资料**，向量是**索引**。同一份资料换个 embedding 模型仍然是同一份资料，
/// 而向量必须和产出它的模型绑在一起才能用。分开之后，换模型只是重建索引，
/// 资料层不用动，`sourceType`/`content` 这些字段也不会因为模型换代而失去意义。
///
/// 放在 SwiftData 里就是放在 SQLite 里——协议 §8 要求的「SQLite + 向量」在这个项目
/// 里不需要额外依赖：SwiftData 的底座本来就是 SQLite，而几百到几万条的暴力扫描
/// 用 Accelerate 跑完全够（见 `SwiftDataVectorIndex` 里关于为什么不引 ANN 的说明）。
@Model
final class EmbeddingRecord {

    /// `"brew:3F2A…"` —— 和 `CoffeeKnowledgeDocument.id` 同一套构造规则。
    /// 拿它做唯一性判断，不必再去查 `sourceType` 和 `sourceId` 两列。
    var recordKey: String = ""
    var sourceTypeRaw: String = ""
    var sourceId: String = ""

    /// 正文直接存一份：引用列表要显示它，而回查源对象（豆子可能已被删）既慢又可能落空。
    var title: String = ""
    var content: String = ""

    /// 从 `DocumentMetadata` 里挑出来的热字段。
    ///
    /// 冗余存一遍而不是每次都解析 JSON：过滤发生在**每一条**上，而一个几百条的
    /// 索引每次检索都要过一遍。JSON 那份留着，以后加过滤维度不必改表。
    var beanID: UUID?
    var score: Int = 0
    var docDate: Date?

    var metadataJSON: Data = Data()

    /// 已归一化的向量。
    var vector: Data = Data()
    var dimension: Int = 0

    /// 向量空间的身份。两项都要对上才算兼容：模型换了、界面语言换了，
    /// 都是另一个空间。
    var modelIdentifier: String = ""
    var languageCode: String = ""

    /// 正文指纹。资料变了才重算向量——`updatedAt` 变了但正文没变的情况很常见
    /// （改了个剩余量、动了个备注然后又改回来），那时重算纯属浪费。
    var contentHash: String = ""

    var updatedAt: Date = Date()

    init(
        recordKey: String,
        sourceType: KnowledgeSourceType,
        sourceId: String,
        title: String,
        content: String,
        metadata: DocumentMetadata,
        metadataJSON: Data,
        vector: Data,
        dimension: Int,
        modelIdentifier: String,
        languageCode: String,
        contentHash: String,
        updatedAt: Date
    ) {
        self.recordKey = recordKey
        self.sourceTypeRaw = sourceType.rawValue
        self.sourceId = sourceId
        self.title = title
        self.content = content
        self.beanID = metadata.beanID
        self.score = metadata.score ?? 0
        self.docDate = metadata.docDate
        self.metadataJSON = metadataJSON
        self.vector = vector
        self.dimension = dimension
        self.modelIdentifier = modelIdentifier
        self.languageCode = languageCode
        self.contentHash = contentHash
        self.updatedAt = updatedAt
    }

    var sourceType: KnowledgeSourceType {
        KnowledgeSourceType(rawValue: sourceTypeRaw) ?? .knowledge
    }

    /// 解析回完整的 metadata。JSON 解不开时退到只有热字段的那份，而不是返回 nil——
    /// 一条资料因为元数据坏了就从检索里消失，比少了几个过滤条件更糟。
    var metadata: DocumentMetadata {
        if let decoded = try? JSONDecoder().decode(DocumentMetadata.self, from: metadataJSON) {
            return decoded
        }
        return DocumentMetadata(beanID: beanID, docDate: docDate, score: score > 0 ? score : nil)
    }
}
