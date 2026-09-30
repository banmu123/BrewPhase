import Foundation

/// 选择由谁生成回答。
///
/// **V1（协议 §二）不使用任何 LLM**，所以这里只剩一个引擎：抽取式。它把检索到的
/// 结构化事实、记录与知识整理成一段有引用的话——不需要模型、不挑设备、永不失败。
///
/// 每个回答仍然标注引擎（`engine`）与是否偏离了偏好（`usedFallback`）：将来把
/// LLM 挂回 `chain` 时，这套「实际用了谁」的报告机制已经就位，不必重写。
@MainActor
enum AnswerComposer {

    struct Composed: Equatable, Sendable {
        let text: String
        let engine: AnswerEngine
        let usedFallback: Bool
        /// 之前那个引擎为什么没用上。
        let failureNote: String?
    }

    static func compose(context: BuiltContext, settings: RAGSettings) async -> Composed {
        let system = PromptBuilder.system()
        let providers = chain(settings: settings)
        var lastFailure: String?

        // 降级的判据是**链内位置**而不是「偏好是否匹配」：V1 的链上只有抽取式，
        // 它是终点而不是降级产物——哪怕偏好里还存着 ollama（老用户的残留偏好），
        // 也不该报一句没人看得懂的「降级了」。V2 挂回 LLM 后，链首成功时 index
        // 是 0，落到后面的引擎时才会是 true，语义自动恢复。
        for (index, provider) in providers.enumerated() {
            do {
                let text = try await provider.generate(prompt: system, context: context)
                let trimmed = text.trimmed
                guard !trimmed.isEmpty else { throw LLMError.empty }
                return Composed(
                    text: trimmed,
                    engine: provider.engine,
                    usedFallback: index > 0,
                    failureNote: index > 0 ? lastFailure : nil
                )
            } catch {
                AppLog.rag.error("llm \(provider.identifier, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                lastFailure = L("%@ 没能给出回答：%@", provider.engine.label, error.localizedDescription)
            }
        }

        // 抽取式 provider 不抛错，正常走不到这里。留着是为了让「一定有一段回答」
        // 这件事在代码上是显然的，而不是靠推断。
        return Composed(
            text: L("抱歉，这次没能生成回答。"),
            engine: .onDeviceSummary,
            usedFallback: true,
            failureNote: lastFailure
        )
    }

    /// 本次可用的 provider。
    ///
    /// **V1（协议 §二）不使用任何 LLM**：抽取式是链上唯一的引擎。Ollama 与
    /// Foundation Models 的 provider 文件保留为接口，但不在链上——将来引入
    /// 「可选 LLM 层」（协议 §41）时，要改的只有这一个函数。
    static func chain(settings: RAGSettings) -> [LLMProvider] {
        [ExtractiveLLMProvider()]
    }

    /// 按引擎种类取 provider。V1 的链上只有抽取式，所以这里只被将来挂回 LLM 层
    /// 时用到；保留它是为了那时不必重新想一遍映射关系。
    static func provider(for engine: AnswerEngine, settings: RAGSettings) -> LLMProvider? {
        switch engine {
        case .onDeviceSummary:
            return ExtractiveLLMProvider()
        case .appleIntelligence:
            return FoundationModelLLMProvider.isAvailable ? FoundationModelLLMProvider() : nil
        case .ollama:
            guard let client = OllamaClient(baseURLString: settings.ollamaBaseURL) else { return nil }
            let model = settings.ollamaChatModel.trimmed
            guard !model.isEmpty else { return nil }
            return OllamaLLMProvider(client: client, model: model)
        }
    }
}
