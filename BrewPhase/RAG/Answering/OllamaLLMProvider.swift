import Foundation

/// 用本机 Ollama 生成回答。
///
/// 这是开发期的主力：本地跑、可以随便换模型、生成质量比抽取式好得多。它仍然是
/// **本地**的（127.0.0.1 上的一个进程），所以不违反 local-first；但它需要用户自己
/// 装并启动 Ollama，因此永远是可选路径，不是默认。
///
/// 在真机上还有一层现实：手机上的 `127.0.0.1` 是手机自己，不是你的 Mac。所以这个
/// provider 实际可用的是模拟器和「在手机上跑 Ollama」这两种情况。地址做成可配置的，
/// 指向局域网里的机器也能用。
struct OllamaLLMProvider: LLMProvider {

    let engine: AnswerEngine = .ollama
    let client: OllamaClient
    let model: String

    var identifier: String { "ollama.\(model)" }

    func generate(prompt: String, context: BuiltContext) async throws -> String {
        let text = try await client.chat(
            model: model,
            system: prompt,
            prompt: PromptBuilder.user(context: context)
        )
        guard !text.trimmed.isEmpty else { throw LLMError.empty }
        return text.trimmed
    }
}
