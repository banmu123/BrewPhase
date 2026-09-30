import Foundation

/// 用 Ollama 的模型算向量。
///
/// 相比端侧模型的优势只有一个，但是真实的：**可以换成多语言的 embedding 模型**。
/// 设备上的句向量按语言分空间，中英不能互查；换一个多语言模型就绕开了这个限制。
/// 代价是需要用户本机跑着 Ollama，所以它永远是可选项，不是默认。
final class OllamaEmbeddingProvider: EmbeddingProvider, @unchecked Sendable {

    private let client: OllamaClient
    private let model: String

    let dimension: Int
    let modelIdentifier: String

    private init(client: OllamaClient, model: String, dimension: Int) {
        self.client = client
        self.model = model
        self.dimension = dimension
        // 维度进不了身份串：维度是模型的结果，模型名才是身份。
        self.modelIdentifier = "ollama.\(model).v1"
    }

    /// 建 provider 必须探一次，因为**维度要问出来才知道**。
    ///
    /// 协议要求 `dimension` 是个属性而不是个异步方法，那就只能在这里把答案拿到。
    /// 探测失败（服务没起、模型没装、名字打错）返回 nil，由 factory 走降级。
    static func make(baseURLString: String, model: String) async -> OllamaEmbeddingProvider? {
        guard let client = OllamaClient(baseURLString: baseURLString) else { return nil }
        let name = model.trimmed
        guard !name.isEmpty else { return nil }
        // 探测用的文本是英文的：它不参与任何检索，只是为了让服务返回一个向量好
        // 量出维度。写成中文会被本地化流水线当成一条待翻译的界面文案。
        guard let probe = try? await client.embedding(model: name, prompt: "coffee"), !probe.isEmpty else {
            AppLog.rag.error("ollama embedding probe failed for model \(name, privacy: .public)")
            return nil
        }
        return OllamaEmbeddingProvider(client: client, model: name, dimension: probe.count)
    }

    func embed(_ text: String) async -> [Float]? {
        let trimmed = text.trimmed
        guard !trimmed.isEmpty else { return nil }
        return try? await client.embedding(model: model, prompt: trimmed)
    }

    /// 批量走 `/api/embed`，失败就退回逐条。
    ///
    /// 两套接口都要留着：批量接口是较新版本才有的，老版本会返回 404。建索引时
    /// 逐条发几百个请求虽然能跑完，但那是几十秒和几秒的差别，值得多这十行。
    func embedBatch(_ texts: [String]) async -> [[Float]?] {
        let cleaned = texts.map(\.trimmed)
        if cleaned.allSatisfy(\.isEmpty) { return cleaned.map { _ in nil } }

        if let rows = try? await client.embeddings(model: model, prompts: cleaned) {
            return rows.map { $0.isEmpty ? nil : $0 }
        }
        var results: [[Float]?] = []
        results.reserveCapacity(cleaned.count)
        for text in cleaned {
            results.append(await embed(text))
        }
        return results
    }
}
