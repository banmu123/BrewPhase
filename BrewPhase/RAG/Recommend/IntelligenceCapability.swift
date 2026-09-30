import Foundation

/// 当前哪些智能能力可用（协议 §36）。
///
/// 结构化查询、规则与推荐**永远是可用的**：它们是纯 Swift 统计，没有任何前置
/// 条件——设备再旧、模型再缺，这几样照跑。会变的只有语义检索的档位（端侧模型
/// 或词法兜底），和知识库有没有加载成功。UI 用这组状态决定显示什么，以及诚实地
/// 说明哪部分降了级。
struct IntelligenceCapability: Equatable, Sendable {
    let structuredQueryAvailable: Bool
    let semanticSearchAvailable: Bool
    /// 语义检索的实际档位：端侧语义模型，还是词法兜底。
    let semanticBackend: EmbeddingBackend
    let semanticModelIdentifier: String
    let knowledgeBaseAvailable: Bool
    let recommendationAvailable: Bool

    /// 语义检索有没有退到词法匹配。退了就要在界面上说清「只认字面相近」。
    var isUsingLexicalFallback: Bool { semanticBackend == .lexical }
}
